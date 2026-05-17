// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L:142 picker channel-liveness integration tests.
 *
 * Coverage matrix (5 result kinds × edge cases):
 *
 *   live:
 *     - one peer heartbeat <30 min → live (1 live, 0 online)
 *     - mixed: 1 live + 1 online + 1 stale → live (1 live, 1 online)
 *
 *   online:
 *     - one peer heartbeat between 30 min and 24 h → online (0 live, 1 online)
 *
 *   stale:
 *     - one peer heartbeat >24 h → stale
 *     - channel exists with participants but no heartbeats → stale
 *
 *   missing:
 *     - derived channel has no on-disk channel dir
 *
 *   derive-failed:
 *     - handoff filename doesn't match HANDOFF_<id>.md shape
 *
 *   Self-exclusion:
 *     - selfSessionId=A excluded; only B counted as live
 *     - selfSessionId=null disables filter; both peers counted
 *
 * Fixture pattern mirrors handoff-resolver.test.ts: tmpdir-scoped
 * `CLAUDE_CONDUCTOR_CHANNELS_DIR`; primitives via `createChannel` +
 * `touchHeartbeat`; heartbeat backdating via `utimesSync`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createChannel,
  joinChannel,
  touchHeartbeat,
} from "../../src/channels/index.ts";
import { summarizeChannelForHandoff } from "../../src/channels/handoff-resolver.ts";

const SESSION_A = "11111111-1111-1111-1111-111111111111";
const SESSION_B = "22222222-2222-2222-2222-222222222222";
const SESSION_C = "33333333-3333-3333-3333-333333333333";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "l142-picker-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
  process.env["CLAUDE_SESSION_ID"] = SESSION_A;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
  if (prevSessionId !== undefined) {
    process.env["CLAUDE_SESSION_ID"] = prevSessionId;
  } else {
    delete process.env["CLAUDE_SESSION_ID"];
  }
});

function writeHandoffBody(filename: string, body: string): string {
  const path = join(tmpRoot, filename);
  writeFileSync(path, body, "utf-8");
  return path;
}

function backdateHeartbeat(
  channelId: string,
  sessionId: string,
  msAgo: number,
): void {
  const past = (Date.now() - msAgo) / 1000;
  const channelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] ?? "";
  utimesSync(join(channelsDir, channelId, "heartbeats", sessionId), past, past);
}

describe("summarizeChannelForHandoff — live", () => {
  it("returns live with peer count 1 when peer heartbeat <30 min", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_B,
    });
    touchHeartbeat(channelId, SESSION_B);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);

    expect(result.kind).toBe("live");
    if (result.kind === "live") {
      expect(result.channelId).toBe(channelId);
      expect(result.livePeerCount).toBe(1);
      expect(result.onlinePeerCount).toBe(0);
    }
  });

  it("returns live with mixed live + online peer counts", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_B,
    });
    await joinChannel({ channelId, sessionId: SESSION_C });
    touchHeartbeat(channelId, SESSION_B);
    touchHeartbeat(channelId, SESSION_C);
    backdateHeartbeat(channelId, SESSION_C, 90 * 60 * 1000);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);

    expect(result.kind).toBe("live");
    if (result.kind === "live") {
      expect(result.livePeerCount).toBe(1);
      expect(result.onlinePeerCount).toBe(1);
    }
  });
});

describe("summarizeChannelForHandoff — online", () => {
  it("returns online when only online (no live) peers present", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_B,
    });
    touchHeartbeat(channelId, SESSION_B);
    backdateHeartbeat(channelId, SESSION_B, 90 * 60 * 1000);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);

    expect(result.kind).toBe("online");
    if (result.kind === "online") {
      expect(result.livePeerCount).toBe(0);
      expect(result.onlinePeerCount).toBe(1);
    }
  });
});

describe("summarizeChannelForHandoff — stale", () => {
  it("returns stale when peer heartbeat >24h old", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_B,
    });
    touchHeartbeat(channelId, SESSION_B);
    backdateHeartbeat(channelId, SESSION_B, 25 * 60 * 60 * 1000);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);

    expect(result.kind).toBe("stale");
    if (result.kind === "stale") {
      expect(result.channelId).toBe(channelId);
      expect(result.livePeerCount).toBe(0);
      expect(result.onlinePeerCount).toBe(0);
    }
  });

  it("returns stale when all heartbeats are >24h old (multi-peer aging)", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_B,
    });
    await joinChannel({ channelId, sessionId: SESSION_C });
    touchHeartbeat(channelId, SESSION_B);
    touchHeartbeat(channelId, SESSION_C);
    backdateHeartbeat(channelId, SESSION_B, 25 * 60 * 60 * 1000);
    backdateHeartbeat(channelId, SESSION_C, 48 * 60 * 60 * 1000);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);

    expect(result.kind).toBe("stale");
  });
});

describe("summarizeChannelForHandoff — missing", () => {
  it("returns missing when derived channel has no on-disk dir", () => {
    const channelId = "2026-05-17_22-00";
    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");

    const result = summarizeChannelForHandoff(path, SESSION_A);
    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.channelId).toBe(channelId);
    }
  });
});

describe("summarizeChannelForHandoff — derive-failed", () => {
  it("returns derive-failed when handoff filename lacks HANDOFF_ prefix", () => {
    const path = writeHandoffBody("not-a-handoff.md", "# Random\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);
    expect(result.kind).toBe("derive-failed");
    if (result.kind === "derive-failed") {
      expect(result.detail).toContain("HANDOFF_");
    }
  });
});

describe("summarizeChannelForHandoff — self-exclusion", () => {
  it("excludes self session id from live peer count", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    await joinChannel({ channelId, sessionId: SESSION_B });
    touchHeartbeat(channelId, SESSION_A);
    touchHeartbeat(channelId, SESSION_B);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);

    expect(result.kind).toBe("live");
    if (result.kind === "live") {
      expect(result.livePeerCount).toBe(1);
    }
  });

  it("returns stale when self is the only peer with a live heartbeat", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    touchHeartbeat(channelId, SESSION_A);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, SESSION_A);

    expect(result.kind).toBe("stale");
  });

  it("counts all peers when selfSessionId is null", async () => {
    const channelId = "2026-05-17_22-00";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    await joinChannel({ channelId, sessionId: SESSION_B });
    touchHeartbeat(channelId, SESSION_A);
    touchHeartbeat(channelId, SESSION_B);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");
    const result = summarizeChannelForHandoff(path, null);

    expect(result.kind).toBe("live");
    if (result.kind === "live") {
      expect(result.livePeerCount).toBe(2);
    }
  });
});
