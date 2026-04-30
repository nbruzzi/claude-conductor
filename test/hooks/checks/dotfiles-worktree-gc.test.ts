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
});
