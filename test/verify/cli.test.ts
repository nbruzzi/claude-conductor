// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Integration tests for the verify CLI (Tier 3-A).
 *
 * Pattern: spawnSync against the real CLI file from the repo root
 * working directory using the canonical verify-manifest.json + CI YAML.
 *
 * Coverage per plan §7:
 *   - --help exits 0 with usage text
 *   - --check against in-sync repo (real worktree) → exits 0
 *   - --check + --json against in-sync repo → JSON output, exit 0
 *   - --gate with unknown name exits non-zero with helpful error
 *   - unknown flag exits 2 with error
 *
 * Plan: slice-T3A-verify-manifest-2026-05-20.md v0.1.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const VERIFY_CLI = resolvePath(import.meta.dir, "../../src/verify/cli.ts");
const REPO_ROOT = resolvePath(import.meta.dir, "../..");

function runVerify(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", VERIFY_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("verify CLI", () => {
  it("--help exits 0 with usage text", () => {
    const result = runVerify(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verify CLI");
    expect(result.stdout).toContain("--check");
    expect(result.stdout).toContain("--gate");
  });

  it("--check against canonical worktree → exits 0 (in-sync)", () => {
    const result = runVerify(["--check"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("clean");
  });

  it("--check --json emits structured JSON drift report", () => {
    const result = runVerify(["--check", "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      ok_steps: readonly string[];
      manifest_only: readonly string[];
      ci_yaml_only: readonly string[];
    };
    expect(parsed.status).toBe("clean");
    expect(parsed.manifest_only).toEqual([]);
    expect(parsed.ci_yaml_only).toEqual([]);
    expect(parsed.ok_steps.length).toBeGreaterThan(0);
  });

  it("--gate with unknown name exits non-zero with helpful error", () => {
    const result = runVerify(["--gate", "totally-not-a-gate"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("totally-not-a-gate");
    expect(result.stderr).toContain("not found");
  });

  it("unknown flag exits 2 with error", () => {
    const result = runVerify(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown flag");
  });
});
