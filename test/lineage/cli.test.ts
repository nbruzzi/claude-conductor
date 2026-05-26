// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for lineage CLI helpers (Cycle 1 substrate-extension PR-A4).
 * Tests pure helpers + derivation paths LOCKED at PR-A6 audit-shadow
 * body_ref c27946e5. Subprocess-level CLI tests deferred to integration
 * cycle (per Charlie PR-A8 deferral framing for subprocess audit-verify-
 * cross-edge.test.ts; same rationale applies here).
 *
 * Plan: ~/.claude/plans/cycle-1-substrate-extension-slice-plan-2026-05-26.md
 * §3.1 + §7 step 4.
 */

import { describe, expect, it } from "bun:test";

import {
  deriveSigChainStatus,
  exitCodeForLineage,
  looksLikeChannelId,
  renderHumanLineage,
} from "../../src/lineage/cli.ts";
import type { LineageVerifyOutput } from "../../src/channels/api.ts";

const VACUOUS_OK: LineageVerifyOutput = {
  ok: true,
  resolved_inputs: [],
  unresolved_inputs: [],
  sig_chain_status: "skip-not-in-channel",
  chain_start_at_msg_seq: null,
};

describe("looksLikeChannelId — Cycle 1 heuristic", () => {
  it("T1.1: typical channel-id (date-prefixed) matches", () => {
    expect(looksLikeChannelId("2026-05-25_23-30")).toBe(true);
  });

  it("T1.2: alphanumeric with hyphens matches", () => {
    expect(looksLikeChannelId("bernstein-review-arc-2026")).toBe(true);
  });

  it("T1.3: alphanumeric with underscores matches", () => {
    expect(looksLikeChannelId("pair_a_2026_05_22")).toBe(true);
  });

  it("T1.4: paths with slashes do NOT match (likely artifact-path)", () => {
    expect(looksLikeChannelId("/tmp/test/some/file.md")).toBe(false);
  });

  it("T1.5: empty string does NOT match", () => {
    expect(looksLikeChannelId("")).toBe(false);
  });

  it("T1.6: starts with non-alphanumeric does NOT match", () => {
    expect(looksLikeChannelId("-leading-hyphen")).toBe(false);
    expect(looksLikeChannelId("_leading-underscore")).toBe(false);
  });

  it("T1.7: single char does NOT match (need length >= 2)", () => {
    expect(looksLikeChannelId("a")).toBe(false);
  });
});

describe("deriveSigChainStatus — composition contract LOCKED at PR-A6 audit-shadow", () => {
  it("T2.1: intact ⟸ ok && total_audit_verdicts > 0 && breaks=[]", () => {
    expect(
      deriveSigChainStatus({ ok: true, total_audit_verdicts: 5, breaks: [] }),
    ).toBe("intact");
  });

  it("T2.2: broken ⟸ breaks non-empty (regardless of ok flag)", () => {
    expect(
      deriveSigChainStatus({
        ok: false,
        total_audit_verdicts: 5,
        breaks: [{ reason: "tamper" }],
      }),
    ).toBe("broken");
    expect(
      deriveSigChainStatus({
        ok: true,
        total_audit_verdicts: 5,
        breaks: [{ reason: "revoked-key" }],
      }),
    ).toBe("broken");
  });

  it("T2.3: skip-not-in-channel ⟸ total_audit_verdicts === 0", () => {
    expect(
      deriveSigChainStatus({ ok: true, total_audit_verdicts: 0, breaks: [] }),
    ).toBe("skip-not-in-channel");
  });

  it("T2.4: total=0 + breaks=[] precedence is skip-not-in-channel (vacuous)", () => {
    expect(
      deriveSigChainStatus({ ok: false, total_audit_verdicts: 0, breaks: [] }),
    ).toBe("skip-not-in-channel");
  });

  it("T2.5: ok=false + total>0 + breaks=[] is broken (defensive default)", () => {
    expect(
      deriveSigChainStatus({ ok: false, total_audit_verdicts: 5, breaks: [] }),
    ).toBe("broken");
  });

  it("T2.6: multiple breaks → broken (consumer surface sees first-class break visibility)", () => {
    expect(
      deriveSigChainStatus({
        ok: false,
        total_audit_verdicts: 10,
        breaks: [{ reason: "tamper" }, { reason: "revoked-key" }],
      }),
    ).toBe("broken");
  });
});

describe("exitCodeForLineage — §3.1 DC-3 4-state mapping", () => {
  it("T3.1: intact + all resolved → 0 (ok)", () => {
    const result: LineageVerifyOutput = {
      ok: true,
      resolved_inputs: [
        { body_ref: "ref-1", ts: "x", kind: "y", producer_session_id: "z" },
      ],
      unresolved_inputs: [],
      sig_chain_status: "intact",
      chain_start_at_msg_seq: 0,
    };
    expect(exitCodeForLineage(result, false)).toBe(0);
  });

  it("T3.2: skip-not-in-channel + empty inputs → 0 (vacuously ok)", () => {
    expect(exitCodeForLineage(VACUOUS_OK, false)).toBe(0);
  });

  it("T3.3: broken sig chain → 1 (broken)", () => {
    const result: LineageVerifyOutput = {
      ok: false,
      resolved_inputs: [],
      unresolved_inputs: [],
      sig_chain_status: "broken",
      chain_start_at_msg_seq: 0,
    };
    expect(exitCodeForLineage(result, false)).toBe(1);
  });

  it("T3.4: unresolved inputs + sig intact + non-strict → 2 (partial)", () => {
    const result: LineageVerifyOutput = {
      ok: false,
      resolved_inputs: [],
      unresolved_inputs: [{ body_ref: "ref-x", reason: "not-found" }],
      sig_chain_status: "intact",
      chain_start_at_msg_seq: 0,
    };
    expect(exitCodeForLineage(result, false)).toBe(2);
  });

  it("T3.5: unresolved inputs + sig intact + --strict → 1 (broken promotion)", () => {
    const result: LineageVerifyOutput = {
      ok: false,
      resolved_inputs: [],
      unresolved_inputs: [{ body_ref: "ref-x", reason: "not-found" }],
      sig_chain_status: "intact",
      chain_start_at_msg_seq: 0,
    };
    expect(exitCodeForLineage(result, true)).toBe(1);
  });

  it("T3.6: broken sig chain (strict no-op; already at 1)", () => {
    const result: LineageVerifyOutput = {
      ok: false,
      resolved_inputs: [],
      unresolved_inputs: [{ body_ref: "ref-x", reason: "not-found" }],
      sig_chain_status: "broken",
      chain_start_at_msg_seq: 0,
    };
    expect(exitCodeForLineage(result, true)).toBe(1);
    expect(exitCodeForLineage(result, false)).toBe(1);
  });
});

describe("renderHumanLineage — compact summary + per-break detail", () => {
  it("T4.1: OK vacuous renders 1-line summary", () => {
    const out = renderHumanLineage(VACUOUS_OK);
    expect(out).toContain("lineage verify: OK");
    expect(out).toContain("sig_chain=skip-not-in-channel");
    expect(out).toContain("resolved=0");
    expect(out).toContain("unresolved=0");
  });

  it("T4.2: BROKEN renders status correctly", () => {
    const result: LineageVerifyOutput = {
      ok: false,
      resolved_inputs: [],
      unresolved_inputs: [],
      sig_chain_status: "broken",
      chain_start_at_msg_seq: 5,
    };
    const out = renderHumanLineage(result);
    expect(out).toContain("lineage verify: BROKEN");
    expect(out).toContain("sig_chain=broken");
    expect(out).toContain("Chain start at msg seq: 5");
  });

  it("T4.3: unresolved inputs render per-break detail", () => {
    const result: LineageVerifyOutput = {
      ok: false,
      resolved_inputs: [],
      unresolved_inputs: [
        { body_ref: "ref-A", reason: "not-found" },
        { body_ref: "ref-B", reason: "schema-mismatch" },
      ],
      sig_chain_status: "intact",
      chain_start_at_msg_seq: null,
    };
    const out = renderHumanLineage(result);
    expect(out).toContain("Unresolved inputs:");
    expect(out).toContain("- ref-A: not-found");
    expect(out).toContain("- ref-B: schema-mismatch");
  });

  it("T4.4: chain_start_at_msg_seq null is omitted from output", () => {
    const result: LineageVerifyOutput = {
      ...VACUOUS_OK,
      chain_start_at_msg_seq: null,
    };
    const out = renderHumanLineage(result);
    expect(out).not.toContain("Chain start at msg seq:");
  });

  it("T4.5: resolved + unresolved counts surface in summary", () => {
    const result: LineageVerifyOutput = {
      ok: false,
      resolved_inputs: [
        { body_ref: "ref-1", ts: "x", kind: "y", producer_session_id: "z" },
        { body_ref: "ref-2", ts: "x", kind: "y", producer_session_id: "z" },
      ],
      unresolved_inputs: [{ body_ref: "ref-3", reason: "not-found" }],
      sig_chain_status: "intact",
      chain_start_at_msg_seq: 0,
    };
    const out = renderHumanLineage(result);
    expect(out).toContain("resolved=2");
    expect(out).toContain("unresolved=1");
  });
});
