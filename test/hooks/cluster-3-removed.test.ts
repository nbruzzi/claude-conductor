// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cluster 3 of INVERSIONS arc (2026-05-07) — substrate-canonical disjointness invariant.
 *
 * Locks the architectural state: `fact-force` is SUBSTRATE-CANONICAL — lives in
 * `~/.claude-dotfiles/src/hooks/checks/`, NOT in plugin's BUNDLED_CHECK_NAMES.
 *
 * Per Cluster 2 v1.3 ARCH-V1.2-MAJOR-3 option-a: presence/shape-only — no count-lock.
 *
 * Mirrors substrate-side `cluster-3-substrate-canonical.test.ts`. Both tests must
 * pass for the substrate-canonical state to hold.
 *
 * Reference:
 * - Plan: `~/.claude/plans/cluster-3-fact-force.md`
 * - Recon: `~/.claude/notes/cluster-3-fact-force-recon-2026-05-07.md`
 * - Sibling-precedent: `cluster-2-removed.test.ts`
 */

import { describe, expect, it } from "bun:test";

import { BUNDLED_CHECK_NAMES } from "../../src/hooks/bundled-check-names.ts";

const CLUSTER_3_NAMES = ["fact-force"] as const;

describe("Cluster 3 plugin-removal: fact-force absent from BUNDLED_CHECK_NAMES", () => {
  it("BUNDLED_CHECK_NAMES contains none of the cluster-3 names (disjointness invariant)", () => {
    const bundledSet = new Set<string>(BUNDLED_CHECK_NAMES);
    for (const clusterName of CLUSTER_3_NAMES) {
      expect(bundledSet.has(clusterName)).toBe(false);
    }
  });
});
