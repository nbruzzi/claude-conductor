// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * C1 S2 — session-pid PROTECT foundation (S1-independent).
 *
 * Covers the two foundation primitives:
 *   - `isOsPidAlive` — the same-host `kill(pid, 0)` probe, with the
 *     ESRCH-vs-EPERM discriminator the pid-spike pinned: a dead pid → ESRCH →
 *     false; an alive-but-unsignalable pid (e.g. pid 1) → EPERM → true; an
 *     absent/invalid pid → false (an ABSENT signal, never a protect).
 *   - `PID_PROTECT_CEILING_MS` — the ceiling MUST be strictly greater than
 *     `GC_WINDOW_MS`, or the protect is a no-op (gc_eligible already gates on
 *     age > GC_WINDOW_MS). This locks that load-bearing invariant.
 *
 * POSIX-portable: every assertion holds identically on macOS + Linux (no
 * `/proc`, no platform-divergent start-time read).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GC_WINDOW_MS,
  PID_PROTECT_CEILING_MS,
  artifactIdFromPath,
  isOsPidAlive,
  readSentinelDotfilesRoot,
  readSessionOsPid,
  recordSessionOsPid,
  setSentinelDotfilesRoot,
  touchHeartbeat,
} from "../../src/active-sessions/index.ts";
import { resolveSessionOsPid } from "../../src/shared/session-id-discovery.ts";

const SID = "b1d2c3e4-0000-4000-8000-000000000001";
const SID2 = "b1d2c3e4-0000-4000-8000-000000000002";

describe("isOsPidAlive (same-host kill(pid,0) probe)", () => {
  it("returns true for the current process (own pid is alive)", () => {
    expect(isOsPidAlive(process.pid)).toBe(true);
  });

  it("returns true for an alive-but-unsignalable pid (EPERM, e.g. pid 1)", () => {
    // pid 1 (launchd / init) exists on macOS + Linux. As a normal user
    // kill(1, 0) throws EPERM (alive-unsignalable → true); as root it succeeds
    // (→ true). Either way the process is ALIVE, so the probe reports true.
    expect(isOsPidAlive(1)).toBe(true);
  });

  it("returns false for a pid that has exited (ESRCH)", () => {
    // Spawn a trivial child and wait for exit + reap; its pid is then gone, so
    // kill(pid, 0) throws ESRCH → not alive.
    const child = spawnSync(process.execPath, ["--version"]);
    const pid = child.pid;
    if (typeof pid !== "number") {
      throw new Error("spawnSync returned no pid");
    }
    expect(isOsPidAlive(pid)).toBe(false);
  });

  it("returns false for an absent / invalid pid (no signal, never a protect)", () => {
    expect(isOsPidAlive(0)).toBe(false); // 0 targets the process group — never probe it
    expect(isOsPidAlive(-1)).toBe(false);
    expect(isOsPidAlive(Number.NaN)).toBe(false);
    expect(isOsPidAlive(1.5)).toBe(false);
  });
});

describe("PID_PROTECT_CEILING_MS (the ceiling-bounded protect window)", () => {
  it("is strictly greater than GC_WINDOW_MS (else the protect is a no-op)", () => {
    // gc_eligible already requires age > GC_WINDOW_MS, so a ceiling ≤ that floor
    // would never widen the protected band — the protect lives in
    // (GC_WINDOW_MS, PID_PROTECT_CEILING_MS]. Load-bearing invariant.
    expect(PID_PROTECT_CEILING_MS).toBeGreaterThan(GC_WINDOW_MS);
  });

  it("is the Nick-ratified 2x GC_WINDOW_MS start value", () => {
    expect(PID_PROTECT_CEILING_MS).toBe(2 * GC_WINDOW_MS);
  });
});

describe("recordSessionOsPid / readSessionOsPid (session-level anchor)", () => {
  let tmpDir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-pid-rec-"));
    prevDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  });

  afterEach(() => {
    if (prevDir === undefined) {
      delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
    } else {
      process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevDir;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Mirrors touchHeartbeat-merge.test.ts: the canonical-claude-home anchor id is
  // derived from the real ~/.claude path; the heartbeat STORAGE is redirected to
  // the sandbox via CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR (no real-state writes).
  function canonicalAnchor(): { artifactId: string; artifactPath: string } {
    const artifactPath = join(process.env["HOME"] ?? homedir(), ".claude");
    return { artifactId: artifactIdFromPath(artifactPath), artifactPath };
  }

  it("round-trips a recorded pid onto the canonical anchor", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: "/tmp/wt-1" });
    recordSessionOsPid(SID, 424242);
    expect(readSessionOsPid(SID)).toBe(424242);
  });

  it("preserves sessionOsPid across a subsequent touchHeartbeat (mergeOwnerRecord)", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: "/tmp/wt-1" });
    recordSessionOsPid(SID, 424242);
    const { artifactId, artifactPath } = canonicalAnchor();
    touchHeartbeat({
      artifactId,
      sessionId: SID,
      artifactPath,
      now: Date.now(),
    });
    // Both the pid AND the co-resident dotfilesRoot survive the auto-touch — the
    // shared read-merge-write must carry every optional field, not just one.
    expect(readSessionOsPid(SID)).toBe(424242);
    expect(readSentinelDotfilesRoot(SID)).toBe("/tmp/wt-1");
  });

  it("no-creates: a session with no anchor heartbeat records nothing (degrades)", () => {
    recordSessionOsPid(SID2, 424242); // no prior anchor for SID2
    expect(readSessionOsPid(SID2)).toBeNull();
  });

  it("rejects a non-positive / non-integer pid (never records garbage)", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: "/tmp/wt-1" });
    recordSessionOsPid(SID, 0);
    expect(readSessionOsPid(SID)).toBeNull();
    recordSessionOsPid(SID, -1);
    expect(readSessionOsPid(SID)).toBeNull();
    recordSessionOsPid(SID, 1.5);
    expect(readSessionOsPid(SID)).toBeNull();
  });
});

describe("resolveSessionOsPid (scan registry by known sessionId)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "session-pid-src-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function writePidFile(pid: number, sessionId: string): void {
    writeFileSync(
      join(sessionsDir, `${pid}.json`),
      JSON.stringify({ pid, sessionId }),
    );
  }

  it("returns the pid of the <pid>.json whose sessionId matches", () => {
    writePidFile(10758, SID);
    writePidFile(99999, SID2); // a DIFFERENT session — must be ignored
    expect(resolveSessionOsPid(SID, { sessionsDir, retryCount: 0 })).toBe(
      10758,
    );
  });

  it("returns null when no pidfile matches the sessionId (no false-positive)", () => {
    writePidFile(99999, SID2);
    expect(resolveSessionOsPid(SID, { sessionsDir, retryCount: 0 })).toBeNull();
  });

  it("skips uuid-stemmed telemetry files (the mixed-stem dir)", () => {
    // A uuid-stemmed telemetry file carries session_id, NOT the pid-keyed CC
    // shape; it must never be mistaken for the pid registry.
    writeFileSync(
      join(sessionsDir, `${SID}.json`),
      JSON.stringify({ session_id: SID }),
    );
    expect(resolveSessionOsPid(SID, { sessionsDir, retryCount: 0 })).toBeNull();
  });

  it("rejects a non-UUID sessionId", () => {
    writePidFile(10758, SID);
    expect(
      resolveSessionOsPid("not-a-uuid", { sessionsDir, retryCount: 0 }),
    ).toBeNull();
  });
});
