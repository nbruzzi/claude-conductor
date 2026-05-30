// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle-2 increment-2 2b — the `--apply` CAS-recheck GC MUTATION (the ONLY path
 * that deletes coordination state). The cardinal contract is NEVER-auto-kill.
 *
 * Two layers:
 *  - runReconcileBoot({apply:true}) INTEGRATION: report-mode never removes;
 *    --apply removes a real gc_eligible stale heartbeat + sets `applied`; the
 *    floor still guards.
 *  - applyGc() DIRECT: the CAS-recheck FLIP cases (now-live / now-paused /
 *    file-gone / mtime-refreshed) cannot arise within a single runReconcileBoot
 *    call (one `now`, one disk read), so they're driven by a constructed
 *    candidate + a controlled on-disk heartbeat; plus the presence-only +
 *    !split_brain + gc_eligible guards, and gc-failed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
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
  canonicalClaudeHomeArtifactId,
} from "../../src/active-sessions/index.ts";
import {
  applyGc,
  runReconcileBoot,
  type ReconcileBootCandidate,
} from "../../src/active-sessions/reconcile-boot.ts";

let tmpDir: string;
let prev: string | undefined;
let prevChannels: string | undefined;
let prevConfig: string | undefined;
const NOW = 1_800_000_000_000;
const STALE = GC_WINDOW_MS + 1; // stale + past the GC floor → gc_eligible
const UNDER_FLOOR = 45 * 60 * 1000; // 45min: stale (>30min) but under the 60min floor
const SID = "abababab-0000-4000-8000-000000000001";

function setEnv(key: string, value: string): void {
  process.env[key] = value;
}
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reconcile-apply-"));
  prev = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevConfig = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  setEnv("CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", tmpDir);
  setEnv("CLAUDE_CONDUCTOR_CHANNELS_DIR", join(tmpDir, "no-channels"));
  setEnv(
    "CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG",
    join(tmpDir, "no-config.json"),
  );
});

afterEach(() => {
  // Restore any read-only chmod so rmSync can clean up.
  try {
    chmodSync(join(tmpDir, "ro", "heartbeats"), 0o755);
  } catch {
    /* not chmod'd this test */
  }
  restoreEnv("CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", prev);
  restoreEnv("CLAUDE_CONDUCTOR_CHANNELS_DIR", prevChannels);
  restoreEnv("CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG", prevConfig);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function writeHeartbeat(
  artifactId: string,
  sessionId: string,
  ageMs: number,
  opts: { pausedAt?: number } = {},
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
      ...(opts.pausedAt !== undefined ? { pausedAt: opts.pausedAt } : {}),
    }),
  );
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
  return path;
}

/** A constructed gc_eligible PRESENCE candidate (the enumeration snapshot).
 *  applyGc re-reads the disk fresh, so the on-disk heartbeat — not these fields
 *  — drives the recheck; the fields gate WHICH candidates applyGc considers. */
function gcEligiblePresence(
  artifactId: string,
  sessionId: string,
  overrides: Partial<ReconcileBootCandidate> = {},
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
    ...overrides,
  };
}

describe("runReconcileBoot --apply — integration (the only state-deleting path)", () => {
  it("report-mode (no --apply) NEVER removes a gc_eligible heartbeat", () => {
    const path = writeHeartbeat("work", SID, STALE);
    const out = runReconcileBoot({ now: NOW });
    expect(out.applied).toBe(false);
    expect(out.cas_races).toEqual([]);
    expect(existsSync(path)).toBe(true); // untouched
  });

  it("--apply removes a gc_eligible stale heartbeat (recheck holds) + sets applied", () => {
    const path = writeHeartbeat("work", SID, STALE);
    const out = runReconcileBoot({ now: NOW, apply: true });
    expect(out.applied).toBe(true);
    expect(existsSync(path)).toBe(false); // removed
    expect(out.errors).toEqual([]);
    expect(out.cas_races).toEqual([]); // recheck held — no race
    expect(out.ok).toBe(true);
  });

  it("--apply does NOT remove a stale-but-under-floor heartbeat (floor guard)", () => {
    const path = writeHeartbeat("work", SID, UNDER_FLOOR);
    runReconcileBoot({ now: NOW, apply: true });
    expect(existsSync(path)).toBe(true); // not gc_eligible -> not removed
  });
});

describe("applyGc — CAS-recheck flips (healthy skips -> cas_races, exit/ok-neutral)", () => {
  it("recheck HOLDS (still stale, past floor, not paused) -> removed", () => {
    const path = writeHeartbeat("work", SID, STALE);
    const { cas_races, errors } = applyGc(
      [gcEligiblePresence("work", SID)],
      NOW,
    );
    expect(existsSync(path)).toBe(false); // removed
    expect(cas_races).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("now-live: the heartbeat was refreshed to fresh -> SKIP into cas_races", () => {
    const path = writeHeartbeat("work", SID, 0); // fresh at apply-time
    const { cas_races } = applyGc([gcEligiblePresence("work", SID)], NOW);
    expect(existsSync(path)).toBe(true); // protected — NOT removed
    expect(cas_races).toHaveLength(1);
    expect(cas_races[0]?.reason).toBe("now-live");
  });

  it("now-paused: the session was paused since enumeration -> SKIP", () => {
    const path = writeHeartbeat("work", SID, STALE);
    // Pause the session: pausedAt on its canonical-claude-home anchor heartbeat.
    writeHeartbeat(canonicalClaudeHomeArtifactId(), SID, STALE, {
      pausedAt: NOW - STALE,
    });
    const { cas_races } = applyGc([gcEligiblePresence("work", SID)], NOW);
    expect(existsSync(path)).toBe(true); // protected
    expect(cas_races[0]?.reason).toBe("now-paused");
  });

  it("file-gone: the heartbeat vanished before apply -> SKIP (no error)", () => {
    // No heartbeat written for SID.
    const { cas_races, errors } = applyGc(
      [gcEligiblePresence("work", SID)],
      NOW,
    );
    expect(cas_races[0]?.reason).toBe("file-gone");
    expect(errors).toEqual([]);
  });

  it("mtime-refreshed: refreshed back under the GC floor (still stale) -> SKIP", () => {
    const path = writeHeartbeat("work", SID, UNDER_FLOOR);
    const { cas_races } = applyGc([gcEligiblePresence("work", SID)], NOW);
    expect(existsSync(path)).toBe(true);
    expect(cas_races[0]?.reason).toBe("mtime-refreshed");
  });
});

describe("applyGc — NEVER-auto-kill guards", () => {
  it("skips a NON-presence candidate even if (wrongly) gc_eligible (presence-only)", () => {
    const path = writeHeartbeat("work", SID, STALE);
    const c = gcEligiblePresence("work", SID, { artifact_class: "identity" });
    const { cas_races, errors } = applyGc([c], NOW);
    expect(existsSync(path)).toBe(true); // identity is never GC'd
    expect(cas_races).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("skips a split_brain candidate (the !split_brain DiD)", () => {
    const path = writeHeartbeat("work", SID, STALE);
    const c = gcEligiblePresence("work", SID, { split_brain: true });
    applyGc([c], NOW);
    expect(existsSync(path)).toBe(true); // split-brain -> operator resolution, not auto-GC
  });

  it("skips a non-eligible candidate (gc_eligible-only)", () => {
    const path = writeHeartbeat("work", SID, STALE);
    const c = gcEligiblePresence("work", SID, { gc_eligible: false });
    applyGc([c], NOW);
    expect(existsSync(path)).toBe(true);
  });
});

describe("applyGc — gc-failed (a real unlink failure surfaces -> errors)", () => {
  it("a recheck-passing unlink that FAILS -> errors[gc-failed], not a cas_race", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses perms
    const sid = "cdcdcdcd-0000-4000-8000-00000000000c";
    writeHeartbeat("ro", sid, STALE);
    // Read-only heartbeats dir: reReadHeartbeat can still READ (recheck holds),
    // but unlinkSync (needs WRITE on the parent) fails EACCES -> gc-failed.
    chmodSync(join(tmpDir, "ro", "heartbeats"), 0o555);
    const { errors, cas_races } = applyGc([gcEligiblePresence("ro", sid)], NOW);
    expect(cas_races).toEqual([]); // recheck held
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error_class).toBe("gc-failed");
  });
});
