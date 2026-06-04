// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L1049 slice-1 — reconcile-boot presence-GC channel-consult.
 *
 * reconcile-boot's gc-eligibility is an ALIVE-ANYWHERE gate, so it consults the
 * coordination CHANNEL store (isSidPrefixLiveOnChannel) in addition to
 * active-sessions: a session with a FRESH channel heartbeat is alive (cohort
 * `cli.ts send` refreshes ONLY the channel store), so its presence heartbeat is
 * never gc_eligible / deleted even when the active-sessions store aged out — the
 * data-loss class B#2 fixed for the worktree reaper, applied here to the
 * presence-GC mutation.
 *
 * Covers: classification gc_eligible=false on channel-fresh; both-stale still
 * gc_eligible (no over-protect); no-channel-HB backward-compat; the apply-time
 * CAS-recheck channel-flip (the TOCTOU data-loss guard); both-stale still
 * deleted. `now` is passed explicitly → deterministic vs a fixed reference.
 *
 * Fail-direction caveat (Bravo, Slice-2 lens): isSidPrefixLiveOnChannel
 * fail-softs to not-live, so a DOUBLE channel-read-error (enumeration AND the
 * apply recheck) could still delete a channel-live presence HB — the residual
 * Charlie #3 flagged for B#2, narrowed here by the two-point consult; the
 * deeper close is the owed 2-sweep-confirm. Documented, not re-fixed this slice.
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
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { GC_WINDOW_MS } from "../../src/active-sessions/index.ts";
import {
  applyGc,
  runReconcileBoot,
  type ReconcileBootCandidate,
} from "../../src/active-sessions/reconcile-boot.ts";

let tmpDir: string;
let channelsDir: string;
let prev: string | undefined;
let prevChannels: string | undefined;
let prevConfig: string | undefined;
const NOW = 1_800_000_000_000;
const STALE = GC_WINDOW_MS + 1; // stale + past the GC floor → gc_eligible
const SID = "abababab-0000-4000-8000-000000000001";

function setEnv(k: string, v: string): void {
  process.env[k] = v;
}
function restoreEnv(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reconcile-channel-"));
  channelsDir = join(tmpDir, "channels");
  prev = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevConfig = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  setEnv("CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", tmpDir);
  // A REAL channels dir (unlike the presence-only suites' no-channels) so the
  // channel-consult has a store to read. No identity claims are planted, so
  // identity enumeration stays empty (the channel HB lives under heartbeats/,
  // not identities/).
  setEnv("CLAUDE_CONDUCTOR_CHANNELS_DIR", channelsDir);
  setEnv(
    "CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG",
    join(tmpDir, "no-config.json"),
  );
});

afterEach(() => {
  restoreEnv("CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", prev);
  restoreEnv("CLAUDE_CONDUCTOR_CHANNELS_DIR", prevChannels);
  restoreEnv("CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG", prevConfig);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Plant a presence (active-sessions) heartbeat, mtime back-dated `ageMs`. */
function writePresenceHeartbeat(
  artifactId: string,
  sessionId: string,
  ageMs: number,
): string {
  const dir = join(tmpDir, artifactId, "heartbeats");
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
    }),
  );
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
  return path;
}

/** Plant a coordination-CHANNEL heartbeat for `sessionId`, mtime back-dated
 *  `ageMs`. Body is irrelevant (the helper reads mtime) — written for realism. */
function writeChannelHeartbeat(sessionId: string, ageMs: number): void {
  const dir = join(channelsDir, "coordination", "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(path, String(NOW - ageMs));
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

/** A constructed gc_eligible presence candidate (the enumeration snapshot).
 *  applyGc re-reads disk fresh, so the on-disk HBs drive the recheck. */
function gcEligiblePresence(
  artifactId: string,
  sessionId: string,
): ReconcileBootCandidate {
  return {
    artifact_class: "presence",
    artifact_id: artifactId,
    session_id: sessionId,
    classification: "stale",
    split_brain: false,
    gc_eligible: true,
    paused: false,
    failed_signals: ["mtime-age"],
    age_ms: STALE,
  };
}

describe("reconcile-boot presence-GC channel-consult (L1049 slice-1)", () => {
  it("classification: presence stale-past-floor but channel-fresh → gc_eligible=false", () => {
    writePresenceHeartbeat("work", SID, STALE);
    writeChannelHeartbeat(SID, 0); // fresh channel HB → session is alive
    const out = runReconcileBoot({ now: NOW });
    const c = out.candidates.find((x) => x.session_id === SID);
    expect(c?.classification).toBe("stale"); // active-sessions still stale ...
    expect(c?.gc_eligible).toBe(false); // ... but channel-live → NOT gc_eligible
    expect(out.gc_eligible_count).toBe(0);
  });

  it("classification: presence stale + channel ALSO stale → gc_eligible=true (no over-protect)", () => {
    writePresenceHeartbeat("work", SID, STALE);
    writeChannelHeartbeat(SID, STALE); // channel also stale
    const out = runReconcileBoot({ now: NOW });
    expect(out.candidates.find((x) => x.session_id === SID)?.gc_eligible).toBe(
      true,
    );
    expect(out.gc_eligible_count).toBe(1);
  });

  it("classification: no channel HB at all → gc_eligible=true (backward-compat)", () => {
    writePresenceHeartbeat("work", SID, STALE); // no channel HB planted
    const out = runReconcileBoot({ now: NOW });
    expect(out.candidates.find((x) => x.session_id === SID)?.gc_eligible).toBe(
      true,
    );
  });

  it("apply CAS TOCTOU: gc_eligible at enumeration but channel-live at apply → SKIP, not deleted (data-loss guard)", () => {
    const path = writePresenceHeartbeat("work", SID, STALE); // presence still stale on disk
    writeChannelHeartbeat(SID, 0); // but channel-live at apply-time
    const { cas_races, errors } = applyGc(
      [gcEligiblePresence("work", SID)],
      NOW,
    );
    expect(cas_races).toHaveLength(1);
    expect(cas_races[0]?.reason).toBe("now-live"); // channel-live flips it out
    expect(errors).toEqual([]);
    expect(existsSync(path)).toBe(true); // protected — NOT deleted
  });

  it("apply: presence stale + channel stale → removed (channel does not over-protect)", () => {
    const path = writePresenceHeartbeat("work", SID, STALE);
    writeChannelHeartbeat(SID, STALE);
    const { cas_races, errors } = applyGc(
      [gcEligiblePresence("work", SID)],
      NOW,
    );
    expect(cas_races).toEqual([]);
    expect(errors).toEqual([]);
    expect(existsSync(path)).toBe(false); // removed
  });
});
