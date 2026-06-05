// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * C1 S4-slim — the liveness CONTRACT test (RFC #200 §4).
 *
 * RFC #200 §4 specs a 3-primitive contract; S4-slim is 2-PRIMITIVE — the
 * generation / 2-sweep primitive is CAPPED (it needs the S3a OwnerRecord marker,
 * out of scope this cycle). The contract this file pins:
 *
 *   1. mtime-proxy — the OR-composed BOTH-store signal (the A1 alive-anywhere
 *      contract, preserved): a fresh heartbeat in EITHER store keeps the session
 *      alive (S1 `classifySessionLiveness`), and reconcile-boot's GC honors the
 *      channel store (a channel-fresh session is never gc_eligible).
 *   2. session-pid — `kill(pid,0)` on the RECORDED OS pid: S2's ceiling-bounded,
 *      subtract-only PROTECT (it can only force gc_eligible=false, never enable a
 *      GC), degrading to mtime past the ceiling.
 *
 * PLUS:
 *   - the gc'd / reclaimed LIFECYCLE: gc'd is reached ONLY by the operator
 *     `--apply` path (the state machine's lone state-deleting edge) — pinned
 *     BEHAVIORALLY here (report-mode is inert; `--apply` actually removes a
 *     gc_eligible heartbeat), not just as table data.
 *   - the NEVER-auto-kill invariants (carried from reconcile-boot's suite):
 *     report-mode never mutates; gc_eligible requires stale && past-floor &&
 *     !paused && !channel-live && !pid-alive.
 *   - the rogue-gate closure (S1, already shipped): classifySessionLiveness is
 *     alive-anywhere (reads BOTH stores), so it cannot be the single-store
 *     false-DEAD gate the LGC-002 tripwire forbids. STRUCTURAL enforcement lives
 *     in scripts/check-liveness-gate-store-contract.sh +
 *     test/scripts/check-liveness-gate-store-contract.test.ts; here we pin the
 *     behavioral property.
 *
 * `idle` is NOT pinned as a classified state — per OBSERVE-NOT-INFER it is the
 * deferred observe rung (harness `status`); the state-machine table test asserts
 * it stays observe-only.
 *
 * Coverage split (so the "contract" framing is honest): the genuinely
 * COMPOSITIONAL pins are the A1 both-store upgrade + the operator-`--apply`
 * lifecycle (both primitives / both stores interacting). The Primitive-2 (pid)
 * cases RE-PIN S2's ceiling-bounded protect at the contract boundary as a
 * documentation-anchored regression net (exhaustive per-primitive unit coverage
 * stays in reconcile-boot-pid.test.ts; the apply-time CAS pid-mirror is S2's
 * unit concern and is NOT re-cloned here). All cases call the REAL
 * classifySessionLiveness / runReconcileBoot against sandboxed stores — no mock
 * divergence. Both stores are sandboxed via their dir env vars; the
 * worktree-provisioner config points at a non-existent path so default-scope
 * identity/worktree enumeration sees nothing. `now` is a fixed base so every
 * case is deterministic against planted mtimes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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
import {
  classifySessionLiveness,
  LIVENESS_TRANSITIONS,
} from "../../src/active-sessions/session-liveness.ts";
import {
  canonicalClaudeHomeArtifactId,
  GC_WINDOW_MS,
  PID_PROTECT_CEILING_MS,
  runReconcileBoot,
} from "../../src/active-sessions/index.ts";
import {
  COORDINATION_CHANNEL_ID,
  resolveChannelsDir,
} from "../../src/channels/index.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const IN_BAND = GC_WINDOW_MS + MIN; // past the 60min floor, within the 120min ceiling
const BEYOND_CEILING = PID_PROTECT_CEILING_MS + MIN; // past the ceiling
const SID = "abababab-0000-4000-8000-0000000000c1";

// A reliably-DEAD pid: spawn a trivial child, wait for exit + reap, so its pid
// probes ESRCH (mirrors reconcile-boot-pid.test.ts). Fallback to an unlikely pid.
const DEAD_PID = ((): number => {
  const child = spawnSync(process.execPath, ["--version"]);
  return typeof child.pid === "number" ? child.pid : 2_147_483_646;
})();

let root: string;
let sessionsDir: string;
let prevSessions: string | undefined;
let prevChannels: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "liveness-contract-"));
  sessionsDir = join(root, "active-sessions");
  prevSessions = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevConfig = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = sessionsDir;
  // A REAL channels temp dir (so the channel-store probe can read planted HBs);
  // no identity sentinels are planted, so identity enumeration stays empty.
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(root, "channels");
  process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = join(
    root,
    "no-config.json",
  );
});

afterEach(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", prevSessions);
  restore("CLAUDE_CONDUCTOR_CHANNELS_DIR", prevChannels);
  restore("CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG", prevConfig);
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

/** Plant a coordination-channel heartbeat at mtime NOW-ageMs. */
function plantChannel(sessionId: string, ageMs: number): void {
  const dir = join(resolveChannelsDir(), COORDINATION_CHANNEL_ID, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(path, String(NOW - ageMs));
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

/** The presence candidate reconcile-boot enumerates for `sessionId`. */
function gcCandidate(sessionId: string) {
  return runReconcileBoot({ now: NOW, scope: "presence" }).candidates.find(
    (c) => c.session_id === sessionId,
  );
}

/** Path of the session's anchor heartbeat on disk. */
function anchorPath(sessionId: string): string {
  return join(
    sessionsDir,
    canonicalClaudeHomeArtifactId(),
    "heartbeats",
    sessionId,
  );
}

describe("Liveness contract — Primitive 1: mtime-proxy (OR-composed both-store; A1)", () => {
  it("channel-only fresh => verdict live (the alive-anywhere upgrade, no active HB)", () => {
    plantChannel(SID, 0);
    expect(classifySessionLiveness(SID, NOW).verdict).toBe("live");
  });

  it("active-only fresh => verdict live (process heartbeating, no channel HB)", () => {
    plantActive("work", SID, 0);
    expect(classifySessionLiveness(SID, NOW).verdict).toBe("live");
  });

  it("stale in BOTH stores (past floor) => stale AND gc_eligible (nothing protects it)", () => {
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND); // stale, past floor
    plantChannel(SID, IN_BAND); // channel also stale
    expect(classifySessionLiveness(SID, NOW).verdict).toBe("stale");
    expect(gcCandidate(SID)?.gc_eligible).toBe(true);
  });

  it("A1 upgrade (COMPOSITION): stale active HB + FRESH channel HB => live AND NOT gc_eligible (channel protect)", () => {
    // The data-loss-critical contract: a channel-fresh session reads stale on
    // active-sessions, but is ALIVE — both stores compose, reconcile-boot must
    // NOT GC it.
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND); // stale on active, past floor
    plantChannel(SID, 0); // but fresh on the channel
    expect(classifySessionLiveness(SID, NOW).verdict).toBe("live");
    expect(gcCandidate(SID)?.gc_eligible).toBe(false);
  });
});

describe("Liveness contract — Primitive 2: session-pid (ceiling-bounded, subtract-only protect)", () => {
  it("pid-alive IN-BAND => gc_eligible false (the subtract-only PROTECT)", () => {
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND, {
      sessionOsPid: process.pid,
    });
    const c = gcCandidate(SID);
    expect(c?.classification).toBe("stale");
    expect(c?.gc_eligible).toBe(false);
  });

  it("pid-alive BEYOND the ceiling => gc_eligible true (bounded-leak: mtime wins; subtract-only)", () => {
    // Same alive pid as the protected case above, only the age differs — proving
    // the pid signal SUBTRACTS within the band and stops subtracting past it,
    // never independently enabling a GC.
    plantActive(canonicalClaudeHomeArtifactId(), SID, BEYOND_CEILING, {
      sessionOsPid: process.pid,
    });
    expect(gcCandidate(SID)?.gc_eligible).toBe(true);
  });

  it("pid DEAD (ESRCH) => gc_eligible true (no protect)", () => {
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND, {
      sessionOsPid: DEAD_PID,
    });
    expect(gcCandidate(SID)?.gc_eligible).toBe(true);
  });

  it("absent recorded pid => gc_eligible true (degrades safely to mtime)", () => {
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND); // no sessionOsPid
    expect(gcCandidate(SID)?.gc_eligible).toBe(true);
  });
});

describe("Liveness contract — gc'd / reclaimed lifecycle + NEVER-auto-kill", () => {
  it("report-mode (no --apply) NEVER mutates: applied=false, no cas_races, the heartbeat survives", () => {
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND); // gc_eligible
    const out = runReconcileBoot({ now: NOW, scope: "presence" });
    expect(out.applied).toBe(false);
    expect(out.cas_races).toEqual([]);
    expect(out.gc_eligible_count).toBeGreaterThanOrEqual(1); // it COULD be GC'd ...
    expect(existsSync(anchorPath(SID))).toBe(true); // ... but report-mode left it.
  });

  it("--apply DOES remove a gc_eligible heartbeat (the positive stale -> gc'd edge; CAS-recheck holds)", () => {
    // The positive twin of the report-mode case: the contract's flagship edge
    // must be proven, not just asserted as table data. With nothing protecting
    // it, --apply removes the heartbeat and the recheck holds (no cas-race).
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND); // gc_eligible
    expect(existsSync(anchorPath(SID))).toBe(true);
    const out = runReconcileBoot({ now: NOW, scope: "presence", apply: true });
    expect(out.applied).toBe(true);
    expect(out.cas_races).toEqual([]); // recheck held -> GC proceeded
    expect(out.errors).toEqual([]);
    expect(existsSync(anchorPath(SID))).toBe(false); // the heartbeat is gone
  });

  it("--apply does NOT remove a PROTECTED heartbeat: a pid-alive in-band session survives the GC pass", () => {
    // NEVER-auto-kill under --apply: a session whose recorded pid probes alive
    // in-band is gc_eligible=false at enumeration, so --apply never touches it.
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND, {
      sessionOsPid: process.pid,
    });
    const out = runReconcileBoot({ now: NOW, scope: "presence", apply: true });
    expect(out.applied).toBe(true);
    expect(existsSync(anchorPath(SID))).toBe(true); // protected -> survives --apply
  });

  it("a deliberately PAUSED stale-past-floor session is NEVER gc_eligible (pause subtracts)", () => {
    plantActive(canonicalClaudeHomeArtifactId(), SID, IN_BAND, {
      pausedAt: NOW,
    });
    const c = gcCandidate(SID);
    expect(c?.classification).toBe("stale");
    expect(c?.paused).toBe(true);
    expect(c?.gc_eligible).toBe(false);
  });

  it("the state machine's ONLY state-deleting edge is the operator stale -> gc'd (nothing auto-kills)", () => {
    const intoGcd = LIVENESS_TRANSITIONS.filter((t) => t.to === "gc'd");
    expect(intoGcd).toHaveLength(1);
    expect(intoGcd[0]?.from).toBe("stale");
    expect(intoGcd[0]?.kind).toBe("operator");
    // No decay/refresh/lifecycle/observe edge ever lands in gc'd — GC is operator-only.
    const autoIntoGcd = LIVENESS_TRANSITIONS.filter(
      (t) => t.to === "gc'd" && t.kind !== "operator",
    );
    expect(autoIntoGcd).toEqual([]);
  });

  it("the reclaim lifecycle exists: gc'd -> reclaimed -> live (a freed artifact can come back)", () => {
    const edge = (from: string, to: string): boolean =>
      LIVENESS_TRANSITIONS.some(
        (t) => t.from === from && t.to === to && t.kind === "lifecycle",
      );
    expect(edge("gc'd", "reclaimed")).toBe(true);
    expect(edge("reclaimed", "live")).toBe(true);
  });
});

describe("Liveness contract — rogue-gate closure (behavioral; structural = check-liveness-gate-store-contract)", () => {
  // STRUCTURAL enforcement: scripts/check-liveness-gate-store-contract.sh
  // (LGC-002) flags any NEW src gate that reads a raw single-store primitive, and
  // its suite pins the canonical OR-composers are NOT flagged. Here we pin the
  // BEHAVIORAL property that makes classifySessionLiveness rogue-proof: it is
  // alive-anywhere (reads BOTH stores), so it can never be the single-store
  // false-DEAD gate the tripwire forbids.
  it("classifySessionLiveness reads the CHANNEL store (channel-only fresh => not stale)", () => {
    plantChannel(SID, 0);
    expect(classifySessionLiveness(SID, NOW).verdict).not.toBe("stale");
  });

  it("classifySessionLiveness reads the ACTIVE-SESSIONS store (active-only fresh => not stale)", () => {
    plantActive("work", SID, 0);
    expect(classifySessionLiveness(SID, NOW).verdict).not.toBe("stale");
  });
});
