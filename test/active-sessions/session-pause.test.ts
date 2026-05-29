// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 6 item-4 — session pause/resume markers (F-b Model A).
 *
 * `markSessionPaused` writes `pausedAt` on the session's canonical-claude-home
 * ANCHOR heartbeat; `readSessionPausedAt` reads it back; `clearSessionPaused`
 * (resume) removes it. Pause is SESSION-state anchored on canonical-claude-home,
 * mirroring `setSentinelDotfilesRoot`'s anchor pattern (Option X).
 *
 * The load-bearing test here is the DISK ROUND-TRIP (`markSessionPaused` ->
 * `readSessionPausedAt`): it guards the `readOwnerRecord` deserialization-carry.
 * The write-side preserve (`mergeOwnerRecord`) is necessary but NOT sufficient —
 * if `readOwnerRecord` drops `pausedAt` on parse-back, the feature is silently
 * dead while typecheck stays green (a runtime data-flow gap, not a type error).
 * See feedback-incremental-roundtrip-test-for-stateful-adapters.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactIdFromPath,
  clearSessionPaused,
  markSessionPaused,
  readSentinelDotfilesRoot,
  readSessionPausedAt,
  setSentinelDotfilesRoot,
  touchHeartbeat,
} from "../../src/active-sessions/index.ts";

const SID = "7c9e2f1a-3b4d-4e5f-8a6b-1c2d3e4f5a6b";
const DOTFILES_ROOT = "/tmp/.claude-dotfiles-7c9e2f1a";

let tmpDir: string;
let prev: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-pause-"));
  prev = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
});

afterEach(() => {
  if (prev === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prev;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Match production's effectiveHome(): HOME first, then os.homedir(). */
function canonicalClaudeHomePath(): string {
  return join(process.env["HOME"] ?? homedir(), ".claude");
}

/** Create the session's canonical-claude-home anchor heartbeat (pause needs it). */
function anchorSession(sessionId: string): void {
  const artifactPath = canonicalClaudeHomePath();
  touchHeartbeat({
    artifactId: artifactIdFromPath(artifactPath),
    sessionId,
    artifactPath,
    now: Date.now(),
  });
}

describe("session pause/resume markers (Cycle 6 item-4)", () => {
  it("markSessionPaused -> readSessionPausedAt ROUND-TRIPS through disk (guards readOwnerRecord carry)", () => {
    anchorSession(SID);
    expect(readSessionPausedAt(SID)).toBeNull(); // not paused yet

    const before = Date.now();
    markSessionPaused(SID);
    const after = Date.now();

    const paused = readSessionPausedAt(SID);
    // Non-null proves readOwnerRecord carried `pausedAt` back from disk; the
    // [before, after] window proves it's the real write timestamp.
    expect(paused).not.toBeNull();
    expect(paused).toBeGreaterThanOrEqual(before);
    expect(paused).toBeLessThanOrEqual(after);
  });

  it("clearSessionPaused (resume) removes the marker — Model A deliberate resume", () => {
    anchorSession(SID);
    markSessionPaused(SID);
    expect(readSessionPausedAt(SID)).not.toBeNull();

    clearSessionPaused(SID);
    expect(readSessionPausedAt(SID)).toBeNull();
  });

  it("markSessionPaused is a no-op when the session has no anchor heartbeat", () => {
    // No anchorSession() — a session with no presence cannot be paused.
    markSessionPaused(SID);
    expect(readSessionPausedAt(SID)).toBeNull();
  });

  it("pausing PRESERVES an existing dotfilesRoot sentinel (mergeOwnerRecord class-closure)", () => {
    anchorSession(SID);
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);

    markSessionPaused(SID);

    // Both optional fields coexist — neither write clobbers the other.
    expect(readSessionPausedAt(SID)).not.toBeNull();
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);
  });

  it("resuming (clearSessionPaused) clears ONLY pausedAt — dotfilesRoot survives", () => {
    anchorSession(SID);
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    markSessionPaused(SID);

    clearSessionPaused(SID);

    expect(readSessionPausedAt(SID)).toBeNull(); // pause cleared
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT); // sentinel intact
  });
});
