// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Paired contract test for the `isInvalidChannelIdError` classifier exposed
 * on the channels public surface (`claude-conductor/channels/api`).
 *
 * Pinning convention per
 * `feedback-cross-edge-contract-via-paired-tests.md`:
 *   - Conductor side asserts (1) the classifier recognizes every channel-
 *     module RE-3 boundary throw produced by an exported read/write fn,
 *     (2) it correctly rejects non-matching throws (different channelId,
 *     non-Error values, unrelated Error messages).
 *   - Dashboard side (separate repo, `channel-stream.test.ts` consumer
 *     migration PR) re-imports `isInvalidChannelIdError` from this surface
 *     and asserts the adapter classifier path uses the substrate primitive,
 *     not an inline string-match.
 *
 * Companion file `api-channelid-guards.test.ts` already pins the wire-
 * shape contract from the throw side (13+ fns × 7 bad-id values). This
 * file pins the classifier side — together they form the paired bidir
 * contract that the L991+ backlog item asked for.
 */
import { describe, expect, it } from "bun:test";

import {
  INVALID_CHANNEL_ID_MESSAGE_FRAGMENT,
  isInvalidChannelIdError,
} from "../../src/channels/api.ts";

describe("isInvalidChannelIdError classifier", () => {
  it("exports the canonical wire-shape fragment used by all RE-3 throws", () => {
    // The substrate guarantee — every RE-3 boundary throw contains this
    // exact substring. The api-channelid-guards.test.ts file pins that
    // from the throw side; we re-assert here for callers who reach the
    // classifier without first inspecting the throws.
    expect(INVALID_CHANNEL_ID_MESSAGE_FRAGMENT).toBe("invalid channelId");
  });

  it("recognizes channels/index.ts readMessages-shaped throw", () => {
    const err = new Error(
      `[channels] readMessages: invalid channelId "../etc" — must match isValidArtifactId pattern`,
    );
    expect(isInvalidChannelIdError(err, "../etc")).toBe(true);
  });

  it("recognizes channels/index.ts readMessagesTail-shaped throw", () => {
    const err = new Error(
      `[channels] readMessagesTail: invalid channelId "" — must match isValidArtifactId pattern`,
    );
    expect(isInvalidChannelIdError(err, "")).toBe(true);
  });

  it("recognizes channels/index.ts readMessagesAfter-shaped throw", () => {
    const err = new Error(
      `[channels] readMessagesAfter: invalid channelId "name with space" — must match isValidArtifactId pattern`,
    );
    expect(isInvalidChannelIdError(err, "name with space")).toBe(true);
  });

  it("recognizes channels/identity.ts claimIdentity-shaped throw", () => {
    const err = new Error(
      `[channels-identity] invalid channelId "/abs" — must match isValidArtifactId pattern`,
    );
    expect(isInvalidChannelIdError(err, "/abs")).toBe(true);
  });

  it("recognizes channels/identity.ts getIdentityForSession-shaped throw", () => {
    const err = new Error(
      `[channels-identity] getIdentityForSession: invalid channelId "a/b" — must match isValidArtifactId pattern`,
    );
    expect(isInvalidChannelIdError(err, "a/b")).toBe(true);
  });

  it("recognizes channels/identity.ts releaseIdentity-shaped throw", () => {
    const err = new Error(
      `[channels-identity] releaseIdentity: invalid channelId ".." — must match isValidArtifactId pattern`,
    );
    expect(isInvalidChannelIdError(err, "..")).toBe(true);
  });

  it("recognizes channels/identity.ts claimIdentityNamed-shaped throw", () => {
    const err = new Error(
      `[channels-identity] claimIdentityNamed: invalid channelId "../sibling" — must match isValidArtifactId pattern`,
    );
    expect(isInvalidChannelIdError(err, "../sibling")).toBe(true);
  });

  it("rejects throws whose quoted id does NOT match the queried id", () => {
    const err = new Error(
      `[channels] readMessages: invalid channelId "../wrong" — must match isValidArtifactId pattern`,
    );
    // Caller queried for "expected-id" but the throw quoted a different
    // value — classifier returns false. Prevents misattributing one
    // call's throw to a sibling call's id.
    expect(isInvalidChannelIdError(err, "expected-id")).toBe(false);
  });

  it("rejects non-Error thrown values", () => {
    expect(isInvalidChannelIdError(`invalid channelId "x"`, "x")).toBe(false);
    expect(isInvalidChannelIdError(null, "x")).toBe(false);
    expect(isInvalidChannelIdError(undefined, "x")).toBe(false);
    expect(
      isInvalidChannelIdError({ message: 'invalid channelId "x"' }, "x"),
    ).toBe(false);
  });

  it("rejects Error messages without the canonical fragment", () => {
    const err = new Error(`channel "x" not found`);
    expect(isInvalidChannelIdError(err, "x")).toBe(false);
  });

  it("recognizes throws via live readMessages call (end-to-end contract proof)", async () => {
    // End-to-end contract proof — call the real read primitive with a
    // bad id, catch the throw, classify via the new export. This binds
    // the classifier to the conductor-emitted wire shape so changes to
    // either side without the other surface immediately at test time.
    const { readMessages } = await import("../../src/channels/index.ts");
    let caught: unknown = null;
    try {
      readMessages("../etc");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(isInvalidChannelIdError(caught, "../etc")).toBe(true);
  });
});
