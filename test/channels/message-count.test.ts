// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `messageCount(channelId)` — the lightweight streaming-byte
 * newline-count primitive exposed on the channels public surface
 * (`claude-conductor/channels/api`).
 *
 * Semantic contract:
 *   - Counts COMPLETE `\n`-terminated JSONL records.
 *   - Mid-write trailing partial line (no final `\n`) is excluded.
 *   - Empty / missing channel returns 0.
 *   - RE-3 boundary guard mirrors the sibling read primitives.
 *
 * Per L991+ vault backlog 2026-05-19 batch — lightweight `messageCount`
 * primitive companion to `readMessages.length`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  createChannel,
  messageCount,
} from "../../src/channels/index.ts";

const SESSION_ID = "0dc53626-9afc-49d4-b799-b324e64e190d";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "messageCount-test-"));
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

/** Write a raw `messages.jsonl` for a channel, bypassing `appendMessage`.
 *  Used for tests that need to exercise specific byte-layout edge cases
 *  (mid-write partial trailing line, no-trailing-newline) that
 *  `appendMessage` would normalize away. */
function writeRawMessagesJsonl(channelId: string, content: string): void {
  const channelDir = join(tmpRoot, "channels", channelId);
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(join(channelDir, "messages.jsonl"), content);
}

describe("messageCount — semantic contract", () => {
  it("returns 0 for a missing channel file (no createChannel call)", async () => {
    expect(await messageCount("absent-channel")).toBe(0);
  });

  it("returns 0 for a newly-created channel with no messages.jsonl yet", async () => {
    await createChannel({
      channelId: "empty-after-create",
      handoffId: "empty-test",
      sessionId: SESSION_ID,
    });
    expect(await messageCount("empty-after-create")).toBe(0);
  });

  it("counts a single complete \\n-terminated record as 1", async () => {
    writeRawMessagesJsonl(
      "single-line",
      `{"ts":"2026-05-19T00:00:00.000Z","kind":"status","from":"x","body":"a"}\n`,
    );
    expect(await messageCount("single-line")).toBe(1);
  });

  it("counts N complete \\n-terminated records as N", async () => {
    const lines = [0, 1, 2].map(
      (i) =>
        `{"ts":"2026-05-19T00:00:0${i}.000Z","kind":"status","from":"x","body":"m${i}"}\n`,
    );
    writeRawMessagesJsonl("multi-line", lines.join(""));
    expect(await messageCount("multi-line")).toBe(3);
  });

  it("excludes a mid-write trailing partial line (no final \\n)", async () => {
    const complete =
      `{"ts":"2026-05-19T00:00:00.000Z","kind":"status","from":"x","body":"a"}\n` +
      `{"ts":"2026-05-19T00:00:01.000Z","kind":"status","from":"x","body":"b"}\n`;
    const partial = `{"ts":"2026-05-19T00:00:02.000Z","kind":"status","from`;
    writeRawMessagesJsonl("mid-write", complete + partial);
    expect(await messageCount("mid-write")).toBe(2);
  });

  it("counts records via the production write path (appendMessage roundtrip)", async () => {
    await createChannel({
      channelId: "roundtrip",
      handoffId: "roundtrip-test",
      sessionId: SESSION_ID,
    });
    for (let i = 0; i < 5; i += 1) {
      await appendMessage({
        channelId: "roundtrip",
        message: {
          ts: `2026-05-19T00:00:0${i}.000Z`,
          kind: "status",
          from: SESSION_ID,
          body: `msg-${i}`,
        },
      });
    }
    expect(await messageCount("roundtrip")).toBe(5);
  });

  it("counts UTF-8 multi-byte-content records correctly (LF byte unique to record boundaries)", async () => {
    // Non-ASCII content shouldn't trip the byte-level scan — LF (0x0A)
    // doesn't appear as a continuation byte in any multi-byte UTF-8
    // sequence, so the count equals the JS-string \n count exactly.
    writeRawMessagesJsonl(
      "utf8-content",
      `{"ts":"2026-05-19T00:00:00.000Z","kind":"status","from":"x","body":"café"}\n` +
        `{"ts":"2026-05-19T00:00:01.000Z","kind":"status","from":"x","body":"日本語"}\n` +
        `{"ts":"2026-05-19T00:00:02.000Z","kind":"status","from":"x","body":"🎉 emoji"}\n`,
    );
    expect(await messageCount("utf8-content")).toBe(3);
  });

  it("throws RE-3 boundary error on an invalid channelId", async () => {
    let caught: unknown = null;
    try {
      await messageCount("../etc");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("messageCount");
    expect((caught as Error).message).toContain("invalid channelId");
    expect((caught as Error).message).toContain(`"../etc"`);
  });

  it("RE-3 throw is classifiable via isInvalidChannelIdError export", async () => {
    // Cross-references boundary-errors.test.ts — pins the classifier
    // contract via the live throw on the new primitive.
    const { isInvalidChannelIdError } =
      await import("../../src/channels/api.ts");
    let caught: unknown = null;
    try {
      await messageCount("name with space");
    } catch (e) {
      caught = e;
    }
    expect(isInvalidChannelIdError(caught, "name with space")).toBe(true);
  });
});
