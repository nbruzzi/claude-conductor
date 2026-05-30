// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 6 Task #6 — the OPPORTUNISTIC reap honors `!paused`.
 *
 * reconcile-boot's `gc_eligible` predicate already protected deliberately-paused
 * sessions (`casRecheckFlip` -> "now-paused"), but the opportunistic reap paths
 * (`listLivePeers` PreToolUse GC + `gcStaleArtifacts` sweep) did NOT — a paused
 * session stops heartbeating, its mtime ages past GC_WINDOW_MS, and it would be
 * silently reaped (the item-4 pause-completeness gap). These tests pin the
 * protection: a paused session's aged-out heartbeat MUST survive both reap paths,
 * while an otherwise-identical unpaused one is still reaped (no GC regression).
 *
 * Aging is simulated by scanning with a `now` far in the future rather than by
 * back-dating file mtimes — the reap branch keys off `defensiveAgeMs(now, mtime)`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GC_WINDOW_MS,
  artifactIdFromPath,
  gcStaleArtifacts,
  listLivePeers,
  markSessionPaused,
  touchHeartbeat,
} from "../../src/active-sessions/index.ts";

const PAUSED = "11111111-1111-4111-8111-111111111111";
const UNPAUSED = "22222222-2222-4222-8222-222222222222";
const SELF = "00000000-0000-4000-8000-000000000000";

let tmpDir: string;
let prev: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reap-pause-"));
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

/** Match production effectiveHome(): HOME first, then os.homedir(). */
function homeArtifactPath(): string {
  return join(process.env["HOME"] ?? homedir(), ".claude");
}

/** Plant a session's canonical-claude-home anchor heartbeat (pause needs it). */
function anchor(sessionId: string, now: number): void {
  const artifactPath = homeArtifactPath();
  touchHeartbeat({
    artifactId: artifactIdFromPath(artifactPath),
    sessionId,
    artifactPath,
    now,
  });
}

function heartbeatPath(sessionId: string): string {
  return join(
    tmpDir,
    artifactIdFromPath(homeArtifactPath()),
    "heartbeats",
    sessionId,
  );
}

describe("opportunistic reap honors !paused (Cycle 6 Task #6)", () => {
  it("listLivePeers protects a paused session's aged-out heartbeat, still reaps an unpaused one", () => {
    const now = Date.now();
    anchor(PAUSED, now);
    anchor(UNPAUSED, now);
    markSessionPaused(PAUSED); // writes pausedAt on the canonical-home anchor

    expect(existsSync(heartbeatPath(PAUSED))).toBe(true);
    expect(existsSync(heartbeatPath(UNPAUSED))).toBe(true);

    // Scan far in the future so BOTH are aged past GC_WINDOW_MS -> reap branch.
    listLivePeers({
      artifactId: artifactIdFromPath(homeArtifactPath()),
      self: SELF,
      now: now + GC_WINDOW_MS + 60_000,
    });

    expect(existsSync(heartbeatPath(PAUSED))).toBe(true); // protected
    expect(existsSync(heartbeatPath(UNPAUSED))).toBe(false); // reaped
  });

  it("gcStaleArtifacts protects a paused session's aged-out heartbeat, still reaps an unpaused one", () => {
    const now = Date.now();
    anchor(PAUSED, now);
    anchor(UNPAUSED, now);
    markSessionPaused(PAUSED);

    const reaped = gcStaleArtifacts(now + GC_WINDOW_MS + 60_000);

    expect(existsSync(heartbeatPath(PAUSED))).toBe(true); // protected
    expect(existsSync(heartbeatPath(UNPAUSED))).toBe(false); // reaped
    expect(reaped.some((r) => r.endsWith(`/${UNPAUSED}`))).toBe(true);
    expect(reaped.some((r) => r.endsWith(`/${PAUSED}`))).toBe(false);
  });
});
