// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Integration tests for the cycle-character CLI (Tier 3-F).
 *
 * Pattern: spawnSync against the real CLI file with synthetic handoff
 * fixtures written to a tempdir.
 *
 * Coverage per plan §8:
 *   - --help exits 0 with usage text
 *   - --classify <path-to-fixture> exits 0 with JSON
 *   - --human emits human-readable text
 *   - missing handoff path → die loud
 *   - unknown flag exits 2 with error
 *
 * Plan: slice-T3F-cycle-character-classifier-2026-05-20.md v0.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const CYCLE_CLI = resolvePath(
  import.meta.dir,
  "../../src/cycle-character/cli.ts",
);

let tmpRoot: string;
let fixturePath: string;

function runCycleChar(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", CYCLE_CLI, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cycle-char-cli-test-"));
  fixturePath = join(tmpRoot, "fixture-handoff.md");
  writeFileSync(
    fixturePath,
    `# Handoff
## Summary
Clean cycle.

## Cycle character
PRISTINE
`,
  );
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("cycle-character CLI", () => {
  it("--help exits 0 with usage text", () => {
    const result = runCycleChar(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cycle-character CLI");
    expect(result.stdout).toContain("--classify");
  });

  it("--classify <fixture> exits 0 with JSON", () => {
    const result = runCycleChar(["--classify", fixturePath]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      class: string;
      confidence: string;
      source: string;
      self_declared_class: string | null;
    };
    expect(parsed.class).toBe("PRISTINE");
    expect(parsed.source).toBe("self-declared");
    expect(parsed.self_declared_class).toBe("PRISTINE");
  });

  it("--human emits human-readable text", () => {
    const result = runCycleChar(["--classify", fixturePath, "--human"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("class:");
    expect(result.stdout).toContain("PRISTINE");
    expect(result.stdout).toContain("confidence:");
    expect(result.stdout).toContain("signals:");
  });

  it("missing handoff path → die loud", () => {
    const result = runCycleChar([
      "--classify",
      join(tmpRoot, "does-not-exist.md"),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not read handoff");
  });

  it("unknown flag exits 2 with error", () => {
    const result = runCycleChar(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown flag");
  });
});
