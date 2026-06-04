// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for `isSidPrefixLiveOnChannel` (src/channels/index.ts) — the
 * cross-store liveness helper the worktree reapers OR in (L1049 slice-2b).
 *
 * Covers: M1 throw-on-invalid-channelId (sibling parity); prefix-scan match;
 * fresh vs stale vs future-mtime (m6 stricter-than-:932 guard); F-A dual-dir
 * legacy union; fail-soft on a missing dir; m9 bump-sentinel exclusion.
 *
 * `now` is a helper PARAMETER, so every case is deterministic against a fixed
 * base mtime — no real-clock dependency.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isSidPrefixLiveOnChannel,
  resolveChannelsDir,
} from "../../src/channels/index.ts";

const CHANNEL = "coordination";
const WINDOW_MS = 60_000;
const BASE_S = 1_700_000_000; // fixed mtime epoch (seconds)
const BASE_MS = BASE_S * 1000;
const SENTINEL = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";

let tmpRoot: string;
let prevChannelsDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-prefix-live-channel-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
});

/**
 * Plant a heartbeat file for `sid` at mtime `mtimeSec` (seconds). `legacy`
 * writes the pre-rename `heartbeat/` dir instead of `heartbeats/`. Body content
 * is irrelevant to the helper (it reads mtime, not body) — written for realism.
 */
function plantHeartbeat(
  sid: string,
  mtimeSec: number,
  opts: { legacy?: boolean } = {},
): void {
  const dir = join(
    resolveChannelsDir(),
    CHANNEL,
    opts.legacy === true ? "heartbeat" : "heartbeats",
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sid);
  writeFileSync(path, String(mtimeSec * 1000));
  utimesSync(path, mtimeSec, mtimeSec);
}

describe("isSidPrefixLiveOnChannel", () => {
  it("throws on an invalid channelId (sibling-parity boundary, M1)", () => {
    expect(() =>
      isSidPrefixLiveOnChannel("11111111", "bad id!", BASE_MS, WINDOW_MS),
    ).toThrow(/invalid channelId/);
  });

  it("returns true for a fresh heartbeat under the sid prefix", () => {
    plantHeartbeat("11111111-1111-4111-8111-111111111111", BASE_S);
    expect(
      isSidPrefixLiveOnChannel("11111111", CHANNEL, BASE_MS + 5_000, WINDOW_MS),
    ).toBe(true);
  });

  it("returns false for a stale heartbeat (age >= windowMs)", () => {
    plantHeartbeat("11111111-1111-4111-8111-111111111111", BASE_S);
    expect(
      isSidPrefixLiveOnChannel(
        "11111111",
        CHANNEL,
        BASE_MS + 120_000,
        WINDOW_MS,
      ),
    ).toBe(false);
  });

  it("returns false when no heartbeat matches the prefix", () => {
    plantHeartbeat("11111111-1111-4111-8111-111111111111", BASE_S);
    expect(
      isSidPrefixLiveOnChannel("22222222", CHANNEL, BASE_MS + 5_000, WINDOW_MS),
    ).toBe(false);
  });

  it("reads the LEGACY heartbeat/ dir too (F-A dual-dir union)", () => {
    plantHeartbeat("33333333-3333-4333-8333-333333333333", BASE_S, {
      legacy: true,
    });
    expect(
      isSidPrefixLiveOnChannel("33333333", CHANNEL, BASE_MS + 5_000, WINDOW_MS),
    ).toBe(true);
  });

  it("treats a future-mtime heartbeat as not-live (m6 stricter guard)", () => {
    plantHeartbeat("44444444-4444-4444-8444-444444444444", BASE_S);
    // now BEFORE the mtime → ageMs < 0 → not live.
    expect(
      isSidPrefixLiveOnChannel("44444444", CHANNEL, BASE_MS - 5_000, WINDOW_MS),
    ).toBe(false);
  });

  it("fails soft to false when the heartbeat dir is missing (never throws)", () => {
    // nothing planted → heartbeats/ + heartbeat/ both absent.
    expect(
      isSidPrefixLiveOnChannel("55555555", CHANNEL, BASE_MS, WINDOW_MS),
    ).toBe(false);
  });

  it("excludes the bump-cron sentinel even when fresh + prefix-matched (m9)", () => {
    plantHeartbeat(SENTINEL, BASE_S);
    // prefix matches the sentinel + heartbeat is fresh — but it must be excluded.
    expect(
      isSidPrefixLiveOnChannel("c0c0c0c0", CHANNEL, BASE_MS + 5_000, WINDOW_MS),
    ).toBe(false);
  });

  it("returns false for an empty sidPrefix", () => {
    plantHeartbeat("11111111-1111-4111-8111-111111111111", BASE_S);
    expect(
      isSidPrefixLiveOnChannel("", CHANNEL, BASE_MS + 5_000, WINDOW_MS),
    ).toBe(false);
  });
});
