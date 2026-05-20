// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeStdio, runGit } from "../../src/git/index.ts";

/**
 * Slice 0 §Test grid §10 (T10.1, T10.2, T10.5, T10.6) — lifted-helper
 * coverage. T10.1 uses `git --version` (no fixture-repo needed). T10.2
 * uses mkdtempSync + `git init` to create an isolated fixture repo (N4
 * per plan v0.2). T10.5 + T10.6 verify the 4 decodeStdio input shapes.
 */

describe("runGit", () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "claude-conductor-git-test-"));
    const init = runGit(fixtureDir, ["init", "--quiet"]);
    if (init.status !== 0) {
      throw new Error(
        `fixture setup: git init failed: ${decodeStdio(init.stderr)}`,
      );
    }
  });

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("T10.1: happy path — `git --version` exits 0 with non-empty stdout", () => {
    // cwd doesn't have to be a git repo for `git --version`; use any valid dir.
    const result = runGit(process.cwd(), ["--version"]);
    expect(result.status).toBe(0);
    expect(decodeStdio(result.stdout)).toMatch(/^git version /);
  });

  test("T10.2: error path — `git rev-parse refs/heads/__nonexistent__` in fixture repo exits non-zero", () => {
    // Fixture repo created in beforeAll has no commits/branches; ref lookup fails.
    const result = runGit(fixtureDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/__nonexistent__",
    ]);
    expect(result.status).not.toBe(0);
  });
});

describe("decodeStdio", () => {
  test("T10.5a: Buffer input → trimmed string", () => {
    const buf = Buffer.from("hello world\n", "utf-8");
    expect(decodeStdio(buf)).toBe("hello world");
  });

  test("T10.5b: string input → trimmed string", () => {
    expect(decodeStdio("  spaced  ")).toBe("spaced");
  });

  test("T10.6a: null input → empty string", () => {
    expect(decodeStdio(null)).toBe("");
  });

  test("T10.6b: undefined input → empty string", () => {
    expect(decodeStdio(undefined)).toBe("");
  });

  test("T10.6c: empty Buffer → empty string", () => {
    expect(decodeStdio(Buffer.from("", "utf-8"))).toBe("");
  });
});
