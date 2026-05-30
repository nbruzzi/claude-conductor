// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle-3 hook tests for `session-reconcile-boot` (report-mode boot briefing).
 *
 * Verifies:
 *   - clean registry → pass() (no spam)
 *   - gc-eligible stale presence → warn() briefing that names the `--apply` CLI
 *   - REPORT-MODE invariant: the stale heartbeat is NOT deleted (no auto-GC)
 *
 * Report-mode is the cardinal contract (DLOG decisions/phase-3.md): the hook
 * must NEVER delete coordination state — that stays operator-explicit via
 * `reconcile-boot --apply`.
 *
 * Heartbeat fixtures are PROGRAMMATIC: liveness is `now - mtime`, so a fixture
 * is touched then back-dated past the GC floor via utimesSync (mirrors
 * test/active-sessions/reconcile-boot.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../../../src/hooks/checks/session-reconcile-boot.ts";
import {
  GC_WINDOW_MS,
  artifactIdFromPath,
  touchHeartbeat,
} from "../../../src/active-sessions/index.ts";
import type { HookInput } from "../../../src/hooks/types.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const STALE_SESSION = "22222222-2222-4222-8222-222222222222";

let tmpDir: string;
let prevDir: string | undefined;
let prevChannels: string | undefined;
let prevConfig: string | undefined;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-reconcile-boot-"));
  prevDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevConfig = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  // Isolate identity (channels) + worktree config so these presence-focused
  // assertions see no real cross-repo claims / worktrees leak in.
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpDir, "no-channels");
  process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = join(
    tmpDir,
    "no-config.json",
  );
});

afterEach(() => {
  restore("CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", prevDir);
  restore("CLAUDE_CONDUCTOR_CHANNELS_DIR", prevChannels);
  restore("CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG", prevConfig);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Create a stale, gc-eligible presence heartbeat: touch it, then back-date the
 *  file mtime past the GC floor (classifyLiveness keys off `now - mtime`). */
function staleHeartbeat(artifactPath: string, sessionId: string): string {
  const artifactId = artifactIdFromPath(artifactPath);
  touchHeartbeat({ artifactId, sessionId, artifactPath, now: Date.now() });
  const path = join(tmpDir, artifactId, "heartbeats", sessionId);
  const backdatedSec = (Date.now() - (GC_WINDOW_MS + 120_000)) / 1000;
  utimesSync(path, backdatedSec, backdatedSec);
  return path;
}

function inputFor(sessionId: string): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw: { session_id: sessionId },
    dispatch: { verbose: false },
  };
}

describe("session-reconcile-boot hook", () => {
  it("returns pass() on a clean registry (no gc-eligible presence)", async () => {
    const result = await check(inputFor(SESSION));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("warns with a --apply briefing when gc-eligible stale presence exists", async () => {
    staleHeartbeat("/private/tmp/srb-stale-repo", STALE_SESSION);
    const result = await check(inputFor(SESSION));
    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("session-reconcile-boot");
    expect(result.stdout).toContain("gc-eligible");
    expect(result.stdout).toContain("reconcile-boot --apply");
  });

  it("REPORT-MODE: does NOT delete the stale heartbeat (no auto-GC)", async () => {
    const path = staleHeartbeat("/private/tmp/srb-report-repo", STALE_SESSION);
    expect(existsSync(path)).toBe(true);
    await check(inputFor(SESSION));
    // Cardinal contract: report-mode never deletes coordination state.
    expect(existsSync(path)).toBe(true);
  });
});
