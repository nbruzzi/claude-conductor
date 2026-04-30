// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — REV 0.2 ARCH-2 / RE-101 critical regression test.
 *
 * Proves that `touchHeartbeat`'s read-merge-write semantics preserve
 * the optional `dotfilesRoot` field across subsequent calls. Without
 * the merge (REV 0.1's overwrite-only behavior), the field written by
 * `setSentinelDotfilesRoot` would be wiped on the next dispatcher fire
 * (every PreToolUse re-touches heartbeats), breaking the substrate
 * end-to-end.
 *
 * Critical invariant: setSentinelDotfilesRoot → touchHeartbeat →
 * readSentinelDotfilesRoot returns the originally-written value.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactIdFromPath,
  readSentinelDotfilesRoot,
  setSentinelDotfilesRoot,
  touchHeartbeat,
} from "../../src/active-sessions/index.ts";

const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";
const DOTFILES_ROOT = "/Users/test/.claude-dotfiles-94a8058c";

let tmpDir: string;
let prevActiveSessionsDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ah-merge-"));
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
});

afterEach(() => {
  if (prevActiveSessionsDir === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function canonicalClaudeHomePath(): string {
  // Match production's effectiveHome() — process.env.HOME first, then
  // os.homedir(). The beforeEach doesn't override HOME for this test,
  // so this resolves the same in test + production.
  const home = process.env["HOME"] ?? homedir();
  return join(home, ".claude");
}

describe("touchHeartbeat — REV 0.2 ARCH-2 read-merge-write", () => {
  it("preserves dotfilesRoot across a subsequent touchHeartbeat call", () => {
    // 1. Pin the anchor.
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);

    // 2. Simulate a regular dispatcher fire — touchHeartbeat on the same
    //    artifact + sessionId. Without read-merge-write, this would clobber
    //    the dotfilesRoot field. With it, the field survives.
    const artifactPath = canonicalClaudeHomePath();
    const artifactId = artifactIdFromPath(artifactPath);
    touchHeartbeat({
      artifactId,
      sessionId: SID,
      artifactPath,
      now: Date.now(),
    });

    // 3. Field MUST still be present.
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);
  });

  it("preserves dotfilesRoot across multiple touchHeartbeat calls", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    const artifactPath = canonicalClaudeHomePath();
    const artifactId = artifactIdFromPath(artifactPath);

    for (let i = 0; i < 5; i++) {
      touchHeartbeat({
        artifactId,
        sessionId: SID,
        artifactPath,
        now: Date.now() + i * 1000,
      });
      expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);
    }
  });

  it("a heartbeat written before setSentinelDotfilesRoot has no field, then gains it on pin", () => {
    const artifactPath = canonicalClaudeHomePath();
    const artifactId = artifactIdFromPath(artifactPath);
    touchHeartbeat({
      artifactId,
      sessionId: SID,
      artifactPath,
      now: Date.now(),
    });
    // Pre-pin: no field.
    expect(readSentinelDotfilesRoot(SID)).toBeNull();

    // Pin: field appears.
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);
  });
});
