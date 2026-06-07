// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Canonical session-liveness API — the single OR-composing entry point that
 * answers "is session S alive?" across BOTH heartbeat stores plus the pause
 * marker. C1 Slice 1 of the boot-reconciliation arc (RFC #200): it centralizes
 * the A1 "alive-anywhere -> read ALL stores OR-composed" contract
 * (docs/conventions/liveness-gate-store-contract.md) so a NEW gate can no longer
 * make a single-store alive-anywhere decision — the false-DEAD class. Gates
 * route through here; raw single-store primitives are flagged outside the
 * liveness module by the LGC-002 tripwire (scripts/check-liveness-gate-store-contract.sh).
 *
 * Why a SEPARATE module (not index.ts): the OR-compose must consult the channel
 * store (isSidPrefixLiveOnChannel), and channels/index.ts already imports
 * active-sessions/index.ts. Adding the channel import to index.ts would close an
 * active-sessions<->channels module cycle AT THE HUB (TDZ risk per
 * reconcile-boot.ts's cycle note). This leaf module imports BOTH — channels has
 * no back-edge to it, so no cycle — mirroring how reconcile-boot.ts reaches the
 * channel store.
 *
 * NO pid lane. C1 S2 adds pid as a reconcile-boot `gc_eligible` subtract-term
 * (a lazy thunk mirroring `channelLiveProbe`), NOT folded into this verdict:
 * pid-liveness is same-host-ONLY + ceiling-bounded-protect + operator-reclaim-
 * oriented — distinct semantics from heartbeat-store liveness (cohort-ratified
 * seam, 2026-06-05). The canonical signature here is therefore stable across S2.
 */

import {
  GC_WINDOW_MS,
  LIKELY_DEAD_MS,
  LIVE_WINDOW_MS,
  isSessionLiveByPrefix,
  listAllHeartbeats,
  listArtifactIds,
  readSessionPausedAt,
  type HeartbeatListing,
  type Liveness,
} from "./index.ts";
import {
  COORDINATION_CHANNEL_ID,
  isSidPrefixLiveOnChannel,
} from "../channels/index.ts";

/** Which heartbeat store proved a session's liveness. */
export type LiveStore = "active-sessions" | "channel";

/**
 * The OR-composed liveness verdict plus the orthogonal pause protection. Two
 * axes kept deliberately separate (mirrors reconcile-boot + the index.ts
 * §"NOTE the axis" comment): `verdict` is the liveness bucket; `paused` is a
 * deliberate-suspension PROTECTION, never a liveness value.
 */
export type SessionLivenessResult = {
  verdict: Liveness;
  paused: boolean;
};

/**
 * Newest (smallest) active-sessions heartbeat age for `sessionId` across ALL
 * artifacts, or null if the session has no active-sessions heartbeat anywhere.
 * The active-sessions half of the OR-compose, used to BUCKET the verdict.
 * Exact-match on the full sessionId (NOT prefix). Fail-soft: an unreadable
 * artifact dir is skipped, never thrown (mirrors isSessionLiveByPrefix).
 */
function newestActiveSessionsAgeMs(
  sessionId: string,
  now: number,
): number | null {
  let artifactIds: readonly string[];
  try {
    artifactIds = listArtifactIds();
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const artifactId of artifactIds) {
    let listings: HeartbeatListing[];
    try {
      listings = listAllHeartbeats({ artifactId, now });
    } catch {
      continue;
    }
    for (const h of listings) {
      if (h.sessionId !== sessionId) continue;
      // ageMs is non-negative by construction: defensiveAgeMs clamps to >= 0 and
      // routes future-mtime garbage to scanHeartbeats' malformed set (never into
      // listAllHeartbeats' valid listings) — so no negative-age guard is needed.
      if (newest === null || h.ageMs < newest) newest = h.ageMs;
    }
  }
  return newest;
}

/**
 * WHICH store proves the sid-PREFIX session is alive within `windowMs`, or null
 * if neither does. The canonical OR-composer for the worktree reapers (which
 * hold only the 8-char path prefix) — it replaces their manual
 * `isSessionLiveByPrefix(p) || isSidPrefixLiveOnChannel(ch, p)` OR so the A1
 * alive-anywhere contract cannot be half-applied, AND returns the store so a
 * caller can keep its forensic which-store breadcrumb.
 *
 * The CHANNEL window is floored at GC_WINDOW_MS: coordination sends are SPARSE,
 * so a short caller `windowMs` (a per-repo `cleanupAfterIdleHours`) would else
 * false-dead a channel-only-fresh session — the L1049 slice-2b 3/3 victim class.
 * Centralizing the floor (the worktree reapers each applied it separately) is a
 * correctness invariant, not a tuning knob. active-sessions is probed first (it
 * short-circuits the channel-dir scan); each store is fail-soft independently.
 * Pause is NOT folded — the reapers gate on liveness; pause-protection is
 * reconcile-boot's.
 */
export function sessionLivePrefixSource(
  sidPrefix: string,
  now: number,
  windowMs: number = GC_WINDOW_MS,
): LiveStore | null {
  if (sidPrefix.length === 0) return null;
  if (isSessionLiveByPrefix(sidPrefix, now, windowMs)) return "active-sessions";
  if (
    isSidPrefixLiveOnChannel(
      sidPrefix,
      COORDINATION_CHANNEL_ID,
      now,
      Math.max(windowMs, GC_WINDOW_MS),
    )
  ) {
    return "channel";
  }
  return null;
}

/**
 * Is the sid-PREFIX session alive in EITHER store within `windowMs` (channel
 * floored at GC_WINDOW_MS, per {@link sessionLivePrefixSource})? Boolean
 * convenience for callers that don't need the store.
 */
export function isSessionLivePrefix(
  sidPrefix: string,
  now: number,
  windowMs: number = GC_WINDOW_MS,
): boolean {
  return sessionLivePrefixSource(sidPrefix, now, windowMs) !== null;
}

/**
 * Is the FULL-id session alive (fresh in either store) within `windowMs`
 * (default LIVE_WINDOW_MS — the "actively coordinating" threshold)? Exact-match
 * on the full sessionId. Unlike {@link isSessionLivePrefix} this does NOT floor
 * the channel window: the reaper-protection floor is a don't-reap concern, not
 * an is-coordinating one — both stores use the same `windowMs` here. Pause is
 * orthogonal: read {@link classifySessionLiveness}`.paused`.
 */
export function isSessionLive(
  sessionId: string,
  now: number,
  windowMs: number = LIVE_WINDOW_MS,
): boolean {
  if (isSessionLiveByPrefix(sessionId, now, windowMs)) return true;
  return isSidPrefixLiveOnChannel(
    sessionId,
    COORDINATION_CHANNEL_ID,
    now,
    windowMs,
  );
}

/**
 * Canonical OR-composed liveness classification for a full sessionId. A fresh
 * coordination-channel heartbeat (within LIVE_WINDOW_MS) upgrades to "live" even
 * when the active-sessions heartbeat aged out (the A1 contract — cohort `send`
 * refreshes ONLY the channel store); otherwise the verdict is the freshest
 * active-sessions heartbeat's age bucket, or "stale" when neither store has a
 * fresh entry. `paused` is the orthogonal deliberate-suspension marker (a
 * protection, never a liveness bucket).
 */
export function classifySessionLiveness(
  sessionId: string,
  now: number,
): SessionLivenessResult {
  const paused = readSessionPausedAt(sessionId) !== null;

  if (
    isSidPrefixLiveOnChannel(
      sessionId,
      COORDINATION_CHANNEL_ID,
      now,
      LIVE_WINDOW_MS,
    )
  ) {
    return { verdict: "live", paused };
  }

  const ageMs = newestActiveSessionsAgeMs(sessionId, now);
  if (ageMs === null || ageMs > LIVE_WINDOW_MS) {
    return { verdict: "stale", paused };
  }
  if (ageMs > LIKELY_DEAD_MS) return { verdict: "likely-dead", paused };
  return { verdict: "live", paused };
}

/**
 * The formalized liveness lifecycle (RFC #200 §3.5, C1 S4-slim) — supersedes the
 * ad-hoc {@link Liveness} buckets with an explicit state machine.
 *
 * S4-slim formalizes the SHIPPED + lifecycle states only (Alpha cohort call,
 * 2026-06-05): the classifiable path `live -> likely-dead -> stale` comes
 * straight from {@link classifySessionLiveness} (S1 mtime OR-compose) gated by
 * S2's pid protect; `gc'd -> reclaimed` are operation-driven lifecycle states;
 * `paused` is orthogonal. It OMITS the 2-sweep states (suspected-dead /
 * confirmed-dead) — they need the S3a generation marker, CAPPED this cycle.
 *
 * `idle` is kept a NAMED state but its signal is the OBSERVE rung: the harness
 * already publishes per-session busy/idle status (the harness `sessions/<pid>.json`
 * status field). Per the Nick-blessed OBSERVE-NOT-INFER bound we do NOT re-derive it
 * from a two-store heartbeat split; the idle edges are marked DEFERRED (a future
 * observe rung) — documented here, NOT classified by the substrate this slice.
 * This REPOSITIONS idle off RFC #200 §3.5's literal linear
 * `live -> idle -> likely-dead` decay path: idle is an off-path observe edge
 * (sibling-of-live), NOT a decay-path state — a deliberate topology deviation
 * per OBSERVE-NOT-INFER, not a transcription error.
 *
 * The classifiable states are exactly the shipped {@link Liveness} buckets, so
 * NO new classifier is hand-rolled — callers classify via classifySessionLiveness
 * (mtime, S1) + reconcile-boot's gc_eligible (mtime+pid, S2). This module adds
 * the state vocabulary + the transition table; liveness-contract.test.ts pins
 * the classifiable + lifecycle edges against S1+S2.
 */
export type LivenessState = Liveness | "idle" | "gc'd" | "reclaimed";

/**
 * What drives a {@link LivenessTransition}:
 *   - "decay"     — substrate-driven; time passes, no actor (a heartbeat ages out)
 *   - "refresh"   — the session ACTED (a heartbeat refreshed) — recovery;
 *                   liveness is NON-monotonic, a silent peer can return
 *   - "operator"  — operator-explicit (`reconcile-boot --apply`); the ONLY
 *                   state-deleting edge — the NEVER-auto-kill gate
 *   - "lifecycle" — a new session registers / reclaims the freed artifact
 *   - "observe"   — DEFERRED observe rung: the harness-published session status
 *                   (OBSERVE-NOT-INFER), documented but NOT classified this slice
 */
export type LivenessTransitionKind =
  | "decay"
  | "refresh"
  | "operator"
  | "lifecycle"
  | "observe";

/** One edge of the formalized lifecycle, with its explicit, testable signal. */
export type LivenessTransition = {
  from: LivenessState;
  to: LivenessState;
  kind: LivenessTransitionKind;
  /** The explicit signal that fires this edge (RFC #200 §3.5). */
  signal: string;
};

/**
 * The C1 S4-slim liveness state machine (RFC #200 §3.5). Each edge's `signal` is
 * its explicit, testable trigger. The decay/refresh edges are classified by S1's
 * classifySessionLiveness (mtime OR-compose); the operator `stale -> gc'd` edge
 * by reconcile-boot's gc_eligible + the NEVER-auto-kill guards (S2); the `idle`
 * edges are the DEFERRED observe rung (harness status; OBSERVE-NOT-INFER) — named
 * but not classified. Identity/worktree `--apply`-GC is DEFERRED (roadmap → C2),
 * so the GC edge is the presence-class one S2 implements.
 */
export const LIVENESS_TRANSITIONS: readonly LivenessTransition[] = [
  // ── forward decay (mtime ages out; classified by S1 classifySessionLiveness) ──
  {
    from: "live",
    to: "likely-dead",
    kind: "decay",
    signal:
      "active-sessions HB ages into (LIKELY_DEAD_MS, LIVE_WINDOW_MS] with no fresh channel HB",
  },
  {
    from: "likely-dead",
    to: "stale",
    kind: "decay",
    signal:
      "active-sessions HB ages past LIVE_WINDOW_MS (or goes absent) with no fresh channel HB",
  },
  // ── refresh recovery (the session acted; liveness is NON-monotonic) ──
  {
    from: "likely-dead",
    to: "live",
    kind: "refresh",
    signal:
      "a channel send or active-sessions touch refreshes a heartbeat within LIVE_WINDOW_MS",
  },
  {
    from: "stale",
    to: "live",
    kind: "refresh",
    signal:
      "a silent/sleeping peer refreshes either store again: re-classified live — the gc'd state is a substrate transition, NOT a death certificate",
  },
  // ── operator-explicit GC — the ONLY state-deleting edge (NEVER-auto-kill) ──
  {
    from: "stale",
    to: "gc'd",
    kind: "operator",
    signal:
      "gc_eligible (stale && age > GC_WINDOW_MS && !paused && !channel-live && !pid-alive) AND operator `--apply` AND !split_brain AND the apply-time CAS-recheck still holds",
  },
  // ── reclaim lifecycle (a new session takes the freed artifact) ──
  {
    from: "gc'd",
    to: "reclaimed",
    kind: "lifecycle",
    signal:
      "a new session registers / takes over the freed presence / identity / worktree",
  },
  {
    from: "reclaimed",
    to: "live",
    kind: "lifecycle",
    signal:
      "the reclaiming session's first heartbeat / channel send re-enters the live state",
  },
  // ── idle: observe rung (harness status; OBSERVE-NOT-INFER). Lane A
  //    (2026-06-07) wired the READ side: teammate-idle-reminder consults the
  //    harness status via cohort-sight.buildHarnessStatusIndex as an
  //    ADVISORY-OBSERVE-ONLY idle suppress (CG6 — off the LGC allowlist; never a
  //    reaper gate). These edges document the topology; no GC path classifies
  //    `idle`. ──
  {
    from: "live",
    to: "idle",
    kind: "observe",
    signal:
      "harness-published session status flips busy->idle (the harness `sessions/<pid>.json` status field). Lane A consumes it ADVISORY-ONLY in teammate-idle-reminder (suppress a would-be idle warn, never reap): active = busy/shell/waiting, idle = idle.",
  },
  {
    from: "idle",
    to: "live",
    kind: "observe",
    signal:
      "harness-published session status flips idle->busy (the harness `sessions/<pid>.json` status field). Lane A: an ACTIVE status + a live pid suppresses the idle reminder REGARDLESS of pidfile updatedAt age — updatedAt freezes during active work (CG1), so isOsPidAlive is the staleness guard, never the age.",
  },
];
