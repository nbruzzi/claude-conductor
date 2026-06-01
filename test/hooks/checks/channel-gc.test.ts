// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for channel-gc's whole-channel archival, focused on the eternal
 * coordination channel archival-EXEMPTION — the coupled counterpart of the
 * stale-identity reclaim reaper. The exemption ensures the eternal channel is
 * never archived-on-idle (which would recreate it into a fresh empty dir on
 * the next session → silent history loss); its dead claims are reclaimed
 * per-letter by channels-gc-reaper instead.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../../../src/hooks/checks/channel-gc.ts";
import {
  COORDINATION_CHANNEL_ID,
  createChannel,
  listChannels,
  resolveChannelsDir,
} from "../../../src/channels/index.ts";
import type { HookInput } from "../../../src/hooks/types.ts";

const OWNER = "00000000-0000-4000-8000-000000000000";

let tmpRoot: string;
let prevChannelsDir: string | undefined;

function sandbox(): void {
  tmpRoot = mkdtempSync(join(tmpdir(), "channel-gc-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
}

function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
}

function inputFor(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw: { hook_event_name: "SessionStart" } as Record<string, unknown>,
    dispatch: { verbose: false },
  };
}

/**
 * Make a channel stale by backdating its only heartbeat past the 24h
 * STALE_HEARTBEAT window. `createChannel` writes one heartbeat for the creator
 * at mtime=now; with no messages and a recent created_at, the heartbeat age is
 * the staleness trigger isStale() evaluates.
 */
function makeStale(channelId: string): void {
  const hbPath = join(resolveChannelsDir(), channelId, "heartbeats", OWNER);
  const past = Date.now() / 1000 - 25 * 60 * 60; // 25h ago
  utimesSync(hbPath, past, past);
}

function liveIds(): string[] {
  return listChannels()
    .map((c) => c.id)
    .sort();
}

describe("channel-gc coordination archival-exemption", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("does NOT archive the eternal coordination channel even when stale", async () => {
    await createChannel({
      channelId: COORDINATION_CHANNEL_ID,
      handoffId: COORDINATION_CHANNEL_ID,
      sessionId: OWNER,
    });
    makeStale(COORDINATION_CHANNEL_ID);

    const result = await check(inputFor());

    expect(result.exitCode).toBe(0);
    expect(liveIds()).toContain(COORDINATION_CHANNEL_ID);
    // Nothing archived → no archival summary line mentioning the channel.
    expect(result.stdout).not.toContain(COORDINATION_CHANNEL_ID);
  });

  it("archives a stale NON-coordination channel (control — the exemption is why coordination survives)", async () => {
    await createChannel({
      channelId: COORDINATION_CHANNEL_ID,
      handoffId: COORDINATION_CHANNEL_ID,
      sessionId: OWNER,
    });
    makeStale(COORDINATION_CHANNEL_ID);
    await createChannel({
      channelId: "ordinary-channel",
      handoffId: "ordinary-channel",
      sessionId: OWNER,
    });
    makeStale("ordinary-channel");

    const result = await check(inputFor());

    // Ordinary stale channel archived; coordination exempt.
    expect(liveIds()).toEqual([COORDINATION_CHANNEL_ID]);
    const all = listChannels({ includeArchived: true });
    expect(all.find((c) => c.id === "ordinary-channel")?.archived).toBe(true);
    expect(result.stdout).toContain("ordinary-channel");
  });
});
