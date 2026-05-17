// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L141 handoff resolver integration tests.
 *
 * Coverage matrix (4 result kinds × edge cases):
 *
 *   derived-active:
 *     - derived channel has 1 live peer (basic)
 *     - derived channel has multiple live peers (count correctness)
 *
 *   derived-empty-no-body-refs:
 *     - derived channel doesn't exist + body names no channels
 *     - derived channel exists but stale peers + body empty
 *
 *   mismatch-body-has-live-alternative:
 *     - derived empty + body names live channel (L141 trigger case)
 *     - multiple alternative candidates filtered by liveness
 *     - derived id itself in body is excluded from candidates (no self-list)
 *
 *   derive-failed:
 *     - file-not-found (handoff path doesn't exist)
 *     - handoff-name-shape (not HANDOFF_-prefixed)
 *
 *   Liveness boundary:
 *     - peer with stale heartbeat (>30 min) does NOT count
 *     - peer at 29 min counts (boundary inside)
 *
 * Fixture pattern follows api.test.ts: tmpdir-scoped CHANNELS_DIR via
 * `CLAUDE_CONDUCTOR_CHANNELS_DIR`; primitives via `createChannel` +
 * `touchHeartbeat`; handoff bodies via `writeFileSync` on tmpdir paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createChannel,
  joinChannel,
  touchHeartbeat,
  heartbeatMtime,
} from "../../src/channels/index.ts";
import { resolveActiveChannelForHandoff } from "../../src/channels/handoff-resolver.ts";

const SESSION_A = "11111111-1111-1111-1111-111111111111";
const SESSION_B = "22222222-2222-2222-2222-222222222222";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "l141-resolver-"));
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

describe("resolveActiveChannelForHandoff — derived-active", () => {
  it("returns derived-active when derived channel has 1 live peer", async () => {
    const channelId = "2026-05-15_18-26";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    touchHeartbeat(channelId, SESSION_A);

    const path = writeHandoffBody(
      `HANDOFF_${channelId}.md`,
      "# Handoff\n\nNo body refs.\n",
    );

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("derived-active");
    if (result.kind === "derived-active") {
      expect(result.channelId).toBe(channelId);
      expect(result.peerCount).toBe(1);
    }
  });

  it("returns derived-active with correct count when 2 live peers present", async () => {
    const channelId = "2026-05-15_18-26";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    await joinChannel({ channelId, sessionId: SESSION_B });
    touchHeartbeat(channelId, SESSION_A);
    touchHeartbeat(channelId, SESSION_B);

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("derived-active");
    if (result.kind === "derived-active") {
      expect(result.peerCount).toBe(2);
    }
  });
});

describe("resolveActiveChannelForHandoff — derived-empty-no-body-refs", () => {
  it("returns derived-empty-no-body-refs when derived channel doesn't exist + body has none", () => {
    const path = writeHandoffBody(
      "HANDOFF_2026-05-15_18-26.md",
      "# Handoff\n\nNo channel refs at all.\n",
    );

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("derived-empty-no-body-refs");
    if (result.kind === "derived-empty-no-body-refs") {
      expect(result.channelId).toBe("2026-05-15_18-26");
    }
  });

  it("returns derived-empty-no-body-refs when derived exists but peers are stale", async () => {
    const channelId = "2026-05-15_18-26";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    touchHeartbeat(channelId, SESSION_A);
    // Backdate heartbeat past LIVE_WINDOW_MS (30 min)
    const stalePast = (Date.now() - 60 * 60 * 1000) / 1000; // 60 min ago
    const channelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] ?? "";
    utimesSync(
      join(channelsDir, channelId, "heartbeats", SESSION_A),
      stalePast,
      stalePast,
    );

    // Sanity check
    const actualMtime = heartbeatMtime(channelId, SESSION_A);
    expect(actualMtime).not.toBeNull();
    expect(Date.now() - (actualMtime ?? 0)).toBeGreaterThan(30 * 60 * 1000);

    const path = writeHandoffBody(
      `HANDOFF_${channelId}.md`,
      "# Handoff\n\nNo body refs.\n",
    );

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("derived-empty-no-body-refs");
  });
});

describe("resolveActiveChannelForHandoff — mismatch-body-has-live-alternative", () => {
  it("returns mismatch when derived empty + body names a live channel (L141 trigger)", async () => {
    const aliveChannel = "2026-05-11_08-15";
    const derivedChannel = "2026-05-15_18-26";

    await createChannel({
      channelId: aliveChannel,
      handoffId: aliveChannel,
      sessionId: SESSION_B,
    });
    touchHeartbeat(aliveChannel, SESSION_B);

    const path = writeHandoffBody(
      `HANDOFF_${derivedChannel}.md`,
      `# Handoff (closeout shape)\n\nChannel \`${aliveChannel}\` HELD OPEN per peer-call-to-close convention.\n`,
    );

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("mismatch-body-has-live-alternative");
    if (result.kind === "mismatch-body-has-live-alternative") {
      expect(result.derivedChannelId).toBe(derivedChannel);
      expect(result.candidateChannels).toEqual([
        { id: aliveChannel, peers: 1 },
      ]);
    }
  });

  it("filters multiple body candidates by liveness (only live ones surface)", async () => {
    const aliveChannel = "2026-05-11_08-15";
    const deadChannel = "2026-05-09_12-00";
    const derivedChannel = "2026-05-15_18-26";

    await createChannel({
      channelId: aliveChannel,
      handoffId: aliveChannel,
      sessionId: SESSION_B,
    });
    touchHeartbeat(aliveChannel, SESSION_B);

    // deadChannel does not exist on disk → countLivePeers returns 0

    const path = writeHandoffBody(
      `HANDOFF_${derivedChannel}.md`,
      `# Handoff\n\nLive: \`${aliveChannel}\`. Dead: \`${deadChannel}\`.\n`,
    );

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("mismatch-body-has-live-alternative");
    if (result.kind === "mismatch-body-has-live-alternative") {
      expect(result.candidateChannels).toEqual([
        { id: aliveChannel, peers: 1 },
      ]);
    }
  });

  it("excludes the derived id itself from candidates (no self-list)", async () => {
    const aliveChannel = "2026-05-11_08-15";
    const derivedChannel = "2026-05-15_18-26";

    await createChannel({
      channelId: aliveChannel,
      handoffId: aliveChannel,
      sessionId: SESSION_B,
    });
    touchHeartbeat(aliveChannel, SESSION_B);

    const path = writeHandoffBody(
      `HANDOFF_${derivedChannel}.md`,
      `# Handoff\n\nDerived \`${derivedChannel}\` is empty; live alt \`${aliveChannel}\`.\n`,
    );

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("mismatch-body-has-live-alternative");
    if (result.kind === "mismatch-body-has-live-alternative") {
      const ids = result.candidateChannels.map((c) => c.id);
      expect(ids).not.toContain(derivedChannel);
      expect(ids).toEqual([aliveChannel]);
    }
  });
});

describe("resolveActiveChannelForHandoff — derive-failed", () => {
  it("returns derive-failed reason=file-not-found when handoff path missing", () => {
    const result = resolveActiveChannelForHandoff(
      join(tmpRoot, "no-such-file.md"),
    );
    expect(result.kind).toBe("derive-failed");
    if (result.kind === "derive-failed") {
      expect(result.reason).toBe("file-not-found");
    }
  });

  it("returns derive-failed reason=handoff-name-shape when not HANDOFF_-prefixed", () => {
    const path = writeHandoffBody("malformed-name.md", "# Whatever\n");
    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("derive-failed");
    if (result.kind === "derive-failed") {
      expect(result.reason).toBe("handoff-name-shape");
      expect(result.detail).toContain("HANDOFF_");
    }
  });
});

describe("resolveActiveChannelForHandoff — liveness boundary", () => {
  it("does not count a peer whose heartbeat exceeds LIVE_WINDOW_MS", async () => {
    const channelId = "2026-05-15_18-26";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    touchHeartbeat(channelId, SESSION_A);

    const stalePast = (Date.now() - 31 * 60 * 1000) / 1000;
    const channelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] ?? "";
    utimesSync(
      join(channelsDir, channelId, "heartbeats", SESSION_A),
      stalePast,
      stalePast,
    );

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("derived-empty-no-body-refs");
  });

  it("counts a peer at 29 min as live (boundary just inside)", async () => {
    const channelId = "2026-05-15_18-26";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_A,
    });
    touchHeartbeat(channelId, SESSION_A);

    const freshPast = (Date.now() - 29 * 60 * 1000) / 1000;
    const channelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] ?? "";
    utimesSync(
      join(channelsDir, channelId, "heartbeats", SESSION_A),
      freshPast,
      freshPast,
    );

    const path = writeHandoffBody(`HANDOFF_${channelId}.md`, "# Handoff\n");

    const result = resolveActiveChannelForHandoff(path);
    expect(result.kind).toBe("derived-active");
  });
});
