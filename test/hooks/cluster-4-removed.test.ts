// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cluster 4 of INVERSIONS arc (2026-05-07) — substrate-canonical disjointness invariant.
 *
 * Locks the architectural state: handoff-latest-guard + handoff-symlink-write-guard
 * are SUBSTRATE-CANONICAL — they live in `~/.claude-dotfiles/src/hooks/checks/`,
 * NOT in plugin's BUNDLED_CHECK_NAMES.
 *
 * Per Cluster 2 v1.3 ARCH-V1.2-MAJOR-3 option-a: presence/shape-only — no count-lock.
 *
 * Mirrors substrate-side `cluster-4-substrate-canonical.test.ts`. Both tests must
 * pass for the substrate-canonical state to hold.
 *
 * Reference:
 * - Plan: `~/.claude/plans/cluster-4-handoff-invariants.md`
 * - Recon: `~/.claude/notes/cluster-4-handoff-invariants-recon-2026-05-07.md`
 * - Sibling-precedent: `cluster-3-removed.test.ts`
 */

import { describe, expect, it } from "bun:test";

import { BUNDLED_CHECK_NAMES } from "../../src/hooks/bundled-check-names.ts";

const CLUSTER_4_NAMES = [
  "handoff-latest-guard",
  "handoff-symlink-write-guard",
] as const;

describe("Cluster 4 plugin-removal: 2 handoff invariant gates absent from BUNDLED_CHECK_NAMES", () => {
  it("BUNDLED_CHECK_NAMES contains none of the cluster-4 names (disjointness invariant)", () => {
    const bundledSet = new Set<string>(BUNDLED_CHECK_NAMES);
    for (const clusterName of CLUSTER_4_NAMES) {
      expect(bundledSet.has(clusterName)).toBe(false);
    }
  });
});
