// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cluster 2 of INVERSIONS arc (2026-05-07) — substrate-canonical disjointness invariant.
 *
 * Locks the architectural state: the 4 CI verification protocol check names
 * (ci-verification-auth-warn, ci-verification-gate, ci-verification-pre-push-arm,
 * ci-verification-reminder) are SUBSTRATE-CANONICAL — they live in
 * `~/.claude-dotfiles/src/hooks/checks/`, NOT in plugin's BUNDLED_CHECK_NAMES.
 *
 * If a future change re-adds one of these names to plugin's bundled list, that's
 * an architecture inversion (plugin scope creep into single-instance discipline)
 * and this test should fail.
 *
 * Mirrors the substrate-side `__tests__/hooks/cluster-2-substrate-canonical.test.ts`
 * (asserts these files exist locally + bundled-registrations.ts imports them via
 * relative path). Both tests must pass for the substrate-canonical state to hold.
 *
 * Per Cluster 2 v1.3 ARCH-V1.2-MAJOR-3 option-a: presence/shape-only — no count-lock.
 * The count is independently locked by `bundled-registrations.test.ts:EXPECTED_COUNT`.
 * Sibling-parity with substrate-side cluster-N-substrate-canonical.test.ts pattern.
 *
 * Reference:
 * - Plan: `~/.claude/plans/cluster-2-ci-verification.md`
 * - Audit doc §9: `~/.claude/notes/plugin-internals-audit-2026-05-06.md`
 * - Discipline: `feedback-cross-edge-contract-via-paired-tests.md`
 * - Substrate test: `~/.claude-dotfiles/src/__tests__/hooks/cluster-2-substrate-canonical.test.ts`
 * - Sibling-precedent: `cluster-1-removed.test.ts` (Cluster 1 INVERSIONS arc 2026-05-07)
 */

import { describe, expect, it } from "bun:test";

import { BUNDLED_CHECK_NAMES } from "../../src/hooks/bundled-check-names.ts";

const CLUSTER_2_NAMES = [
  "ci-verification-auth-warn",
  "ci-verification-gate",
  "ci-verification-pre-push-arm",
  "ci-verification-reminder",
] as const;

describe("Cluster 2 plugin-removal: 4 CI verification protocol names absent from BUNDLED_CHECK_NAMES", () => {
  it("BUNDLED_CHECK_NAMES contains none of the 4 cluster-2 names (disjointness invariant)", () => {
    const bundledSet = new Set<string>(BUNDLED_CHECK_NAMES);
    for (const clusterName of CLUSTER_2_NAMES) {
      expect(bundledSet.has(clusterName)).toBe(false);
    }
  });
});
