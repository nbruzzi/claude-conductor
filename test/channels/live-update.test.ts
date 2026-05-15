// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `parseLiveUpdateBody` unit tests — L152 shared parser for the
 * `live-update` message kind.
 *
 * Sibling test file to `digest.test.ts` (Phase 4 Step A Layer 4 pattern).
 * The kind is registered in `src/channels/index.ts:CHANNEL_KINDS`; this
 * file covers the body schema.
 */

import { describe, expect, it } from "bun:test";

import { parseLiveUpdateBody } from "../../src/channels/live-update.ts";

describe("parseLiveUpdateBody", () => {
  it("accepts a well-formed body with all required + optional fields populated", () => {
    const body = JSON.stringify({
      kind_version: 1,
      since_handoff:
        "Committed PR #50 (manualCommitInFlight lift). Memory feedback-coord-aware-substrate-gates filed.",
      current_focus: "Wrapping up Bundle B dotfiles consumer half.",
      your_scope:
        "Pick up Bundle C TA-1..TA-8 + RE-12 (9 items, ~80 LOC tests).",
      hands_off:
        "Plugin sync-common.ts — Alpha will land Bundle B substrate first.",
    });
    const parsed = parseLiveUpdateBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind_version).toBe(1);
    expect(parsed?.since_handoff).toContain("PR #50");
    expect(parsed?.current_focus).toContain("Bundle B");
    expect(parsed?.your_scope).toContain("Bundle C");
    expect(parsed?.hands_off).toContain("sync-common");
  });

  it("accepts `since_handoff: null` (optional field)", () => {
    const body = JSON.stringify({
      kind_version: 1,
      since_handoff: null,
      current_focus: "Plan-mode for the next slice.",
      your_scope: "Read the plan and audit before exec.",
      hands_off: "none",
    });
    const parsed = parseLiveUpdateBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.since_handoff).toBeNull();
  });

  it("treats omitted `since_handoff` as null (forward-compat with v1 minimal body)", () => {
    const body = JSON.stringify({
      kind_version: 1,
      current_focus: "Doing X.",
      your_scope: "Do Y.",
      hands_off: "none",
    });
    const parsed = parseLiveUpdateBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.since_handoff).toBeNull();
  });

  it("normalizes empty-string `since_handoff` to null (writer-bug recovery)", () => {
    const body = JSON.stringify({
      kind_version: 1,
      since_handoff: "",
      current_focus: "Doing X.",
      your_scope: "Do Y.",
      hands_off: "none",
    });
    const parsed = parseLiveUpdateBody(body);
    expect(parsed?.since_handoff).toBeNull();
  });

  it("rejects body with missing kind_version", () => {
    const body = JSON.stringify({
      current_focus: "Doing X.",
      your_scope: "Do Y.",
      hands_off: "none",
    });
    expect(parseLiveUpdateBody(body)).toBeNull();
  });

  it("rejects body with wrong kind_version (forward incompat)", () => {
    const body = JSON.stringify({
      kind_version: 2,
      current_focus: "Doing X.",
      your_scope: "Do Y.",
      hands_off: "none",
    });
    expect(parseLiveUpdateBody(body)).toBeNull();
  });

  it("rejects body with empty current_focus (sibling needs SOMETHING actionable)", () => {
    const body = JSON.stringify({
      kind_version: 1,
      current_focus: "",
      your_scope: "Do Y.",
      hands_off: "none",
    });
    expect(parseLiveUpdateBody(body)).toBeNull();
  });

  it("rejects body with empty your_scope", () => {
    const body = JSON.stringify({
      kind_version: 1,
      current_focus: "Doing X.",
      your_scope: "",
      hands_off: "none",
    });
    expect(parseLiveUpdateBody(body)).toBeNull();
  });

  it("rejects body with empty hands_off (use literal 'none' instead)", () => {
    const body = JSON.stringify({
      kind_version: 1,
      current_focus: "Doing X.",
      your_scope: "Do Y.",
      hands_off: "",
    });
    expect(parseLiveUpdateBody(body)).toBeNull();
  });

  it("rejects body with non-string field types", () => {
    const body = JSON.stringify({
      kind_version: 1,
      since_handoff: 42, // wrong type
      current_focus: "Doing X.",
      your_scope: "Do Y.",
      hands_off: "none",
    });
    expect(parseLiveUpdateBody(body)).toBeNull();
  });

  it("rejects non-JSON body", () => {
    expect(parseLiveUpdateBody("not json")).toBeNull();
    expect(parseLiveUpdateBody("")).toBeNull();
    expect(parseLiveUpdateBody("undefined")).toBeNull();
  });

  it("rejects non-object body (array / primitive)", () => {
    expect(parseLiveUpdateBody("[]")).toBeNull();
    expect(parseLiveUpdateBody("42")).toBeNull();
    expect(parseLiveUpdateBody("null")).toBeNull();
    expect(parseLiveUpdateBody('"a-string"')).toBeNull();
  });

  it("permissive on extra fields (forward-compat)", () => {
    const body = JSON.stringify({
      kind_version: 1,
      current_focus: "Doing X.",
      your_scope: "Do Y.",
      hands_off: "none",
      future_field: "ignored gracefully",
      schema_v2_only: { nested: "object" },
    });
    const parsed = parseLiveUpdateBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.current_focus).toBe("Doing X.");
  });
});
