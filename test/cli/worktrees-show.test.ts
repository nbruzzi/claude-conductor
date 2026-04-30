// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — CLI verb test for D-CLIDX2 worktrees inspector.
 *
 * Spawns the CLI as a subprocess. Asserts:
 * - missing-sid → exit 1 + usage message on stderr.
 * - success path with no live worktrees → header lines + "(none)".
 * - success path with one provisioned worktree → entry rendered with
 *   sid + branch.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "cli",
  "worktrees-show.ts",
);
const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";

let tmpHome: string;
let canonical: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "wt-show-"));
  mkdirSync(join(tmpHome, ".claude", "logs"), { recursive: true });
  canonical = join(tmpHome, ".claude-dotfiles");
  mkdirSync(canonical, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonical });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "anchor",
    ],
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
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function run(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["HOME"] = tmpHome;
  env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = join(
    tmpHome,
    "active-sessions",
  );
  env["CLAUDE_DOTFILES_ROOT"] = canonical;

  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("worktrees-show CLI verb (D-CLIDX2)", () => {
  it("prints usage + exits 1 when sessionId is missing", async () => {
    const r = await run([]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("usage:");
  });

  it("renders header lines with no live worktrees", async () => {
    const r = await run([SID]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Session: ${SID}`);
    expect(r.stdout).toContain("Resolved DOTFILES_ROOT:");
    expect(r.stdout).toContain("Heartbeat-body sentinel: (not pinned)");
    expect(r.stdout).toContain("Live worktrees:");
    expect(r.stdout).toContain("  (none)");
  });

  it("renders a provisioned worktree entry with sid + branch", async () => {
    const sidPrefix = SID.slice(0, 8);
    const worktreePath = `${canonical}-${sidPrefix}`;
    execFileSync(
      "git",
      ["worktree", "add", "-b", `worktree/${sidPrefix}`, worktreePath],
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

    const r = await run([SID]);
    expect(r.exitCode).toBe(0);
    // listWorktrees realpaths the canonical for prefix matching, so the
    // rendered worktree path will be in `/private/var/...` form on macOS.
    const realCanonical = realpathSync(canonical);
    expect(r.stdout).toContain(`${realCanonical}-${sidPrefix}`);
    expect(r.stdout).toContain(`branch: worktree/${sidPrefix}`);
    expect(r.stdout).toContain(`sid: ${sidPrefix}`);
  });
});
