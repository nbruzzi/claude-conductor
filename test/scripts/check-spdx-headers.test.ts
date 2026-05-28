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
  "check-spdx-headers.sh",
);

const SPDX = "SPDX-License-Identifier: Apache-2.0";
const TS_HEADER = `// ${SPDX}\n// Copyright 2026 nbruzzi\n`;

let repo: string;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "spdx-test-"));
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

describe("scripts/check-spdx-headers.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("exits 0 when every source file carries an SPDX header", () => {
    writeFileSync(join(repo, "ok.ts"), `${TS_HEADER}\nexport const x = 1;\n`);
    commit(repo);
    const { exitCode, stdout, stderr } = runScript(repo);
    if (exitCode !== 0) {
      console.error(
        `Unexpected exit ${exitCode}:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
    expect(stdout).toContain("0 violations");
  });

  it("flags a .ts source file missing SPDX (SPDX-001)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "foo.ts"), "export const x = 1;\n");
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[SPDX-001]");
    expect(stderr).toContain("src/foo.ts");
    expect(stderr).toContain("missing SPDX-License-Identifier");
  });

  it("flags a .sh script missing SPDX (gap ESLint cannot cover — it lints .ts only)", () => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(
      join(repo, "scripts", "tool.sh"),
      "#!/usr/bin/env bash\nset -e\necho hi\n",
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[SPDX-001]");
    expect(stderr).toContain("scripts/tool.sh");
  });

  it("accepts a .sh script with a shebang on line 1 and SPDX on line 2", () => {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(
      join(repo, "scripts", "ok.sh"),
      `#!/usr/bin/env bash\n# ${SPDX}\n# Copyright 2026 nbruzzi\nset -e\n`,
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags a .js file missing SPDX (ESLint files-glob is .ts only)", () => {
    writeFileSync(join(repo, "build.js"), "module.exports = {};\n");
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("build.js");
    expect(stderr).toContain("error[SPDX-001]");
  });

  it("does NOT scan .md docs (SPDX is a source-file convention, not a docs one)", () => {
    writeFileSync(
      join(repo, "README.md"),
      "# Project\n\nNo license header here, by design.\n",
    );
    writeFileSync(join(repo, "ok.ts"), `${TS_HEADER}export const x = 1;\n`);
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("does NOT scan .json / .yml config + data", () => {
    writeFileSync(join(repo, "tsconfig.json"), '{ "compilerOptions": {} }\n');
    writeFileSync(join(repo, "config.yml"), "name: ci\n");
    writeFileSync(join(repo, "ok.ts"), `${TS_HEADER}export const x = 1;\n`);
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("accepts SPDX anywhere within the first 5 lines (not only line 1)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "windowed.ts"),
      `/* eslint-disable */\n// ${SPDX}\nexport const x = 1;\n`,
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags SPDX that appears only BELOW the first-5-lines header window", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "late.ts"),
      `// 1\n// 2\n// 3\n// 4\n// 5\n// ${SPDX}\nexport const x = 1;\n`,
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/late.ts");
    expect(stderr).toContain("error[SPDX-001]");
  });

  it("errors on an unknown argument with a helpful hint (exit 2)", () => {
    writeFileSync(join(repo, "ok.ts"), `${TS_HEADER}export const x = 1;\n`);
    commit(repo);
    const { exitCode, stderr } = runScript(repo, ["--bogus-flag"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown argument");
    expect(stderr).toContain("--help");
  });

  it("does NOT flag an untracked source file by default (tracked-only gate)", () => {
    writeFileSync(join(repo, "ok.ts"), `${TS_HEADER}export const x = 1;\n`);
    commit(repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "new.ts"), "export const y = 2;\n");
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
    expect(stdout).toContain("1 untracked source file(s) not scanned");
  });

  it("flags an untracked source file missing SPDX when --include-untracked is set", () => {
    writeFileSync(join(repo, "ok.ts"), `${TS_HEADER}export const x = 1;\n`);
    commit(repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "new.ts"), "export const y = 2;\n");
    const { exitCode, stderr } = runScript(repo, ["--include-untracked"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/new.ts");
    expect(stderr).toContain("error[SPDX-001]");
  });

  it("exits 0 with a clean message on a repo containing only docs", () => {
    writeFileSync(join(repo, "README.md"), "# docs only\n");
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });
});
