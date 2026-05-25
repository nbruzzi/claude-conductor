// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Paired contract test for the `isInvalidArtifactIdError` /
 * `isInvalidSessionIdError` classifiers exposed on the active-sessions
 * public surface (`claude-conductor/active-sessions`).
 *
 * Pinning convention per `feedback-cross-edge-contract-via-paired-tests.md`:
 *   - Conductor side asserts (1) the classifiers recognize every active-
 *     sessions boundary throw produced by an exported fn (today:
 *     touchHeartbeat × 2, resetArtifactRegistry × 1), (2) they correctly
 *     reject non-matching throws (wrong id, non-Error values, unrelated
 *     Error messages).
 *   - Dashboard side (separate repo, `active-sessions.ts` adapter
 *     consumer migration PR) re-imports the classifiers from this surface
 *     and asserts the adapter's wrapThrow discriminates
 *     kind:"invalid-input" via the substrate primitive, not via inline
 *     string-match.
 *
 * Mirrors `test/channels/boundary-errors.test.ts`. Existing positive-shape
 * coverage on the throw side (`test/active-sessions/reset-and-atomic-meta`,
 * the `resetArtifactRegistry` block) uses a loose `/invalid artifactId/`
 * regex; this file pins the classifier side under the same wire-shape contract.
 */
import { describe, expect, it } from "bun:test";

import {
  INVALID_ARTIFACT_ID_MESSAGE_FRAGMENT,
  INVALID_SESSION_ID_MESSAGE_FRAGMENT,
  isInvalidArtifactIdError,
  isInvalidSessionIdError,
} from "../../src/active-sessions/index.ts";

describe("isInvalidArtifactIdError classifier", () => {
  it("exports the canonical wire-shape fragment used by artifactId throws", () => {
    // The substrate guarantee — every artifactId-rejection throw contains
    // this exact substring. Backward-compat with reset-and-atomic-meta's
    // loose `/invalid artifactId/` regex.
    expect(INVALID_ARTIFACT_ID_MESSAGE_FRAGMENT).toBe("invalid artifactId:");
  });

  it("recognizes touchHeartbeat-shaped artifactId throw", () => {
    const err = new Error(`invalid artifactId: ../etc`);
    expect(isInvalidArtifactIdError(err, "../etc")).toBe(true);
  });

  it("recognizes resetArtifactRegistry-shaped artifactId throw", () => {
    const err = new Error(`invalid artifactId: `);
    expect(isInvalidArtifactIdError(err, "")).toBe(true);
  });

  it("recognizes artifactId throw with non-canonical (spaced) id", () => {
    const err = new Error(`invalid artifactId: name with space`);
    expect(isInvalidArtifactIdError(err, "name with space")).toBe(true);
  });

  it("rejects throws whose id substring does NOT match the queried id", () => {
    const err = new Error(`invalid artifactId: ../wrong`);
    // Caller queried for "expected-id" but the throw mentioned a different
    // value — classifier returns false. Prevents misattributing one call's
    // throw to a sibling call's id.
    expect(isInvalidArtifactIdError(err, "expected-id")).toBe(false);
  });

  it("rejects non-Error thrown values", () => {
    expect(isInvalidArtifactIdError(`invalid artifactId: x`, "x")).toBe(false);
    expect(isInvalidArtifactIdError(null, "x")).toBe(false);
    expect(isInvalidArtifactIdError(undefined, "x")).toBe(false);
    expect(
      isInvalidArtifactIdError({ message: "invalid artifactId: x" }, "x"),
    ).toBe(false);
  });

  it("rejects Error messages without the canonical fragment", () => {
    const err = new Error(`refusing to reset: x is a symlink`);
    expect(isInvalidArtifactIdError(err, "x")).toBe(false);
  });

  it("rejects sessionId-shaped throws (different fragment)", () => {
    const err = new Error(`invalid sessionId: x`);
    // The two fragments are distinct anchors — sessionId throws must not
    // false-positive as artifactId throws (defends downstream callers
    // doing kind-specific discrimination).
    expect(isInvalidArtifactIdError(err, "x")).toBe(false);
  });

  it("recognizes throws via live touchHeartbeat call (end-to-end contract proof)", async () => {
    // End-to-end contract proof — call the real fn with a bad artifactId,
    // catch the throw, classify via the new export. Binds the classifier
    // to the active-sessions-emitted wire shape so changes to either side
    // without the other surface immediately at test time.
    const { touchHeartbeat } =
      await import("../../src/active-sessions/index.ts");
    let caught: unknown = null;
    try {
      touchHeartbeat({
        artifactId: "../etc",
        sessionId: "11111111-2222-3333-4444-555555555555",
        artifactPath: "/tmp/x",
        now: Date.now(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(isInvalidArtifactIdError(caught, "../etc")).toBe(true);
  });

  it("recognizes throws via live resetArtifactRegistry call (end-to-end contract proof)", async () => {
    const { resetArtifactRegistry } =
      await import("../../src/active-sessions/index.ts");
    let caught: unknown = null;
    try {
      resetArtifactRegistry("../wrong");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(isInvalidArtifactIdError(caught, "../wrong")).toBe(true);
  });
});

describe("isInvalidSessionIdError classifier", () => {
  it("exports the canonical wire-shape fragment used by sessionId throws", () => {
    expect(INVALID_SESSION_ID_MESSAGE_FRAGMENT).toBe("invalid sessionId:");
  });

  it("recognizes touchHeartbeat-shaped sessionId throw", () => {
    const err = new Error(`invalid sessionId: ../bad-sid`);
    expect(isInvalidSessionIdError(err, "../bad-sid")).toBe(true);
  });

  it("recognizes sessionId throw with empty id", () => {
    const err = new Error(`invalid sessionId: `);
    expect(isInvalidSessionIdError(err, "")).toBe(true);
  });

  it("rejects throws whose id substring does NOT match the queried id", () => {
    const err = new Error(`invalid sessionId: ../wrong`);
    expect(isInvalidSessionIdError(err, "expected-sid")).toBe(false);
  });

  it("rejects non-Error thrown values", () => {
    expect(isInvalidSessionIdError(`invalid sessionId: x`, "x")).toBe(false);
    expect(isInvalidSessionIdError(null, "x")).toBe(false);
    expect(isInvalidSessionIdError(undefined, "x")).toBe(false);
  });

  it("rejects Error messages without the canonical fragment", () => {
    const err = new Error(`session "x" not found`);
    expect(isInvalidSessionIdError(err, "x")).toBe(false);
  });

  it("rejects artifactId-shaped throws (different fragment)", () => {
    const err = new Error(`invalid artifactId: x`);
    expect(isInvalidSessionIdError(err, "x")).toBe(false);
  });

  it("recognizes throws via live touchHeartbeat call (end-to-end contract proof)", async () => {
    const { touchHeartbeat } =
      await import("../../src/active-sessions/index.ts");
    let caught: unknown = null;
    try {
      touchHeartbeat({
        artifactId: "valid-id",
        // "../bad-sid" fails VALID_ID_REGEX (leading "." is non-alphanumeric
        // anchor; "/" is rejected). artifactId passes so the order-of-checks
        // reaches the sessionId throw.
        sessionId: "../bad-sid",
        artifactPath: "/tmp/x",
        now: Date.now(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(isInvalidSessionIdError(caught, "../bad-sid")).toBe(true);
  });
});
