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
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getMostRecentPeerKind,
  getMostRecentPeerMessageOfKind,
  getMostRecentPeerMessageWithBody,
} from "../../src/channels/peer-recent-message.ts";

// Per-test sandbox via mkdtemp under the OS tmpdir (NOT /tmp+pid): avoids the
// macOS /tmp -> /private/tmp realpath divergence + weak pid-uniqueness class
// (Slice-1 FINDING-1). mkdtemp gives a unique, realpath-stable dir per
// sandbox() call; the channels-dir env var is saved + restored so the suite
// never leaks CLAUDE_CONDUCTOR_CHANNELS_DIR to sibling test files.
const CHANNEL = "c-recent";
const PEER_A = "sess-a";
const PEER_B = "sess-b";

let sandboxDir: string;
let savedChannelsDir: string | undefined;

function sandbox(): void {
  savedChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  sandboxDir = mkdtempSync(join(tmpdir(), "peer-recent-message-"));
  mkdirSync(join(sandboxDir, CHANNEL), { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = sandboxDir;
}

function cleanup(): void {
  if (savedChannelsDir === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = savedChannelsDir;
  }
  if (sandboxDir !== undefined && existsSync(sandboxDir)) {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

function writeMessages(lines: readonly string[], trailingNewline = true): void {
  const content =
    lines.join("\n") + (trailingNewline && lines.length > 0 ? "\n" : "");
  writeFileSync(join(sandboxDir, CHANNEL, "messages.jsonl"), content, "utf-8");
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
    writeFileSync(join(sandboxDir, CHANNEL, "messages.jsonl"), "", "utf-8");
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

    const before = collectMtimes(sandboxDir);
    getMostRecentPeerKind(CHANNEL, PEER_A);
    getMostRecentPeerKind(CHANNEL, PEER_B);
    getMostRecentPeerKind(CHANNEL, "missing");
    const after = collectMtimes(sandboxDir);
    expect(after).toEqual(before);
  });
});

/**
 * Sibling helper — kind-filtered tail scan. Same shape + same failure
 * modes as `getMostRecentPeerKind` but skips messages whose kind does
 * not equal the filter. Used by Bravo's `live-update-reminder` hook to
 * find the most-recent live-update from the joining sibling (NOT the
 * most-recent message of any kind).
 */
describe("getMostRecentPeerMessageOfKind", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns the latest message of the filtered kind", () => {
    writeMessages([
      msg(PEER_A, "note"),
      msg(PEER_A, "live-update"),
      msg(PEER_A, "status"),
    ]);
    const result = getMostRecentPeerMessageOfKind(
      CHANNEL,
      PEER_A,
      "live-update",
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("live-update");
  });

  it("returns null when the filter matches no messages from peer", () => {
    writeMessages([msg(PEER_A, "note"), msg(PEER_A, "status")]);
    const result = getMostRecentPeerMessageOfKind(
      CHANNEL,
      PEER_A,
      "live-update",
    );
    expect(result).toBeNull();
  });

  it("returns null when peer never posted on channel (even if filter kind exists from others)", () => {
    writeMessages([msg(PEER_B, "live-update"), msg(PEER_B, "status")]);
    const result = getMostRecentPeerMessageOfKind(
      CHANNEL,
      PEER_A,
      "live-update",
    );
    expect(result).toBeNull();
  });

  it("walks past intervening non-matching messages to find the latest match", () => {
    // Older live-update + 3 newer non-matching → returns the OLDER live-update
    // (still the most-recent live-update from peer, just not the most-recent
    // message overall).
    writeMessages([
      msg(PEER_A, "live-update"),
      msg(PEER_A, "note"),
      msg(PEER_A, "note"),
      msg(PEER_A, "status"),
    ]);
    const result = getMostRecentPeerMessageOfKind(
      CHANNEL,
      PEER_A,
      "live-update",
    );
    expect(result?.kind).toBe("live-update");
  });

  it("returns null on empty channel (ENOENT path)", () => {
    const result = getMostRecentPeerMessageOfKind(
      "c-nonexistent",
      PEER_A,
      "live-update",
    );
    expect(result).toBeNull();
  });

  it("returns null when kindFilter is empty (defensive)", () => {
    writeMessages([msg(PEER_A, "note")]);
    const result = getMostRecentPeerMessageOfKind(CHANNEL, PEER_A, "");
    expect(result).toBeNull();
  });

  it("filters by canonical kind only (non-canonical bodies already rejected by validator)", () => {
    // A line with a non-canonical kind ("custom") would be rejected by
    // isChannelMessage in the shared scan, so even if the caller asked
    // for kindFilter="custom" the scan returns null.
    writeMessages([msg(PEER_A, "custom"), msg(PEER_A, "note")]);
    expect(
      getMostRecentPeerMessageOfKind(CHANNEL, PEER_A, "custom"),
    ).toBeNull();
    // Sanity: the canonical "note" IS findable from the same input.
    expect(getMostRecentPeerMessageOfKind(CHANNEL, PEER_A, "note")?.kind).toBe(
      "note",
    );
  });
});

/**
 * Body-returning sibling — same scan + failure modes as
 * `getMostRecentPeerMessageOfKind`, but resolves the message body (inline
 * or `body_ref` sidecar). First consumer: the #6 `live-update-reminder`
 * scope-to-parallel-marker fix, which inspects a present peer's most-recent
 * `status` body for the parallel-join marker.
 */
describe("getMostRecentPeerMessageWithBody", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns the inline body of the latest message of the filtered kind", () => {
    writeMessages([
      msg(PEER_A, "status", "first status"),
      msg(PEER_A, "note", "a note"),
      msg(PEER_A, "status", "joined channel in parallel context-load mode"),
    ]);
    const result = getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "status");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("status");
    expect(result?.body).toBe("joined channel in parallel context-load mode");
    expect(result?.body_read_error).toBeUndefined();
  });

  it("walks past intervening non-matching kinds to the latest matching body", () => {
    writeMessages([
      msg(PEER_A, "status", "the marker body"),
      msg(PEER_A, "note", "newer note"),
      msg(PEER_A, "roger", "newer roger"),
    ]);
    const result = getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "status");
    expect(result?.body).toBe("the marker body");
  });

  it("returns null when the filtered kind never appears from the peer", () => {
    writeMessages([msg(PEER_A, "note", "x"), msg(PEER_A, "roger", "y")]);
    expect(
      getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "status"),
    ).toBeNull();
  });

  it("returns null when kindFilter is empty (defensive, mirrors sibling)", () => {
    writeMessages([msg(PEER_A, "status", "x")]);
    expect(getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "")).toBeNull();
  });

  it("returns an inline empty-string body distinctly (not null, not undefined)", () => {
    writeMessages([msg(PEER_A, "status")]); // msg() defaults body=""
    const result = getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "status");
    expect(result).not.toBeNull();
    expect(result?.body).toBe("");
    expect(result?.body_read_error).toBeUndefined();
  });

  it("resolves a body_ref to its sidecar file content", () => {
    const ref = randomUUID();
    mkdirSync(join(sandboxDir, CHANNEL, "bodies"), { recursive: true });
    writeFileSync(
      join(sandboxDir, CHANNEL, "bodies", `${ref}.txt`),
      "resolved sidecar body",
      "utf-8",
    );
    writeMessages([
      JSON.stringify({
        ts: new Date().toISOString(),
        from: PEER_A,
        kind: "status",
        body_ref: ref,
      }),
    ]);
    const result = getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "status");
    expect(result?.body).toBe("resolved sidecar body");
    expect(result?.body_read_error).toBeUndefined();
  });

  it("surfaces body_read_error when a body_ref cannot be resolved", () => {
    const ref = randomUUID(); // valid id shape but NO sidecar file written
    writeMessages([
      JSON.stringify({
        ts: new Date().toISOString(),
        from: PEER_A,
        kind: "status",
        body_ref: ref,
      }),
    ]);
    const result = getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "status");
    expect(result).not.toBeNull();
    expect(result?.body).toBeUndefined();
    expect(result?.body_read_error).toContain(ref);
  });

  it("returns body_read_error (never throws) when the channelId is invalid for readBodyFile", () => {
    // tailScanForPeer finds the message (it joins paths without validating
    // the id), but readBodyFile rejects an id failing isValidArtifactId and
    // throws. The read-only helper MUST catch it and surface body_read_error
    // rather than throw out — a throw would break fail-open safety in the
    // hook lock contexts this helper is called from.
    const badChannel = "c recent"; // space => fails VALID_ID_REGEX
    const ref = randomUUID();
    mkdirSync(join(sandboxDir, badChannel), { recursive: true });
    writeFileSync(
      join(sandboxDir, badChannel, "messages.jsonl"),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        from: PEER_A,
        kind: "status",
        body_ref: ref,
      })}\n`,
      "utf-8",
    );
    const result = getMostRecentPeerMessageWithBody(
      badChannel,
      PEER_A,
      "status",
    );
    expect(result).not.toBeNull();
    expect(result?.body).toBeUndefined();
    expect(result?.body_read_error).toBeTruthy();
  });

  it("read-only invariant: resolving a body_ref performs zero fs writes", () => {
    const ref = randomUUID();
    mkdirSync(join(sandboxDir, CHANNEL, "bodies"), { recursive: true });
    writeFileSync(
      join(sandboxDir, CHANNEL, "bodies", `${ref}.txt`),
      "sidecar",
      "utf-8",
    );
    writeMessages([
      msg(PEER_A, "note", "n"),
      JSON.stringify({
        ts: new Date().toISOString(),
        from: PEER_A,
        kind: "status",
        body_ref: ref,
      }),
    ]);
    const before = collectMtimes(sandboxDir);
    getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "status");
    getMostRecentPeerMessageWithBody(CHANNEL, PEER_A, "note");
    getMostRecentPeerMessageWithBody(CHANNEL, "missing", "status");
    const after = collectMtimes(sandboxDir);
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
