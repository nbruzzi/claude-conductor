// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "check-dep-rationale.sh",
);

let repo: string;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-test-"));
  // git init only — the script reads working-tree files (package.json +
  // dependencies-rationale.md) directly; no commit needed. The repo is
  // required so `git rev-parse --show-toplevel` resolves the root.
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function writePkg(
  dir: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): void {
  const pkg = {
    name: "fixture",
    version: "0.0.0",
    dependencies: deps,
    devDependencies: devDeps,
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function writeRationale(dir: string, names: readonly string[]): void {
  // Names wrapped in backticks in table rows — matches the real
  // dependencies-rationale.md convention the check requires.
  const rows = names.map((n) => `| \`${n}\` | x | why | alts |`).join("\n");
  writeFileSync(
    join(dir, "dependencies-rationale.md"),
    `# Dependency Rationale\n\n| Package | Version | Why | Alternatives |\n| --- | --- | --- | --- |\n${rows}\n`,
  );
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

describe("scripts/check-dep-rationale.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("exits 0 when every declared dependency is rationalized", () => {
    writePkg(repo, { "left-pad": "^1.0.0" }, { typescript: "^5.5.0" });
    writeRationale(repo, ["left-pad", "typescript"]);
    const { exitCode, stdout, stderr } = runScript(repo);
    if (exitCode !== 0) console.error(`STDERR: ${stderr}`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
    expect(stdout).toContain("2 dependencies all rationalized");
  });

  it("exits 0 with zero declared dependencies", () => {
    writePkg(repo, {}, {});
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0 dependencies declared");
  });

  it("flags a runtime dependency with no rationale entry (CDR-001)", () => {
    writePkg(repo, { "hot-new-dep": "^2.0.0" }, {});
    writeRationale(repo, []);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[CDR-001]");
    expect(stderr).toContain("hot-new-dep");
    expect(stderr).toContain("package.json");
  });

  it("flags a devDependency with no rationale entry", () => {
    writePkg(repo, {}, { "@scope/tool": "^1.0.0" });
    writeRationale(repo, []);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[CDR-001]");
    expect(stderr).toContain("@scope/tool");
  });

  it("requires a backtick-wrapped name — a bare prose mention does not satisfy", () => {
    writePkg(repo, { mylib: "^1.0.0" }, {});
    writeFileSync(
      join(repo, "dependencies-rationale.md"),
      "# Dependency Rationale\n\nWe use mylib for stuff (no table row).\n",
    );
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("mylib");
  });

  it("treats a missing rationale file as all-unrationalized when deps exist", () => {
    writePkg(repo, { something: "^1.0.0" }, {});
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("something");
  });

  it("checks both dependencies and devDependencies, passing the covered one", () => {
    writePkg(repo, { runtimeDep: "1" }, { devDep: "1" });
    writeRationale(repo, ["runtimeDep"]);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("dependency 'devDep'");
    expect(stderr).not.toContain("dependency 'runtimeDep'");
  });

  it("--help exits 0 and documents the Dependency policy", () => {
    const { exitCode, stdout } = runScript(repo, ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dependency policy");
  });

  it("errors on unknown argument with a --help hint", () => {
    const { exitCode, stderr } = runScript(repo, ["--bogus"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown argument");
    expect(stderr).toContain("--help");
  });
});
