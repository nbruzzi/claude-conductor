// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 5 hook tests for `identity-injector`.
 *
 * Verifies the hook's behavior across the canonical scenarios:
 *   - no session id → pass()
 *   - no claims on any channel → pass()
 *   - first emission for a claimed channel → warn() with formatted block
 *   - re-emit when (identity, role, peer-letters) change → warn()
 *   - cursor matches current state → pass() (no spam)
 *   - multiple channels → all blocks emit on first session start
 *   - corrupt cursor → treated as no-cursor, emits
 *
 * Plan: ~/.claude/plans/prismatic-orbiting-mesh.md REV 2.1 §Slice 5.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { check } from "../../../src/hooks/checks/identity-injector.ts";
import { createChannel } from "../../../src/channels/index.ts";
import { claimIdentity, setRole } from "../../../src/channels/identity.ts";
import type { HookInput } from "../../../src/hooks/types.ts";

const SANDBOX = `/tmp/test-identity-injector-${process.pid}`;
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

function inputFor(sessionId: string): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw: { session_id: sessionId } as Record<string, unknown>,
    dispatch: { verbose: false },
  };
}

describe("identity-injector hook", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns pass() when session_id is missing", async () => {
    const result = await check({
      toolName: undefined,
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

  it("returns pass() when session has no identity claims", async () => {
    await createChannel({
      channelId: "c-noclaim",
      handoffId: "c-noclaim",
      sessionId: SESSION_A,
    });
    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("emits warn() with identity context on first claimed channel", async () => {
    await createChannel({
      channelId: "c-first",
      handoffId: "c-first",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-first", sessionId: SESSION_A });

    const result = await check(inputFor(SESSION_A));
    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("identity-injector");
    expect(result.stdout).toContain("Identity context");
    expect(result.stdout).toContain("You are Alpha on channel c-first");
    expect(result.stdout).toContain("role=queue");
    expect(result.stdout).toContain("Active peers: no peers");
    expect(result.stdout).toContain("claude-conductor channels whoami c-first");
  });

  it("does NOT re-emit when state matches cursor", async () => {
    await createChannel({
      channelId: "c-cursor",
      handoffId: "c-cursor",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-cursor", sessionId: SESSION_A });

    const first = await check(inputFor(SESSION_A));
    expect(first.stdout).toContain("Identity context");

    const second = await check(inputFor(SESSION_A));
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("");
  });

  it("re-emits when role changes (cursor delta)", async () => {
    await createChannel({
      channelId: "c-rolechange",
      handoffId: "c-rolechange",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-rolechange", sessionId: SESSION_A });
    await check(inputFor(SESSION_A));

    await setRole("c-rolechange", "Alpha", "pen");

    const result = await check(inputFor(SESSION_A));
    expect(result.stdout).toContain("Identity context");
    expect(result.stdout).toContain("role=pen");
  });

  it("re-emits when peer roster changes (peer joins)", async () => {
    await createChannel({
      channelId: "c-peerdelta",
      handoffId: "c-peerdelta",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-peerdelta", sessionId: SESSION_A });
    await check(inputFor(SESSION_A));

    await claimIdentity({ channelId: "c-peerdelta", sessionId: SESSION_B });

    const result = await check(inputFor(SESSION_A));
    expect(result.stdout).toContain("Identity context");
    expect(result.stdout).toContain("Active peers: Bravo (queue)");
  });

  it("emits all channels on first session start", async () => {
    for (const id of ["c-multi-a", "c-multi-b", "c-multi-c"]) {
      await createChannel({
        channelId: id,
        handoffId: id,
        sessionId: SESSION_A,
      });
      await claimIdentity({ channelId: id, sessionId: SESSION_A });
    }

    const result = await check(inputFor(SESSION_A));
    expect(result.stdout).toContain("c-multi-a");
    expect(result.stdout).toContain("c-multi-b");
    expect(result.stdout).toContain("c-multi-c");
  });

  it("treats corrupt cursor as no-cursor and emits", async () => {
    await createChannel({
      channelId: "c-corrupt-cursor",
      handoffId: "c-corrupt-cursor",
      sessionId: SESSION_A,
    });
    await claimIdentity({
      channelId: "c-corrupt-cursor",
      sessionId: SESSION_A,
    });

    const cursorPath = join(
      SANDBOX,
      "c-corrupt-cursor",
      "identity-emit-cursors",
      `${SESSION_A}.json`,
    );
    mkdirSync(join(SANDBOX, "c-corrupt-cursor", "identity-emit-cursors"), {
      recursive: true,
    });
    writeFileSync(cursorPath, "{ not json", "utf-8");

    const result = await check(inputFor(SESSION_A));
    expect(result.stdout).toContain("Identity context");

    const newCursor = JSON.parse(readFileSync(cursorPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(newCursor["identity"]).toBe("Alpha");
  });

  it("writes cursor with correct shape post-emission", async () => {
    await createChannel({
      channelId: "c-shape",
      handoffId: "c-shape",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-shape", sessionId: SESSION_A });
    await claimIdentity({ channelId: "c-shape", sessionId: SESSION_B });

    await check(inputFor(SESSION_A));

    const cursorPath = join(
      SANDBOX,
      "c-shape",
      "identity-emit-cursors",
      `${SESSION_A}.json`,
    );
    const cursor = JSON.parse(readFileSync(cursorPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(cursor["identity"]).toBe("Alpha");
    expect(cursor["role"]).toBe("queue");
    expect(cursor["peer_letters"]).toEqual(["Bravo"]);
    expect(typeof cursor["emitted_at"]).toBe("string");
  });
});
