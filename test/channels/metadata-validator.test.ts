// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Negative-path tests for validateChannelMetadata (Sub-step 0.10 TS-1 +
 * TS-A6 path-parameterized split).
 *
 * The validator replaces the inline shape-check that lived only in
 * `readMetadataRaw` and was bypassed by the archive branch's
 * `as ChannelMetadata` cast. Both active-channel and archive branches now
 * route through this validator. Tests assert the rejection axes so a future
 * refactor that drops the lifecycle === "parallel" literal gate or accepts
 * non-string participants surfaces here. Slice 7.1 RE-4 closure.
 */

import { describe, expect, it } from "bun:test";
import {
  validateChannelMetadata,
  type ChannelMetadata,
} from "../../src/channels/index.ts";

describe("validateChannelMetadata", () => {
  const valid: ChannelMetadata = {
    created_at: "2026-04-28T13:00:00Z",
    lifecycle: "parallel",
    handoff_id: "2026-04-28_01-50",
    participants: ["abc-123", "def-456"],
  };

  it("accepts a well-formed metadata object", () => {
    expect(validateChannelMetadata(valid, "test-channel")).toEqual(valid);
  });

  it("preserves optional closed_at when present", () => {
    const withClosed = { ...valid, closed_at: "2026-04-28T14:00:00Z" };
    expect(validateChannelMetadata(withClosed, "test-channel")).toEqual(
      withClosed,
    );
  });

  it("rejects null and undefined", () => {
    expect(() => validateChannelMetadata(null, "label")).toThrow();
    expect(() => validateChannelMetadata(undefined, "label")).toThrow();
  });

  it("rejects non-object primitives", () => {
    expect(() => validateChannelMetadata("string", "label")).toThrow();
    expect(() => validateChannelMetadata(42, "label")).toThrow();
  });

  it("rejects lifecycle drift (must be literal 'parallel')", () => {
    expect(() =>
      validateChannelMetadata({ ...valid, lifecycle: "serial" }, "label"),
    ).toThrow();
    expect(() =>
      validateChannelMetadata({ ...valid, lifecycle: "" }, "label"),
    ).toThrow();
    expect(() =>
      validateChannelMetadata({ ...valid, lifecycle: 1 }, "label"),
    ).toThrow();
  });

  it("rejects non-string created_at / handoff_id", () => {
    expect(() =>
      validateChannelMetadata({ ...valid, created_at: 123 }, "label"),
    ).toThrow();
    expect(() =>
      validateChannelMetadata({ ...valid, handoff_id: null }, "label"),
    ).toThrow();
  });

  it("rejects non-array participants", () => {
    expect(() =>
      validateChannelMetadata({ ...valid, participants: "abc" }, "label"),
    ).toThrow();
    expect(() =>
      validateChannelMetadata({ ...valid, participants: null }, "label"),
    ).toThrow();
  });

  it("rejects participants[] with non-string elements", () => {
    expect(() =>
      validateChannelMetadata({ ...valid, participants: ["abc", 42] }, "label"),
    ).toThrow();
    expect(() =>
      validateChannelMetadata(
        { ...valid, participants: [null, "abc"] },
        "label",
      ),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    for (const key of [
      "created_at",
      "lifecycle",
      "handoff_id",
      "participants",
    ] as const) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      expect(() => validateChannelMetadata(partial, "label")).toThrow();
    }
  });

  it("includes sourceLabel in error message for traceability", () => {
    expect(() => validateChannelMetadata(null, "alpha-channel")).toThrow(
      /alpha-channel/,
    );
    expect(() =>
      validateChannelMetadata({ ...valid, lifecycle: "wrong" }, "beta-archive"),
    ).toThrow(/beta-archive/);
  });

  it("accepts empty participants array (zero is valid)", () => {
    expect(
      validateChannelMetadata({ ...valid, participants: [] }, "label"),
    ).toEqual({ ...valid, participants: [] });
  });
});
