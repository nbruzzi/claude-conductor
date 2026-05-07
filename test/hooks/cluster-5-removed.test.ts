// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cluster 5 of INVERSIONS arc (2026-05-07; FINAL CLUSTER — ARC COMPLETE 21/21) —
 * substrate-canonical disjointness invariant.
 *
 * Locks the architectural state: config-protection is SUBSTRATE-CANONICAL —
 * it lives in `~/.claude-dotfiles/src/hooks/checks/`, NOT in plugin's
 * BUNDLED_CHECK_NAMES.
 *
 * Note: Only `config-protection` is registered in BUNDLED_CHECK_NAMES;
 * `config-protection-cli` and `config-protection-store` are utility modules
 * never registered as hook checks (same pattern as Cluster 3 fact-force
 * /fact-force-scope-cli/fact-force-scope-store).
 *
 * Per Cluster 2 v1.3 ARCH-V1.2-MAJOR-3 option-a: presence/shape-only — no count-lock.
 *
 * Mirrors substrate-side `cluster-5-substrate-canonical.test.ts`. Both tests must
 * pass for the substrate-canonical state to hold.
 *
 * Reference:
 * - Plan: `~/.claude/plans/cluster-5-config-protection.md`
 * - Recon: `~/.claude/notes/cluster-5-config-protection-recon-2026-05-07.md`
 * - Sibling-precedent: `cluster-4-removed.test.ts`
 */

import { describe, expect, it } from "bun:test";

import { BUNDLED_CHECK_NAMES } from "../../src/hooks/bundled-check-names.ts";

const CLUSTER_5_NAMES = ["config-protection"] as const;

describe("Cluster 5 plugin-removal: config-protection absent from BUNDLED_CHECK_NAMES (FINAL CLUSTER OF INVERSIONS ARC)", () => {
  it("BUNDLED_CHECK_NAMES contains none of the cluster-5 names (disjointness invariant)", () => {
    const bundledSet = new Set<string>(BUNDLED_CHECK_NAMES);
    for (const clusterName of CLUSTER_5_NAMES) {
      expect(bundledSet.has(clusterName)).toBe(false);
    }
  });
});
