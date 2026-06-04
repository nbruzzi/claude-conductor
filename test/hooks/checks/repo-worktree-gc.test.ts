// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Stream 3 Slice 3 — repo-worktree-gc hook tests.
 *
 * Mirrors dotfiles-worktree-gc.test.ts pattern: real git fixtures (no
 * mocking) + manipulate fake heartbeats at the canonical-claude-home
 * anchor to exercise the sid-prefix-liveness primary check.
 *
 * Coverage per RFC v0.2 §Tests subsection 2:
 * - Feature-flag off → pass()
 * - Config absent → pass() (no sweep)
 * - Config empty repos → pass()
 * - Stale worktree (no live heartbeat for sid-prefix) → reaped
 * - Live worktree (heartbeat fresh for sid-prefix) → preserved
 * - Forensic marker present → skipped
 * - Rate-gate: second hook fire within 5min → no scan
 * - cleanupAfterIdleHours per-repo override → uses per-repo threshold
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check as gcCheck } from "../../../src/hooks/checks/repo-worktree-gc.ts";
import { readPresenceFailures } from "../../../src/shared/presence-failure-log.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "b1c2d3e4-f5a6-4789-9abc-def012345678";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";
const CONFIG_ENV = "CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG";
const HOME_ENV = "HOME";

let tmpHome: string;
let prevHome: string | undefined;
let prevFlag: string | undefined;
let prevConfig: string | undefined;

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

function addWorktree(canonical: string, sidPrefix: string): string {
  const worktreePath = `${canonical}-${sidPrefix}`;
  execFileSync(
    "git",
    ["worktree", "add", "-b", `worktree/${sidPrefix}`, worktreePath],
    { cwd: canonical },
  );
  return worktreePath;
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
  tmpHome = mkdtempSync(join(tmpdir(), "repo-wt-gc-"));
  mkdirSync(join(tmpHome, ".claude", "logs"), { recursive: true });
  prevHome = process.env[HOME_ENV];
  prevFlag = process.env[FEATURE_FLAG_ENV];
  prevConfig = process.env[CONFIG_ENV];
  process.env[HOME_ENV] = tmpHome;
  delete process.env[FEATURE_FLAG_ENV];
  delete process.env[CONFIG_ENV];
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevHome !== undefined) process.env[HOME_ENV] = prevHome;
  else delete process.env[HOME_ENV];
  if (prevFlag !== undefined) process.env[FEATURE_FLAG_ENV] = prevFlag;
  else delete process.env[FEATURE_FLAG_ENV];
  if (prevConfig !== undefined) process.env[CONFIG_ENV] = prevConfig;
  else delete process.env[CONFIG_ENV];
});

describe("repo-worktree-gc hook", () => {
  it("returns pass() when feature flag is unset", async () => {
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns pass() when config is absent (nothing to sweep)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    process.env[CONFIG_ENV] = join(tmpHome, "missing.json");
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns pass() when config repos array is empty", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const configPath = join(tmpHome, "empty.json");
    writeFileSync(configPath, `{"version":1,"repos":[]}`);
    process.env[CONFIG_ENV] = configPath;
    const result = await gcCheck(makeInput());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("reaps stale worktree (no live heartbeat for sid-prefix)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const stalePrefix = "deadbeef";
    const worktreePath = addWorktree(repo, stalePrefix);
    expect(existsSync(worktreePath)).toBe(true);

    const configPath = join(tmpHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [{ name: "repo-a", canonical: repo, auto: true, gc: true }],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    await gcCheck(makeInput());
    // No heartbeats planted for "deadbeef" sid-prefix; reaper sweeps.
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("preserves worktree when sid-prefix-liveness anchor is live", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const livePrefix = SID.slice(0, 8); // our session is "live"
    const worktreePath = addWorktree(repo, livePrefix);

    const { artifactIdFromPath, touchHeartbeat } =
      await import("../../../src/active-sessions/index.ts");
    const claudeHome = join(tmpHome, ".claude");
    const artifactId = artifactIdFromPath(claudeHome);
    touchHeartbeat({
      artifactId,
      sessionId: SID,
      artifactPath: claudeHome,
      now: Date.now(),
    });

    const configPath = join(tmpHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [{ name: "repo-a", canonical: repo, auto: true, gc: true }],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    await gcCheck(makeInput());
    // Live heartbeat for matching sid-prefix → worktree preserved.
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("skips reap when forensic marker present for sid-prefix", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const stalePrefix = "cafebabe";
    const worktreePath = addWorktree(repo, stalePrefix);

    const forensicDir = join(tmpHome, ".claude", "session-state-forensic");
    mkdirSync(forensicDir, { recursive: true });
    writeFileSync(join(forensicDir, stalePrefix), "");

    const configPath = join(tmpHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [{ name: "repo-a", canonical: repo, auto: true, gc: true }],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    await gcCheck(makeInput());
    expect(existsSync(worktreePath)).toBe(true); // forensic-marker preserves
  });

  it("rate-gate: second hook fire within 5min is a no-op (cursor mtime fresh)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const stalePrefix = "12345678";
    const worktreePath = addWorktree(repo, stalePrefix);

    const configPath = join(tmpHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [{ name: "repo-a", canonical: repo, auto: true, gc: true }],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    // Plant a fresh cursor before first call. The reaper should see
    // "recent sweep" + skip — worktree preserved.
    const cursorPath = join(
      tmpHome,
      ".claude/logs/.repo-worktree-gc-cursor.repo-a",
    );
    writeFileSync(cursorPath, "");

    await gcCheck(makeInput());
    expect(existsSync(worktreePath)).toBe(true); // skipped due to rate-gate
  });

  it("cleanupAfterIdleHours per-repo override uses per-repo threshold (preserves 90-min-old heartbeat under 2hr threshold)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const stalePrefix = "abcd1234";
    const worktreePath = addWorktree(repo, stalePrefix);

    // Plant a 90-min-old heartbeat for the sid-prefix.
    // - Default 60min threshold → 90min is stale → would reap
    // - Override cleanupAfterIdleHours: 2 (2hr threshold) → 90min is fresh → preserves
    // Test confirms the OVERRIDE is being applied.
    const ninetyMinAgoMs = Date.now() - 90 * 60 * 1000;
    const { artifactIdFromPath, touchHeartbeat } =
      await import("../../../src/active-sessions/index.ts");
    const claudeHome = join(tmpHome, ".claude");
    const artifactId = artifactIdFromPath(claudeHome);
    const liveSidUsingPrefix = `${stalePrefix}-1234-4567-8abc-def012345678`;
    touchHeartbeat({
      artifactId,
      sessionId: liveSidUsingPrefix,
      artifactPath: claudeHome,
      now: ninetyMinAgoMs,
    });
    // Force the file's mtime back 90min so listAllHeartbeats ages it.
    const heartbeatPath = join(
      claudeHome,
      "active-sessions",
      artifactId,
      "heartbeats",
      liveSidUsingPrefix,
    );
    const ninetyMinDate = new Date(ninetyMinAgoMs);
    utimesSync(heartbeatPath, ninetyMinDate, ninetyMinDate);

    const configPath = join(tmpHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [
          {
            name: "repo-a",
            canonical: repo,
            auto: true,
            gc: true,
            cleanupAfterIdleHours: 2, // 2hr threshold (overrides default 60min)
          },
        ],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    await gcCheck(makeInput());
    // 90-min-old heartbeat is within 2hr threshold → preserved.
    expect(existsSync(worktreePath)).toBe(true);
  });

  /* ─── Channel-store liveness consult (L1049 slice-2b) ───────────── */

  function plantChannelHeartbeat(fullSid: string, ageSeconds: number): void {
    const dir = join(
      tmpHome,
      ".claude",
      "channels",
      "coordination",
      "heartbeats",
    );
    mkdirSync(dir, { recursive: true });
    const p = join(dir, fullSid);
    writeFileSync(p, String(Date.now()));
    const mtime = Date.now() / 1000 - ageSeconds;
    utimesSync(p, mtime, mtime);
  }

  it("REGRESSION (3/3 live-reap): fresh CHANNEL heartbeat + no active-sessions → preserved + channel breadcrumb", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const sidPrefix = "c0ffee00";
    const fullSid = "c0ffee00-1111-4567-8abc-def012345678";
    const worktreePath = addWorktree(repo, sidPrefix);
    plantChannelHeartbeat(fullSid, 0); // fresh channel HB; no active-sessions HB

    const configPath = join(tmpHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [{ name: "repo-a", canonical: repo, auto: true, gc: true }],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    await gcCheck(makeInput());
    expect(existsSync(worktreePath)).toBe(true); // preserved by the channel consult

    const fallback = readPresenceFailures().find(
      (e) => e.kind === "worktree-gc-liveness-fallback-fired",
    );
    expect(fallback).toBeDefined();
    expect(fallback?.detail).toContain("coordination channel");
  });

  it("M4 window FLOOR: short per-repo window (15min) + channel HB aged 30min → preserved (max(repo,60min) floor)", async () => {
    // The channel store is SPARSE (send-driven). A short per-repo
    // cleanupAfterIdleHours must NOT shorten the channel branch below the 60-min
    // send-cadence floor — else a channel-only-fresh session (last send 30min
    // ago, the exact 3/3 victim class) reads false-dead under a 15-min window.
    process.env[FEATURE_FLAG_ENV] = "1";
    const repo = join(tmpHome, "repo-a");
    initRepo(repo);
    const sidPrefix = "f100f100";
    const fullSid = "f100f100-2222-4567-8abc-def012345678";
    const worktreePath = addWorktree(repo, sidPrefix);
    plantChannelHeartbeat(fullSid, 30 * 60); // 30min old — > 15min repo, < 60min floor

    const configPath = join(tmpHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repos: [
          {
            name: "repo-a",
            canonical: repo,
            auto: true,
            gc: true,
            cleanupAfterIdleHours: 0.25, // 15min per-repo window
          },
        ],
      }),
    );
    process.env[CONFIG_ENV] = configPath;

    await gcCheck(makeInput());
    // Without the floor (channel window = 15min) the 30min HB would be stale →
    // reaped. The max(15min, 60min) = 60min floor keeps it fresh → preserved.
    expect(existsSync(worktreePath)).toBe(true);
  });
});
