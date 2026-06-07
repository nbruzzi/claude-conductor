// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * T10 (plan v1.3 §Tests T10; RE-12 / TS-NEW-4 fold) — `listLivePeers`
 * opportunistic-reap SUCCESS telemetry: the Branch-B promotion test.
 *
 * The Phase-2 trigger decision tree's Branch B (opportunistic age-out reap that
 * fires from inside a `listLivePeers` walk) is the LIKELY-fire path per RE-10.
 * T7 (sentinel-extension) already covers `tryReapHeartbeat` via the
 * `unregisterActiveSession` caller; THIS pins the DISTINCT live-peer
 * opportunistic-age-out caller — a peer's heartbeat aged past `GC_WINDOW_MS` is
 * reaped during a `listLivePeers` walk, and the reap MUST emit a
 * `heartbeat-reaped` breadcrumb whose `caller_top4` identifies `listLivePeers`
 * as the reaper. That discriminator is what lets post-incident triage tell WHICH
 * branch fired (over-reap-live-sibling vs under-reap-dead-debt).
 *
 * Age-out is forced the same way the RE-3 suite (gc-miss-logging) does:
 * `utimesSync` backdates the heartbeat FILE mtime past `GC_WINDOW_MS` — the reap
 * keys on mtime, not the body's `touchedAt`. Unlike RE-3 (which plants a
 * directory to force an unlink FAILURE → `registry-contention`), T10 keeps a
 * real file so the unlink SUCCEEDS → `heartbeat-reaped`.
 *
 * POSIX-portable: mtime backdating, signal-free; holds identically on
 * macOS + Linux.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  artifactIdFromPath,
  listLivePeers,
  setCoordinationRootsForTesting,
  touchHeartbeat,
} from "../../src/active-sessions/index.ts";
import { readPresenceFailures } from "../../src/shared/presence-failure-log.ts";
import { makeTmpHome, type TmpHome } from "../../test-utils/index.ts";

let tmpHome: TmpHome | null = null;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let REGISTRY_DIR = "";
let ARTIFACT_PATH = "";
let ARTIFACT_ID = "";

function heartbeatPath(sessionId: string): string {
  return join(REGISTRY_DIR, ARTIFACT_ID, "heartbeats", sessionId);
}

/** Reaped breadcrumbs for a specific peer sessionId. */
function reapedFor(sessionId: string) {
  return readPresenceFailures().filter(
    (e) => e.kind === "heartbeat-reaped" && e.sessionId === sessionId,
  );
}

beforeEach(() => {
  tmpHome = makeTmpHome();
  prevHome = process.env["HOME"];
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  process.env["HOME"] = tmpHome.home;

  REGISTRY_DIR = join(tmpHome.home, "registry");
  const fakeRepo = join(tmpHome.home, "fake-repo");
  mkdirSync(REGISTRY_DIR, { recursive: true });
  mkdirSync(fakeRepo, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = REGISTRY_DIR;
  ARTIFACT_PATH = realpathSync(fakeRepo);
  ARTIFACT_ID = artifactIdFromPath(ARTIFACT_PATH);
  setCoordinationRootsForTesting({ roots: [realpathSync(tmpHome.home)] });
});

afterEach(() => {
  setCoordinationRootsForTesting(null);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevActiveSessionsDir === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  tmpHome?.cleanup();
  tmpHome = null;
});

describe("T10 — listLivePeers opportunistic-reap success telemetry (Branch B)", () => {
  it("reaps an aged-out peer + emits heartbeat-reaped with caller_top4 naming listLivePeers", () => {
    const PEER = "peer-aged";
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: PEER,
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    // Backdate the file mtime ~24h (well past GC_WINDOW_MS=60min) so the next
    // listLivePeers walk classifies it aged-out and opportunistically reaps it.
    const longAgoSeconds = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    utimesSync(heartbeatPath(PEER), longAgoSeconds, longAgoSeconds);

    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });

    const reaped = reapedFor(PEER);
    expect(reaped.length).toBe(1);
    const detail = reaped[0]?.detail ?? "";
    expect(detail).toContain(`target_sid=${PEER}`);
    expect(detail).toContain("reaper_sid=");
    expect(detail).toContain("caller_top4=");
    // Branch-B discriminator: the reaper IS listLivePeers (vs T7's
    // unregisterActiveSession caller) — the whole point of this regression test.
    expect(detail).toContain("listLivePeers");
    // Success path (not contention): the file is actually gone.
    expect(existsSync(heartbeatPath(PEER))).toBe(false);
  });

  it("does NOT reap a within-window peer (reap is age-gated; peer returned live)", () => {
    const PEER = "peer-live";
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: PEER,
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });

    const peers = listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });

    expect(peers.some((p) => p.sessionId === PEER)).toBe(true);
    expect(existsSync(heartbeatPath(PEER))).toBe(true);
    expect(reapedFor(PEER).length).toBe(0);
  });
});
