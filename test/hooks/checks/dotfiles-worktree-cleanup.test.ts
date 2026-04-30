// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — cleanup hook smoke tests.
 *
 * Coverage:
 * - Feature-flag off → no-op.
 * - No sessionId → no-op.
 * - Sentinel absent (no per-session worktree) → no-op.
 * - Sentinel + clean worktree → removes + clears sentinel + emits epilogue.
 * - .git/index.lock active → skip + breadcrumb (GC reaper retries).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSentinelDotfilesRoot,
  setSentinelDotfilesRoot,
} from "../../../src/active-sessions/index.ts";
import { check as cleanupCheck } from "../../../src/hooks/checks/dotfiles-worktree-cleanup.ts";
import { readPresenceFailures } from "../../../src/shared/presence-failure-log.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";

let tmpHome: string;
let canonical: string;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let prevDotfilesRoot: string | undefined;
let prevFlag: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "wt-clean-"));
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

function makeInput(opts: { sid?: string } = {}): HookInput {
  const raw: Record<string, unknown> =
    opts.sid !== undefined ? { session_id: opts.sid } : {};
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: tmpHome,
    transcriptPath: undefined,
    raw,
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

describe("dotfiles-worktree-cleanup hook", () => {
  it("returns pass() when feature flag is unset", async () => {
    delete process.env[FEATURE_FLAG_ENV];
    const result = await cleanupCheck(makeInput({ sid: SID }));
    expect(result.exitCode).toBe(0);
  });

  it("returns pass() when sessionId is absent (no raw.session_id)", async () => {
    const result = await cleanupCheck(makeInput());
    expect(result.exitCode).toBe(0);
  });

  it("returns pass() when no sentinel exists for the session", async () => {
    const result = await cleanupCheck(makeInput({ sid: SID }));
    expect(result.exitCode).toBe(0);
  });

  it("removes worktree + clears sentinel + emits epilogue when sentinel is set", async () => {
    const wtPath = provisionRawWorktree(SID.slice(0, 8));
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: wtPath });
    expect(readSentinelDotfilesRoot(SID)).toBe(wtPath);

    const result = await cleanupCheck(makeInput({ sid: SID }));
    // CLI-DX-5 epilogue is a warn() with stdout text.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Working from a second terminal");
    expect(existsSync(wtPath)).toBe(false);
    expect(readSentinelDotfilesRoot(SID)).toBeNull();
  });

  it("skips cleanup + breadcrumb when .git/index.lock is fresh", async () => {
    const wtPath = provisionRawWorktree(SID.slice(0, 8));
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: wtPath });

    // git creates `.git` as a FILE (worktree pointer); replace with dir to
    // host the lock. Production-equivalent: any .git location can have an
    // index.lock during commits.
    rmSync(join(wtPath, ".git"));
    mkdirSync(join(wtPath, ".git"));
    writeFileSync(join(wtPath, ".git", "index.lock"), "");

    const result = await cleanupCheck(makeInput({ sid: SID }));
    expect(result.exitCode).toBe(0);
    // Worktree preserved (skipped per safety guard).
    expect(existsSync(wtPath)).toBe(true);

    const events = readPresenceFailures();
    const skip = events.find(
      (e) =>
        e.kind === "worktree-cleanup-failed" &&
        e.detail.includes("safety guard"),
    );
    expect(skip).toBeDefined();
  });
});
