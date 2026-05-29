// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 2 boot-reconciliation — WORKTREE report-only enumeration (§2, PR 2a).
 *
 * Cross-class: a per-session worktree has no heartbeat of its own and its path
 * encodes only the 8-char sid-PREFIX (the full UUID is unrecoverable), so
 * liveness is cross-ref'd by PREFIX-match against the presence sessions. This
 * suite drives runReconcileBoot over a presence registry
 * (CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR) + a real git repo with worktrees
 * (CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG) to assert: a worktree whose
 * prefix matches a live session inherits that liveness; an ORPHAN worktree (no
 * live session for its prefix) is stale + ["no-presence-heartbeat"]; auto:false
 * + config-absent enumerate nothing; gc_eligible is always false (report-only —
 * worktree GC is deferred).
 *
 * Real git fixtures (no mocking), mirroring repo-worktree-gc.test.ts. The path
 * assertion uses toContain (not toBe) — git/listWorktrees realpath the worktree
 * path, which diverges from the symlink form on macOS (/var → /private/var).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runReconcileBoot } from "../../src/active-sessions/index.ts";

const CONFIG_ENV = "CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG";
const SESSIONS_ENV = "CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR";
const NOW = 1_800_000_000_000;

let tmpHome: string;
let sessionsDir: string;
let prevConfig: string | undefined;
let prevSessions: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "reconcile-wt-"));
  sessionsDir = mkdtempSync(join(tmpdir(), "reconcile-wt-sessions-"));
  prevConfig = process.env[CONFIG_ENV];
  prevSessions = process.env[SESSIONS_ENV];
  process.env[SESSIONS_ENV] = sessionsDir;
  delete process.env[CONFIG_ENV];
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env[CONFIG_ENV];
  else process.env[CONFIG_ENV] = prevConfig;
  if (prevSessions === undefined) delete process.env[SESSIONS_ENV];
  else process.env[SESSIONS_ENV] = prevSessions;
  for (const d of [tmpHome, sessionsDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: path });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "init", "--no-gpg-sign"],
    {
      cwd: path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "t@x",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "t@x",
      },
    },
  );
}

function addWorktree(canonical: string, sidPrefix: string): string {
  const worktreePath = `${canonical}-${sidPrefix}`;
  execFileSync(
    "git",
    ["worktree", "add", "-b", `worktree/${sidPrefix}`, worktreePath],
    { cwd: canonical },
  );
  return worktreePath;
}

function writeConfig(repoCanonical: string, auto: boolean): void {
  const configPath = join(tmpHome, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      repos: [{ name: "repo-a", canonical: repoCanonical, auto }],
    }),
  );
  process.env[CONFIG_ENV] = configPath;
}

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

function worktreeCandidates(scope: "worktree" | "all") {
  return runReconcileBoot({ now: NOW, scope }).candidates.filter(
    (c) => c.artifact_class === "worktree",
  );
}

describe("runReconcileBoot — worktree report-only enumeration (§2)", () => {
  it("a worktree whose prefix matches a LIVE session inherits its liveness; gc_eligible false", () => {
    const fullSid = "abcd1234-0000-4000-8000-000000000001";
    const prefix = fullSid.slice(0, 8); // "abcd1234"
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    addWorktree(repo, prefix);
    writeConfig(repo, true);
    writeHeartbeat("work", fullSid, 0); // live presence for the full sid

    const [wt] = worktreeCandidates("worktree");
    expect(wt).toBeDefined();
    expect(wt?.artifact_id).toContain(`-${prefix}`); // realpath-robust
    expect(wt?.session_id).toBe(fullSid); // full sid resolved via prefix-match
    expect(wt?.classification).toBe("live"); // inherited
    expect(wt?.gc_eligible).toBe(false);
  });

  it("an ORPHAN worktree (no live session for its prefix) is stale + ['no-presence-heartbeat']", () => {
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const orphanPrefix = "deadbeef";
    addWorktree(repo, orphanPrefix);
    writeConfig(repo, true);
    // No heartbeat for any "deadbeef..." session → orphan.

    const [wt] = worktreeCandidates("worktree");
    expect(wt).toBeDefined();
    expect(wt?.artifact_id).toContain(`-${orphanPrefix}`);
    expect(wt?.session_id).toBe(orphanPrefix); // only the prefix is recoverable
    expect(wt?.classification).toBe("stale");
    expect(wt?.failed_signals).toEqual(["no-presence-heartbeat"]);
    expect(wt?.gc_eligible).toBe(false);
    // An orphan worktree exposes only the 8-char prefix, so paused can't be
    // resolved (readSessionPausedAt needs the full sid) → false. Locked here
    // because it becomes load-bearing when worktree-GC lands (a later increment
    // must resolve paused via prefix-scan OR document the gap — tracked).
    expect(wt?.paused).toBe(false);
  });

  it("config absent → no worktree candidates", () => {
    // CONFIG_ENV is unset (beforeEach deletes it) → readRepoConfig "absent".
    expect(worktreeCandidates("worktree").length).toBe(0);
  });

  it("a repo with auto:false is skipped (no worktree candidates)", () => {
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    addWorktree(repo, "abcd1234");
    writeConfig(repo, false); // auto:false → not enumerated
    writeHeartbeat("work", "abcd1234-0000-4000-8000-000000000001", 0);

    expect(worktreeCandidates("worktree").length).toBe(0);
  });
});
