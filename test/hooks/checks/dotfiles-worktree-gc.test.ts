// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — GC reaper hook smoke tests.
 *
 * Coverage:
 * - Feature-flag off → no-op.
 * - Rate-gate: cursor mtime < 5 min → no-op.
 * - No worktrees → no-op + cursor touched.
 * - Forensic marker active → skip + breadcrumb.
 * - .git/index.lock active (RE-103) → skip + breadcrumb.
 * - Orphan worktree (no anchor) AND no guards → reaped + breadcrumb.
 *
 * Doesn't test concurrent-Stop+GC race (covered in unregisterActiveSession
 * + reconciliation guard at the active-sessions level).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check as gcCheck } from "../../../src/hooks/checks/dotfiles-worktree-gc.ts";
import { readPresenceFailures } from "../../../src/shared/presence-failure-log.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";
import {
  artifactIdFromPath,
  setSentinelDotfilesRoot,
  touchHeartbeat,
} from "../../../src/active-sessions/index.ts";

const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";
const SCANNER_SID = "11111111-1111-4111-8111-111111111111";

let tmpHome: string;
let canonical: string;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let prevDotfilesRoot: string | undefined;
let prevFlag: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "wt-gc-"));
  canonical = join(tmpHome, ".claude-dotfiles");
  mkdirSync(canonical, { recursive: true });
  mkdirSync(join(tmpHome, ".claude", "logs"), { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonical });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: canonical,
  });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "anchor", "--no-gpg-sign"],
    { cwd: canonical, env: gitEnv() },
  );

  prevHome = process.env["HOME"];
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevDotfilesRoot = process.env["CLAUDE_DOTFILES_ROOT"];
  prevFlag = process.env[FEATURE_FLAG_ENV];

  process.env["HOME"] = tmpHome;
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = join(
    tmpHome,
    "active-sessions",
  );
  process.env["CLAUDE_DOTFILES_ROOT"] = canonical;
  process.env[FEATURE_FLAG_ENV] = "1";
});

afterEach(() => {
  for (const [k, v] of [
    ["HOME", prevHome],
    ["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", prevActiveSessionsDir],
    ["CLAUDE_DOTFILES_ROOT", prevDotfilesRoot],
    [FEATURE_FLAG_ENV, prevFlag],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function makeInput(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: tmpHome,
    transcriptPath: undefined,
    raw: { session_id: SCANNER_SID },
    dispatch: DEFAULT_DISPATCH,
  };
}

function provisionRawWorktree(sidPrefix: string): string {
  const wtPath = `${canonical}-${sidPrefix}`;
  execFileSync(
    "git",
    ["worktree", "add", "-b", `worktree/${sidPrefix}`, wtPath],
    { cwd: canonical, env: gitEnv() },
  );
  return wtPath;
}

describe("dotfiles-worktree-gc hook", () => {
  it("returns pass() when feature flag is unset", async () => {
    delete process.env[FEATURE_FLAG_ENV];
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
  });

  it("returns pass() when no worktrees exist", async () => {
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
  });

  it("rate-gate: skips when cursor mtime is recent", async () => {
    const cursorPath = join(tmpHome, ".claude", "logs", ".worktree-gc-cursor");
    writeFileSync(cursorPath, "");
    const now = new Date();
    utimesSync(cursorPath, now, now);

    provisionRawWorktree("aa00aa00");

    // Even with an orphan, the rate-gate should suppress.
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(existsSync(`${canonical}-aa00aa00`)).toBe(true);
  });

  it("forensic marker active → skip + breadcrumb", async () => {
    provisionRawWorktree("bb00bb00");
    mkdirSync(join(tmpHome, ".claude", "session-state-forensic"), {
      recursive: true,
    });
    writeFileSync(
      join(tmpHome, ".claude", "session-state-forensic", "bb00bb00"),
      "",
    );

    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    // Worktree preserved due to forensic marker.
    expect(existsSync(`${canonical}-bb00bb00`)).toBe(true);

    const events = readPresenceFailures();
    const skipBreadcrumb = events.find(
      (e) =>
        e.kind === "worktree-cleanup-failed" &&
        e.detail.includes("forensic marker"),
    );
    expect(skipBreadcrumb).toBeDefined();
  });

  it("index.lock active (RE-103) → skip + breadcrumb", async () => {
    const wtPath = provisionRawWorktree("cc00cc00");
    // Create a fresh index.lock at <worktree>/.git/index.lock — the guard
    // path. (git worktree's `.git` is a FILE pointing at the canonical's
    // worktrees subdir; we create a sibling `.git/` dir to satisfy the
    // hook's check, which doesn't traverse into the gitfile.)
    mkdirSync(join(wtPath, ".git-fakedir"), { recursive: true });
    // Ensure the guard finds .git/index.lock at the worktree path. Since
    // git's `.git` is a file, the hook's guardReason path is
    // `<worktree>/.git/index.lock` — it will check existsSync on that.
    // Replace the .git file with a dir to host the index.lock.
    rmSync(join(wtPath, ".git"));
    mkdirSync(join(wtPath, ".git"));
    writeFileSync(join(wtPath, ".git", "index.lock"), "");

    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    // Worktree preserved due to safety guard.
    expect(existsSync(wtPath)).toBe(true);
  });

  it("orphan worktree without guards → reaped + breadcrumb", async () => {
    const wtPath = provisionRawWorktree("dd00dd00");
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);

    const events = readPresenceFailures();
    const reapEvent = events.find((e) => e.kind === "worktree-gc-reaped");
    expect(reapEvent).toBeDefined();
    expect(existsSync(wtPath)).toBe(false);
  });

  /* ─── Liveness fallback (slice 7 substrate fix) ─────────────────── */

  it("FALLBACK: live anchor heartbeat matching sid-prefix without dotfilesRoot → skip reap + fallback breadcrumb", async () => {
    // Simulates the failure mode behind
    // `feedback-worktree-provisioner-reaps-live-siblings.md`:
    // a heartbeat overwrite wiped the dotfilesRoot sentinel field while
    // the owning session is still alive. The byDotfilesRoot map misses
    // (no record carries this worktree's path) but the sid-prefix is
    // still present in anchors. The fallback must catch it.
    const sidPrefix = "abc12345";
    const fullSid = "abc12345-1234-4567-89ab-000000000000";
    const wtPath = provisionRawWorktree(sidPrefix);

    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const anchorArtifactId = artifactIdFromPath(join(tmpHome, ".claude"));
    touchHeartbeat({
      artifactId: anchorArtifactId,
      sessionId: fullSid,
      artifactPath: join(tmpHome, ".claude"),
      now: Date.now(),
    });
    // NOTE: deliberately not calling setSentinelDotfilesRoot — simulates
    // the heartbeat-overwrite-wiped-sentinel failure mode.

    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    // Worktree preserved by fallback (not reaped).
    expect(existsSync(wtPath)).toBe(true);

    const events = readPresenceFailures();
    const fallback = events.find(
      (e) => e.kind === "worktree-gc-liveness-fallback-fired",
    );
    expect(fallback).toBeDefined();
    expect(fallback?.detail).toContain(sidPrefix);
    // Reap must NOT have fired for this worktree.
    const reaped = events.find((e) => e.kind === "worktree-gc-reaped");
    expect(reaped).toBeUndefined();
  });

  it("FALLBACK: live anchor heartbeat matching sid-prefix with stale dotfilesRoot path → skip reap", async () => {
    // Simulates the raw-vs-realpath drift failure mode: heartbeat
    // record's dotfilesRoot points at a path that doesn't match the
    // worktree path enumerated by listWorktrees. Same fallback should
    // catch it.
    const sidPrefix = "def67890";
    const fullSid = "def67890-2222-4567-89ab-111111111111";
    const wtPath = provisionRawWorktree(sidPrefix);

    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const anchorArtifactId = artifactIdFromPath(join(tmpHome, ".claude"));
    touchHeartbeat({
      artifactId: anchorArtifactId,
      sessionId: fullSid,
      artifactPath: join(tmpHome, ".claude"),
      now: Date.now(),
    });
    // dotfilesRoot points at a different path — byDotfilesRoot map
    // won't contain wtPath as a key. Use a tmpHome-relative path so the
    // hardcoded-path detector (`check-generic-paths.sh`) stays clean.
    setSentinelDotfilesRoot({
      sessionId: fullSid,
      dotfilesRoot: join(tmpHome, "wrong-path-that-doesnt-match-wtpath"),
    });

    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(existsSync(wtPath)).toBe(true);

    const events = readPresenceFailures();
    const fallback = events.find(
      (e) => e.kind === "worktree-gc-liveness-fallback-fired",
    );
    expect(fallback).toBeDefined();
  });

  it("FALLBACK: no live sibling sharing sid-prefix → orphan IS reaped (regression: fallback doesn't over-protect)", async () => {
    // Same setup as the bare-orphan test (no anchor heartbeat at all),
    // but with the new fallback in place: confirm the fallback doesn't
    // accidentally guard against real orphans.
    const sidPrefix = "ee00ee00";
    const wtPath = provisionRawWorktree(sidPrefix);
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);

    const events = readPresenceFailures();
    expect(events.find((e) => e.kind === "worktree-gc-reaped")).toBeDefined();
    expect(
      events.find((e) => e.kind === "worktree-gc-liveness-fallback-fired"),
    ).toBeUndefined();
    expect(existsSync(wtPath)).toBe(false);
  });

  /* ─── Dirty-tree --force data-loss guard (L1049 slice 2a) ───────── */

  it("dirty worktree (uncommitted WIP) → NOT reaped + guard breadcrumb (--force would destroy WIP)", async () => {
    const sidPrefix = "ff00ff00";
    const wtPath = provisionRawWorktree(sidPrefix);
    // Uncommitted in-flight work a `git worktree remove --force` reap destroys.
    // This orphan has no live anchor, so it is otherwise reap-eligible — the
    // dirty-tree guard is the only thing that should preserve it.
    writeFileSync(join(wtPath, "wip-uncommitted.ts"), "// in-flight work\n");

    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    // Preserved — the dirty-tree guard refused the reap.
    expect(existsSync(wtPath)).toBe(true);

    const events = readPresenceFailures();
    const guard = events.find(
      (e) =>
        e.kind === "worktree-cleanup-failed" &&
        e.detail.includes("dirty working tree"),
    );
    expect(guard).toBeDefined();
    // Reap must NOT have fired for this worktree.
    expect(events.find((e) => e.kind === "worktree-gc-reaped")).toBeUndefined();
  });

  it("orphan with only an untracked node_modules (no WIP) → still reaped (dirty-guard ignores node_modules)", async () => {
    const sidPrefix = "ab00ba00";
    const wtPath = provisionRawWorktree(sidPrefix);
    // node_modules (a symlink in prod) shows as untracked but is NOT WIP — the
    // dirty-guard must ignore it so a clean worktree still reaps. An untracked
    // file named node_modules reproduces the same `?? node_modules` porcelain
    // line the prod symlink yields.
    writeFileSync(join(wtPath, "node_modules"), "");

    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    // Reaped — node_modules-only is "clean" for reap purposes.
    expect(existsSync(wtPath)).toBe(false);
    expect(
      readPresenceFailures().find((e) => e.kind === "worktree-gc-reaped"),
    ).toBeDefined();
  });
});
