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
  "check-import-extensions.sh",
);

let repo: string;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cie-test-"));
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

function writeSrc(repo: string, relPath: string, content: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

describe("scripts/check-import-extensions.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("exits 0 on an empty tree (no .ts files under src/)", () => {
    writeFileSync(join(repo, "README.md"), "# hi\n");
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("exits 0 on static imports with .ts extension", () => {
    writeSrc(
      repo,
      "src/a.ts",
      `import { x } from "./b.ts";\nexport const y = x;\n`,
    );
    writeSrc(repo, "src/b.ts", `export const x = 1;\n`);
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags static import missing .ts extension (T1)", () => {
    writeSrc(
      repo,
      "src/a.ts",
      `import { x } from "./b";\nexport const y = x;\n`,
    );
    writeSrc(repo, "src/b.ts", `export const x = 1;\n`);
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[CIE-001]");
    expect(stderr).toContain("src/a.ts");
    expect(stderr).toContain("relative import missing .ts extension");
  });

  it("allows .json imports (resolveJsonModule)", () => {
    writeSrc(
      repo,
      "src/a.ts",
      `import data from "./config.json";\nexport const x = data;\n`,
    );
    writeSrc(repo, "src/config.json", `{}\n`);
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags `export ... from` missing .ts extension (T1)", () => {
    writeSrc(repo, "src/a.ts", `export { x } from "./b";\n`);
    writeSrc(repo, "src/b.ts", `export const x = 1;\n`);
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[CIE-001]");
  });

  // ─── L:761 — dynamic-import coverage (call-site form) ────────────

  it('flags dynamic `await import("./x")` missing .ts extension (T1)', () => {
    writeSrc(
      repo,
      "src/a.ts",
      `export async function load() {\n  const mod = await import("./b");\n  return mod;\n}\n`,
    );
    writeSrc(repo, "src/b.ts", `export const x = 1;\n`);
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[CIE-001]");
    expect(stderr).toContain("src/a.ts");
  });

  it('allows dynamic `await import("./x.ts")` with extension', () => {
    writeSrc(
      repo,
      "src/a.ts",
      `export async function load() {\n  const mod = await import("./b.ts");\n  return mod;\n}\n`,
    );
    writeSrc(repo, "src/b.ts", `export const x = 1;\n`);
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it('flags parent-relative dynamic import `import("../x")` missing extension', () => {
    writeSrc(
      repo,
      "src/sub/a.ts",
      `export const f = async () => import("../b");\n`,
    );
    writeSrc(repo, "src/b.ts", `export const x = 1;\n`);
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[CIE-001]");
    expect(stderr).toContain("src/sub/a.ts");
  });
});
