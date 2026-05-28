// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "check-decision-log.sh",
);

let repo: string;

function git(dir: string, args: readonly string[]): void {
  Bun.spawnSync(["git", ...args], { cwd: dir });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdl-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

// Write the given files, commit, and return the resulting HEAD sha.
function writeCommit(
  dir: string,
  files: Readonly<Record<string, string>>,
  msg: string,
): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir });
  return new TextDecoder().decode(r.stdout).trim();
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

describe("scripts/check-decision-log.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("clean: no substrate change (docs only)", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(repo, { "docs/foo.md": "doc\n" }, "docs change");
    const { exitCode, stdout } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("violation: substrate change, no decision entry, no opt-out", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      { "src/channels/foo.ts": "export const x = 1;\n" },
      "substrate change",
    );
    const { exitCode, stderr } = runScript(repo, [base]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("DLOG-001");
  });

  it("clean: substrate change WITH a decision entry in the same diff", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      {
        "src/channels/foo.ts": "export const x = 1;\n",
        "decisions/phase-9.md": "# Decision Log — Phase 9\n",
      },
      "substrate + decision",
    );
    const { exitCode } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
  });

  it("clean: substrate change WITH an opt-out trailer", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      { "src/channels/foo.ts": "export const x = 1;\n" },
      "substrate change\n\nDecision-log: none (mechanical rename, no decision warranted)",
    );
    const { exitCode } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
  });

  it("clean: only *.test.ts under src changed (tests are not substrate)", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      { "src/channels/foo.test.ts": "import { expect } from 'bun:test';\n" },
      "test only",
    );
    const { exitCode } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
  });

  it("error: unresolvable base ref exits 2 (never silently passes)", () => {
    writeCommit(repo, { "README.md": "# x\n" }, "base");
    const { exitCode, stderr } = runScript(repo, ["definitely-not-a-ref"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not found");
  });
});
