// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 2 boot-reconciliation — IDENTITY report-only enumeration (§2, PR 2a).
 *
 * Cross-class: an identity sentinel has no heartbeat of its own, so a claim's
 * liveness IS its session's PRESENCE liveness (cross-ref). This suite drives
 * runReconcileBoot over a DUAL substrate — a presence registry
 * (CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR) AND a channels dir
 * (CLAUDE_CONDUCTOR_CHANNELS_DIR) — to assert: a WITH-presence claim inherits
 * its session's freshest liveness; an ORPHAN claim (no presence heartbeat) is
 * stale + ["no-presence-heartbeat"]; `paused` is carried; `gc_eligible` is
 * always false (report-only); and a multi-participant channel is NOT falsely
 * split-brain-flagged.
 *
 * NOTE the cross-class fixture wrinkle: `createChannel` calls `touchHeartbeat`
 * for the CREATOR session (a real-wall-clock mtime → STALE under the fixed test
 * NOW, which sits far in the future). So (a) WITH-presence relies on an explicit
 * fresh `writeHeartbeat` — the most-live tiebreak picks it over createChannel's
 * stale one; (b) an ORPHAN session must NOT be the channel creator, else it
 * inherits createChannel's (stale) heartbeat and is no longer heartbeat-less.
 * `claimIdentity` itself writes NO heartbeat, so a non-creator claim is a true
 * orphan.
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
  canonicalClaudeHomeArtifactId,
  LIVE_WINDOW_MS,
  runReconcileBoot,
} from "../../src/active-sessions/index.ts";
import { claimIdentity } from "../../src/channels/identity.ts";
import { createChannel } from "../../src/channels/index.ts";

let sessionsDir: string;
let channelsDir: string;
let prevSessions: string | undefined;
let prevChannels: string | undefined;
const NOW = 1_800_000_000_000; // fixed reference; far in the future of wall-clock.

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "reconcile-id-sessions-"));
  channelsDir = mkdtempSync(join(tmpdir(), "reconcile-id-channels-"));
  prevSessions = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = sessionsDir;
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = channelsDir;
});

afterEach(() => {
  if (prevSessions === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevSessions;
  if (prevChannels === undefined)
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannels;
  for (const d of [sessionsDir, channelsDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Write a presence heartbeat with a back-dated mtime (`ageMs` from NOW),
 *  optionally carrying a `pausedAt` marker (what a paused session's anchor
 *  heartbeat holds). */
function writeHeartbeat(
  artifactId: string,
  sessionId: string,
  ageMs: number,
  opts: { pausedAt?: number } = {},
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
      ...(opts.pausedAt !== undefined ? { pausedAt: opts.pausedAt } : {}),
    }),
  );
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

/** Plant a coordination-CHANNEL heartbeat for `sessionId`, mtime back-dated
 *  `ageMs` from NOW. Mirrors reconcile-boot-channel-consult.test.ts — the body
 *  is irrelevant (isSidPrefixLiveOnChannel reads mtime only). Models a
 *  coordination-only session: channel-live with NO presence heartbeat. */
function writeChannelHeartbeat(sessionId: string, ageMs: number): void {
  const dir = join(channelsDir, "coordination", "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(path, String(NOW - ageMs));
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

describe("runReconcileBoot — identity report-only enumeration (§2)", () => {
  it("a claim WITH presence inherits its session's freshest liveness; gc_eligible stays false", async () => {
    const sid = "11111111-0000-4000-8000-000000000001";
    await createChannel({
      channelId: "c-id-1",
      handoffId: "c-id-1",
      sessionId: sid,
    });
    await claimIdentity({ channelId: "c-id-1", sessionId: sid });
    writeHeartbeat("work", sid, 0); // fresh presence → freshest is live

    const out = runReconcileBoot({ now: NOW, scope: "identity" });
    const idc = out.candidates.find((c) => c.artifact_class === "identity");
    expect(idc?.session_id).toBe(sid);
    expect(idc?.artifact_id).toBe("c-id-1");
    expect(idc?.classification).toBe("live"); // inherited from the fresh heartbeat
    expect(idc?.gc_eligible).toBe(false); // ALWAYS false — report-only
    expect(idc?.failed_signals).toEqual([]); // inherited (live → no failed signals)
  });

  it("an ORPHAN claim (no presence heartbeat) is stale + ['no-presence-heartbeat']", async () => {
    const creator = "aaaaaaaa-0000-4000-8000-00000000000a";
    const orphan = "22222222-0000-4000-8000-000000000002";
    // Creator makes the channel (and gets a stale-under-NOW heartbeat). The
    // ORPHAN is a DIFFERENT session that only claims an identity (no heartbeat).
    await createChannel({
      channelId: "c-id-2",
      handoffId: "c-id-2",
      sessionId: creator,
    });
    await claimIdentity({ channelId: "c-id-2", sessionId: orphan });

    const out = runReconcileBoot({ now: NOW, scope: "identity" });
    const idc = out.candidates.find(
      (c) => c.artifact_class === "identity" && c.session_id === orphan,
    );
    expect(idc).toBeDefined();
    expect(idc?.classification).toBe("stale");
    expect(idc?.failed_signals).toEqual(["no-presence-heartbeat"]);
    expect(idc?.gc_eligible).toBe(false);
  });

  it("a YOUNG orphan (recent joined_at) is STILL stale — classification is the absence-signal, age_ms is informational", async () => {
    const creator = "bbbbbbbb-0000-4000-8000-00000000000b";
    const orphan = "cccccccc-0000-4000-8000-00000000000c";
    await createChannel({
      channelId: "c-young",
      handoffId: "c-young",
      sessionId: creator,
    });
    // Raw sentinel for the orphan with joined_at AT NOW (young) — bypass
    // claimIdentity to control joined_at. No heartbeat → orphan. The contract:
    // an orphan is stale because it has NO presence heartbeat, NOT because it is
    // old; age_ms is purely informational (now - joined_at), never a liveness age.
    const identitiesPath = join(channelsDir, "c-young", "identities");
    mkdirSync(identitiesPath, { recursive: true });
    writeFileSync(
      join(identitiesPath, "Bravo"),
      JSON.stringify({
        session_id: orphan,
        role: "pen",
        joined_at: new Date(NOW).toISOString(),
      }),
    );

    const out = runReconcileBoot({ now: NOW, scope: "identity" });
    const idc = out.candidates.find((c) => c.session_id === orphan);
    expect(idc?.classification).toBe("stale"); // absence-signal, independent of age
    expect(idc?.failed_signals).toEqual(["no-presence-heartbeat"]);
    expect(idc?.age_ms).toBe(0); // now - joined_at(NOW) = 0 — informational, not liveness
  });

  it("paused is carried onto the identity claim (session-level lookup)", async () => {
    const sid = "33333333-0000-4000-8000-000000000003";
    const anchorId = canonicalClaudeHomeArtifactId();
    await createChannel({
      channelId: "c-id-3",
      handoffId: "c-id-3",
      sessionId: sid,
    });
    await claimIdentity({ channelId: "c-id-3", sessionId: sid });
    // Anchor heartbeat carrying pausedAt → readSessionPausedAt(sid) != null.
    writeHeartbeat(anchorId, sid, 0, { pausedAt: NOW });

    const out = runReconcileBoot({ now: NOW, scope: "identity" });
    const idc = out.candidates.find((c) => c.artifact_class === "identity");
    expect(idc?.paused).toBe(true);
  });

  it("a multi-participant channel is NOT falsely split-brain-flagged", async () => {
    const a = "44444444-0000-4000-8000-00000000000a";
    const b = "44444444-0000-4000-8000-00000000000b";
    await createChannel({
      channelId: "c-multi",
      handoffId: "c-multi",
      sessionId: a,
    });
    await claimIdentity({ channelId: "c-multi", sessionId: a }); // Alpha
    await claimIdentity({ channelId: "c-multi", sessionId: b }); // Bravo
    writeHeartbeat("work", a, 0); // both live
    writeHeartbeat("work", b, 0);

    const out = runReconcileBoot({ now: NOW, scope: "identity" });
    const idCandidates = out.candidates.filter(
      (c) => c.artifact_class === "identity",
    );
    expect(idCandidates.length).toBe(2); // two claims on one channel — legitimate
    expect(idCandidates.every((c) => c.split_brain === false)).toBe(true);
  });

  it("scope='presence' excludes identity candidates", async () => {
    const sid = "55555555-0000-4000-8000-000000000005";
    await createChannel({
      channelId: "c-id-5",
      handoffId: "c-id-5",
      sessionId: sid,
    });
    await claimIdentity({ channelId: "c-id-5", sessionId: sid });
    writeHeartbeat("work", sid, 0);

    const out = runReconcileBoot({ now: NOW, scope: "presence" });
    expect(out.candidates.every((c) => c.artifact_class === "presence")).toBe(
      true,
    );
  });

  // ── G2 report-fix: alive-anywhere channel consult in the ORPHAN path ──
  // A coordination-only session (cohort `cli.ts send` refreshes ONLY the channel
  // store) has an identity claim + a FRESH coordination heartbeat but ZERO
  // presence heartbeats. Pre-G2 it was mislabeled a `stale` orphan; the channel
  // consult reclassifies it `live`. Report-only: gc_eligible stays false.
  it("an orphan-by-presence claim whose session is coordination-channel-live → classification live, NOT a stale orphan (G2)", async () => {
    const creator = "dddddddd-0000-4000-8000-00000000000d";
    const liveSid = "eeeeeeee-0000-4000-8000-00000000000e";
    await createChannel({
      channelId: "coordination",
      handoffId: "coordination",
      sessionId: creator,
    });
    await claimIdentity({ channelId: "coordination", sessionId: liveSid });
    writeChannelHeartbeat(liveSid, 0); // fresh coordination HB; NO presence HB

    const out = runReconcileBoot({ now: NOW, scope: "identity" });
    const idc = out.candidates.find(
      (c) => c.artifact_class === "identity" && c.session_id === liveSid,
    );
    expect(idc).toBeDefined();
    expect(idc?.classification).toBe("live"); // channel-live → live (was "stale")
    expect(idc?.failed_signals).toEqual([]); // not an orphan (was ["no-presence-heartbeat"])
    expect(idc?.gc_eligible).toBe(false); // report-only — unchanged
    // A coordination-only session has no presence anchor, so readSessionPausedAt
    // returns null → paused false (a paused such session is not detectable here).
    expect(idc?.paused).toBe(false);
  });

  // Window-choice lock: the classification consult uses LIVE_WINDOW_MS (the
  // "actively coordinating" threshold, matching classifySessionLiveness), NOT
  // the GC-protect GC_WINDOW_MS used by enumeratePresence. A coordination HB
  // aged past LIVE_WINDOW_MS is no longer actively coordinating → still orphan.
  it("an orphan-by-presence claim whose coordination HB is past LIVE_WINDOW_MS → still a stale orphan", async () => {
    const creator = "ffffffff-0000-4000-8000-00000000000f";
    const sid = "a0a0a0a0-0000-4000-8000-0000000000a0";
    await createChannel({
      channelId: "coordination",
      handoffId: "coordination",
      sessionId: creator,
    });
    await claimIdentity({ channelId: "coordination", sessionId: sid });
    writeChannelHeartbeat(sid, LIVE_WINDOW_MS + 60_000); // channel-stale; NO presence HB

    const out = runReconcileBoot({ now: NOW, scope: "identity" });
    const idc = out.candidates.find(
      (c) => c.artifact_class === "identity" && c.session_id === sid,
    );
    expect(idc?.classification).toBe("stale");
    expect(idc?.failed_signals).toEqual(["no-presence-heartbeat"]);
  });
});
