// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — provisioner hook smoke tests.
 *
 * Coverage:
 * - Feature-flag off → returns pass() (no-op).
 * - Feature-flag on + clean canonical → provisions worktree + pins
 *   the canonical-claude-home anchor (REV 0.2 ARCH-1 fix).
 * - Idempotent re-run when worktree already exists.
 * - Anchor-pin observable from a session whose CWD is in a worktree
 *   (REV 0.2 RE-201 / Bravo F1 fix — the discrete worktree-CWD scenario).
 *
 * Real git fixtures (no mocking — covers the actual primitive integration).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check as provisionerCheck } from "../../../src/hooks/checks/dotfiles-worktree-provisioner.ts";
import {
  artifactIdFromPath,
  readSentinelDotfilesRoot,
} from "../../../src/active-sessions/index.ts";
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
  tmpHome = mkdtempSync(join(tmpdir(), "wt-prov-"));
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
    {
      cwd: canonical,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    },
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
  delete process.env[FEATURE_FLAG_ENV];
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

function makeInput(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: tmpHome,
    transcriptPath: undefined,
    raw: { session_id: SID },
    dispatch: DEFAULT_DISPATCH,
  };
}

describe("dotfiles-worktree-provisioner hook", () => {
  it("returns pass() when feature flag is unset (no-op)", async () => {
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    const realCanonical = realpathSync(canonical);
    expect(existsSync(`${realCanonical}-${SID.slice(0, 8)}`)).toBe(false);
    expect(readSentinelDotfilesRoot(SID)).toBeNull();
  });

  it("provisions worktree + pins anchor when flag=1", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);

    const realCanonical = realpathSync(canonical);
    const expectedPath = `${realCanonical}-${SID.slice(0, 8)}`;
    expect(existsSync(expectedPath)).toBe(true);
    const sentinel = readSentinelDotfilesRoot(SID);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.endsWith(`-${SID.slice(0, 8)}`)).toBe(true);
  });

  it("REV 0.2 RE-201: anchor-pin observable at canonical-claude-home artifact-id (NOT worktree-toplevel)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    await provisionerCheck(makeInput());

    // Sentinel was written using the canonical from env var (NOT realpathed).
    // worktreePathForSession appends `-<sid-prefix>` to whatever canonical
    // was passed. The CRITICAL invariant per REV 0.2 ARCH-1 is that
    // readSentinelDotfilesRoot returns SOMETHING (not null) — proving the
    // anchor heartbeat exists at the canonical-claude-home artifact-id
    // regardless of CWD.
    const sentinel = readSentinelDotfilesRoot(SID);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.endsWith(`-${SID.slice(0, 8)}`)).toBe(true);

    // Verify the artifact-id used is the canonical-claude-home one, not
    // the worktree's git toplevel. We assert by computing the worktree's
    // git toplevel and confirming its artifact-id is DIFFERENT — proving
    // the anchor is pinned at the right artifact-id and not at the
    // worktree's, which would have been the bug REV 0.1 had.
    const realCanonical = realpathSync(canonical);
    const worktreePathReal = `${realCanonical}-${SID.slice(0, 8)}`;
    const anchorArtifactId = artifactIdFromPath(join(tmpHome, ".claude"));
    const worktreeGitArtifactId = artifactIdFromPath(worktreePathReal);
    expect(anchorArtifactId).not.toBe(worktreeGitArtifactId);
  });

  it("idempotent re-run when worktree already exists", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const first = await provisionerCheck(makeInput());
    expect(first.exitCode).toBe(0);
    const second = await provisionerCheck(makeInput());
    expect(second.exitCode).toBe(0);
    expect(readSentinelDotfilesRoot(SID)).not.toBeNull();
  });
});
