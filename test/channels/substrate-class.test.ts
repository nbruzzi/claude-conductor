// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for substrate-class PR detection at
 * `src/channels/substrate-class.ts`.
 *
 * Pinning convention per
 * `feedback-cross-edge-contract-via-paired-tests.md` (structurally
 * analogous to `test/channels/boundary-errors.test.ts`):
 *   - Asserts the helper recognizes the canonical substrate-class repo
 *     (`nbruzzi/claude-conductor`) AND correctly rejects non-substrate
 *     repos (dashboard, dotfiles, arbitrary).
 *   - Asserts the SUBSTRATE_CLASS_REPOS const set is exported + has
 *     the documented membership.
 *
 * Consumer-side: `src/channels/cli.ts` send-time validator gates
 * audit-verdict bodies on substrate-class PRs via this helper; the
 * cross-edge contract is exercised end-to-end by the audit-verdict
 * parser tests at `test/channels/audit-verdict.test.ts`
 * (cross_edge_consumers_verified field round-trip + negative-shape).
 */
import { describe, expect, it } from "bun:test";

import {
  isSubstrateClassPR,
  SUBSTRATE_CLASS_REPOS,
} from "../../src/channels/substrate-class.ts";

describe("SUBSTRATE_CLASS_REPOS const set", () => {
  it("exports the canonical set containing nbruzzi/claude-conductor", () => {
    expect(SUBSTRATE_CLASS_REPOS.has("nbruzzi/claude-conductor")).toBe(true);
  });

  it("does NOT include the consumer dashboard repo (consumer-side, not substrate)", () => {
    expect(
      SUBSTRATE_CLASS_REPOS.has("nbruzzi/claude-conductor-dashboard"),
    ).toBe(false);
  });

  it("does NOT include the dotfiles repo (defaults to non-substrate at v0.1)", () => {
    expect(SUBSTRATE_CLASS_REPOS.has("nbruzzi/claude-dotfiles")).toBe(false);
  });

  it("is a Set instance (caller-enumerable)", () => {
    expect(SUBSTRATE_CLASS_REPOS instanceof Set).toBe(true);
  });
});

describe("isSubstrateClassPR helper", () => {
  it("returns true for nbruzzi/claude-conductor PRs", () => {
    expect(
      isSubstrateClassPR({ repo: "nbruzzi/claude-conductor", number: 119 }),
    ).toBe(true);
  });

  it("returns false for nbruzzi/claude-conductor-dashboard PRs", () => {
    expect(
      isSubstrateClassPR({
        repo: "nbruzzi/claude-conductor-dashboard",
        number: 38,
      }),
    ).toBe(false);
  });

  it("returns false for nbruzzi/claude-dotfiles PRs", () => {
    expect(
      isSubstrateClassPR({ repo: "nbruzzi/claude-dotfiles", number: 146 }),
    ).toBe(false);
  });

  it("returns false for an arbitrary unknown repo", () => {
    expect(
      isSubstrateClassPR({ repo: "some-org/unrelated-repo", number: 1 }),
    ).toBe(false);
  });

  it("returns false for empty repo string (defensive)", () => {
    expect(isSubstrateClassPR({ repo: "", number: 1 })).toBe(false);
  });

  it("is PR-number agnostic — only the repo signal matters", () => {
    // Detection MUST NOT depend on PR number; same repo with different
    // numbers ALWAYS produces the same answer.
    const r1 = isSubstrateClassPR({
      repo: "nbruzzi/claude-conductor",
      number: 1,
    });
    const r99999 = isSubstrateClassPR({
      repo: "nbruzzi/claude-conductor",
      number: 99999,
    });
    expect(r1).toBe(true);
    expect(r99999).toBe(true);
    expect(r1).toBe(r99999);
  });

  // Canonical-normalization regression coverage. Bravo L3 on PR #121
  // dogfood caught that v0.1 stored only the GitHub-prefixed shape but
  // canonical wire shape across actual audit-verdict send sites is bare
  // `"claude-conductor"` (cross-cohort empirical: 13+ audit-verdicts on
  // cycle 2026-05-25 all sent bare). v0.1.1 stores both shapes; future
  // sends in either form resolve identically.
  it("returns true for the bare canonical repo shape (claude-conductor)", () => {
    expect(isSubstrateClassPR({ repo: "claude-conductor", number: 119 })).toBe(
      true,
    );
  });

  it("returns true regardless of which shape the caller sends (parity)", () => {
    const bare = isSubstrateClassPR({ repo: "claude-conductor", number: 120 });
    const prefixed = isSubstrateClassPR({
      repo: "nbruzzi/claude-conductor",
      number: 120,
    });
    expect(bare).toBe(true);
    expect(prefixed).toBe(true);
    expect(bare).toBe(prefixed);
  });

  it("returns false for partial-match-but-non-substrate suffix (e.g., bare claude-conductor-dashboard)", () => {
    // Defends against accidental over-inclusion: 'claude-conductor-dashboard'
    // is NOT a substrate-class repo even though it shares a prefix with
    // the substrate name. Set-membership is exact-match; no substring shape.
    expect(
      isSubstrateClassPR({ repo: "claude-conductor-dashboard", number: 38 }),
    ).toBe(false);
    expect(
      isSubstrateClassPR({
        repo: "nbruzzi/claude-conductor-dashboard",
        number: 38,
      }),
    ).toBe(false);
  });
});

describe("SUBSTRATE_CLASS_REPOS canonical-normalization (v0.1.1 regression coverage)", () => {
  it("includes both bare and GitHub-prefixed shapes for parity", () => {
    expect(SUBSTRATE_CLASS_REPOS.has("claude-conductor")).toBe(true);
    expect(SUBSTRATE_CLASS_REPOS.has("nbruzzi/claude-conductor")).toBe(true);
  });
});
