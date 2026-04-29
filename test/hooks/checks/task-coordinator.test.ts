// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 6 hook tests for `task-coordinator`.
 *
 * Coverage matrix per plan REV 2.1 §Slice 6:
 *   - non-Task tool → pass() (hook only fires on Task)
 *   - missing session id → pass() (fail-open per RE-W0-3)
 *   - no claims on any channel → pass() (no-op for non-coordinated sessions)
 *   - role=pen claim → pass() (dispatch is the expected pen-holder action)
 *   - role=queue claim → warn() with formatted reminder + pen-holder peer
 *   - role=out claim → block() exit 2 (sibling-parity with send role-gate)
 *   - multi-channel: any out → block; any queue (no out) → warn; all pen → pass
 *
 * Plan: ~/.claude/plans/prismatic-orbiting-mesh.md REV 2.1 §Slice 6.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { check } from "../../../src/hooks/checks/task-coordinator.ts";
import { createChannel } from "../../../src/channels/index.ts";
import { claimIdentity, setRole } from "../../../src/channels/identity.ts";
import type { HookInput } from "../../../src/hooks/types.ts";

const SANDBOX = `/tmp/test-task-coordinator-${process.pid}`;
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

function inputFor(sessionId: string, toolName = "Task"): HookInput {
  return {
    toolName,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw: { session_id: sessionId } as Record<string, unknown>,
    dispatch: { verbose: false },
  };
}

describe("task-coordinator hook", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns pass() for non-Task tools (Bash/Edit/Write/etc.)", async () => {
    const result = await check(inputFor(SESSION_A, "Bash"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // Source is empty for pass() — no [task-coordinator] label fires.
    expect(result.source).toBe("");
  });

  it("returns pass() when session_id is missing (fail-open)", async () => {
    const result = await check({
      toolName: "Task",
      filePath: undefined,
      command: undefined,
      cwd: undefined,
      transcriptPath: undefined,
      raw: {},
      dispatch: { verbose: false },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns pass() when session has no identity claims (no-op for non-coordinated)", async () => {
    await createChannel({
      channelId: "c-noclaim",
      handoffId: "c-noclaim",
      sessionId: SESSION_A,
    });
    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns pass() when role=pen on the claimed channel (no emission)", async () => {
    await createChannel({
      channelId: "c-pen",
      handoffId: "c-pen",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-pen", sessionId: SESSION_A });
    await setRole("c-pen", "Alpha", "pen");

    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns warn() with pen-holder hint when role=queue", async () => {
    await createChannel({
      channelId: "c-queue",
      handoffId: "c-queue",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-queue", sessionId: SESSION_A });
    // SESSION_A is queue (default role from claim), peer claims pen.
    await claimIdentity({ channelId: "c-queue", sessionId: SESSION_B });
    await setRole("c-queue", "Bravo", "pen");

    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[task-coordinator]");
    expect(result.stdout).toContain("queue");
    expect(result.stdout).toContain("c-queue");
    // Pen-holder peer letter surfaces in the warning.
    expect(result.stdout).toContain("Bravo");
    expect(result.stdout).toContain(
      "claude-conductor channels set-role c-queue --role pen",
    );
    expect(result.source).toBe("task-coordinator");
  });

  it("returns block() exit 2 with remediation when role=out", async () => {
    await createChannel({
      channelId: "c-out",
      handoffId: "c-out",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-out", sessionId: SESSION_A });
    await setRole("c-out", "Alpha", "out");

    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("[task-coordinator]");
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).toContain("'out'");
    expect(result.stdout).toContain("c-out");
    expect(result.stdout).toContain(
      "claude-conductor channels set-role c-out --role pen",
    );
    expect(result.source).toBe("task-coordinator");
  });

  it("multi-channel: any 'out' wins over 'queue'/'pen' (block)", async () => {
    // SESSION_A is pen on c-pen, queue on c-queue, out on c-out.
    // Hook must hard-block because at least one channel is out.
    for (const cid of ["c-mc-pen", "c-mc-queue", "c-mc-out"]) {
      await createChannel({
        channelId: cid,
        handoffId: cid,
        sessionId: SESSION_A,
      });
      await claimIdentity({ channelId: cid, sessionId: SESSION_A });
    }
    await setRole("c-mc-pen", "Alpha", "pen");
    await setRole("c-mc-queue", "Alpha", "queue");
    await setRole("c-mc-out", "Alpha", "out");

    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).toContain("c-mc-out");
  });

  it("multi-channel: any 'queue' wins over 'pen' when no 'out' (warn)", async () => {
    // SESSION_A is pen on c-mc-pen-only, queue on c-mc-queue-only.
    // Hook warns for the queue channel, doesn't block.
    for (const cid of ["c-mcwarn-pen", "c-mcwarn-queue"]) {
      await createChannel({
        channelId: cid,
        handoffId: cid,
        sessionId: SESSION_A,
      });
      await claimIdentity({ channelId: cid, sessionId: SESSION_A });
    }
    await setRole("c-mcwarn-pen", "Alpha", "pen");
    await setRole("c-mcwarn-queue", "Alpha", "queue");

    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[task-coordinator]");
    expect(result.stdout).toContain("queue");
    expect(result.stdout).toContain("c-mcwarn-queue");
    // Pen-only channel doesn't appear in the warning (only queue ones do).
    expect(result.stdout).not.toContain("c-mcwarn-pen");
  });

  it("multi-channel: all 'pen' → pass() with no emission", async () => {
    for (const cid of ["c-allpen-1", "c-allpen-2"]) {
      await createChannel({
        channelId: cid,
        handoffId: cid,
        sessionId: SESSION_A,
      });
      await claimIdentity({ channelId: cid, sessionId: SESSION_A });
      await setRole(cid, "Alpha", "pen");
    }
    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
