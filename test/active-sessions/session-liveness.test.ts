// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the canonical session-liveness OR-composer (session-liveness.ts) —
 * C1 Slice 1. Verifies sessionLivePrefixSource / isSessionLivePrefix /
 * isSessionLive / classifySessionLiveness compose BOTH heartbeat stores
 * (active-sessions + the coordination channel) + the pause marker — the A1
 * alive-anywhere contract, centralized.
 *
 * Both stores are sandboxed via their dir env vars (CLAUDE_CONDUCTOR_*_DIR);
 * `now` is a fixed base so every case is deterministic against planted mtimes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifySessionLiveness,
  isSessionLive,
  isSessionLivePrefix,
  sessionLivePrefixSource,
} from "../../src/active-sessions/session-liveness.ts";
import { canonicalClaudeHomeArtifactId } from "../../src/active-sessions/index.ts";
import {
  COORDINATION_CHANNEL_ID,
  resolveChannelsDir,
} from "../../src/channels/index.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const FULL_SID = "abcd1234-0000-4000-8000-000000000001";
const PREFIX = "abcd1234";

let root: string;
let sessionsDir: string;
let prevSessions: string | undefined;
let prevChannels: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-liveness-"));
  sessionsDir = join(root, "active-sessions");
  prevSessions = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = sessionsDir;
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(root, "channels");
});

afterEach(() => {
  if (prevSessions === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevSessions;
  }
  if (prevChannels === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannels;
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Plant an active-sessions heartbeat (OwnerRecord JSON) at mtime NOW-ageMs. */
function plantActive(
  artifactId: string,
  sessionId: string,
  ageMs: number,
  extra: Record<string, unknown> = {},
): void {
  const dir = join(sessionsDir, artifactId, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(
    path,
    JSON.stringify({
      sessionId,
      pid: 4242,
      host: hostname(),
      createdAt: NOW - ageMs,
      touchedAt: NOW - ageMs,
      ...extra,
    }),
  );
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

/** Plant a coordination-channel heartbeat at mtime NOW-ageMs (body irrelevant). */
function plantChannel(sessionId: string, ageMs: number): void {
  const dir = join(resolveChannelsDir(), COORDINATION_CHANNEL_ID, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(path, String(NOW - ageMs));
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

describe("sessionLivePrefixSource / isSessionLivePrefix — OR both stores", () => {
  it("fresh ONLY in active-sessions => 'active-sessions'", () => {
    plantActive("work", FULL_SID, 0);
    expect(sessionLivePrefixSource(PREFIX, NOW)).toBe("active-sessions");
    expect(isSessionLivePrefix(PREFIX, NOW)).toBe(true);
  });

  it("fresh ONLY on the channel => 'channel' (A1 cross-store protection)", () => {
    plantChannel(FULL_SID, 0);
    expect(sessionLivePrefixSource(PREFIX, NOW)).toBe("channel");
    expect(isSessionLivePrefix(PREFIX, NOW)).toBe(true);
  });

  it("stale in BOTH stores (beyond GC_WINDOW) => null / not live", () => {
    plantActive("work", FULL_SID, 90 * MIN);
    plantChannel(FULL_SID, 90 * MIN);
    expect(sessionLivePrefixSource(PREFIX, NOW)).toBeNull();
    expect(isSessionLivePrefix(PREFIX, NOW)).toBe(false);
  });

  it("empty prefix => null / not live (no match-all)", () => {
    plantActive("work", FULL_SID, 0);
    expect(sessionLivePrefixSource("", NOW)).toBeNull();
    expect(isSessionLivePrefix("", NOW)).toBe(false);
  });

  it("CHANNEL FLOOR: a short windowMs still protects a channel-fresh-within-GC_WINDOW session", () => {
    // Channel-only, 40min old. With a short 5min caller window the channel
    // branch is floored at GC_WINDOW_MS (60min), so 40min < 60min => live.
    plantChannel(FULL_SID, 40 * MIN);
    expect(sessionLivePrefixSource(PREFIX, NOW, 5 * MIN)).toBe("channel");
    expect(isSessionLivePrefix(PREFIX, NOW, 5 * MIN)).toBe(true);
  });
});

describe("isSessionLive — full-id, NO channel floor (is-coordinating)", () => {
  it("fresh in active-sessions within LIVE_WINDOW => true", () => {
    plantActive("work", FULL_SID, 0);
    expect(isSessionLive(FULL_SID, NOW)).toBe(true);
  });

  it("channel HB beyond LIVE_WINDOW is NOT live (no floor), but IS reaper-protected", () => {
    // 45min-old channel HB. isSessionLive uses LIVE_WINDOW_MS (30min) with no
    // floor => 45 > 30 => false. isSessionLivePrefix floors the channel at
    // GC_WINDOW_MS (60min) => 45 < 60 => true. Same session, distinct questions.
    plantChannel(FULL_SID, 45 * MIN);
    expect(isSessionLive(FULL_SID, NOW)).toBe(false);
    expect(isSessionLivePrefix(FULL_SID, NOW)).toBe(true);
  });
});

describe("classifySessionLiveness — OR-composed verdict + orthogonal pause", () => {
  it("fresh channel HB => live (even with no active-sessions HB)", () => {
    plantChannel(FULL_SID, 0);
    expect(classifySessionLiveness(FULL_SID, NOW)).toEqual({
      verdict: "live",
      paused: false,
    });
  });

  it("active HB age <= LIKELY_DEAD => live", () => {
    plantActive("work", FULL_SID, 0);
    expect(classifySessionLiveness(FULL_SID, NOW).verdict).toBe("live");
  });

  it("active HB LIKELY_DEAD < age <= LIVE_WINDOW => likely-dead", () => {
    plantActive("work", FULL_SID, 20 * MIN);
    expect(classifySessionLiveness(FULL_SID, NOW).verdict).toBe("likely-dead");
  });

  it("active HB age > LIVE_WINDOW, no channel => stale", () => {
    plantActive("work", FULL_SID, 40 * MIN);
    expect(classifySessionLiveness(FULL_SID, NOW).verdict).toBe("stale");
  });

  it("no heartbeat in either store => stale", () => {
    expect(classifySessionLiveness(FULL_SID, NOW).verdict).toBe("stale");
  });

  it("fresh channel HB upgrades a stale active-sessions HB to 'live' (the A1 contract)", () => {
    // active-sessions HB 40min old (stale alone, > LIVE_WINDOW_MS=30min); the
    // fresh channel HB must upgrade the verdict to 'live' — the exact false-DEAD
    // class C1 closes.
    plantActive("work", FULL_SID, 40 * MIN);
    plantChannel(FULL_SID, 0);
    expect(classifySessionLiveness(FULL_SID, NOW).verdict).toBe("live");
  });

  it("paused is orthogonal — reported true even with a stale verdict", () => {
    plantActive(canonicalClaudeHomeArtifactId(), FULL_SID, 40 * MIN, {
      pausedAt: NOW,
    });
    const result = classifySessionLiveness(FULL_SID, NOW);
    expect(result.verdict).toBe("stale");
    expect(result.paused).toBe(true);
  });

  it("paused marker on the canonical anchor => paused:true (orthogonal to verdict)", () => {
    plantActive(canonicalClaudeHomeArtifactId(), FULL_SID, 0, {
      pausedAt: NOW,
    });
    const result = classifySessionLiveness(FULL_SID, NOW);
    expect(result.paused).toBe(true);
    expect(result.verdict).toBe("live");
  });
});
