// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * RE-3 boundary-guard tests — every exported channels-module function
 * that accepts a `channelId` (or `id`) parameter must throw on a value
 * that fails `isValidArtifactId`.
 *
 * Plan: ~/.claude/plans/mirrored-stitching-orchid.md A3.
 *
 * Pattern: mirror `active-sessions/index.ts:341` boundary discipline.
 * Catches future contributors who add a new exported fn without the
 * guard — adding such a fn but skipping the guard would silently allow
 * `..`/path-traversal/empty-string into filesystem-path constructors.
 *
 * Coverage: 13 newly-guarded fns × representative bad-id values.
 * Pre-existing guards (commitIdentityClaim, removeIdentityClaim,
 * closeStalePeerIdentity, claimNamedIdentityWithLock, setIdentityRole,
 * readLastSeenCursor, writeLastSeenCursor, clearLastSeenCursor,
 * isChannelArchived, resolveLastSeenDir, resolveLegacyLastSeenDir,
 * resolveLastSeenCursorPath) are covered by their own existing tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  archiveChannel,
  closeChannel,
  createChannel,
  heartbeatMtime,
  joinChannel,
  newestHeartbeatMtime,
  readBodyFile,
  readHeartbeatBody,
  readMessages,
  readMetadata,
  touchHeartbeat,
  withMetadataLock,
} from "../../src/channels/index.ts";

const SESSION_ID = "0dc53626-9afc-49d4-b799-b324e64e190d";
const BAD_IDS = ["", "..", "../sibling", "/abs", "a/b", "name with space", "."];

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-a3-guards-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
  process.env["CLAUDE_SESSION_ID"] = SESSION_ID;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
  if (prevSessionId !== undefined) {
    process.env["CLAUDE_SESSION_ID"] = prevSessionId;
  } else {
    delete process.env["CLAUDE_SESSION_ID"];
  }
});

/** Unify sync-throw + async-reject into a single assertion shape. */
async function expectGuardThrows(
  fnName: string,
  badId: string,
  invoke: () => unknown | Promise<unknown>,
): Promise<void> {
  let caught: unknown = null;
  try {
    const ret = invoke();
    if (ret instanceof Promise) await ret;
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeNull();
  const message = (caught as Error).message;
  expect(message).toContain(fnName);
  expect(message).toContain("invalid channelId");
  expect(message).toContain(`"${badId}"`);
  expect(message).toContain("isValidArtifactId");
}

describe("RE-3 boundary guards on channels module API (slice 6 / A3)", () => {
  describe.each(BAD_IDS)("bad id %p rejected by every guarded fn", (badId) => {
    it("withMetadataLock", async () => {
      await expectGuardThrows("withMetadataLock", badId, () =>
        withMetadataLock(badId, () => null),
      );
    });
    it("readMetadata", async () => {
      await expectGuardThrows("readMetadata", badId, () => readMetadata(badId));
    });
    it("readBodyFile", async () => {
      await expectGuardThrows("readBodyFile", badId, () =>
        readBodyFile(badId, "ref"),
      );
    });
    it("createChannel", async () => {
      await expectGuardThrows("createChannel", badId, () =>
        createChannel({
          channelId: badId,
          handoffId: "x",
          sessionId: SESSION_ID,
        }),
      );
    });
    it("joinChannel", async () => {
      await expectGuardThrows("joinChannel", badId, () =>
        joinChannel({ channelId: badId, sessionId: SESSION_ID }),
      );
    });
    it("closeChannel", async () => {
      await expectGuardThrows("closeChannel", badId, () =>
        closeChannel({ channelId: badId, sessionId: SESSION_ID }),
      );
    });
    it("appendMessage", async () => {
      await expectGuardThrows("appendMessage", badId, () =>
        appendMessage({
          channelId: badId,
          message: {
            ts: new Date().toISOString(),
            from: SESSION_ID,
            kind: "status",
          },
        }),
      );
    });
    it("readMessages", async () => {
      await expectGuardThrows("readMessages", badId, () => readMessages(badId));
    });
    it("touchHeartbeat", async () => {
      await expectGuardThrows("touchHeartbeat", badId, () =>
        touchHeartbeat(badId, SESSION_ID),
      );
    });
    it("heartbeatMtime", async () => {
      await expectGuardThrows("heartbeatMtime", badId, () =>
        heartbeatMtime(badId, SESSION_ID),
      );
    });
    it("readHeartbeatBody", async () => {
      await expectGuardThrows("readHeartbeatBody", badId, () =>
        readHeartbeatBody(badId, SESSION_ID),
      );
    });
    it("newestHeartbeatMtime", async () => {
      await expectGuardThrows("newestHeartbeatMtime", badId, () =>
        newestHeartbeatMtime(badId),
      );
    });
    it("archiveChannel", async () => {
      await expectGuardThrows("archiveChannel", badId, () =>
        archiveChannel(badId),
      );
    });
  });
});
