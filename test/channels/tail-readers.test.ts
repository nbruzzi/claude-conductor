// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `readMessagesTail` + `readMessagesAfter` — the two new
 * incremental-read primitives added so external consumers (notably the
 * claude-conductor-dashboard channel-stream adapter) can read a bounded
 * tail or read messages strictly after a last-seen timestamp without
 * loading the full transcript at the call site.
 *
 * Scope:
 *   - readMessagesTail: happy / empty channel / limit > total / limit = 0
 *     / limit < 0 / RE-3 boundary guard.
 *   - readMessagesAfter: happy (middle ts) / empty channel / afterTs >
 *     newest (no match) / afterTs < oldest (returns all) / afterTs
 *     exactly equals a message ts (strict-greater excludes it) / RE-3
 *     boundary guard.
 *   - Wire-format invariant: setup writes via `appendMessage` so the
 *     readers exercise the same JSONL line shape conductor emits — paired
 *     contract surface for dashboard's spec §5.7.
 *
 * Plan: Phase -1 of dashboard implementation plan
 * (~/.claude/plans/conductor-dashboard-implementation-2026-05-18.md),
 * Delta lane `delta/dashboard-prereq-exports`. Per
 * `feedback-cross-edge-contract-via-paired-tests`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  createChannel,
  readMessagesAfter,
  readMessagesTail,
} from "../../src/channels/index.ts";

const SESSION_ID = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tail-readers-test-"));
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

/**
 * Deterministic ts for the Nth populated message. Keeps tests free of
 * array indexing + non-null assertions while staying aligned with the
 * formula in `populate`.
 */
function tsAt(i: number): string {
  return `2026-05-18T20:00:${String(i).padStart(2, "0")}.000Z`;
}

/**
 * Populate a channel with `count` status messages whose timestamps step
 * by 1 second each (per `tsAt`).
 */
async function populate(channelId: string, count: number): Promise<void> {
  await createChannel({
    channelId,
    handoffId: "tail-readers-test",
    sessionId: SESSION_ID,
  });
  for (let i = 0; i < count; i++) {
    await appendMessage({
      channelId,
      message: {
        ts: tsAt(i),
        kind: "status",
        from: SESSION_ID,
        body: `msg-${i}`,
      },
    });
  }
}

describe("readMessagesTail — happy + bounds", () => {
  it("returns the last N messages in order when limit < total", async () => {
    await populate("tail-happy", 5);
    const result = readMessagesTail("tail-happy", 3);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.body)).toEqual(["msg-2", "msg-3", "msg-4"]);
  });

  it("returns [] for an empty channel (no messages.jsonl)", async () => {
    await createChannel({
      channelId: "tail-empty",
      handoffId: "tail-empty",
      sessionId: SESSION_ID,
    });
    expect(readMessagesTail("tail-empty", 10)).toEqual([]);
  });

  it("returns all messages when limit > total", async () => {
    await populate("tail-overshoot", 3);
    const result = readMessagesTail("tail-overshoot", 100);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.body)).toEqual(["msg-0", "msg-1", "msg-2"]);
  });

  it("returns [] when limit === 0", async () => {
    await populate("tail-zero", 5);
    expect(readMessagesTail("tail-zero", 0)).toEqual([]);
  });

  it("returns [] when limit is negative", async () => {
    await populate("tail-neg", 5);
    expect(readMessagesTail("tail-neg", -3)).toEqual([]);
  });
});

describe("readMessagesTail — boundary guard (RE-3)", () => {
  it("throws on invalid channelId (path-traversal)", () => {
    expect(() => readMessagesTail("../escape", 5)).toThrow(
      /readMessagesTail.*invalid channelId/,
    );
  });

  it("throws on invalid channelId (empty string)", () => {
    expect(() => readMessagesTail("", 5)).toThrow(
      /readMessagesTail.*invalid channelId/,
    );
  });
});

describe("readMessagesAfter — happy + boundaries", () => {
  it("returns messages strictly after the given ts (middle)", async () => {
    await populate("after-happy", 5);
    // After msg-1's ts → should include msg-2, msg-3, msg-4
    const result = readMessagesAfter("after-happy", tsAt(1));
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.body)).toEqual(["msg-2", "msg-3", "msg-4"]);
  });

  it("returns [] for an empty channel", async () => {
    await createChannel({
      channelId: "after-empty",
      handoffId: "after-empty",
      sessionId: SESSION_ID,
    });
    expect(
      readMessagesAfter("after-empty", "2026-05-18T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("returns [] when afterTs is >= the newest message ts", async () => {
    await populate("after-future", 5);
    // Exact match to newest (msg-4) → strict-greater excludes it
    expect(readMessagesAfter("after-future", tsAt(4))).toEqual([]);
    // afterTs strictly greater than newest → also empty
    expect(
      readMessagesAfter("after-future", "2026-05-19T00:00:00.000Z"),
    ).toEqual([]);
  });

  it("returns all messages when afterTs is < the oldest message ts", async () => {
    await populate("after-past", 4);
    const result = readMessagesAfter("after-past", "2026-05-17T00:00:00.000Z");
    expect(result).toHaveLength(4);
    expect(result.map((m) => m.body)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
  });

  it("strict-greater semantics — exact-match excludes that message", async () => {
    await populate("after-exact", 3);
    // afterTs == msg-0's ts → returns msg-1 + msg-2 (not msg-0)
    const result = readMessagesAfter("after-exact", tsAt(0));
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.body)).toEqual(["msg-1", "msg-2"]);
  });
});

describe("readMessagesAfter — boundary guard (RE-3)", () => {
  it("throws on invalid channelId (path-traversal)", () => {
    expect(() =>
      readMessagesAfter("../escape", "2026-05-18T00:00:00.000Z"),
    ).toThrow(/readMessagesAfter.*invalid channelId/);
  });

  it("throws on invalid channelId (empty string)", () => {
    expect(() => readMessagesAfter("", "2026-05-18T00:00:00.000Z")).toThrow(
      /readMessagesAfter.*invalid channelId/,
    );
  });
});
