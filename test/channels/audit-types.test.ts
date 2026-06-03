// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for shared audit-discipline types + type-guards
 * (`src/channels/audit-types.ts`).
 *
 * Coverage: each type-guard returns `true` for valid inputs across the
 * full `as const` tuple, and `false` for unknown / wrong-case / non-
 * string / non-array / empty-array / contains-invalid inputs.
 *
 * Plan: `~/.claude/plans/slice-1-kind-audit-ask-schema-2026-05-19.md`
 * v0.2 §Files-to-create #2 (audit-types.test.ts).
 */

import { describe, expect, it } from "bun:test";

import {
  AUDIT_ASK_TIERS,
  AUDIT_AXES,
  AUDIT_CLASSES,
  AUDIT_VERDICTS,
  BANDWIDTH_STATES,
  FINDING_SEVERITIES,
  LENS_CLASSES,
  auditTargetKey,
  auditTargetToWire,
  isAuditAskTier,
  isAuditAxis,
  isAuditAxisArray,
  isAuditClass,
  isAuditVerdict,
  isBandwidthState,
  isFindingSeverity,
  isLensClass,
  isLensClassArray,
  parseAuditTarget,
  sameTarget,
  type AuditTarget,
  type BandwidthInputs,
} from "../../src/channels/audit-types.ts";

describe("audit-types — isAuditAskTier", () => {
  it("accepts every literal in AUDIT_ASK_TIERS", () => {
    for (const t of AUDIT_ASK_TIERS) {
      expect(isAuditAskTier(t)).toBe(true);
    }
  });
  it("rejects unknown / wrong-case / non-string / null / undefined", () => {
    expect(isAuditAskTier("Light-Touch")).toBe(false);
    expect(isAuditAskTier("huge")).toBe(false);
    expect(isAuditAskTier(42)).toBe(false);
    expect(isAuditAskTier(null)).toBe(false);
    expect(isAuditAskTier(undefined)).toBe(false);
    expect(isAuditAskTier({})).toBe(false);
    expect(isAuditAskTier([])).toBe(false);
  });
});

describe("audit-types — isAuditClass", () => {
  it("accepts every literal in AUDIT_CLASSES", () => {
    for (const c of AUDIT_CLASSES) {
      expect(isAuditClass(c)).toBe(true);
    }
  });
  it("rejects unknown / wrong-case / non-string", () => {
    expect(isAuditClass("inside-pair-shadow")).toBe(false);
    expect(isAuditClass("Inside-Pair")).toBe(false);
    expect(isAuditClass(42)).toBe(false);
    expect(isAuditClass(null)).toBe(false);
  });
});

describe("audit-types — isLensClass", () => {
  it("accepts every literal in LENS_CLASSES", () => {
    for (const l of LENS_CLASSES) {
      expect(isLensClass(l)).toBe(true);
    }
  });
  it("rejects unknown / wrong-case / non-string", () => {
    expect(isLensClass("Reliability")).toBe(false);
    expect(isLensClass("re")).toBe(false);
    expect(isLensClass(42)).toBe(false);
    expect(isLensClass(null)).toBe(false);
  });
});

describe("audit-types — isLensClassArray", () => {
  it("accepts non-empty arrays of valid lenses", () => {
    expect(isLensClassArray(["RE"])).toBe(true);
    expect(isLensClassArray(["RE", "Architecture"])).toBe(true);
    expect(isLensClassArray([...LENS_CLASSES])).toBe(true);
  });
  it("rejects empty array", () => {
    expect(isLensClassArray([])).toBe(false);
  });
  it("rejects non-array (string)", () => {
    expect(isLensClassArray("RE")).toBe(false);
  });
  it("rejects arrays containing invalid lens", () => {
    expect(isLensClassArray(["RE", "InvalidLens"])).toBe(false);
  });
  it("rejects arrays containing non-string", () => {
    expect(isLensClassArray(["RE", 42])).toBe(false);
  });
  it("rejects null / undefined / object", () => {
    expect(isLensClassArray(null)).toBe(false);
    expect(isLensClassArray(undefined)).toBe(false);
    expect(isLensClassArray({})).toBe(false);
  });
});

describe("audit-types — isAuditAxis (Slice 2)", () => {
  it("accepts every literal in AUDIT_AXES", () => {
    for (const a of AUDIT_AXES) {
      expect(isAuditAxis(a)).toBe(true);
    }
  });
  it("rejects unknown / wrong-case / non-string", () => {
    expect(isAuditAxis("Surface")).toBe(false);
    expect(isAuditAxis("breadth")).toBe(false);
    expect(isAuditAxis(42)).toBe(false);
    expect(isAuditAxis(null)).toBe(false);
  });
});

describe("audit-types — isAuditAxisArray (Slice 2)", () => {
  it("accepts non-empty arrays of valid axes", () => {
    expect(isAuditAxisArray(["surface"])).toBe(true);
    expect(isAuditAxisArray(["surface", "depth"])).toBe(true);
    expect(isAuditAxisArray([...AUDIT_AXES])).toBe(true);
  });
  it("rejects empty array", () => {
    expect(isAuditAxisArray([])).toBe(false);
  });
  it("rejects non-array (string)", () => {
    expect(isAuditAxisArray("surface")).toBe(false);
  });
  it("rejects arrays containing invalid axis", () => {
    expect(isAuditAxisArray(["surface", "breadth"])).toBe(false);
  });
  it("rejects arrays containing non-string", () => {
    expect(isAuditAxisArray(["surface", 42])).toBe(false);
  });
  it("rejects null / undefined / object", () => {
    expect(isAuditAxisArray(null)).toBe(false);
    expect(isAuditAxisArray(undefined)).toBe(false);
    expect(isAuditAxisArray({})).toBe(false);
  });
});

describe("audit-types — isAuditVerdict (Slice 2)", () => {
  it("accepts every literal in AUDIT_VERDICTS", () => {
    for (const v of AUDIT_VERDICTS) {
      expect(isAuditVerdict(v)).toBe(true);
    }
  });
  it("rejects unknown / wrong-case / non-string", () => {
    expect(isAuditVerdict("ship-clean")).toBe(false); // case-mismatch
    expect(isAuditVerdict("SHIP-DIRTY")).toBe(false);
    expect(isAuditVerdict(42)).toBe(false);
    expect(isAuditVerdict(null)).toBe(false);
  });
});

describe("audit-types — isFindingSeverity (Slice 2)", () => {
  it("accepts every literal in FINDING_SEVERITIES", () => {
    for (const s of FINDING_SEVERITIES) {
      expect(isFindingSeverity(s)).toBe(true);
    }
  });
  it("rejects unknown / wrong-case / non-string", () => {
    expect(isFindingSeverity("blocker")).toBe(false); // case-mismatch
    expect(isFindingSeverity("MAJOR")).toBe(false);
    expect(isFindingSeverity(42)).toBe(false);
    expect(isFindingSeverity(null)).toBe(false);
  });
});

describe("audit-types — isBandwidthState (Slice 3)", () => {
  it("accepts every literal in BANDWIDTH_STATES", () => {
    for (const s of BANDWIDTH_STATES) {
      expect(isBandwidthState(s)).toBe(true);
    }
  });
  it("rejects unknown / wrong-case / non-string", () => {
    expect(isBandwidthState("saturated")).toBe(false); // case-mismatch
    expect(isBandwidthState("idle")).toBe(false); // truncated
    expect(isBandwidthState("IDLE")).toBe(false); // missing -AVAILABLE
    expect(isBandwidthState("BUSY")).toBe(false); // not a literal
    expect(isBandwidthState(42)).toBe(false);
    expect(isBandwidthState(null)).toBe(false);
    expect(isBandwidthState(undefined)).toBe(false);
    expect(isBandwidthState({})).toBe(false);
    expect(isBandwidthState([])).toBe(false);
  });
});

describe("audit-types — BandwidthInputs shape (Slice 3)", () => {
  it("type-assignment compiles + carries the 4 documented keys at runtime", () => {
    const inputs: BandwidthInputs = {
      msg_density_30min: 0,
      audits_delivered_90min: 0,
      heartbeat_age_ms: null,
      open_audit_asks: 0,
    };
    expect(Object.keys(inputs).sort()).toEqual([
      "audits_delivered_90min",
      "heartbeat_age_ms",
      "msg_density_30min",
      "open_audit_asks",
    ]);
    expect(inputs.heartbeat_age_ms).toBeNull();
  });
});

// Item #3(b) 2026-06-03 — audit-target generalization (discriminated
// AuditTarget = pr | plan). HIGH-2 from Alpha+Golf's convergent
// SHIP-WITH-FOLDS lens on #193: the right-size cut's load-bearing
// invariants (exactly-one wire matrix, back-compat target_pr-only -> pr,
// roundtrip, pairing identity) are correct-by-inspection but were UNPROVEN.
describe("audit-types — parseAuditTarget exactly-one matrix (Item #3b)", () => {
  it("pr-only wire -> {kind:'pr'} (historical back-compat, unchanged)", () => {
    expect(
      parseAuditTarget({ target_pr: { repo: "conductor", number: 99 } }),
    ).toEqual({ kind: "pr", repo: "conductor", number: 99 });
  });
  it("plan-only wire -> {kind:'plan'}", () => {
    expect(parseAuditTarget({ target_plan: { ref: "my-plan.md" } })).toEqual({
      kind: "plan",
      ref: "my-plan.md",
    });
  });
  it("BOTH present -> null (exactly-one violated)", () => {
    expect(
      parseAuditTarget({
        target_pr: { repo: "conductor", number: 99 },
        target_plan: { ref: "my-plan.md" },
      }),
    ).toBeNull();
  });
  it("NEITHER present -> null (exactly-one violated)", () => {
    expect(parseAuditTarget({})).toBeNull();
  });
  it("trims whitespace on repo + ref (A1-fold parity)", () => {
    expect(
      parseAuditTarget({ target_pr: { repo: "  conductor ", number: 1 } }),
    ).toEqual({ kind: "pr", repo: "conductor", number: 1 });
    expect(parseAuditTarget({ target_plan: { ref: "  p.md " } })).toEqual({
      kind: "plan",
      ref: "p.md",
    });
  });
  it("rejects malformed pr (empty/missing repo, non-positive/non-integer number)", () => {
    expect(parseAuditTarget({ target_pr: { repo: "", number: 1 } })).toBeNull();
    expect(
      parseAuditTarget({ target_pr: { repo: "conductor", number: 0 } }),
    ).toBeNull();
    expect(
      parseAuditTarget({ target_pr: { repo: "conductor", number: 1.5 } }),
    ).toBeNull();
    expect(parseAuditTarget({ target_pr: { number: 1 } })).toBeNull();
    expect(parseAuditTarget({ target_pr: null })).toBeNull();
  });
  it("rejects malformed plan (empty/missing ref, non-object)", () => {
    expect(parseAuditTarget({ target_plan: { ref: "" } })).toBeNull();
    expect(parseAuditTarget({ target_plan: {} })).toBeNull();
    expect(parseAuditTarget({ target_plan: "p.md" })).toBeNull();
  });
});

describe("audit-types — auditTargetToWire + roundtrip (Item #3b)", () => {
  it("pr -> {target_pr}", () => {
    expect(
      auditTargetToWire({ kind: "pr", repo: "conductor", number: 99 }),
    ).toEqual({ target_pr: { repo: "conductor", number: 99 } });
  });
  it("plan -> {target_plan}", () => {
    expect(auditTargetToWire({ kind: "plan", ref: "my-plan.md" })).toEqual({
      target_plan: { ref: "my-plan.md" },
    });
  });
  it("parseAuditTarget(auditTargetToWire(t)) === t for BOTH kinds", () => {
    const pr: AuditTarget = { kind: "pr", repo: "conductor", number: 99 };
    const plan: AuditTarget = { kind: "plan", ref: "my-plan.md" };
    expect(parseAuditTarget(auditTargetToWire(pr))).toEqual(pr);
    expect(parseAuditTarget(auditTargetToWire(plan))).toEqual(plan);
  });
});

describe("audit-types — sameTarget (Item #3b)", () => {
  it("pr<->pr matches on repo+number; mismatches on either", () => {
    const base: AuditTarget = { kind: "pr", repo: "c", number: 1 };
    expect(sameTarget(base, { kind: "pr", repo: "c", number: 1 })).toBe(true);
    expect(sameTarget(base, { kind: "pr", repo: "c", number: 2 })).toBe(false);
    expect(sameTarget(base, { kind: "pr", repo: "d", number: 1 })).toBe(false);
  });
  it("plan<->plan matches on ref", () => {
    const base: AuditTarget = { kind: "plan", ref: "a.md" };
    expect(sameTarget(base, { kind: "plan", ref: "a.md" })).toBe(true);
    expect(sameTarget(base, { kind: "plan", ref: "b.md" })).toBe(false);
  });
  it("cross-kind never matches", () => {
    expect(
      sameTarget(
        { kind: "pr", repo: "c", number: 1 },
        { kind: "plan", ref: "a.md" },
      ),
    ).toBe(false);
  });
});

describe("audit-types — auditTargetKey (Item #3b)", () => {
  it("pr -> 'pr:<repo>#<number>'", () => {
    expect(auditTargetKey({ kind: "pr", repo: "conductor", number: 99 })).toBe(
      "pr:conductor#99",
    );
  });
  it("plan -> 'plan:<ref>'", () => {
    expect(auditTargetKey({ kind: "plan", ref: "my-plan.md" })).toBe(
      "plan:my-plan.md",
    );
  });
  it("kind-prefix prevents a pr/plan key collision on a textual ref", () => {
    expect(auditTargetKey({ kind: "pr", repo: "c", number: 1 })).not.toBe(
      auditTargetKey({ kind: "plan", ref: "c#1" }),
    );
  });
});
