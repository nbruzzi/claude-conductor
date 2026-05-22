// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Meta-test — anti-drift assertions for the 20 bundled discipline checks
 * (Phase 1: 18; Phase 2 Slice 5 added identity-injector → 19; Phase 2
 * Slice 6 added task-coordinator → 20).
 *
 * Replaces the per-component-stub approach (one stub per check) with a single
 * iteration over `BUNDLED_CHECKS_BY_EVENT` that builds a fresh
 * `RegistryBuilder<BundledCheckName>`, calls `registerBundled`, seals, and
 * asserts (event, name) tuples + count + duplicates + bidirectional set
 * equality. Single source of truth; automatic on bundle changes.
 *
 * Imports are relative — `BUNDLED_CHECKS_BY_EVENT` is exported from plugin's
 * `package.json` exports map (`./hooks/bundled-check-names`) for external
 * consumers (dotfiles will compose AllCheckNames at reconciliation time),
 * but in-plugin code uses relative paths.
 *
 * --- Deferred-copy semantics (cross-repo drift) ---
 *
 * Plugin's `src/hooks/checks/bundled-registrations.ts` is currently a COPY of
 * the dotfiles canonical at `~/.claude-dotfiles/src/hooks/checks/
 * bundled-registrations.ts`. The cross-edge to `active-sessions/index.ts`
 * blocks shimming the registrations file in batch 5 (memory
 * `feedback-cross-edge-module-state-audit.md`).
 *
 * This meta-test pins drift WITHIN the plugin copy (typo in plugin's
 * registration → fails in plugin's CI). It does NOT catch dotfiles canonical
 * adding a 19th bundled check while plugin's copy stays at 18 (cross-repo
 * divergence; plugin self-consistent but stale).
 *
 * The cross-repo assertion below (commented out) is the durable fix; it
 * activates when plugin's `bundled-registrations.ts` becomes the canonical
 * via active-sessions cluster shim closure.
 *
 * TODO(0.8 / batch-5-closure): uncomment the cross-repo assertion block once
 * plugin canonical-flips for `bundled-registrations.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  BUNDLED_CHECKS_BY_EVENT,
  BUNDLED_CHECK_NAMES,
  type BundledCheckName,
} from "../../src/hooks/bundled-check-names.ts";
import { RegistryBuilder } from "../../src/hooks/registry.ts";
import { registerBundled } from "../../src/hooks/checks/bundled-registrations.ts";
import { pass } from "../../src/hooks/types.ts";
import type { HookEvent } from "../../src/hooks/types.ts";

// Phase 3 Slice 2 — bumped from 22 to 25 with 3 new bundled hook checks
// (dotfiles-worktree-provisioner, dotfiles-worktree-gc on session-start,
// dotfiles-worktree-cleanup on stop). REV 0.2 ARCH-4 fix re-targets the
// atomic-wiring count assertion from registry-primitives.test.ts (which
// uses synthetic fixtures and never loads bundled-registrations) to this
// file, where EXPECTED_COUNT actually pins production state.
//
// CI verification cycle (TIER 2/3/3a/4) — bumped from 25 to 29 with 4 new
// bundled hook checks (ci-verification-pre-push-arm on pre-tool-use,
// ci-verification-reminder on post-tool-use, ci-verification-gate on stop,
// ci-verification-auth-warn on session-start). Plan ~/.claude/plans/typed-sleeping-snowglobe.md.
//
// Cluster 1 of INVERSIONS arc (2026-05-07) — 9 universal-coding-discipline
// checks moved plugin → substrate (auto-format, branch-enforcement,
// destructive-cmd, no-any, no-enum, pre-commit, prefer-bun, sensitive-files,
// test-gate); count drops 29 → 20. Plan ~/.claude/plans/cluster-1-universal-discipline.md.
//
// Cluster 2 of INVERSIONS arc (2026-05-07) — 4 CI verification protocol checks
// moved plugin → substrate (ci-verification-{auth-warn,gate,pre-push-arm,reminder});
// count drops 20 → 16. Plan ~/.claude/plans/cluster-2-ci-verification.md.
//
// Cluster 5 of INVERSIONS arc (2026-05-07; FINAL CLUSTER — ARC COMPLETE 21/21) —
// config-protection moved plugin → substrate (with config-protection-cli +
// config-protection-store utility modules); count drops 13 → 12. Plan
// ~/.claude/plans/cluster-5-config-protection.md.
//
// Phase 4 Step A Layer 1 (2026-05-14) — peer-message-deliverer hook added to
// user-prompt-submit event; count rises 11 → 12. Plan
// ~/.claude/plans/eventual-marinating-wall.md v5 §Phase 1.
//
// Stream 3 Slice 2 of generic-worktree-provisioner RFC (2026-05-19) —
// `repo-worktree-provisioner` hook added to session-start event; count
// rises 12 → 13. Plan ~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md
// v0.2 §Phasing Slice 2.
//
// Stream 3 Slice 3 of generic-worktree-provisioner RFC (2026-05-19) —
// `repo-worktree-gc` hook added to session-start event; count rises
// 13 → 14. Same plan v0.2 §Phasing Slice 3.
//
// T4-X3 cycle 2026-05-22 — `pattern-trace-auto-propose` Stop hook added
// (Tier 4 (a) composition primitive: pattern-trace × memory-proposal).
// Count rises 15 → 16. Plan: T4-X3 v0.2 + Alpha plan-tier audit RATIFY-
// WITH-FOLDS 4/4 @ 15:20Z.
const EXPECTED_COUNT = 16;

/** TA-9 fold (Phase 4 Step A Layer 1 audit): explicit-presence pin for
 *  `peer-message-deliverer` on `user-prompt-submit` event. Sibling-shape
 *  to the worktree-trio + identity-injector / channels-gc-reaper presence
 *  assertions below. A future regression that removes peer-message-deliverer
 *  from BUNDLED_CHECKS_BY_EVENT (or swaps it for a different name while
 *  preserving the count) must touch this assertion too. */
const PHASE_4_STEP_A_L1_USER_PROMPT_SUBMIT_CHECK = "peer-message-deliverer";

describe("bundled-registrations meta-test", () => {
  it("BUNDLED_CHECK_NAMES has exactly EXPECTED_COUNT entries", () => {
    expect(BUNDLED_CHECK_NAMES.length).toBe(EXPECTED_COUNT);
  });

  it("BUNDLED_CHECK_NAMES has no duplicates", () => {
    expect(new Set(BUNDLED_CHECK_NAMES).size).toBe(EXPECTED_COUNT);
  });

  it("BUNDLED_CHECK_NAMES is the flattened concatenation of BUNDLED_CHECKS_BY_EVENT", () => {
    const flatFromMap = Object.values(BUNDLED_CHECKS_BY_EVENT).flat();
    expect(BUNDLED_CHECK_NAMES.length).toBe(flatFromMap.length);
    expect(new Set(BUNDLED_CHECK_NAMES)).toEqual(new Set(flatFromMap));
  });

  it("registerBundled produces a sealed registry whose (event, name) tuples match BUNDLED_CHECKS_BY_EVENT", () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    registerBundled(builder);
    const sealed = builder.seal();

    for (const [event, expectedNames] of Object.entries(
      BUNDLED_CHECKS_BY_EVENT,
    )) {
      const registeredAtEvent = sealed.checksFor(event as HookEvent);
      const actualNames = [...registeredAtEvent.values()].map((r) => r.name);
      expect(new Set(actualNames)).toEqual(new Set(expectedNames));
      expect(actualNames.length).toBe(expectedNames.length);
    }
  });

  it("registerBundled total count equals BUNDLED_CHECK_NAMES.length", () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    registerBundled(builder);
    const sealed = builder.seal();

    let totalRegistered = 0;
    for (const event of Object.keys(BUNDLED_CHECKS_BY_EVENT) as HookEvent[]) {
      totalRegistered += sealed.checksFor(event).size;
    }
    expect(totalRegistered).toBe(EXPECTED_COUNT);
  });

  it("registerBundled produces no duplicate names across all events (bidirectional set equality)", () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    registerBundled(builder);
    const sealed = builder.seal();

    const allRegisteredNames: string[] = [];
    for (const event of Object.keys(BUNDLED_CHECKS_BY_EVENT) as HookEvent[]) {
      for (const reg of sealed.checksFor(event).values()) {
        allRegisteredNames.push(reg.name);
      }
    }

    expect(new Set(allRegisteredNames).size).toBe(allRegisteredNames.length);
    expect(new Set(allRegisteredNames)).toEqual(new Set(BUNDLED_CHECK_NAMES));
  });

  // Phase 3 Slice 2 — REV 0.2 ARCH-4 sibling-parity assertions for the
  // 3 new hook checks. Per Bravo lens-audit (a): each new hook contributes
  // 5 dotfiles-side surface entries (shim + check-names + bundled-
  // registrations + ORDER + count-test toContain) AND 4 plugin-side
  // entries (the check itself + check-names + bundled-registrations +
  // exports map). The toContain assertions below pin the bundled-check-
  // names side; the dotfiles-lane registry test pins the sibling parity
  // when Bravo's lane lands.
  it("Phase 3 Slice 2 — provisioner registered on session-start", () => {
    const names = BUNDLED_CHECKS_BY_EVENT["session-start"];
    expect(names).toContain("dotfiles-worktree-provisioner");
  });

  it("Phase 3 Slice 2 — gc reaper registered on session-start", () => {
    const names = BUNDLED_CHECKS_BY_EVENT["session-start"];
    expect(names).toContain("dotfiles-worktree-gc");
  });

  it("Phase 4 Step A Layer 1 — peer-message-deliverer registered on user-prompt-submit", () => {
    const names = BUNDLED_CHECKS_BY_EVENT["user-prompt-submit"];
    expect(names).toContain(PHASE_4_STEP_A_L1_USER_PROMPT_SUBMIT_CHECK);
  });

  // dotfiles-worktree-cleanup test removed in cycle-3 fix (channel
  // 2026-05-08_02-15) — cleanup hook removed; teardown now happens
  // exclusively via dotfiles-worktree-gc reaper at next session-start.
  // Stop-event fires per-turn (not session-end) and the cleanup hook
  // had no session-end discrimination, so it destroyed the worktree
  // after the first turn-end Stop, defeating per-session isolation.

  // CI verification cycle (TIER 2/3/3a/4) — Cluster 2 of INVERSIONS arc 2026-05-07
  // moved these 4 names to substrate; belt-and-suspenders assertions removed
  // because the names no longer live in BUNDLED_CHECKS_BY_EVENT. Disjointness
  // invariant locked by `cluster-2-removed.test.ts`.

  // TA-3 PARTIAL fix — pin narrowing at compile time, not just runtime.
  // These blocks verify the type-level guarantees of
  // `RegistryBuilder<BundledCheckName>`. They ride along as runtime no-ops;
  // the assertion is at typecheck time via @ts-expect-error.
  it("type-test — RegistryBuilder<BundledCheckName> rejects non-bundled names at compile time", async () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    const noopFn = async () => pass();

    // Positive: registering a known bundled name compiles.
    builder.register("pre-tool-use", {
      name: "session-collision-gate",
      fn: noopFn,
      description: "test",
      canBlock: false,
      profiles: ["standard"],
    });

    // Negative: typo'd name fails at compile time.
    builder.register("pre-tool-use", {
      // @ts-expect-error - typo'd name "fact-forcce" is not in BundledCheckName
      name: "fact-forcce",
      fn: noopFn,
      description: "test",
      canBlock: false,
      profiles: ["standard"],
    });

    // Negative: non-bundled name fails at compile time (e.g., a dotfiles-only
    // name like "intent-gate").
    builder.register("pre-tool-use", {
      // @ts-expect-error - "intent-gate" is dotfiles-only, not bundled
      name: "intent-gate",
      fn: noopFn,
      description: "test",
      canBlock: false,
      profiles: ["standard"],
    });

    // Runtime sanity — at least the positive registration landed.
    expect(builder.seal().checksFor("pre-tool-use").size).toBeGreaterThan(0);
  });

  // TODO(0.8 / batch-5-closure): cross-repo assertion — uncomment once
  // plugin's bundled-registrations.ts becomes the canonical (currently a
  // copy; dotfiles holds canonical due to active-sessions cross-edge).
  //
  // The assertion below would import dotfiles' check-names.ts
  // ALL_CHECK_NAMES, filter to the bundled-18 subset (lines 13-35 of that
  // file's ALL_CHECK_NAMES `as const` array), and assert set-equality with
  // plugin's BUNDLED_CHECK_NAMES. Cross-repo coupling is intentional at
  // closure time — the goal is plugin's BUNDLED_CHECK_NAMES being the
  // single source of truth, with dotfiles importing it.
  //
  // it("BUNDLED_CHECK_NAMES matches dotfiles canonical bundled-18 subset", () => {
  //   import { ALL_CHECK_NAMES } from "<dotfiles>/src/hooks/check-names.ts";
  //   const dotfilesBundled = ALL_CHECK_NAMES.slice(0, 18); // first 18 are bundled by convention
  //   expect(new Set(BUNDLED_CHECK_NAMES)).toEqual(new Set(dotfilesBundled));
  // });
});
