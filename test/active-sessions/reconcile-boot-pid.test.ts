// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * C1 S2 — reconcile-boot pid-PROTECT lane (the subtract-only `kill(pid,0)`
 * protect). Kept SEPARATE from the other reconcile-boot suites (the cohort
 * convention — avoids shared-test-file merges).
 *
 * The protect is CEILING-bounded: a session whose RECORDED OS pid probes alive
 * is protected from GC, but ONLY while its heartbeat age is in
 * (GC_WINDOW_MS, PID_PROTECT_CEILING_MS]. Beyond the ceiling, mtime-staleness
 * wins regardless of the pid — so a reused-pid false-protect cannot leak
 * forever. Same-host only; an absent recorded pid degrades to mtime. Like the
 * pause protect, the pid read is SESSION-level (the canonical anchor).
 *
 * Paired macOS+Linux: kill(pid,0) is POSIX — process.pid is alive and a
 * spawned-then-exited pid is ESRCH on either platform; no /proc, no start-time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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
  GC_WINDOW_MS,
  PID_PROTECT_CEILING_MS,
  canonicalClaudeHomeArtifactId,
  runReconcileBoot,
} from "../../src/active-sessions/index.ts";
import {
  applyGc,
  type ReconcileBootCandidate,
} from "../../src/active-sessions/reconcile-boot.ts";

const NOW = 1_800_000_000_000;
const IN_BAND = GC_WINDOW_MS + 60_000; // past the 60min floor, within the 120min ceiling
const BEYOND_CEILING = PID_PROTECT_CEILING_MS + 60_000; // past the ceiling

const SID = "abababab-0000-4000-8000-0000000000a1";

// A reliably-DEAD pid: spawn a trivial child, wait for exit + reap, so its pid
// is gone (kill(pid,0) → ESRCH). Fallback to an unlikely-high pid.
const DEAD_PID = ((): number => {
  const child = spawnSync(process.execPath, ["--version"]);
  return typeof child.pid === "number" ? child.pid : 2_147_483_646;
})();

let tmpDir: string;
let prev: string | undefined;
let prevChannels: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reconcile-pid-"));
  prev = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevConfig = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  // Isolate identity (channels) + worktree enumeration so the presence-focused
  // pid tests stay deterministic (mirrors reconcile-boot-pause.test.ts).
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpDir, "no-channels");
  process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = join(
    tmpDir,
    "no-config.json",
  );
});

afterEach(() => {
  if (prev === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prev;
  if (prevChannels === undefined)
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannels;
  if (prevConfig === undefined)
    delete process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  else process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = prevConfig;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Write the canonical anchor heartbeat (the session-level record the pid-protect
// reads) with a back-dated mtime + an optional recorded sessionOsPid + host.
function writeAnchor(
  sessionId: string,
  ageMs: number,
  opts: { sessionOsPid?: number; host?: string } = {},
): void {
  const artifactId = canonicalClaudeHomeArtifactId();
  const dir = join(tmpDir, artifactId, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(
    path,
    JSON.stringify({
      sessionId,
      pid: 4242,
      host: opts.host ?? hostname(),
      createdAt: NOW - ageMs,
      touchedAt: NOW - ageMs,
      ...(opts.sessionOsPid !== undefined
        ? { sessionOsPid: opts.sessionOsPid }
        : {}),
    }),
  );
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

function anchorCandidate(
  sessionId: string,
): ReconcileBootCandidate | undefined {
  const artifactId = canonicalClaudeHomeArtifactId();
  return runReconcileBoot({ now: NOW }).candidates.find(
    (c) => c.session_id === sessionId && c.artifact_id === artifactId,
  );
}

describe("runReconcileBoot — pid-PROTECT lane (C1 S2)", () => {
  it("PROTECTS a pid-alive session in-band (gc_eligible=false)", () => {
    writeAnchor(SID, IN_BAND, { sessionOsPid: process.pid });
    const c = anchorCandidate(SID);
    expect(c?.classification).toBe("stale");
    expect(c?.gc_eligible).toBe(false);
  });

  it("does NOT protect a pid-alive session BEYOND the ceiling (bounded-leak: mtime wins)", () => {
    writeAnchor(SID, BEYOND_CEILING, { sessionOsPid: process.pid });
    expect(anchorCandidate(SID)?.gc_eligible).toBe(true);
  });

  it("does NOT protect when the recorded pid is dead (ESRCH)", () => {
    writeAnchor(SID, IN_BAND, { sessionOsPid: DEAD_PID });
    expect(anchorCandidate(SID)?.gc_eligible).toBe(true);
  });

  it("does NOT protect a cross-host record (a pid is meaningless off-host)", () => {
    writeAnchor(SID, IN_BAND, {
      sessionOsPid: process.pid,
      host: "some-other-host",
    });
    expect(anchorCandidate(SID)?.gc_eligible).toBe(true);
  });

  it("degrades safely: no recorded sessionOsPid → no protect (today's mtime behaviour)", () => {
    writeAnchor(SID, IN_BAND); // legacy / flag-off record — no sessionOsPid
    expect(anchorCandidate(SID)?.gc_eligible).toBe(true);
  });
});

describe("applyGc — pid-protect apply-time CAS mirror (C1 S2)", () => {
  it("flips a gc_eligible candidate to a pid-alive cas-race when the recorded pid probes alive in-band", () => {
    // On-disk: the anchor carries an alive pid + an in-band (still-stale,
    // past-floor) age, so casRecheckFlip's pid-mirror fires ahead of the mtime
    // rechecks. The candidate is the enumeration snapshot (gc_eligible=true).
    writeAnchor(SID, IN_BAND, { sessionOsPid: process.pid });
    const candidate: ReconcileBootCandidate = {
      artifact_class: "presence",
      artifact_id: canonicalClaudeHomeArtifactId(),
      session_id: SID,
      classification: "stale",
      split_brain: false,
      gc_eligible: true,
      paused: false,
      failed_signals: ["mtime-age"],
      age_ms: IN_BAND,
    };
    const { cas_races, errors } = applyGc([candidate], NOW);
    expect(errors).toEqual([]);
    expect(cas_races).toHaveLength(1);
    expect(cas_races[0]?.reason).toBe("pid-alive");
  });
});
