// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `~/.claude/channels/LATEST` aggregate-pointer symlink regression.
 *
 * Backlog L143 — sibling to `~/.claude/handoffs/LATEST.md`. LATEST symlinks
 * to the channel directory of the most-recently-active channel (touched on
 * `createChannel` + `appendMessage`; cleared on `closeChannel` +
 * `archiveChannel` if it points to the channel being closed/archived).
 *
 * Assertion axes:
 *   (a) `createChannel` writes LATEST pointing to the new channel.
 *   (b) `appendMessage` re-targets LATEST when the active channel changes.
 *   (c) `closeChannel` clears LATEST iff it pointed at the closing channel.
 *   (d) `closeChannel` does NOT clear LATEST when it points elsewhere
 *       (race-protection — peer A's close should not clobber peer B's
 *       active LATEST pointer).
 *   (e) `archiveChannel` clears LATEST defensively when it pointed there.
 *   (f) Concurrent `createChannel` racers both succeed; LATEST resolves to
 *       one of them (atomic mkstemp+rename per L143 concern (i)).
 *   (g) `resolveLatestSymlinkPath` returns the expected path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  archiveChannel,
  closeChannel,
  createChannel,
  resolveChannelsDir,
  resolveLatestSymlinkPath,
  type ChannelMessage,
} from "../../src/channels/index.ts";

const SESSION_A = "sess-latest-a";
const SESSION_B = "sess-latest-b";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-latest-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = tmpRoot;
});

afterEach(() => {
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
  rmSync(tmpRoot, { recursive: true, force: true });
});

function msg(
  from: string,
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    ts: new Date().toISOString(),
    from,
    kind: "note",
    body: "hello",
    ...overrides,
  };
}

function readLatest(): string | null {
  const path = resolveLatestSymlinkPath();
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) return null;
  return readlinkSync(path);
}

describe("channels LATEST symlink primitive (L143)", () => {
  it("(a) createChannel writes LATEST pointing to the new channel directory", async () => {
    await createChannel({
      channelId: "c-create",
      handoffId: "c-create",
      sessionId: SESSION_A,
    });
    const target = readLatest();
    expect(target).toBe(join(resolveChannelsDir(), "c-create"));
  });

  it("(b) appendMessage re-targets LATEST to the channel just written to", async () => {
    await createChannel({
      channelId: "c-first",
      handoffId: "c-first",
      sessionId: SESSION_A,
    });
    await createChannel({
      channelId: "c-second",
      handoffId: "c-second",
      sessionId: SESSION_B,
    });
    expect(readLatest()).toBe(join(resolveChannelsDir(), "c-second"));
    // Send a message on the older channel — LATEST should follow the activity.
    await appendMessage({
      channelId: "c-first",
      message: msg(SESSION_A),
    });
    expect(readLatest()).toBe(join(resolveChannelsDir(), "c-first"));
  });

  it("(c) closeChannel clears LATEST when it points at the closing channel", async () => {
    await createChannel({
      channelId: "c-closing",
      handoffId: "c-closing",
      sessionId: SESSION_A,
    });
    expect(readLatest()).toBe(join(resolveChannelsDir(), "c-closing"));
    await closeChannel({ channelId: "c-closing", sessionId: SESSION_A });
    expect(readLatest()).toBeNull();
  });

  it("(d) closeChannel does NOT clear LATEST when it points elsewhere", async () => {
    await createChannel({
      channelId: "c-other",
      handoffId: "c-other",
      sessionId: SESSION_A,
    });
    await createChannel({
      channelId: "c-active",
      handoffId: "c-active",
      sessionId: SESSION_B,
    });
    // LATEST → c-active now. Closing c-other must not touch LATEST.
    expect(readLatest()).toBe(join(resolveChannelsDir(), "c-active"));
    await closeChannel({ channelId: "c-other", sessionId: SESSION_A });
    expect(readLatest()).toBe(join(resolveChannelsDir(), "c-active"));
  });

  it("(e) archiveChannel clears LATEST defensively when it pointed at the archived channel", async () => {
    await createChannel({
      channelId: "c-archiving",
      handoffId: "c-archiving",
      sessionId: SESSION_A,
    });
    expect(readLatest()).toBe(join(resolveChannelsDir(), "c-archiving"));
    archiveChannel("c-archiving");
    expect(readLatest()).toBeNull();
  });

  it("(f) concurrent createChannel racers — LATEST resolves to one of them, neither errors", async () => {
    // Issue two creates in parallel; resolveLatest must return one of the
    // two channel dirs (atomic mkstemp+rename — no torn writes).
    const [a, b] = await Promise.all([
      createChannel({
        channelId: "c-race-a",
        handoffId: "c-race-a",
        sessionId: SESSION_A,
      }),
      createChannel({
        channelId: "c-race-b",
        handoffId: "c-race-b",
        sessionId: SESSION_B,
      }),
    ]);
    expect(a.handoff_id).toBe("c-race-a");
    expect(b.handoff_id).toBe("c-race-b");
    const target = readLatest();
    expect(target).not.toBeNull();
    const aPath = join(resolveChannelsDir(), "c-race-a");
    const bPath = join(resolveChannelsDir(), "c-race-b");
    // After the non-null assertion, narrow for toContain's `string` overload.
    expect([aPath, bPath]).toContain(target as string);
  });

  it("(g) resolveLatestSymlinkPath returns <channelsDir>/LATEST", () => {
    const path = resolveLatestSymlinkPath();
    expect(path).toBe(join(resolveChannelsDir(), "LATEST"));
  });
});
