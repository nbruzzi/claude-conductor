// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for the stale-identity reclaim reaper primitive
 * (`src/channels/reclaim.ts:reclaimStaleIdentities`).
 *
 * Scope: the PRIMITIVE's per-claim behavior — stale claim reclaimed (metadata
 * entry removed + sentinel unlinked = pool slot freed), fresh claim skipped
 * (the `force: false` staleness gate), mixed partition, empty channel. The
 * staleness threshold is supplied by the caller, so these use small,
 * deterministic windows (the 24h hook-policy window is asserted in
 * test/hooks/checks/channel-gc.test.ts + channels-gc-reaper.test.ts).
 *
 * The full reclaim INVARIANT suite — 26-pool never exhausts under come-and-go,
 * the exemption+reaper split-detector (#4), and the negative key-revoke
 * assertion (#5) — is Bravo's Slice 3 (a separate file), built against this
 * primitive's contract. This file is the substrate author's verification that
 * the primitive itself behaves.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

import { reclaimStaleIdentities } from "../../src/channels/reclaim.ts";
import {
  commitIdentityClaim,
  createChannel,
  resolveChannelsDir,
  touchHeartbeat,
  type IdentityClaim,
} from "../../src/channels/index.ts";
import {
  identitiesDir,
  identitySentinelPath,
  listClaims,
  type NatoIdentity,
} from "../../src/channels/identity.ts";

const CHANNEL = "coordination";
const OWNER = "00000000-0000-4000-8000-000000000000";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

function sandbox(): void {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-reclaim-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
}

function cleanup(): void {
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
}

function heartbeatPath(channelId: string, sessionId: string): string {
  return join(resolveChannelsDir(), channelId, "heartbeats", sessionId);
}

/**
 * Plant a fully-committed claim (sentinel + metadata.identities entry +
 * heartbeat) whose heartbeat mtime is `heartbeatAgeSeconds` old. This is the
 * shape `claimIdentity` produces; we fabricate it directly so the heartbeat
 * age is precisely controllable. `closeStalePeerIdentity` reads the heartbeat
 * MTIME (not body) for the staleness comparison.
 */
async function plantClaim(
  channelId: string,
  letter: NatoIdentity,
  sessionId: string,
  heartbeatAgeSeconds: number,
): Promise<void> {
  const claim: IdentityClaim = {
    session_id: sessionId,
    role: "queue",
    joined_at: new Date(Date.now() - heartbeatAgeSeconds * 1000).toISOString(),
  };
  // Sentinel (the pool slot `claimIdentity` walks).
  mkdirSync(identitiesDir(channelId), { recursive: true });
  writeFileSync(
    identitySentinelPath(channelId, letter),
    `${JSON.stringify(claim)}\n`,
    {
      mode: 0o600,
    },
  );
  // Metadata entry (what closeStalePeerIdentity reads + removes).
  await commitIdentityClaim({ channelId, identity: letter, claim });
  // Heartbeat with a controllable mtime.
  touchHeartbeat(channelId, sessionId);
  const mtime = Date.now() / 1000 - heartbeatAgeSeconds;
  utimesSync(heartbeatPath(channelId, sessionId), mtime, mtime);
}

function claimedLetters(channelId: string): NatoIdentity[] {
  return listClaims(channelId)
    .map((c) => c.identity)
    .sort();
}

const THRESHOLD_MS = 60_000; // 1 minute
const STALE_AGE_S = 3600; // 1h heartbeat age → stale vs 1-min threshold
const FRESH_AGE_S = 0; // just-now heartbeat → fresh vs 1-min threshold

describe("reclaimStaleIdentities", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("reclaims a claim whose heartbeat is stale beyond the threshold (frees the pool slot)", async () => {
    await createChannel({
      channelId: CHANNEL,
      handoffId: CHANNEL,
      sessionId: OWNER,
    });
    await plantClaim(
      CHANNEL,
      "Alpha",
      "11111111-1111-4111-8111-111111111111",
      STALE_AGE_S,
    );

    const result = await reclaimStaleIdentities({
      channelId: CHANNEL,
      staleThresholdMs: THRESHOLD_MS,
    });

    expect(result.reclaimed).toEqual(["Alpha"]);
    expect(result.skippedActive).toEqual([]);
    expect(result.stuck).toEqual([]);
    // Sentinel unlinked → the pool slot is free again.
    expect(existsSync(identitySentinelPath(CHANNEL, "Alpha"))).toBe(false);
    // Metadata entry removed → listClaims no longer reports it.
    expect(claimedLetters(CHANNEL)).toEqual([]);
  });

  it("leaves a claim whose heartbeat is fresher than the threshold untouched", async () => {
    await createChannel({
      channelId: CHANNEL,
      handoffId: CHANNEL,
      sessionId: OWNER,
    });
    await plantClaim(
      CHANNEL,
      "Bravo",
      "22222222-2222-4222-8222-222222222222",
      FRESH_AGE_S,
    );

    const result = await reclaimStaleIdentities({
      channelId: CHANNEL,
      staleThresholdMs: THRESHOLD_MS,
    });

    expect(result.skippedActive).toEqual(["Bravo"]);
    expect(result.reclaimed).toEqual([]);
    // Sentinel + claim intact: a live (heads-down) session is never reclaimed.
    expect(existsSync(identitySentinelPath(CHANNEL, "Bravo"))).toBe(true);
    expect(claimedLetters(CHANNEL)).toEqual(["Bravo"]);
  });

  it("partitions a mix of stale and fresh claims", async () => {
    await createChannel({
      channelId: CHANNEL,
      handoffId: CHANNEL,
      sessionId: OWNER,
    });
    await plantClaim(
      CHANNEL,
      "Alpha",
      "11111111-1111-4111-8111-111111111111",
      STALE_AGE_S,
    );
    await plantClaim(
      CHANNEL,
      "Bravo",
      "22222222-2222-4222-8222-222222222222",
      FRESH_AGE_S,
    );
    await plantClaim(
      CHANNEL,
      "Charlie",
      "33333333-3333-4333-8333-333333333333",
      STALE_AGE_S,
    );

    const result = await reclaimStaleIdentities({
      channelId: CHANNEL,
      staleThresholdMs: THRESHOLD_MS,
    });

    expect(result.reclaimed.sort()).toEqual(["Alpha", "Charlie"]);
    expect(result.skippedActive).toEqual(["Bravo"]);
    expect(result.stuck).toEqual([]);
    // Only the fresh letter remains claimed; the two stale slots are freed.
    expect(claimedLetters(CHANNEL)).toEqual(["Bravo"]);
  });

  it("returns an empty result for a channel with no claims", async () => {
    await createChannel({
      channelId: CHANNEL,
      handoffId: CHANNEL,
      sessionId: OWNER,
    });

    const result = await reclaimStaleIdentities({
      channelId: CHANNEL,
      staleThresholdMs: THRESHOLD_MS,
    });

    expect(result).toEqual({ reclaimed: [], skippedActive: [], stuck: [] });
  });

  it("returns an empty result when the identities dir is absent (never-claimed channel)", async () => {
    await createChannel({
      channelId: CHANNEL,
      handoffId: CHANNEL,
      sessionId: OWNER,
    });
    // No claim planted → no identities/ dir → listClaims yields [] → no-op.
    const result = await reclaimStaleIdentities({
      channelId: CHANNEL,
      staleThresholdMs: THRESHOLD_MS,
    });
    expect(result.reclaimed).toEqual([]);
  });
});
