// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Test helper: throwaway git repos + dispatcher subprocess runner.
 *
 * Each repo is self-contained (its own .git, its own bare remote, its own
 * HOME) so parallel tests cannot race on a shared working directory. The
 * dispatcher runs as a subprocess so the DOTFILES_ROOT env override is the
 * only way tests point production code at the temp repo — no mutation of
 * process.env in the test process.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export const DISPATCHER_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "hooks",
  "dispatcher.ts",
);

export type TmpHome = {
  home: string;
  base: string;
  cleanup: () => void;
};

/**
 * Throwaway HOME directory for hook tests that write to ~/.claude/* paths.
 * Lighter than makeTmpRepo (no git init) — use when you only need HOME isolation,
 * not a git fixture. Pair with `process.env.HOME = tmp.home` in beforeEach and
 * restore the prior value in afterEach.
 */
export function makeTmpHome(): TmpHome {
  const base = mkdtempSync(join(tmpdir(), "cdhome-"));
  const home = join(base, "home");
  mkdirSync(join(home, ".claude", "logs"), { recursive: true });
  return {
    home,
    base,
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

export type TmpRepo = {
  dir: string;
  homeDir: string;
  base: string;
  cleanup: () => void;
  stage: (name: string, content: string) => void;
  commit: (msg: string) => void;
  head: () => string;
  status: () => string;
  addBareRemote: () => string;
  git: (...args: string[]) => string;
};

export function makeTmpRepo(): TmpRepo {
  const base = mkdtempSync(join(tmpdir(), "cdrace-"));
  const dir = join(base, "repo");
  const homeDir = join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(homeDir, ".claude", "logs"), { recursive: true });

  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).toString();

  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitkeep"), "");
  git("add", ".gitkeep");
  git("commit", "-q", "-m", "anchor", "--no-gpg-sign");

  return {
    dir,
    homeDir,
    base,
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
    stage: (name, content) => {
      const full = join(dir, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      git("add", name);
    },
    commit: (msg) => {
      git("commit", "-q", "-m", msg, "--no-gpg-sign");
    },
    head: () => git("rev-parse", "HEAD").trim(),
    status: () => git("status", "--porcelain"),
    addBareRemote: () => {
      const bare = join(base, "bare.git");
      execFileSync("git", ["init", "-q", "--bare", bare], { stdio: "ignore" });
      git("remote", "add", "origin", bare);
      git("push", "-q", "-u", "origin", "main");
      return bare;
    },
    git,
  };
}

export type DispatcherOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Spawn the dispatcher entrypoint against a tmp repo.
 * env inherits DOTFILES_ROOT + HOME pointing at the repo's sandbox.
 *
 * `envOverride`: per-test env tweaks. A value of `undefined` unsets the key,
 * which is how peer-identity tests scrub a leaked CLAUDE_SESSION_ID so stdin
 * session_id is the only source of identity.
 */
export async function runDispatcher(
  event: string,
  repo: TmpRepo,
  stdin: string = "",
  extraArgs: string[] = [],
  envOverride: Record<string, string | undefined> = {},
): Promise<DispatcherOutcome> {
  if (!existsSync(DISPATCHER_PATH)) {
    throw new Error(`dispatcher entrypoint not found at ${DISPATCHER_PATH}`);
  }
  const mergedOverride: Record<string, string | undefined> = {
    DOTFILES_ROOT: repo.dir,
    HOME: repo.homeDir,
    ...envOverride,
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !(k in mergedOverride)) env[k] = v;
  }
  for (const [k, v] of Object.entries(mergedOverride)) {
    if (v !== undefined) env[k] = v;
  }
  const proc = Bun.spawn(["bun", "run", DISPATCHER_PATH, event, ...extraArgs], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
