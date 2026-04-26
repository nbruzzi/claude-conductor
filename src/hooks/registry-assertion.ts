// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Boot-time wiring assertion for the dual-registry contract.
 *
 * Runs after RegistryBuilder.seal() and before any handler dispatches.
 *
 * Bidirectional check:
 *   A) Every ORDER entry resolves to a registered check (covers typos,
 *      missing register module calls, renamed checks).
 *   B) Every registered check with `canBlock: true` appears in some ORDER
 *      list for its event (security invariant — a blocking check that's
 *      registered but unwired is a silent disarm).
 *
 * Non-blocking checks may be deliberately registered-but-unwired (surfaced
 * via --list); blocking checks NEVER may be silently unwired.
 *
 * All errors accumulate before fail-CLOSED — operator gets one round-trip,
 * not N round-trips for N misses (per RE-9).
 *
 * Plugin-side: takes `allOrders` as a parameter. Dotfiles owns the ORDER
 * files (./handlers/*.order.ts) and constructs ALL_ORDERS at its own
 * dispatcher boot, then passes it in. This keeps Nick-specific handler
 * topology in dotfiles while the assertion logic lives in the plugin.
 */

import { HOOK_EVENTS, type HookEvent } from "./types.ts";
import type { OrderEntry, SealedRegistry } from "./registry.ts";

export function assertWiringComplete(
  registry: SealedRegistry,
  allOrders: Record<HookEvent, readonly OrderEntry[]>,
): void {
  const errors: string[] = [];

  for (const event of HOOK_EVENTS) {
    const order = allOrders[event];
    const registered = registry.checksFor(event);

    // Direction A: every ORDER entry resolves to a registration.
    for (const entry of order) {
      if (!registered.has(entry.name)) {
        errors.push(
          `${event} ORDER references unregistered check: ${entry.name}`,
        );
      }
    }

    // Direction B: every blocking registration appears in this event's ORDER.
    const orderNames = new Set(order.map((e) => e.name));
    for (const reg of registered.values()) {
      if (reg.canBlock && !orderNames.has(reg.name)) {
        errors.push(
          `${event} blocking check NOT in ORDER (silent disarm risk): ${reg.name}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error(
      `[registry] wiring incomplete:\n  - ${errors.join("\n  - ")}`,
    );
    failBoot();
  }
}

/** Explicit `: never` so TypeScript narrows correctly at call sites. */
function failBoot(): never {
  process.exit(2);
}
