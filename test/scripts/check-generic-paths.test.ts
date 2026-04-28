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
import { join } from "node:path";

const SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "check-generic-paths.sh",
);

let repo: string;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cgp-test-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function commit(dir: string, msg = "init"): void {
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-q", "-m", msg], { cwd: dir });
}

function runScript(cwd: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(["bash", SCRIPT_PATH], { cwd });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("scripts/check-generic-paths.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("exits 0 on a clean tree", () => {
    writeFileSync(join(repo, "ok.ts"), "export const x = 1;\n");
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
    expect(stdout).toContain("0 violations");
  });

  it("flags hardcoded substrate identifier in source code (P1)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    // Build the literal at runtime so this test file itself doesn't contain
    // the substrate identifier (avoids self-flagging in the parent repo).
    const ident = ["nbr", "uzz", "i"].join("");
    writeFileSync(
      join(repo, "src", "foo.ts"),
      `export const path = '/home/${ident}/data';\n`,
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[P1]");
    expect(stderr).toContain("src/foo.ts");
    expect(stderr).toContain("hardcoded user identifier");
  });

  it("flags hardcoded /Users/<name>/ paths (P2)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "bar.ts"),
      "export const root = '/Users/somebody/data';\n",
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[P2]");
    expect(stderr).toContain("src/bar.ts");
    expect(stderr).toContain("non-portable");
  });

  it("suppresses canonical SPDX header (Layer 2)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "headered.ts"),
      "// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 nbruzzi\n\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("suppresses JSDoc narration lines (Layer 3)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "narrated.ts"),
      "/**\n * See nbruzzi/claude-dotfiles for context.\n */\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });
});
