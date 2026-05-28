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
const TS_HEADER = `// ${SPDX}\n`;

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
    expect(stderr).toContain("missing or non-Apache-2.0 SPDX header");
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
      `#!/usr/bin/env bash\n# ${SPDX}\nset -e\n`,
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

  it("flags a bare mention of the marker that is not a real header (RE-1)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "mention.ts"),
      "// see the SPDX-License-Identifier convention for details\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/mention.ts");
    expect(stderr).toContain("error[SPDX-001]");
  });

  it("flags a non-Apache-2.0 SPDX license value (RE-2)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "gpl.ts"),
      "// SPDX-License-Identifier: GPL-3.0-or-later\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/gpl.ts");
    expect(stderr).toContain("error[SPDX-001]");
  });

  it("accepts a compound SPDX expression beginning with Apache-2.0", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "compound.ts"),
      "// SPDX-License-Identifier: Apache-2.0 OR MIT\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("prints help and exits 0 for --help and -h (TA-1)", () => {
    writeFileSync(join(repo, "ok.ts"), `${TS_HEADER}export const x = 1;\n`);
    commit(repo);
    for (const flag of ["--help", "-h"]) {
      const { exitCode, stdout } = runScript(repo, [flag]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--include-untracked");
    }
  });

  it("flags an empty source file and a 1-line non-header file (TA-2)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "empty.ts"), "");
    writeFileSync(join(repo, "src", "oneline.ts"), "export const x = 1;");
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/empty.ts");
    expect(stderr).toContain("src/oneline.ts");
  });

  it("reports EVERY offending file and a plural count (TA-3)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(repo, "src", "c.ts"), "export const c = 3;\n");
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/a.ts");
    expect(stderr).toContain("src/b.ts");
    expect(stderr).toContain("src/c.ts");
    expect(stderr).toContain("3 source file(s) missing SPDX header");
  });

  it("scans .mjs / .cjs / .tsx source files (TA-4)", () => {
    writeFileSync(join(repo, "a.mjs"), "export const a = 1;\n");
    writeFileSync(join(repo, "b.cjs"), "module.exports = {};\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "C.tsx"), "export const C = 1;\n");
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("a.mjs");
    expect(stderr).toContain("b.cjs");
    expect(stderr).toContain("src/C.tsx");
  });

  it("emits GitHub Actions error annotations under GITHUB_ACTIONS=true (TA-5)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "foo.ts"), "export const x = 1;\n");
    commit(repo);
    const result = Bun.spawnSync(["bash", SCRIPT_PATH], {
      cwd: repo,
      env: { ...Bun.env, GITHUB_ACTIONS: "true" },
    });
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("::error file=");
    expect(stderr).toContain("title=SPDX-001");
  });

  it("exits 2 when run outside a git repository (TA-6)", () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "spdx-nonrepo-"));
    try {
      const { exitCode, stderr } = runScript(nonRepo);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("not in a git repo");
    } finally {
      if (existsSync(nonRepo))
        rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
