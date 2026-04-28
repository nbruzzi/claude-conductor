// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * RE-3 regression suite.
 *
 * Before this fix, `listLivePeers`' opportunistic GC did `unlinkSync` inside
 * a try/swallow. When unlink failed for anything other than ENOENT (e.g.
 * EACCES, EPERM, EISDIR, EBUSY), the file stayed, the next scan tried
 * again, and the operator got zero signal — a silent repeating failure
 * with no log trail.
 *
 * The fix routes all stale-heartbeat unlinks through `tryReapHeartbeat`,
 * which:
 *   - Returns true on ENOENT (benign race — peer already reaped).
 *   - Logs one `registry-contention` event per `(artifactId, sessionId)`
 *     key per process on the first non-ENOENT failure, dedup'd by an
 *     in-memory `Set`. Subsequent failures on the same key stay silent
 *     until the process restarts OR a test calls
 *     `resetGcMissDedupeForTesting()`.
 *
 * Failure injection: replace the on-disk heartbeat file with a directory
 * of the same name. `unlinkSync` on a directory fails with EISDIR on
 * macOS/Linux, hitting the non-ENOENT branch reliably without fs mocks.
 * Using `utimesSync` to backdate the dir's mtime forces the GC path to
 * classify it as stale, which is the same path the bug lived on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  artifactIdFromPath,
  listLivePeers,
  resetGcMissDedupeForTesting,
  setCoordinationRootsForTesting,
  touchHeartbeat,
} from "../../src/active-sessions/index.ts";
import { readPresenceFailures } from "../../src/shared/presence-failure-log.ts";
import { makeTmpHome, type TmpHome } from "../../test-utils/index.ts";

let tmpHome: TmpHome | null = null;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let REGISTRY_DIR = "";
let FAKE_REPO = "";
let ARTIFACT_PATH = "";
let ARTIFACT_ID = "";

/**
 * Replace a heartbeat file with a directory and backdate its mtime so
 * `gcStaleArtifacts` classifies it as aged-out. The resulting `unlinkSync`
 * fails with EISDIR on POSIX — the exact non-ENOENT branch `tryReapHeartbeat`
 * exists to observe.
 */
function planDirAtHeartbeat(sessionId: string): string {
  const hbPath = join(REGISTRY_DIR, ARTIFACT_ID, "heartbeats", sessionId);
  rmSync(hbPath, { force: true });
  mkdirSync(hbPath);
  const longAgoSeconds = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
  utimesSync(hbPath, longAgoSeconds, longAgoSeconds);
  return hbPath;
}

function countContentionEvents(): number {
  return readPresenceFailures().filter(
    (e) =>
      e.kind === "registry-contention" &&
      e.source === "active-sessions-registry",
  ).length;
}

beforeEach(() => {
  tmpHome = makeTmpHome();
  prevHome = process.env["HOME"];
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  process.env["HOME"] = tmpHome.home;

  REGISTRY_DIR = join(tmpHome.home, "registry");
  FAKE_REPO = join(tmpHome.home, "fake-repo");
  mkdirSync(REGISTRY_DIR, { recursive: true });
  mkdirSync(FAKE_REPO, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = REGISTRY_DIR;
  ARTIFACT_PATH = realpathSync(FAKE_REPO);
  ARTIFACT_ID = artifactIdFromPath(ARTIFACT_PATH);
  setCoordinationRootsForTesting({ roots: [realpathSync(tmpHome.home)] });

  resetGcMissDedupeForTesting();
});

afterEach(() => {
  setCoordinationRootsForTesting(null);
  resetGcMissDedupeForTesting();
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevActiveSessionsDir === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  tmpHome?.cleanup();
  tmpHome = null;
});

describe("RE-3 GC miss logging", () => {
  it("logs one registry-contention event on first unlink failure", () => {
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "peer-stuck",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    planDirAtHeartbeat("peer-stuck");

    const baseline = countContentionEvents();

    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });

    const after = readPresenceFailures().filter(
      (e) =>
        e.kind === "registry-contention" &&
        e.source === "active-sessions-registry",
    );
    expect(after.length).toBe(baseline + 1);
    const event = after[after.length - 1];
    expect(event?.sessionId).toBe("peer-stuck");
    expect(event?.detail).toContain(ARTIFACT_ID);
    expect(event?.detail).toContain("peer-stuck");
  });

  it("does not duplicate for the same (artifactId, sessionId) within one process", () => {
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "peer-stuck",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    planDirAtHeartbeat("peer-stuck");

    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });
    const afterFirst = countContentionEvents();

    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });
    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });
    const afterRepeats = countContentionEvents();

    expect(afterRepeats).toBe(afterFirst);
  });

  it("logs again for a different (artifactId, sessionId) key", () => {
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "peer-a",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "peer-b",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    planDirAtHeartbeat("peer-a");
    planDirAtHeartbeat("peer-b");

    const baseline = countContentionEvents();

    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });

    const events = readPresenceFailures().filter(
      (e) =>
        e.kind === "registry-contention" &&
        e.source === "active-sessions-registry",
    );
    expect(events.length).toBe(baseline + 2);
    const sessionIds = events.slice(-2).map((e) => e.sessionId);
    expect(sessionIds.sort()).toEqual(["peer-a", "peer-b"]);
  });

  it("stays silent when the heartbeat has already been reaped (stat-ENOENT path)", () => {
    // When the file is gone before scan, statSync throws ENOENT and we skip
    // before reaching tryReapHeartbeat — so no log event fires. Proves we
    // don't produce spurious contention events for benign concurrent-GC races.
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "peer-vanished",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    const hbPath = join(
      REGISTRY_DIR,
      ARTIFACT_ID,
      "heartbeats",
      "peer-vanished",
    );
    rmSync(hbPath, { force: true });

    const baseline = countContentionEvents();

    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });

    expect(countContentionEvents()).toBe(baseline);
  });

  it("re-logs the same key after resetGcMissDedupeForTesting clears state", () => {
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "peer-stuck",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    planDirAtHeartbeat("peer-stuck");

    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });
    const firstCount = countContentionEvents();

    resetGcMissDedupeForTesting();
    listLivePeers({
      artifactId: ARTIFACT_ID,
      self: "session-me",
      now: Date.now(),
    });

    expect(countContentionEvents()).toBe(firstCount + 1);
  });
});
