// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — REV 0.2 RE-1 mandatory canonicalization regression test.
 *
 * Proves that `artifactIdFromPath` canonicalizes via `git rev-parse
 * --show-toplevel` so worktree paths and the canonical's main toplevel
 * produce the SAME artifact-id. Without canonicalization (REV 0.1
 * pre-fix behavior), the substrate's collision detection breaks the
 * moment Phase 3 Slice 2 flips on — two sessions with CWD in different
 * worktrees pointing at the same canonical would each register under
 * different artifact-ids.
 *
 * Falls back to raw input on any git failure (path outside a git tree,
 * git not available, etc.) — never throws.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactIdFromPath } from "../../src/active-sessions/index.ts";

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "wt-artid-"));
});

afterEach(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

describe("artifactIdFromPath — REV 0.2 RE-1 canonicalization", () => {
  it("worktree path and canonical produce the SAME artifact-id", () => {
    const repoDir = join(tmpBase, "repo");
    mkdirSync(repoDir);
    git(repoDir, "init", "-q", "-b", "main");
    git(repoDir, "config", "commit.gpgsign", "false");
    git(repoDir, "commit", "-q", "--allow-empty", "-m", "anchor");

    const worktreeDir = join(tmpBase, "repo-94a8058c");
    git(repoDir, "worktree", "add", "-b", "worktree/94a8058c", worktreeDir);

    const idFromCanonical = artifactIdFromPath(repoDir);
    const idFromWorktree = artifactIdFromPath(worktreeDir);

    expect(idFromWorktree).toBe(idFromCanonical);
  });

  it("a path outside any git tree falls back to raw-input id", () => {
    const nonRepoDir = join(tmpBase, "not-a-repo");
    mkdirSync(nonRepoDir);

    const id = artifactIdFromPath(nonRepoDir);
    expect(id.length).toBeGreaterThan(0);
    expect(id.endsWith("-not-a-repo")).toBe(true);
  });

  it("non-existent path falls back to raw-input id (never throws)", () => {
    const fakePath = "/definitely/not/a/real/path";
    const id = artifactIdFromPath(fakePath);
    expect(id.length).toBeGreaterThan(0);
  });

  it("a subdirectory inside the canonical resolves to the canonical's id", () => {
    const repoDir = join(tmpBase, "repo");
    mkdirSync(repoDir);
    git(repoDir, "init", "-q", "-b", "main");
    git(repoDir, "config", "commit.gpgsign", "false");
    git(repoDir, "commit", "-q", "--allow-empty", "-m", "anchor");
    mkdirSync(join(repoDir, "src"));

    const idFromRoot = artifactIdFromPath(repoDir);
    const idFromSub = artifactIdFromPath(join(repoDir, "src"));

    expect(idFromSub).toBe(idFromRoot);
  });
});
