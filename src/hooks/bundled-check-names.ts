// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Source-of-truth for the 13 multi-instance-coordination-machinery checks
 * the plugin bundles, organized by hook event.
 *
 * Cluster 1 of INVERSIONS arc (2026-05-07): 9 universal-coding-discipline
 * checks moved to substrate.
 *
 * Cluster 2 of INVERSIONS arc (2026-05-07): 4 CI verification protocol checks
 * moved to substrate — single-session enforcement, not multi-instance coordination.
 *
 * Cluster 3 of INVERSIONS arc (2026-05-07): fact-force gate moved to substrate
 * (with fact-force-scope-cli + fact-force-scope-store support files) — within-session
 * read-before-write state, not multi-instance coordination. Plugin retains only
 * multi-instance coordination machinery (channels, sessions, handoffs, worktrees,
 * config-protection).
 *
 * Two derived shapes:
 * - `BundledCheckName` — closed string-literal union of all 13 names.
 * - `BUNDLED_CHECK_NAMES` — flat readonly array (use `Object.values`-flat
 *   over `BUNDLED_CHECKS_BY_EVENT` so the array stays in sync with the map
 *   automatically).
 *
 * Anti-drift discipline: `test/hooks/bundled-registrations.test.ts` builds a
 * fresh `RegistryBuilder<BundledCheckName>`, calls `registerBundled`, seals,
 * and asserts (event, name) tuple-equality + duplicate-detection +
 * length-pinned (=13) + bidirectional set-equality between this map and the
 * sealed-registry contents. A typo'd registration name fails at compile time
 * via the generic narrowing in `RegistryBuilder<BundledCheckName>` — no
 * runtime check needed for that class. The meta-test catches event-bucket
 * mismatches (e.g., a check moved from pre-tool-use to post-tool-use with
 * BUNDLED_CHECKS_BY_EVENT not updated to match) and miscounts.
 *
 * Architectural invariant: cluster-1 + cluster-2 + cluster-3 names MUST NOT
 * appear in this map. Locked by `test/hooks/cluster-1-removed.test.ts` +
 * `test/hooks/cluster-2-removed.test.ts` + `test/hooks/cluster-3-removed.test.ts`
 * (substrate-canonical disjointness invariant).
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
    "config-protection",
    "task-coordinator",
  ],
  "post-tool-use": [],
  stop: ["session-presence-unregister", "dotfiles-worktree-cleanup"],
  "session-start": [
    "channel-gc",
    "channels-gc-reaper",
    "active-channels-load",
    "session-presence-register",
    "identity-injector",
    "dotfiles-worktree-provisioner",
    "dotfiles-worktree-gc",
  ],
  "user-prompt-submit": ["teammate-idle-reminder"],
} as const satisfies Record<HookEvent, readonly string[]>;

export type BundledCheckName =
  (typeof BUNDLED_CHECKS_BY_EVENT)[HookEvent][number];

export const BUNDLED_CHECK_NAMES: readonly BundledCheckName[] = Object.values(
  BUNDLED_CHECKS_BY_EVENT,
).flat();
