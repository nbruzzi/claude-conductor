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
  FINDING_SEVERITIES,
  LENS_CLASSES,
  isAuditAskTier,
  isAuditAxis,
  isAuditAxisArray,
  isAuditClass,
  isAuditVerdict,
  isFindingSeverity,
  isLensClass,
  isLensClassArray,
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
