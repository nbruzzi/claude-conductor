// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Stream 3 Slice 2 — repo-worktree-provisioner hook tests.
 *
 * Mirrors the dotfiles-worktree-provisioner.test.ts shape: real git
 * fixtures (no mocking) so the actual generic primitive integration is
 * exercised. Per RFC v0.2 §Tests subsection 1.
 *
 * Coverage:
 * - Feature-flag off → pass()
 * - Subagent skip (CLAUDE_CODE_SUBAGENT=1) → pass()
 * - Config absent → pass()
 * - Config empty repos → pass()
 * - Config malformed JSON → warn() with breadcrumb naming parse error
 * - Single opted-in repo → worktree appears at expected path
 * - Multi-repo opted-in → both worktrees appear
 * - Skips repos with auto:false
 * - siblingCloneOf reference to absent repo → warn() with breadcrumb
 * - siblingCloneOf cycle → warn() with breadcrumb
 * - Idempotent re-run → breadcrumb only
 * - Topo-ordered provisioning when siblingCloneOf-target appears later in config
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check as provisionerCheck } from "../../../src/hooks/checks/repo-worktree-provisioner.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "f9e8d7c6-b5a4-3210-9876-543210fedcba";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";
const SUBAGENT_ENV = "CLAUDE_CODE_SUBAGENT";
const CONFIG_ENV = "CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG";

let tmpHome: string;
let prevFlag: string | undefined;
let prevSubagent: string | undefined;
let prevConfig: string | undefined;

/** Initialize a bare git repo at `path` so `git worktree add` works. */
function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: path });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "init", "--no-gpg-sign"],
    {
      cwd: path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "t@x",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "t@x",
      },
    },
  );
}

function writeConfig(path: string, content: string): void {
  writeFileSync(path, content);
}

function makeInput(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: tmpHome,
    transcriptPath: undefined,
    raw: { session_id: SID },
    dispatch: DEFAULT_DISPATCH,
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "repo-wt-prov-"));
  prevFlag = process.env[FEATURE_FLAG_ENV];
  prevSubagent = process.env[SUBAGENT_ENV];
  prevConfig = process.env[CONFIG_ENV];
  delete process.env[FEATURE_FLAG_ENV];
  delete process.env[SUBAGENT_ENV];
  delete process.env[CONFIG_ENV];
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevFlag !== undefined) process.env[FEATURE_FLAG_ENV] = prevFlag;
  else delete process.env[FEATURE_FLAG_ENV];
  if (prevSubagent !== undefined) process.env[SUBAGENT_ENV] = prevSubagent;
  else delete process.env[SUBAGENT_ENV];
  if (prevConfig !== undefined) process.env[CONFIG_ENV] = prevConfig;
  else delete process.env[CONFIG_ENV];
});

describe("repo-worktree-provisioner hook", () => {
  it("returns pass() when feature flag is unset", async () => {
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns pass() when CLAUDE_CODE_SUBAGENT=1 (subagent inherits parent worktree)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    process.env[SUBAGENT_ENV] = "1";
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns pass() when config file is absent", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    process.env[CONFIG_ENV] = join(tmpHome, "does-not-exist.json");
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns pass() when config repos array is empty", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const configPath = join(tmpHome, "empty.json");
    writeConfig(configPath, `{"version":1,"repos":[]}`);
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("warns with breadcrumb when config JSON is malformed (does NOT fail session-start)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const configPath = join(tmpHome, "broken.json");
    writeConfig(configPath, `{ broken: "json", "repos": [`);
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0); // warn, not block
    expect(result.stdout).toContain("config malformed");
    expect(result.stdout).toContain(configPath);
    expect(result.stdout).toContain("session continues");
  });

  it("provisions a single opted-in repo's worktree at expected path", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repoCanonical = join(tmpHome, "repo-a");
    initRepo(repoCanonical);
    const configPath = join(tmpHome, "config.json");
    writeConfig(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [{ name: "repo-a", canonical: repoCanonical, auto: true }],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    const expectedWorktreePath = `${repoCanonical}-${SID.slice(0, 8)}`;
    expect(existsSync(expectedWorktreePath)).toBe(true);
  });

  it("provisions multiple opted-in repos in one hook invocation", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repoA = join(tmpHome, "repo-a");
    const repoB = join(tmpHome, "repo-b");
    initRepo(repoA);
    initRepo(repoB);
    const configPath = join(tmpHome, "config.json");
    writeConfig(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [
          { name: "repo-a", canonical: repoA, auto: true },
          { name: "repo-b", canonical: repoB, auto: true },
        ],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(existsSync(`${repoA}-${SID.slice(0, 8)}`)).toBe(true);
    expect(existsSync(`${repoB}-${SID.slice(0, 8)}`)).toBe(true);
  });

  it("skips repos with auto:false but provisions auto:true siblings", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repoA = join(tmpHome, "repo-a");
    const repoB = join(tmpHome, "repo-b");
    initRepo(repoA);
    initRepo(repoB);
    const configPath = join(tmpHome, "config.json");
    writeConfig(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [
          { name: "repo-a", canonical: repoA, auto: false },
          { name: "repo-b", canonical: repoB, auto: true },
        ],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(existsSync(`${repoA}-${SID.slice(0, 8)}`)).toBe(false);
    expect(existsSync(`${repoB}-${SID.slice(0, 8)}`)).toBe(true);
  });

  it("fails-closed on siblingCloneOf reference to absent repo (warn + no provision)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repoA = join(tmpHome, "repo-a");
    initRepo(repoA);
    const configPath = join(tmpHome, "config.json");
    writeConfig(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [
          {
            name: "repo-a",
            canonical: repoA,
            auto: true,
            siblingCloneOf: "absent-target",
          },
        ],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0); // warn, not block
    expect(result.stdout).toContain("topo-sort failed");
    expect(result.stdout).toContain("absent-target");
    expect(existsSync(`${repoA}-${SID.slice(0, 8)}`)).toBe(false);
  });

  it("fails-closed on siblingCloneOf cycle (warn + no provision)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repoA = join(tmpHome, "repo-a");
    const repoB = join(tmpHome, "repo-b");
    initRepo(repoA);
    initRepo(repoB);
    const configPath = join(tmpHome, "config.json");
    writeConfig(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [
          {
            name: "repo-a",
            canonical: repoA,
            auto: true,
            siblingCloneOf: "repo-b",
          },
          {
            name: "repo-b",
            canonical: repoB,
            auto: true,
            siblingCloneOf: "repo-a",
          },
        ],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cycle detected");
    expect(existsSync(`${repoA}-${SID.slice(0, 8)}`)).toBe(false);
    expect(existsSync(`${repoB}-${SID.slice(0, 8)}`)).toBe(false);
  });

  it("idempotent re-run — second call sees existing worktree + emits breadcrumb only", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repoCanonical = join(tmpHome, "repo-a");
    initRepo(repoCanonical);
    const configPath = join(tmpHome, "config.json");
    writeConfig(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [{ name: "repo-a", canonical: repoCanonical, auto: true }],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    await provisionerCheck(makeInput());
    const expectedWorktreePath = `${repoCanonical}-${SID.slice(0, 8)}`;
    expect(existsSync(expectedWorktreePath)).toBe(true);

    const result2 = await provisionerCheck(makeInput());
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toContain("idempotent re-run");
  });

  it("topo-ordered provisioning when siblingCloneOf-target appears after dependent in config", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repoA = join(tmpHome, "repo-a");
    const repoB = join(tmpHome, "repo-b");
    initRepo(repoA);
    initRepo(repoB);
    const configPath = join(tmpHome, "config.json");
    writeConfig(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [
          {
            name: "repo-a",
            canonical: repoA,
            auto: true,
            siblingCloneOf: "repo-b",
          },
          { name: "repo-b", canonical: repoB, auto: true },
        ],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(existsSync(`${repoA}-${SID.slice(0, 8)}`)).toBe(true);
    expect(existsSync(`${repoB}-${SID.slice(0, 8)}`)).toBe(true);
    // Breadcrumbs should appear in topo order: repo-b before repo-a.
    const indexB = result.stdout.indexOf("repo-worktree-provisioner:repo-b");
    const indexA = result.stdout.indexOf("repo-worktree-provisioner:repo-a");
    expect(indexB).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeGreaterThan(indexB);
  });
});
