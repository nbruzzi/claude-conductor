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
  AUDIT_CLASSES,
  LENS_CLASSES,
  isAuditAskTier,
  isAuditClass,
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
