// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Negative-path tests for isApprovalMarker (Sub-step 0.10 TS-1 predicate).
 *
 * The predicate replaced an unchecked `as ApprovalMarker` cast in
 * config-protection-cli.ts and config-protection.ts. These tests assert the
 * rejection axes so a future refactor that drops a check (e.g. removing the
 * version === 1 literal gate, or accepting non-finite Date.parse results)
 * surfaces here rather than as a runtime quietly-accepts-malformed-marker
 * bug. Slice 7.1 RE-4 closure.
 */

import { describe, expect, it } from "bun:test";
import { isApprovalMarker } from "../../../src/hooks/checks/config-protection-store.ts";

describe("isApprovalMarker", () => {
  const valid = {
    version: 1,
    path: "/abs/path/to/file.ts",
    approved_at: "2026-04-28T13:00:00Z",
    expires_at: "2026-04-28T14:00:00Z",
    reason: "scope reason",
  };

  it("accepts a well-formed marker", () => {
    expect(isApprovalMarker(valid)).toBe(true);
  });

  it("rejects null and undefined", () => {
    expect(isApprovalMarker(null)).toBe(false);
    expect(isApprovalMarker(undefined)).toBe(false);
  });

  it("rejects non-object primitives", () => {
    expect(isApprovalMarker("string")).toBe(false);
    expect(isApprovalMarker(42)).toBe(false);
    expect(isApprovalMarker(true)).toBe(false);
  });

  it("rejects version drift", () => {
    expect(isApprovalMarker({ ...valid, version: 2 })).toBe(false);
    expect(isApprovalMarker({ ...valid, version: "1" })).toBe(false);
    expect(isApprovalMarker({ ...valid, version: 0 })).toBe(false);
  });

  it("rejects empty path", () => {
    expect(isApprovalMarker({ ...valid, path: "" })).toBe(false);
  });

  it("rejects non-string path", () => {
    expect(isApprovalMarker({ ...valid, path: 123 })).toBe(false);
    expect(isApprovalMarker({ ...valid, path: null })).toBe(false);
  });

  it("rejects unparseable date strings", () => {
    expect(isApprovalMarker({ ...valid, approved_at: "" })).toBe(false);
    expect(isApprovalMarker({ ...valid, approved_at: "not-a-date" })).toBe(
      false,
    );
    expect(isApprovalMarker({ ...valid, expires_at: "" })).toBe(false);
    expect(isApprovalMarker({ ...valid, expires_at: "garbage" })).toBe(false);
  });

  it("rejects non-string date types", () => {
    expect(isApprovalMarker({ ...valid, approved_at: 123 })).toBe(false);
    expect(isApprovalMarker({ ...valid, expires_at: null })).toBe(false);
  });

  it("rejects non-string reason", () => {
    expect(isApprovalMarker({ ...valid, reason: 42 })).toBe(false);
    expect(isApprovalMarker({ ...valid, reason: null })).toBe(false);
  });

  it("rejects missing fields", () => {
    for (const key of [
      "version",
      "path",
      "approved_at",
      "expires_at",
      "reason",
    ] as const) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      expect(isApprovalMarker(partial)).toBe(false);
    }
  });
});
