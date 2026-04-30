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
 * Name typing: CheckRegistration / RegistryBuilder / SealedRegistry are
 * generic on `Name extends string = string`. Default = `string` keeps every
 * existing caller (dotfiles' 11 register-module + dispatcher call-sites)
 * working without ripple. Plugin's bundled-registrations.ts narrows via
 * `RegistryBuilder<BundledCheckName>` so registration `name` fields
 * type-check against the closed literal union (see ./bundled-check-names.ts).
 *
 * `CheckMeta.name` (CLI surface) and `OrderEntry.name` (ORDER files) are
 * still `name: string`; their tightening is deferred to a successor sub-step
 * — the productive #10 win for sub-step 0.7 is registration-site narrowing,
 * which is what catches typos at compile time. See `decisions/phase-0.md`
 * Decision E entry for the deferral rationale.
 */

import type {
  HookEvent,
  HookProfile,
  CheckFn,
  KnownToolName,
} from "./types.ts";
import { HOOK_EVENTS } from "./types.ts";

export type { HookProfile, KnownToolName };

export const ALL_PROFILES: HookProfile[] = ["minimal", "standard", "strict"];

export type CheckMeta = {
  /** Check name (used with --check=NAME). */
  name: string;
  /** One-line description shown by --list. */
  description: string;
  /** Tool names this check applies to, or "*" for all tools. */
  tools: KnownToolName | "*";
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
 *
 * Generic on `Name extends string = string`. Default = `string` is the
 * loose-typing path used by every dotfiles register-module today (no ripple
 * from this parametrization). Plugin's bundled-registrations.ts uses
 * `CheckRegistration<BundledCheckName>` via `RegistryBuilder<BundledCheckName>`
 * so registration `name` fields type-check against the closed union.
 */
export type CheckRegistration<Name extends string = string> = {
  name: Name;
  fn: CheckFn;
} & CheckMetadata;

/**
 * Per-event handler policy for one check.
 *
 * `tools` is the closed `KnownToolName` literal-union (sub-step 0.10
 * TS-2 / D7a). A typo like `tools: ["Edti"]` is now a compile error
 * instead of a runtime no-op. `name: string` remains broad — Decision E
 * in `decisions/phase-0.md` retains it; the win there composes
 * separately when `CheckName` is tightened cross-repo.
 */
export type OrderEntry = {
  name: string;
  earlyReturn: "on-block" | "on-output" | "never";
  silent?: boolean;
  tools?: readonly KnownToolName[];
};

/**
 * Mutable phase of the registry. Use during boot; transition to SealedRegistry
 * via .seal() before any handler reads.
 *
 * Generic on `Name extends string = string`. Default = `string` keeps every
 * existing caller working without explicit type argument. Plugin's
 * `registerBundled` narrows via `RegistryBuilder<BundledCheckName>` so
 * registration name fields type-check against the closed literal union.
 */
export class RegistryBuilder<Name extends string = string> {
  private readonly byEvent: Map<
    HookEvent,
    Map<string, CheckRegistration<Name>>
  >;

  constructor() {
    this.byEvent = new Map(HOOK_EVENTS.map((event) => [event, new Map()]));
  }

  register(event: HookEvent, reg: CheckRegistration<Name>): void {
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

  seal(): SealedRegistry<Name> {
    return new SealedRegistry<Name>(this.byEvent);
  }
}

/**
 * Read-only phase of the registry.
 *
 * Has no register() — post-construction mutation is a compile error.
 * metadataFor() reads from a snapshot built once at seal() time, so the view
 * is referentially transparent and can't drift from runtime dispatch.
 *
 * Generic on `Name extends string = string`. Carries the narrowing from
 * RegistryBuilder so checksFor() returns CheckRegistration<Name> entries —
 * narrowed consumers (e.g., the bundled-registrations meta-test) see
 * literal-union name typing without any `as`-cast.
 */
export class SealedRegistry<Name extends string = string> {
  private readonly byEvent: ReadonlyMap<
    HookEvent,
    ReadonlyMap<string, CheckRegistration<Name>>
  >;
  private readonly metadataCache: ReadonlyMap<
    HookEvent,
    readonly CheckMetadata[]
  >;

  constructor(byEvent: Map<HookEvent, Map<string, CheckRegistration<Name>>>) {
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

  checksFor(event: HookEvent): ReadonlyMap<string, CheckRegistration<Name>> {
    return this.byEvent.get(event) ?? new Map();
  }

  metadataFor(event: HookEvent): readonly CheckMetadata[] {
    return this.metadataCache.get(event) ?? [];
  }

  /** Per-event blocking-check names — used by --check=NAME security gate. */
  blockingNamesFor(event: HookEvent): readonly Name[] {
    const out: Name[] = [];
    for (const reg of this.checksFor(event).values()) {
      if (reg.canBlock) out.push(reg.name);
    }
    return out;
  }

  /**
   * Full union of registered check names across all events.
   *
   * Phase 3 Slice 1 primitive — consumed by the `dispatcher-kill-switch`
   * parser (`src/shared/disable-hooks.ts`) for `CLAUDE_CONDUCTOR_DISABLE_HOOKS`
   * env-var validation. Lifted to plugin per TS-2 audit finding (V2
   * anticipation pattern from `feedback-partial-v2-anticipation-primitives.md`)
   * so the dotfiles dispatcher consumes one primitive instead of iterating
   * `HOOK_EVENTS` and unioning per-event names ad-hoc.
   *
   * A check registered for multiple events appears once in the returned
   * Set (deduped).
   */
  allCheckNames(): ReadonlySet<Name> {
    const out = new Set<Name>();
    for (const event of HOOK_EVENTS) {
      for (const reg of this.checksFor(event).values()) {
        out.add(reg.name);
      }
    }
    return out;
  }

  /**
   * Full union of blocking-check names (canBlock=true) across all events.
   *
   * Phase 3 Slice 1 primitive — consumed by the dispatcher-kill-switch
   * parser to format the louder warning when an operator env-disables a
   * blocking hook. Sibling to `allCheckNames` and `blockingNamesFor`.
   */
  allBlockingNames(): ReadonlySet<Name> {
    const out = new Set<Name>();
    for (const event of HOOK_EVENTS) {
      for (const reg of this.checksFor(event).values()) {
        if (reg.canBlock) out.add(reg.name);
      }
    }
    return out;
  }

  /**
   * Map: check name → events the check is registered for.
   *
   * Phase 3 Slice 1 primitive — consumed by the dispatcher-kill-switch
   * parser's cross-event hint logic. When an operator lists a hook name
   * that's valid in the registry but doesn't run on the dispatcher's
   * current event, the parser surfaces the actual events via
   * `cross_event` so the operator knows when the disable will apply.
   *
   * A check registered for multiple events has all its events listed.
   * The order of events follows `HOOK_EVENTS` (lifecycle order:
   * pre-tool-use, post-tool-use, stop, session-start, user-prompt-submit).
   */
  nameToEvents(): ReadonlyMap<Name, readonly HookEvent[]> {
    const out = new Map<Name, HookEvent[]>();
    for (const event of HOOK_EVENTS) {
      for (const reg of this.checksFor(event).values()) {
        const events = out.get(reg.name);
        if (events === undefined) {
          out.set(reg.name, [event]);
        } else {
          events.push(event);
        }
      }
    }
    return out;
  }
}
