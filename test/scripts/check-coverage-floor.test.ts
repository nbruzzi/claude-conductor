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
  "check-coverage-floor.sh",
);

let dir: string;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccf-test-"));
}

// Synthesize a `bun test --coverage` text dump. `allFilesLinesPct === null`
// omits the All-files aggregate row (parse-error fixture). The `--from-file`
// seam parses this without re-running the real suite, keeping tests fast.
function writeCoverage(d: string, allFilesLinesPct: string | null): string {
  const header =
    "--------|---------|---------|----\nFile    | % Funcs | % Lines | Uncovered\n--------|---------|---------|----\n";
  const allFiles =
    allFilesLinesPct === null
      ? ""
      : `All files            |   88.43 |   ${allFilesLinesPct} |\n`;
  const perFile = " src/x.ts            |  100.00 |  100.00 |\n";
  const summary = "\n 2299 pass\n 0 fail\n";
  const path = join(d, "coverage.txt");
  writeFileSync(path, header + allFiles + perFile + summary);
  return path;
}

function run(
  args: readonly string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", SCRIPT_PATH, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("scripts/check-coverage-floor.sh", () => {
  beforeEach(() => {
    dir = tmp();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("passes when line coverage is at/above the floor", () => {
    const f = writeCoverage(dir, "84.45");
    const { exitCode, stdout } = run(["--from-file", f]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
    expect(stdout).toContain("84.45");
  });

  it("fails with CCF-001 when line coverage is below the floor", () => {
    const f = writeCoverage(dir, "70.00");
    const { exitCode, stderr } = run(["--from-file", f]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[CCF-001]");
    expect(stderr).toContain("below the floor");
  });

  it("honors COVERAGE_FLOOR env override (raised floor fails otherwise-OK coverage)", () => {
    const f = writeCoverage(dir, "84.45");
    const { exitCode, stderr } = run(["--from-file", f], {
      COVERAGE_FLOOR: "90",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("floor of 90%");
  });

  it("passes exactly at the floor (boundary, >= is OK)", () => {
    const f = writeCoverage(dir, "84.00");
    const { exitCode } = run(["--from-file", f]);
    expect(exitCode).toBe(0);
  });

  it("errors (exit 2) when no All-files aggregate row is present", () => {
    const f = writeCoverage(dir, null);
    const { exitCode, stderr } = run(["--from-file", f]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("All files");
  });

  it("errors (exit 2) when the % Lines value is non-numeric", () => {
    const path = join(dir, "bad.txt");
    writeFileSync(path, "All files            |   88.43 |   N/A |\n");
    const { exitCode, stderr } = run(["--from-file", path]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("parse");
  });

  it("errors (exit 2) when --from-file path is missing", () => {
    const { exitCode, stderr } = run(["--from-file", join(dir, "nope.txt")]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not found");
  });

  it("--help exits 0 and documents the coverage floor", () => {
    const { exitCode, stdout } = run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("coverage");
  });

  it("errors on unknown argument", () => {
    const { exitCode, stderr } = run(["--bogus"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown argument");
  });
});
