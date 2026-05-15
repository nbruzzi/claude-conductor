// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `getMostRecentPeerKind` — plan v2 Lane A.2 RE-3 fold.
 *
 * Per plan v2 §Test surface — covers:
 *   - happy path (returns latest peer kind)
 *   - peer never posted → null
 *   - ENOENT messages.jsonl → null
 *   - malformed JSON line tolerated (skip)
 *   - non-canonical kind tolerated (skip — isChannelMessage rejects)
 *   - trailing partial-line (no `\n`) dropped
 *   - multi-peer mixed-stream returns peer-of-interest's most recent
 *   - corrupt + valid mix returns valid
 *   - empty file → null
 *   - empty input → null
 *   - regression: zero fs writes during call
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getMostRecentPeerKind } from "../../src/channels/peer-recent-message.ts";

const SANDBOX = `/tmp/test-peer-recent-message-${process.pid}`;
const CHANNEL = "c-recent";
const PEER_A = "sess-a";
const PEER_B = "sess-b";

function sandbox(): void {
  cleanup();
  mkdirSync(join(SANDBOX, CHANNEL), { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

function writeMessages(lines: readonly string[], trailingNewline = true): void {
  const content =
    lines.join("\n") + (trailingNewline && lines.length > 0 ? "\n" : "");
  writeFileSync(join(SANDBOX, CHANNEL, "messages.jsonl"), content, "utf-8");
}

function msg(from: string, kind: string, body = ""): string {
  return JSON.stringify({ ts: new Date().toISOString(), from, kind, body });
}

describe("getMostRecentPeerKind", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns latest peer message kind on happy path", () => {
    writeMessages([msg(PEER_A, "note"), msg(PEER_A, "status")]);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("status");
  });

  it("returns null when peer never posted on channel", () => {
    writeMessages([msg(PEER_B, "note"), msg(PEER_B, "status")]);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result).toBeNull();
  });

  it("returns null when messages.jsonl ENOENT (channel has no posts yet)", () => {
    // Don't create messages.jsonl — sandbox has only the channel dir.
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result).toBeNull();
  });

  it("returns null when channel directory itself does not exist", () => {
    const result = getMostRecentPeerKind("c-nonexistent", PEER_A);
    expect(result).toBeNull();
  });

  it("tolerates malformed JSON line (skips it)", () => {
    writeMessages([
      msg(PEER_A, "note"),
      "{not-valid-json",
      msg(PEER_A, "standby"),
    ]);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result?.kind).toBe("standby");
  });

  it("rejects non-canonical kinds via isChannelMessage (returns earlier valid match)", () => {
    writeMessages([
      msg(PEER_A, "note"),
      // "fake-kind" is NOT in CHANNEL_KINDS — isChannelMessage rejects.
      msg(PEER_A, "fake-kind"),
    ]);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result?.kind).toBe("note");
  });

  it("drops trailing partial line without newline (mid-append safety)", () => {
    // Last line is JSON-valid but file does NOT end in `\n` — treat as
    // potentially mid-write, drop it; return the earlier message.
    const valid = msg(PEER_A, "roger");
    const truncatedLast = msg(PEER_A, "standby");
    writeMessages([valid, truncatedLast], /* trailingNewline */ false);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result?.kind).toBe("roger");
  });

  it("returns most-recent from peer-of-interest when other peers also posted", () => {
    writeMessages([
      msg(PEER_A, "note"),
      msg(PEER_B, "status"),
      msg(PEER_A, "out"),
      msg(PEER_B, "ack"),
    ]);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result?.kind).toBe("out");
  });

  it("scans bottom-up; corrupt-then-valid mix returns the valid one", () => {
    writeMessages([
      msg(PEER_A, "note"),
      msg(PEER_A, "roger"),
      "garbage",
      "{partial: json",
      "",
    ]);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result?.kind).toBe("roger");
  });

  it("returns null when peer's only messages are validator-rejected", () => {
    writeMessages([
      msg(PEER_B, "note"),
      JSON.stringify({ from: PEER_A, ts: "now" }), // missing kind → isChannelMessage rejects
      msg(PEER_B, "status"),
    ]);
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result).toBeNull();
  });

  it("handles empty messages.jsonl file (zero bytes) → null", () => {
    writeFileSync(join(SANDBOX, CHANNEL, "messages.jsonl"), "", "utf-8");
    const result = getMostRecentPeerKind(CHANNEL, PEER_A);
    expect(result).toBeNull();
  });

  it("returns null for empty input parameters (defensive)", () => {
    expect(getMostRecentPeerKind("", PEER_A)).toBeNull();
    expect(getMostRecentPeerKind(CHANNEL, "")).toBeNull();
  });

  it("regression: zero fs writes during call (read-only invariant)", () => {
    writeMessages([
      msg(PEER_A, "note"),
      msg(PEER_B, "status"),
      msg(PEER_A, "standby"),
    ]);

    const before = collectMtimes(SANDBOX);
    getMostRecentPeerKind(CHANNEL, PEER_A);
    getMostRecentPeerKind(CHANNEL, PEER_B);
    getMostRecentPeerKind(CHANNEL, "missing");
    const after = collectMtimes(SANDBOX);
    expect(after).toEqual(before);
  });
});

function collectMtimes(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  walk(root, root, out);
  return out;
}

function walk(root: string, dir: string, out: Record<string, number>): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (ent.isFile()) {
      const rel = full.slice(root.length + 1);
      out[rel] = statSync(full).mtimeMs;
    }
  }
}
