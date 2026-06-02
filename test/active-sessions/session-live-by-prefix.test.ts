// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `isSessionLiveByPrefix` — cross-artifact liveness probe by sid-prefix.
 *
 * Regression coverage for the 2026-06-02 4/4 live-worktree-reap (backlog
 * L1049). The worktree reapers (`dotfiles-worktree-gc` / `repo-worktree-gc`)
 * used to scan ONLY the `~/.claude` ANCHOR artifact's heartbeats. But per-tool
 * heartbeats land on the session's CWD artifact (its worktree dir), NOT the
 * anchor — so a live session editing files is fresh on its cwd artifact while
 * its anchor aged out, and the anchor-only scan reaped its LIVE worktree. This
 * probe scans ALL artifacts.
 *
 * The first test ("fresh ONLY on a non-anchor artifact ⇒ live") is the
 * load-bearing 4/4 regression AND the Q4 acceptance canary: a tool-active
 * session (fresh on its cwd worktree artifact, anchor stale/absent) survives
 * the reaper's liveness gate.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GC_WINDOW_MS,
  isSessionLiveByPrefix,
} from "../../src/active-sessions/index.ts";

const SESSIONS_ENV = "CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR";
const NOW = 1_800_000_000_000;

let sessionsDir: string;
let prevSessions: string | undefined;

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "live-by-prefix-"));
  prevSessions = process.env[SESSIONS_ENV];
  process.env[SESSIONS_ENV] = sessionsDir;
});

afterEach(() => {
  if (prevSessions === undefined) delete process.env[SESSIONS_ENV];
  else process.env[SESSIONS_ENV] = prevSessions;
  try {
    rmSync(sessionsDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Write a heartbeat under `<sessionsDir>/<artifactId>/heartbeats/<sessionId>`
 *  with mtime = NOW - ageMs (mirrors reconcile-boot-worktree.test.ts). */
function writeHeartbeat(
  artifactId: string,
  sessionId: string,
  ageMs: number,
): void {
  const dir = join(sessionsDir, artifactId, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(
    path,
    JSON.stringify({
      sessionId,
      pid: 4242,
      host: hostname(),
      createdAt: NOW - ageMs,
      touchedAt: NOW - ageMs,
    }),
  );
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

const FULL_SID = "abcd1234-0000-4000-8000-000000000001";
const PREFIX = "abcd1234";

describe("isSessionLiveByPrefix — cross-artifact liveness by sid-prefix", () => {
  it("L1049 REGRESSION: fresh ONLY on a NON-anchor artifact ⇒ live (anchor-only scan would have reaped it)", () => {
    // No ~/.claude anchor heartbeat at all; the session's cwd worktree
    // artifact ("work") is fresh — the exact 4/4 live-reap scenario.
    writeHeartbeat("work", FULL_SID, 0);
    expect(isSessionLiveByPrefix(PREFIX, NOW)).toBe(true);
  });

  it("ANY fresh artifact wins: anchor stale, cwd artifact fresh ⇒ live", () => {
    writeHeartbeat("anchor", FULL_SID, GC_WINDOW_MS * 2); // anchor long-stale
    writeHeartbeat("work", FULL_SID, 0); // cwd fresh
    expect(isSessionLiveByPrefix(PREFIX, NOW)).toBe(true);
  });

  it("fresh within GC_WINDOW_MS ⇒ live; strictly beyond it ⇒ not live", () => {
    writeHeartbeat("work", FULL_SID, GC_WINDOW_MS - 1);
    expect(isSessionLiveByPrefix(PREFIX, NOW)).toBe(true);
    writeHeartbeat("work", FULL_SID, GC_WINDOW_MS + 1); // overwrite stale
    expect(isSessionLiveByPrefix(PREFIX, NOW)).toBe(false);
  });

  it("no heartbeat matches the prefix ⇒ not live (truly-dead worktree → reapable)", () => {
    // A fresh heartbeat for a DIFFERENT prefix must not protect this one.
    writeHeartbeat("work", "ffff9999-0000-4000-8000-000000000002", 0);
    expect(isSessionLiveByPrefix(PREFIX, NOW)).toBe(false);
  });

  it("all matching heartbeats stale across every artifact ⇒ not live", () => {
    writeHeartbeat("anchor", FULL_SID, GC_WINDOW_MS + 1);
    writeHeartbeat("work", FULL_SID, GC_WINDOW_MS + 5);
    expect(isSessionLiveByPrefix(PREFIX, NOW)).toBe(false);
  });

  it("empty prefix ⇒ false even with fresh heartbeats present (no match-all)", () => {
    writeHeartbeat("work", FULL_SID, 0);
    expect(isSessionLiveByPrefix("", NOW)).toBe(false);
  });

  it("respects a caller-supplied windowMs (repo-worktree-gc per-repo threshold)", () => {
    writeHeartbeat("work", FULL_SID, 45 * 60 * 1000); // 45min old
    expect(isSessionLiveByPrefix(PREFIX, NOW, 60 * 60 * 1000)).toBe(true); // 60min window → live
    expect(isSessionLiveByPrefix(PREFIX, NOW, 30 * 60 * 1000)).toBe(false); // 30min window → dead
  });
});
