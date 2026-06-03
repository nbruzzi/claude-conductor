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
import {
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";
import { generateKeypair } from "../../src/channels/key-surface.ts";
import type { ChannelMessage } from "../../src/channels/index.ts";

const EMPTY_BODIES: ReadonlyMap<string, string> = new Map();

function bodyJson(over: Partial<AuditVerdictBody>): string {
  const base: AuditVerdictBody = {
    kind_version: 1,
    target: { kind: "pr", repo: "claude-conductor", number: 200 },
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
        target_pr: { repo: "owner/claude-conductor", number: 200 },
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
      target_pr: { repo: "owner/claude-conductor", number: 200 },
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

describe("computeAuditQuorum — v0.3 DSSE-wrapped (signed) verdicts", () => {
  // Build a signed (DSSE-wrapped) audit-verdict message. The SUT stays sync
  // + pure; only the fixture is async (Web Crypto sign). Mirrors the wrap
  // pattern in test/channels/audit-verdict.test.ts.
  async function signedVerdictMsg(
    secretKey: CryptoKey,
    identity: string,
    over: Partial<AuditVerdictBody> = {},
  ): Promise<ChannelMessage> {
    const base: AuditVerdictBody = {
      kind_version: 1,
      target: { kind: "pr", repo: "claude-conductor", number: 200 },
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
    const wrappedBody = await wrapAuditVerdictBody(
      { ...base, ...over },
      secretKey,
      identity,
    );
    return {
      ts: "2026-05-28T13:00:00.000Z",
      from: `session-${identity}`,
      kind: "audit-verdict",
      identity,
      body: wrappedBody,
    };
  }

  it("counts signed (wrapped) verdicts identically to raw bodies", async () => {
    const kp = await generateKeypair();
    const messages = [
      await signedVerdictMsg(kp.privateKey, "Alpha", {
        lens_set_applied: ["RE"],
      }),
      await signedVerdictMsg(kp.privateKey, "Bravo", {
        lens_set_applied: ["Architecture"],
      }),
      await signedVerdictMsg(kp.privateKey, "Delta", {
        lens_set_applied: ["TA"],
      }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    // Pre-fix, parseAuditVerdictBody returns null on a DSSE envelope, so all
    // three would be skipped (verdicts_considered 0, ok false). The dual-
    // parse fix counts them — this asserts the foundational fix.
    expect(r.verdicts_considered).toBe(3);
    expect(r.distinct_auditors).toEqual(["Alpha", "Bravo", "Delta"]);
    expect(r.distinct_lenses).toEqual(["Architecture", "RE", "TA"]);
    expect(r.ok).toBe(true);
  });

  it("counts a mix of signed (wrapped) and raw verdicts together", async () => {
    const kp = await generateKeypair();
    const messages = [
      await signedVerdictMsg(kp.privateKey, "Alpha", {
        lens_set_applied: ["RE"],
      }),
      verdictMsg("Bravo", { lens_set_applied: ["Architecture"] }),
      verdictMsg("Delta", { lens_set_applied: ["TA"] }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    expect(r.verdicts_considered).toBe(3);
    expect(r.ok).toBe(true);
  });

  it("still excludes a signed self-audit (auditor_identity === target_peer)", async () => {
    const kp = await generateKeypair();
    const messages = [
      await signedVerdictMsg(kp.privateKey, "Author", {
        lens_set_applied: ["RE", "Architecture", "TA"],
        target_peer: "Author",
      }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    // Self-audit exclusion must read the INNER (unwrapped) body's target_peer.
    expect(r.self_audits_excluded).toBe(1);
    expect(r.verdicts_considered).toBe(0);
    expect(r.ok).toBe(false);
  });

  it("--require-signed counts only signed (wrapped) verdicts; excludes raw/unsigned", async () => {
    const kp = await generateKeypair();
    const messages = [
      await signedVerdictMsg(kp.privateKey, "Alpha", {
        lens_set_applied: ["RE"],
      }),
      verdictMsg("Bravo", { lens_set_applied: ["Architecture"] }), // raw → excluded
      await signedVerdictMsg(kp.privateKey, "Delta", {
        lens_set_applied: ["TA"],
      }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
      options: { requireSigned: true },
    });
    expect(r.require_signed).toBe(true);
    expect(r.unsigned_excluded).toBe(1); // Bravo's raw body
    expect(r.distinct_auditors).toEqual(["Alpha", "Delta"]);
    expect(r.verdicts_considered).toBe(2);
  });

  it("--require-signed excludes wrapped verdicts whose chain failed (brokenSignatureSeqs)", async () => {
    const kp = await generateKeypair();
    const messages = [
      await signedVerdictMsg(kp.privateKey, "Alpha", {
        lens_set_applied: ["RE"],
      }), // idx 0
      await signedVerdictMsg(kp.privateKey, "Bravo", {
        lens_set_applied: ["Architecture"],
      }), // idx 1 — marked broken
      await signedVerdictMsg(kp.privateKey, "Delta", {
        lens_set_applied: ["TA"],
      }), // idx 2
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
      // Index 1 (Bravo) is the failed-chain entry verify.ts would report.
      options: { requireSigned: true, brokenSignatureSeqs: new Set([1]) },
    });
    expect(r.invalid_signature_excluded).toBe(1);
    expect(r.distinct_auditors).toEqual(["Alpha", "Delta"]);
    expect(r.verdicts_considered).toBe(2);
  });

  it("default (no requireSigned) counts both signed + raw — back-compat", async () => {
    const kp = await generateKeypair();
    const messages = [
      await signedVerdictMsg(kp.privateKey, "Alpha", {
        lens_set_applied: ["RE"],
      }),
      verdictMsg("Bravo", { lens_set_applied: ["Architecture"] }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: { repo: "claude-conductor", number: 200 },
    });
    expect(r.require_signed).toBe(false);
    expect(r.unsigned_excluded).toBe(0);
    expect(r.verdicts_considered).toBe(2);
  });
});

describe("computeAuditQuorum — --pr-author independence (OBS-B1)", () => {
  const targetPr = { repo: "claude-conductor", number: 200 };

  it("excludes verdicts authored by the PR author (even when addressed elsewhere)", () => {
    const messages = [
      // PR author audits their own PR but addresses the verdict to a third
      // party (Reviewer) — evades the auditor===target_peer self-exclusion;
      // caught by --pr-author. This is the OBS-B1 hole.
      verdictMsg("Author", {
        lens_set_applied: ["RE"],
        target_peer: "Reviewer",
      }),
      verdictMsg("Bravo", {
        lens_set_applied: ["Architecture"],
        target_peer: "Reviewer",
      }),
      verdictMsg("Delta", {
        lens_set_applied: ["TA"],
        target_peer: "Reviewer",
      }),
    ];
    const r = computeAuditQuorum({
      messages,
      bodies_by_ref: EMPTY_BODIES,
      target_pr: targetPr,
      options: { prAuthor: "Author" },
    });
    expect(r.pr_author).toBe("Author");
    expect(r.pr_author_audits_excluded).toBe(1);
    expect(r.distinct_auditors).toEqual(["Bravo", "Delta"]);
    expect(r.verdicts_considered).toBe(2);
  });

  it("no --pr-author → no pr-author exclusion (default)", () => {
    const r = computeAuditQuorum({
      messages: [
        verdictMsg("Author", {
          lens_set_applied: ["RE"],
          target_peer: "Reviewer",
        }),
      ],
      bodies_by_ref: EMPTY_BODIES,
      target_pr: targetPr,
    });
    expect(r.pr_author).toBeNull();
    expect(r.pr_author_audits_excluded).toBe(0);
    expect(r.verdicts_considered).toBe(1);
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
