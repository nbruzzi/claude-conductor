// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Check registry — RegistryBuilder + SealedRegistry phase split.
 *
 * Plugin-side: registry types + classes only. The static REGISTRY const +
 * Nick-specific helpers (`checkNamesForEvent`, `isValidCheck`, `checksForTool`,
 * `isEnabledForProfile`) stay in dotfiles for now (per ARCH-4 boundary
 * discipline + per RE-1/TS-1 dotfiles-first deletion deferral). When batch 4b
 * lands the dotfiles flip, those consumers rewrite to read from
 * SealedRegistry's metadataFor() / blockingNamesFor() instead.
 *
 * TODO(batch-4b/0.7): Narrow `name: string` to a closed union of valid check
 * names once the plugin's BundledCheckName + dotfiles' AllCheckNames types are
 * reconciled. For now, registry types are name-agnostic to avoid leaking
 * Nick-specific names from check-names.ts (which stays in dotfiles).
 */

import type { HookEvent, HookProfile, CheckFn } from "./types.ts";
import { HOOK_EVENTS } from "./types.ts";

export type { HookProfile };

export const ALL_PROFILES: HookProfile[] = ["minimal", "standard", "strict"];

export type CheckMeta = {
  /** Check name (used with --check=NAME). */
  name: string;
  /** One-line description shown by --list. */
  description: string;
  /** Tool names this check applies to, or "*" for all tools. */
  tools: string;
  /** Whether this check can block (exit 2). */
  canBlock: boolean;
  /** Which profiles include this check. */
  profiles: HookProfile[];
};

/** Check if a profile name is valid. */
export function isValidProfile(name: string): name is HookProfile {
  return (ALL_PROFILES as readonly string[]).includes(name);
}

/** Get the active profile from env var or override, defaulting to "standard". */
export function activeProfile(override?: string): HookProfile {
  const raw = override ?? process.env["HOOK_PROFILE"] ?? "standard";
  return isValidProfile(raw) ? raw : "standard";
}

// ─── Dual-registry contract (per extraction-manifest §§ 194–225) ──────────
//
// Builder→Sealed phase split: register-time mutability vs. read-time
// immutability are type-enforced (not just convention).

/** Metadata fields shared by all registrations and surfaced via metadataFor(). */
export type CheckMetadata = {
  description: string;
  canBlock: boolean;
  profiles: readonly HookProfile[];
};

/**
 * A check registration in the new Registry.
 *
 * No `silent` / `tools` / `earlyReturn` — those are handler-level policy
 * (audit consensus: ARCH-8, TS-1, RE-7). Registration carries identity +
 * behavior + metadata. Per-event policy lives in the ORDER files.
 */
export type CheckRegistration = {
  name: string;
  fn: CheckFn;
} & CheckMetadata;

/**
 * Per-event handler policy for one check.
 *
 * Note: `name: string` is the staging-scope choice (see top-of-file TODO).
 * Closed-union typo protection is reinstated in batch 4b when CheckName
 * is reconciled across the plugin/dotfiles boundary.
 */
export type OrderEntry = {
  name: string;
  earlyReturn: "on-block" | "on-output" | "never";
  silent?: boolean;
  tools?: readonly string[];
};

/**
 * Mutable phase of the registry. Use during boot; transition to SealedRegistry
 * via .seal() before any handler reads.
 */
export class RegistryBuilder {
  private readonly byEvent: Map<HookEvent, Map<string, CheckRegistration>>;

  constructor() {
    this.byEvent = new Map(HOOK_EVENTS.map((event) => [event, new Map()]));
  }

  register(event: HookEvent, reg: CheckRegistration): void {
    const map = this.byEvent.get(event);
    if (!map) {
      throw new Error(`[registry] unknown event: ${event}`);
    }
    if (map.has(reg.name)) {
      throw new Error(
        `[registry] duplicate registration: ${event}/${reg.name}`,
      );
    }
    map.set(reg.name, reg);
  }

  seal(): SealedRegistry {
    return new SealedRegistry(this.byEvent);
  }
}

/**
 * Read-only phase of the registry.
 *
 * Has no register() — post-construction mutation is a compile error.
 * metadataFor() reads from a snapshot built once at seal() time, so the view
 * is referentially transparent and can't drift from runtime dispatch.
 */
export class SealedRegistry {
  private readonly byEvent: ReadonlyMap<
    HookEvent,
    ReadonlyMap<string, CheckRegistration>
  >;
  private readonly metadataCache: ReadonlyMap<
    HookEvent,
    readonly CheckMetadata[]
  >;

  constructor(byEvent: Map<HookEvent, Map<string, CheckRegistration>>) {
    this.byEvent = byEvent;
    this.metadataCache = new Map(
      [...byEvent.entries()].map(([event, regs]) => [
        event,
        [...regs.values()].map(({ description, canBlock, profiles }) => ({
          description,
          canBlock,
          profiles,
        })),
      ]),
    );
  }

  checksFor(event: HookEvent): ReadonlyMap<string, CheckRegistration> {
    return this.byEvent.get(event) ?? new Map();
  }

  metadataFor(event: HookEvent): readonly CheckMetadata[] {
    return this.metadataCache.get(event) ?? [];
  }

  /** Per-event blocking-check names — used by --check=NAME security gate. */
  blockingNamesFor(event: HookEvent): readonly string[] {
    const out: string[] = [];
    for (const reg of this.checksFor(event).values()) {
      if (reg.canBlock) out.push(reg.name);
    }
    return out;
  }
}
