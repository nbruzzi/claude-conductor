// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi
//
// Tests for scripts/warn-uncommitted-substrate.sh — the advisory that warns when
// the working tree has UNCOMMITTED substrate changes the COMMIT-based decision-log
// gate (check-decision-log.sh) cannot see pre-commit.
//
// Coverage:
//  - behavioral (temp git sandbox): detects tracked-modified / staged-new /
//    untracked / nested src .ts; EXCLUDES *.test.ts and non-src .ts; clean tree
//    -> empty stdout.
//  - advisory-not-gate invariant: ALWAYS exits 0 (even when it warns) — pins the
//    "never fail the build" contract the directive requires.
//  - classification PARITY with check-decision-log.sh (the substrate rule must not
//    drift between the two classifiers — feedback-cross-edge-contract-via-paired-tests).
//  - ci-local.sh wiring: ci-local invokes the advisory (so it can't be dropped).
//  - shebang-before-SPDX + executable (house convention; mirrors ci-local.test.ts).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPTS_DIR = join(import.meta.dir, "..", "..", "scripts");
const SCRIPT_PATH = join(SCRIPTS_DIR, "warn-uncommitted-substrate.sh");
const CHECK_DLOG_PATH = join(SCRIPTS_DIR, "check-decision-log.sh");
const CI_LOCAL_PATH = join(SCRIPTS_DIR, "ci-local.sh");

let repo: string;

function git(dir: string, args: readonly string[]): void {
  Bun.spawnSync(["git", ...args], { cwd: dir });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wus-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(dir: string, msg: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
}

function runScript(
  cwd: string,
  args: readonly string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", SCRIPT_PATH, ...args], { cwd });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("scripts/warn-uncommitted-substrate.sh — behavioral", () => {
  beforeEach(() => {
    repo = makeRepo();
    // Baseline commit: tracked files we will later modify, plus a clean HEAD so
    // `git diff --name-only HEAD` has a base to diff against.
    write(repo, "README.md", "# x\n");
    write(repo, "src/tracked-mod.ts", "export const a = 1;\n");
    write(repo, "src/skip.test.ts", "export const t = 1;\n");
    write(repo, "docs/outside.ts", "export const d = 1;\n");
    commitAll(repo, "base");
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("clean working tree: empty stdout, exit 0", () => {
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("detects uncommitted substrate (tracked-mod / staged-new / untracked / nested) and still exits 0", () => {
    write(repo, "src/tracked-mod.ts", "export const a = 2;\n"); // tracked, unstaged
    write(repo, "src/staged-new.ts", "export const b = 1;\n"); // new, staged
    git(repo, ["add", "src/staged-new.ts"]);
    write(repo, "src/untracked.ts", "export const c = 1;\n"); // untracked
    write(repo, "src/nested/deep.ts", "export const e = 1;\n"); // untracked, nested

    const { exitCode, stdout, stderr } = runScript(repo);
    expect(exitCode).toBe(0); // advisory NEVER fails the build, even when warning
    expect(stdout).toContain("src/tracked-mod.ts");
    expect(stdout).toContain("src/staged-new.ts");
    expect(stdout).toContain("src/untracked.ts");
    expect(stdout).toContain("src/nested/deep.ts");
    expect(stdout).toContain("ci-local"); // remedy guidance present
    expect(stdout).toMatch(/commit/i);
    // message integrity: the exact remedy field name must survive (guards against
    // a quoting bug that would command-substitute/corrupt the body), and the warn
    // path must emit NOTHING to stderr (no leaked shell errors).
    expect(stdout).toContain("ts:");
    expect(stderr.trim()).toBe("");
  });

  it("excludes *.test.ts and non-src .ts (classification matches the gate)", () => {
    write(repo, "src/skip.test.ts", "export const t = 2;\n"); // tracked test mod
    write(repo, "src/new.test.ts", "export const t2 = 1;\n"); // untracked test
    write(repo, "docs/outside.ts", "export const d = 2;\n"); // tracked non-src mod
    write(repo, "lib/elsewhere.ts", "export const f = 1;\n"); // untracked non-src

    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(""); // none are substrate -> no advisory
  });

  it("--help prints usage and exits 0", () => {
    const { exitCode, stdout } = runScript(repo, ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Advisory");
  });

  it("not a git repo: advisory skips gracefully (stderr note, empty stdout, exit 0)", () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "wus-nonrepo-"));
    try {
      const { exitCode, stdout, stderr } = runScript(nonRepo);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
      expect(stderr).toContain("not in a git repo");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("warn-uncommitted-substrate.sh — contract pins", () => {
  it("substrate classification matches check-decision-log.sh (no drift)", () => {
    // Both classifiers must treat `src/*.ts` (recursive) as substrate and exclude
    // `*.test.ts`. Pin the shared `case` arms in BOTH scripts so an edit to one
    // without the other fails here (feedback-cross-edge-contract-via-paired-tests).
    const advisory = readFileSync(SCRIPT_PATH, "utf8");
    const gate = readFileSync(CHECK_DLOG_PATH, "utf8");
    for (const src of [advisory, gate]) {
      expect(src).toContain("*.test.ts)");
      expect(src).toContain("src/*.ts)");
    }
  });

  it("ci-local.sh invokes the advisory (so it can't be silently dropped)", () => {
    const ciLocal = readFileSync(CI_LOCAL_PATH, "utf8");
    expect(ciLocal).toContain("warn-uncommitted-substrate.sh");
  });

  it("is executable and leads with shebang-before-SPDX", () => {
    const mode = statSync(SCRIPT_PATH).mode;
    expect(mode & 0o111).not.toBe(0);
    const src = readFileSync(SCRIPT_PATH, "utf8");
    const [first, second] = src.split("\n", 2);
    expect(first).toBe("#!/usr/bin/env bash");
    expect(second).toBe("# SPDX-License-Identifier: Apache-2.0");
  });
});
