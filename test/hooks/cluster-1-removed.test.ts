// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cluster 1 of INVERSIONS arc (2026-05-07) — substrate-canonical disjointness invariant.
 *
 * Locks the architectural state: the 9 universal-coding-discipline check names
 * (auto-format, branch-enforcement, destructive-cmd, no-any, no-enum, pre-commit,
 * prefer-bun, sensitive-files, test-gate) are SUBSTRATE-CANONICAL — they live
 * in `~/.claude-dotfiles/src/hooks/checks/`, NOT in plugin's BUNDLED_CHECK_NAMES.
 *
 * If a future change re-adds one of these names to plugin's bundled list, that's
 * an architecture inversion (plugin scope creep into single-instance discipline)
 * and this test should fail.
 *
 * Mirrors the substrate-side `__tests__/hooks/cluster-1-substrate-canonical.test.ts`
 * (asserts these files exist locally + bundled-registrations.ts imports them via
 * relative path). Both tests must pass for the substrate-canonical state to hold.
 *
 * Reference:
 * - Plan: `~/.claude/plans/cluster-1-universal-discipline.md`
 * - Audit doc §9: `~/.claude/notes/plugin-internals-audit-2026-05-06.md`
 * - Discipline: `feedback-cross-edge-contract-via-paired-tests.md`
 * - Substrate test: `~/.claude-dotfiles/src/__tests__/hooks/cluster-1-substrate-canonical.test.ts`
 */

import { describe, expect, it } from "bun:test";

import { BUNDLED_CHECK_NAMES } from "../../src/hooks/bundled-check-names.ts";

const CLUSTER_1_NAMES = [
  "auto-format",
  "branch-enforcement",
  "destructive-cmd",
  "no-any",
  "no-enum",
  "pre-commit",
  "prefer-bun",
  "sensitive-files",
  "test-gate",
] as const;

const EXPECTED_POST_PR2_COUNT = 20;

describe("Cluster 1 plugin-removal: 9 universal-discipline names absent from BUNDLED_CHECK_NAMES", () => {
  it("BUNDLED_CHECK_NAMES contains none of the 9 cluster-1 names (disjointness invariant)", () => {
    const bundledSet = new Set<string>(BUNDLED_CHECK_NAMES);
    for (const clusterName of CLUSTER_1_NAMES) {
      expect(bundledSet.has(clusterName)).toBe(false);
    }
  });

  it("BUNDLED_CHECK_NAMES count is locked at EXPECTED_POST_PR2_COUNT", () => {
    // Was 29 pre-Cluster-1; now 20 (29 − 9). If a future cluster removal happens,
    // this number drops further; if a re-introduction happens, this fails first.
    expect(BUNDLED_CHECK_NAMES.length).toBe(EXPECTED_POST_PR2_COUNT);
  });
});
