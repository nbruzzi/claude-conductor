// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Negative-path tests for isScopeMarker (Sub-step 0.10 TS-1 predicate).
 *
 * The predicate closes the NaN-loop hazard in tryConsumeScope per TS-A1: a
 * marker with `files_consumed = NaN` would silently bypass the
 * `consumed >= max` exhaustion check (NaN comparisons are always false) and
 * leave the marker active forever. Tests assert the rejection axes so a
 * future refactor that drops Number.isInteger or the consumed <= max
 * invariant surfaces here. Slice 7.1 RE-4 closure.
 */

import { describe, expect, it } from "bun:test";
import { isScopeMarker } from "../../../src/hooks/checks/fact-force-scope-store.ts";

describe("isScopeMarker", () => {
  const valid = {
    version: 1,
    sessionId: "abc-123",
    reason: "batch edit",
    approved_at: "2026-04-28T13:00:00Z",
    expires_at: "2026-04-28T14:00:00Z",
    max_files: 25,
    files_consumed: 0,
  };

  it("accepts a well-formed marker", () => {
    expect(isScopeMarker(valid)).toBe(true);
  });

  it("rejects null and undefined", () => {
    expect(isScopeMarker(null)).toBe(false);
    expect(isScopeMarker(undefined)).toBe(false);
  });

  it("rejects non-object primitives", () => {
    expect(isScopeMarker("string")).toBe(false);
    expect(isScopeMarker(42)).toBe(false);
  });

  it("rejects version drift", () => {
    expect(isScopeMarker({ ...valid, version: 2 })).toBe(false);
    expect(isScopeMarker({ ...valid, version: "1" })).toBe(false);
  });

  it("rejects non-string sessionId / reason", () => {
    expect(isScopeMarker({ ...valid, sessionId: 42 })).toBe(false);
    expect(isScopeMarker({ ...valid, reason: null })).toBe(false);
  });

  it("rejects unparseable dates", () => {
    expect(isScopeMarker({ ...valid, approved_at: "" })).toBe(false);
    expect(isScopeMarker({ ...valid, expires_at: "garbage" })).toBe(false);
  });

  it("rejects NaN max_files (the original hazard)", () => {
    expect(isScopeMarker({ ...valid, max_files: NaN })).toBe(false);
  });

  it("rejects NaN files_consumed (the original hazard)", () => {
    expect(isScopeMarker({ ...valid, files_consumed: NaN })).toBe(false);
  });

  it("rejects non-integer max_files / files_consumed", () => {
    expect(isScopeMarker({ ...valid, max_files: 25.5 })).toBe(false);
    expect(isScopeMarker({ ...valid, files_consumed: 1.1 })).toBe(false);
    expect(isScopeMarker({ ...valid, max_files: Infinity })).toBe(false);
    expect(isScopeMarker({ ...valid, files_consumed: -Infinity })).toBe(false);
  });

  it("rejects non-number max_files / files_consumed", () => {
    expect(isScopeMarker({ ...valid, max_files: "25" })).toBe(false);
    expect(isScopeMarker({ ...valid, files_consumed: null })).toBe(false);
  });

  it("rejects negative max_files / files_consumed", () => {
    expect(isScopeMarker({ ...valid, max_files: -1 })).toBe(false);
    expect(isScopeMarker({ ...valid, files_consumed: -5 })).toBe(false);
  });

  it("rejects already-overspent markers (consumed > max)", () => {
    expect(isScopeMarker({ ...valid, max_files: 10, files_consumed: 11 })).toBe(
      false,
    );
  });

  it("accepts boundary case consumed === max (exhausted but valid)", () => {
    expect(isScopeMarker({ ...valid, max_files: 10, files_consumed: 10 })).toBe(
      true,
    );
  });

  it("rejects missing fields", () => {
    for (const key of ["version", "max_files", "files_consumed"] as const) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      expect(isScopeMarker(partial)).toBe(false);
    }
  });
});
