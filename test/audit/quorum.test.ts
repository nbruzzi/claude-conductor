// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the multi-persona audit-quorum check (Cycle 4+ enforcement;
 * cohort cycle 2026-05-28 Pair-B Charlie-pen). The SUT is a PURE function
 * over a caller-supplied message set + body-ref map, so these tests build
 * synthetic in-memory fixtures — no filesystem / channel JSONL needed
 * (contrast `verify.test.ts`, which exercises the crypto chain via real
 * key + channel files).
 *
 * Coverage:
 *   1. Quorum met (>=3 lenses across >=2 auditors)
 *   2. Lens-short (N auditors, same single lens) — primary axis fails
 *   3. Auditor-short (one author, N lens-hats) — independence floor fails
 *   4. Self-audit excluded (auditor_identity === target_peer)
 *   5. target_pr filtering (other-PR verdicts ignored)
 *   6. Owner-prefix repo normalization
 *   7. body_ref hydration counted
 *   8. Configurable thresholds
 *   9. Empty / no verdicts
 *  10. Malformed + non-verdict + identity-less messages skipped
 *  11. Human render output
 */

import { describe, expect, it } from "bun:test";
import {
  computeAuditQuorum,
  renderQuorumHuman,
  DEFAULT_MIN_LENSES,
  DEFAULT_MIN_AUDITORS,
} from "../../src/audit/quorum.ts";
import type { AuditVerdictBody } from "../../src/channels/audit-verdict.ts";
import type { ChannelMessage } from "../../src/channels/index.ts";

const EMPTY_BODIES: ReadonlyMap<string, string> = new Map();

function bodyJson(over: Partial<AuditVerdictBody>): string {
  const base: AuditVerdictBody = {
    kind_version: 1,
    target_pr: { repo: "claude-conductor", number: 200 },
    target_peer: "Author",
    lens_set_applied: ["RE"],
    audit_class: "cross-pair-shadow",
    audit_axes: ["surface"],
    verdict: "SHIP-CLEAN",
    counts: { blocker: 0, fold: 0, nit: 0 },
    three_option_ask: {
      a_ratify: "cleared",
      b_fold_if_applicable: null,
      c_reframe_if_applicable: null,
    },
    findings: [],
  };
  return JSON.stringify({ ...base, ...over });
}

function verdictMsg(
  identity: string,
  over: Partial<AuditVerdictBody> = {},
): ChannelMessage {
  return {
    ts: "2026-05-28T13:00:00.000Z",
    from: `session-${identity}`,
    kind: "audit-verdict",
    identity,
    body: bodyJson(over),
  };
}

describe("computeAuditQuorum — defaults sanity", () => {
  it("uses CONTRIBUTING-canonical defaults", () => {
    expect(DEFAULT_MIN_LENSES).toBe(3);
    expect(DEFAULT_MIN_AUDITORS).toBe(2);
  });
});

describe("computeAuditQuorum — conjunction", () => {
  const targetPr = { repo: "claude-conductor", number: 200 };

  it("passes with >=3 lenses across >=2 distinct auditors", () => {
    const messages = [
      verdictMsg("Alpha", { lens_set_applied: ["RE"] }),
      verdictMsg("Bravo", { lens_set_applied: ["Architecture"] }),
      verdictMsg("Delta", { lens_set_applied: ["TA"] }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: targetPr,
    });
    expect(r.ok).toBe(true);
    expect(r.shortfalls).toEqual([]);
    expect(r.distinct_lenses).toEqual(["Architecture", "RE", "TA"]);
    expect(r.distinct_auditors).toEqual(["Alpha", "Bravo", "Delta"]);
    expect(r.verdicts_considered).toBe(3);
  });

  it("FAILS lens-diversity when N auditors apply the same single lens", () => {
    const messages = [
      verdictMsg("Alpha", { lens_set_applied: ["RE"] }),
      verdictMsg("Bravo", { lens_set_applied: ["RE"] }),
      verdictMsg("Delta", { lens_set_applied: ["RE"] }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: targetPr,
    });
    expect(r.ok).toBe(false);
    expect(r.distinct_lenses).toEqual(["RE"]);
    expect(r.distinct_auditors.length).toBe(3);
    expect(r.shortfalls.some((s) => s.includes("lens-diversity"))).toBe(true);
    expect(r.shortfalls.some((s) => s.includes("auditor-independence"))).toBe(
      false,
    );
  });

  it("FAILS auditor-independence when one author wears N lens-hats", () => {
    const messages = [
      verdictMsg("Solo", {
        lens_set_applied: ["RE", "Architecture", "TA", "Security"],
      }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: targetPr,
    });
    expect(r.ok).toBe(false);
    expect(r.distinct_lenses.length).toBeGreaterThanOrEqual(DEFAULT_MIN_LENSES);
    expect(r.distinct_auditors).toEqual(["Solo"]);
    expect(r.shortfalls.some((s) => s.includes("auditor-independence"))).toBe(
      true,
    );
    expect(r.shortfalls.some((s) => s.includes("lens-diversity"))).toBe(false);
  });
});

describe("computeAuditQuorum — self-audit exclusion", () => {
  it("drops verdicts whose auditor_identity === target_peer", () => {
    const messages = [
      // Author audits a PR addressed to Author => self-audit, excluded.
      verdictMsg("Author", {
        lens_set_applied: ["RE", "Architecture", "TA"],
        target_peer: "Author",
      }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    expect(r.verdicts_considered).toBe(0);
    expect(r.self_audits_excluded).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("counts non-self verdicts even when a self-audit is present", () => {
    const messages = [
      verdictMsg("Author", { lens_set_applied: ["RE"], target_peer: "Author" }),
      verdictMsg("Alpha", { lens_set_applied: ["RE"], target_peer: "Author" }),
      verdictMsg("Bravo", {
        lens_set_applied: ["Architecture"],
        target_peer: "Author",
      }),
      verdictMsg("Delta", { lens_set_applied: ["TA"], target_peer: "Author" }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    expect(r.self_audits_excluded).toBe(1);
    expect(r.distinct_auditors).toEqual(["Alpha", "Bravo", "Delta"]);
    expect(r.ok).toBe(true);
  });
});

describe("computeAuditQuorum — target_pr matching", () => {
  it("ignores verdicts for a different PR number", () => {
    const messages = [
      verdictMsg("Alpha", {
        lens_set_applied: ["RE"],
        target_pr: { repo: "claude-conductor", number: 999 },
      }),
      verdictMsg("Bravo", {
        lens_set_applied: ["Architecture"],
        target_pr: { repo: "claude-conductor", number: 999 },
      }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    expect(r.verdicts_considered).toBe(0);
  });

  it("normalizes bare vs owner-prefixed repo forms", () => {
    const messages = [
      verdictMsg("Alpha", {
        lens_set_applied: ["RE"],
        target_pr: { repo: "claude-conductor", number: 200 },
      }),
      verdictMsg("Bravo", {
        lens_set_applied: ["Architecture"],
        target_pr: { repo: "nbruzzi/claude-conductor", number: 200 },
      }),
      verdictMsg("Delta", {
        lens_set_applied: ["TA"],
        target_pr: { repo: "claude-conductor", number: 200 },
      }),
    ];
    // Query with the owner-prefixed form; all three should match.
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "nbruzzi/claude-conductor", number: 200 },
    });
    expect(r.verdicts_considered).toBe(3);
    expect(r.ok).toBe(true);
  });
});

describe("computeAuditQuorum — body_ref hydration", () => {
  it("counts a verdict whose body is supplied via body_ref", () => {
    const refMsg: ChannelMessage = {
      ts: "2026-05-28T13:00:00.000Z",
      from: "session-Alpha",
      kind: "audit-verdict",
      identity: "Alpha",
      body_ref: "ref-alpha",
    };
    const bodies = new Map<string, string>([
      ["ref-alpha", bodyJson({ lens_set_applied: ["RE"] })],
    ]);
    const messages = [
      refMsg,
      verdictMsg("Bravo", { lens_set_applied: ["Architecture"] }),
      verdictMsg("Delta", { lens_set_applied: ["TA"] }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: bodies,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    // If body_ref hydration failed, Alpha would be dropped => only 2
    // auditors / 2 lenses => fail. ok===true proves it was counted.
    expect(r.distinct_auditors).toContain("Alpha");
    expect(r.ok).toBe(true);
  });
});

describe("computeAuditQuorum — configurable thresholds", () => {
  it("honors relaxed --min-lenses / --min-auditors", () => {
    const messages = [verdictMsg("Solo", { lens_set_applied: ["RE"] })];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
      options: { minLenses: 1, minAuditors: 1 },
    });
    expect(r.min_lenses).toBe(1);
    expect(r.min_auditors).toBe(1);
    expect(r.ok).toBe(true);
  });
});

describe("computeAuditQuorum — degenerate input", () => {
  it("reports both shortfalls on an empty message set", () => {
    const r = computeAuditQuorum({
      messages: [],
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    expect(r.ok).toBe(false);
    expect(r.verdicts_considered).toBe(0);
    expect(r.shortfalls.length).toBe(2);
  });

  it("skips malformed, non-verdict, and identity-less messages", () => {
    const messages: ChannelMessage[] = [
      {
        ts: "2026-05-28T13:00:00.000Z",
        from: "x",
        kind: "audit-verdict",
        identity: "Alpha",
        body: "not json at all",
      },
      {
        ts: "2026-05-28T13:00:00.000Z",
        from: "y",
        kind: "status",
        identity: "Bravo",
        body: bodyJson({ lens_set_applied: ["RE"] }),
      },
      {
        // audit-verdict but no identity => skipped (mirrors reciprocation)
        ts: "2026-05-28T13:00:00.000Z",
        from: "z",
        kind: "audit-verdict",
        body: bodyJson({ lens_set_applied: ["Architecture"] }),
      },
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    expect(r.verdicts_considered).toBe(0);
    expect(r.ok).toBe(false);
  });
});

describe("renderQuorumHuman", () => {
  it("renders ok + counts for a passing report", () => {
    const r = computeAuditQuorum({
      messages: [
        verdictMsg("Alpha", { lens_set_applied: ["RE"] }),
        verdictMsg("Bravo", { lens_set_applied: ["Architecture"] }),
        verdictMsg("Delta", { lens_set_applied: ["TA"] }),
      ],
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    const text = renderQuorumHuman(r);
    expect(text).toContain("ok: true");
    expect(text).toContain("target_pr: claude-conductor#200");
    expect(text).toContain("distinct_lenses: 3");
    expect(text).toContain("distinct_auditors: 3");
  });

  it("renders shortfall lines for a failing report", () => {
    const r = computeAuditQuorum({
      messages: [verdictMsg("Solo", { lens_set_applied: ["RE"] })],
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    const text = renderQuorumHuman(r);
    expect(text).toContain("ok: false");
    expect(text).toContain("shortfall:");
  });
});
