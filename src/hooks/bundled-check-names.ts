// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Source-of-truth for the 18 generic discipline-as-code checks the plugin
 * bundles, organized by hook event.
 *
 * Two derived shapes:
 * - `BundledCheckName` — closed string-literal union of all 18 names.
 * - `BUNDLED_CHECK_NAMES` — flat readonly array (use `Object.values`-flat
 *   over `BUNDLED_CHECKS_BY_EVENT` so the array stays in sync with the map
 *   automatically).
 *
 * Anti-drift discipline: `test/hooks/bundled-registrations.test.ts` builds a
 * fresh `RegistryBuilder<BundledCheckName>`, calls `registerBundled`, seals,
 * and asserts (event, name) tuple-equality + duplicate-detection +
 * length-pinned (=18) + bidirectional set-equality between this map and the
 * sealed-registry contents. A typo'd registration name fails at compile time
 * via the generic narrowing in `RegistryBuilder<BundledCheckName>` — no
 * runtime check needed for that class. The meta-test catches event-bucket
 * mismatches (e.g., a check moved from pre-tool-use to post-tool-use with
 * BUNDLED_CHECKS_BY_EVENT not updated to match) and miscounts.
 *
 * Cross-repo drift: plugin's `bundled-registrations.ts` is currently a copy
 * (canonical lives in dotfiles per the deferred-shim cross-edge to
 * `active-sessions/index.ts` — see TODO(0.8 / batch-5-closure) tags in the
 * meta-test). The 18 names here pin the plugin copy; if dotfiles canonical
 * adds a 19th bundled check before batch-5 closure, the plugin copy stays
 * self-consistent but diverges from production. Closure unblocks at sub-step
 * 0.6-followup when active-sessions/index.ts is shimmed.
 *
 * `as const satisfies Record<HookEvent, readonly string[]>` — the satisfies
 * clause preserves known-key narrowing under `noUncheckedIndexedAccess`
 * while the `as const` keeps the literal-union derivation working (per the
 * matching pattern memory).
 */

import type { HookEvent } from "./types.ts";

export const BUNDLED_CHECKS_BY_EVENT = {
  "pre-tool-use": [
    "session-collision-gate",
    "handoff-symlink-write-guard",
    "fact-force",
    "branch-enforcement",
    "destructive-cmd",
    "prefer-bun",
    "pre-commit",
    "config-protection",
    "sensitive-files",
  ],
  "post-tool-use": ["auto-format", "no-any", "no-enum"],
  stop: ["test-gate", "handoff-latest-guard", "session-presence-unregister"],
  "session-start": [
    "channel-gc",
    "active-channels-load",
    "session-presence-register",
    "identity-injector",
  ],
  "user-prompt-submit": [],
} as const satisfies Record<HookEvent, readonly string[]>;

export type BundledCheckName =
  (typeof BUNDLED_CHECKS_BY_EVENT)[HookEvent][number];

export const BUNDLED_CHECK_NAMES: readonly BundledCheckName[] = Object.values(
  BUNDLED_CHECKS_BY_EVENT,
).flat();
