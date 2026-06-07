// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 2 — boot reconciliation (agetor steal-list A-P0-1; backlog 1040).
 *
 * A cross-class operator interface that surfaces stale coordination state
 * (presence heartbeats + identity sentinels + per-session worktrees) in ONE
 * report, and — only under an explicit `--apply` — garbage-collects the
 * GC-eligible entries. The cardinal safety contract is **NEVER auto-kill**:
 *   - report-mode is the default; no caller path mutates without `--apply`;
 *   - the session-start hook integration runs report-mode ONLY;
 *   - `--apply` GCs only `gc_eligible` candidates, CAS-rechecked at apply-time;
 *   - a safety-floor (GC_WINDOW_MS = 2× the live window) refuses young entries
 *     even when classified stale (clock-skew defense).
 *
 * Placement (Pair-B §0, cohort-unanimous): this core lives plugin-side so a
 * conductor hook/dashboard can import `runReconcileBoot` in report-mode. The
 * dotfiles `/presence` cli.ts adds a thin `reconcile-boot` verb that calls it.
 *
 * Two axes are kept deliberately separate so the word "stale" never means two
 * things: `classification` is the liveness bucket (live/likely-dead/stale,
 * stale = OLDEST) from {@link classifyLiveness}; `gc_eligible` is the derived
 * GC-lifecycle predicate. See {@link Liveness}.
 */

import { statSync } from "node:fs";
import { hostname } from "node:os";
import {
  GC_WINDOW_MS,
  LIVE_WINDOW_MS,
  PID_PROTECT_CEILING_MS,
  classifyLiveness,
  isOsPidAlive,
  listArtifactIds,
  reReadHeartbeat,
  readSessionOsPid,
  readSessionPausedAt,
  removeOwnHeartbeat,
  scanHeartbeats,
  type HeartbeatListing,
  type HeartbeatScan,
  type Liveness,
} from "./index.ts";
// Cross-module imports for the identity + worktree classes. channels/* and
// worktrees/* both depend on active-sessions, so these EXTEND the existing
// index↔reconcile-boot cycle (now spanning three subsystems). LOAD-SAFE only
// because every use below is CALL-TIME — inside enumerateIdentity /
// enumerateWorktree, never at module-eval. A future module-EVAL-time use of any
// of these in this cycle would hit a TDZ on the partially-initialized exports.
// Keep all cross-module uses call-time. (Bravo+Charlie #179 integration-lens.)
import {
  COORDINATION_CHANNEL_ID,
  isSidPrefixLiveOnChannel,
  listChannels,
} from "../channels/index.ts";
import { listClaims } from "../channels/identity.ts";
import { listWorktrees } from "../worktrees/index.ts";
import { readRepoConfig } from "../worktrees/repo-config.ts";

/** Which substrate class a candidate belongs to. Presence is fully enumerated;
 *  identity + worktree are report-only (enumerated as candidates, never
 *  `--apply`-GC'd this increment — their GC primitives are deferred). */
export type ReconcileBootArtifactClass = "presence" | "identity" | "worktree";

/**
 * The three liveness signals that "live" requires (active-sessions/index.ts
 * §"Liveness of a heartbeat requires all three"): mtime within the live window,
 * a parseable OwnerRecord body (anti-ghost), and a host match.
 *
 * `no-presence-heartbeat` is a DIFFERENT kind of signal — not a per-heartbeat
 * liveness check but the ABSENCE of any presence heartbeat for the session. It
 * is the sole `failed_signals` member of an ORPHAN identity/worktree candidate
 * (a sentinel/worktree whose session left no presence heartbeat — §2
 * enumeration). A presence candidate never lists it (it always has a heartbeat
 * to evaluate); only the cross-class identity/worktree enumeration can.
 *
 * `pid-alive` (C1 S2): a same-host `kill(pid, 0)` probe on the session's RECORDED
 * OS pid, consulted as a CEILING-bounded gc_eligible PROTECT (isGcEligible). It
 * can only force `gc_eligible = false`, never enable a GC. Like `paused`, it is a
 * PROTECTION — not a failed liveness signal — so `failed_signals` does NOT list
 * it; the type member is retained for potential future protect-visibility.
 */
export type ReconcileBootSignal =
  | "mtime-age"
  | "owner-record-parses"
  | "host-match"
  | "no-presence-heartbeat"
  | "pid-alive";

export type ReconcileBootCandidate = {
  artifact_class: ReconcileBootArtifactClass;
  artifact_id: string;
  session_id: string;
  /** Liveness bucket (stale = OLDEST). Distinct axis from `gc_eligible`. */
  classification: Liveness;
  /** Two sessions claim one artifact. Separate flag, never a `classification`
   *  value — resolves the stale-collision. `--apply` does NOT auto-resolve. */
  split_brain: boolean;
  /** Derived: stale AND past the GC_WINDOW_MS safety-floor AND not paused. The
   *  ONLY thing `--apply` will GC. */
  gc_eligible: boolean;
  /** Session deliberately paused (markSessionPaused) — a SESSION-level lookup
   *  (readSessionPausedAt), so `true` across ALL of a paused session's
   *  candidates, not just its anchor. Makes a stale + gc_eligible=false entry
   *  operator-VISIBLE as paused (vs a silent indistinguishable skip) →
   *  manual-self-heal viable. Pause is a PROTECTION, not a failed liveness
   *  signal, so it is its own field, never a `failed_signals` member.
   *  (Cycle-6 item-4 / Bravo+Charlie #175 paused-dead report-visibility.) */
  paused: boolean;
  /** Which liveness signals failed (never-auto-kill transparency). */
  failed_signals: ReconcileBootSignal[];
  age_ms: number;
};

export type ReconcileBootError = {
  artifact_id: string;
  /** `gc-failed`: a `--apply` unlink genuinely failed (EACCES/EISDIR/...) →
   *  exit 1. `malformed-entry`: an unreadable presence heartbeat (corrupt owner
   *  / future-mtime) → exit 3. A cas-race is NOT an error — a recheck-skip is a
   *  HEALTHY protection (see {@link ReconcileBootCasRace}). */
  error_class: "gc-failed" | "malformed-entry";
  detail: string;
};

/**
 * A `--apply` candidate that was `gc_eligible` at enumeration but FLIPPED at the
 * apply-time CAS re-read — so it was SKIPPED, not removed. A HEALTHY protective
 * skip (the re-read saw the peer recover or vanish), NOT an error: `cas_races`
 * is exit/ok-NEUTRAL — it never flips `ok` and drives no exit code. Advisory: it
 * surfaces what the TOCTOU re-read protected (convergent with 2a's "a healthy
 * protection must not signal an error").
 */
export type ReconcileBootCasRace = {
  artifact_id: string;
  session_id: string;
  /** Why the re-read no longer permits GC: the session is now live (channel or
   *  mtime), now paused, its recorded OS pid probes alive within the ceiling
   *  (pid-alive), its heartbeat refreshed back under the GC floor, or it is
   *  gone/garbage. */
  reason:
    | "now-live"
    | "now-paused"
    | "mtime-refreshed"
    | "file-gone"
    | "pid-alive";
};

export type ReconcileBootOutput = {
  ok: boolean;
  total_enumerated: number;
  live_count: number;
  likely_dead_count: number;
  stale_count: number;
  split_brain_count: number;
  gc_eligible_count: number;
  applied: boolean;
  candidates: ReconcileBootCandidate[];
  errors: ReconcileBootError[];
  /** `--apply` recheck-skips (healthy, exit/ok-neutral). Empty in report-mode. */
  cas_races: ReconcileBootCasRace[];
};

export type ReconcileBootOptions = {
  now: number;
  /**
   * `--apply` GC (2b): when `true`, after enumeration run the CAS-recheck pass
   * that removes the `gc_eligible` PRESENCE candidates (re-confirmed at
   * apply-time) and sets `applied: true`. Default/absent → report-only (no
   * mutation; `applied: false`). The ONLY operator-explicit, state-deleting
   * switch — no auto-path passes it (the session-start hook stays report-mode).
   */
  apply?: boolean;
  scope?: ReconcileBootArtifactClass | "all";
};

/**
 * Compute which of the three live-requiring signals failed for a heartbeat.
 * `scanHeartbeats` routes future-mtime garbage and unparseable owner records
 * into its `malformed` set (surfaced as errors), so an entry in the `valid`
 * set we classify here has a parseable owner; the signals we can still observe
 * failing on a surviving listing are mtime-age and host-match.
 * (`owner-record-parses` is in the union for direct callers that read raw
 * entries.) `pid-alive` is never listed yet (reserved — see type).
 */
function failedSignals(
  h: HeartbeatListing,
  currentHost: string,
): ReconcileBootSignal[] {
  const failed: ReconcileBootSignal[] = [];
  // "mtime-age" fails once the heartbeat is past the LIVE window (30min) — NOT
  // the GC floor (60min). The signal means "mtime within LIVE_WINDOW_MS" (the
  // live-requiring definition), so every stale entry (classifyLiveness "stale"
  // = age > LIVE_WINDOW_MS) reports it failed, even while floor-protected from
  // GC. Keying this off GC_WINDOW_MS under-reported the 30-60min stale band
  // (failed_signals=[] on a stale entry) — F1, caught by 3-way cross-audit.
  if (h.ageMs > LIVE_WINDOW_MS) failed.push("mtime-age");
  if (h.owner.host !== currentHost) failed.push("host-match");
  return failed;
}

/**
 * GC-eligibility predicate (Pair-B §3). Eligible iff in the oldest liveness
 * bucket AND past the safety-floor AND not deliberately paused AND not
 * channel-live.
 *
 * Each AND-term can only SUBTRACT eligibility, never add, so a later signal can
 * never make reconcile-boot MORE aggressive:
 *   - pause-marker (Cycle-6 item-4, Alpha cross-pair): a deliberately
 *     `pause-session`'d session is never gc_eligible. `paused` is a SESSION-level
 *     lookup (readSessionPausedAt) computed in enumeratePresence — it protects
 *     ALL of a paused session's candidates across every artifact, not just its
 *     canonical anchor heartbeat (Option X, Delta-concurred).
 *   - channel-live (L1049 slice-1, the alive-anywhere contract): a session with
 *     a FRESH coordination-channel heartbeat is alive — cohort `cli.ts send`
 *     refreshes ONLY the channel store, so a channel-active session's presence
 *     HB reads stale-on-active-sessions yet is NOT dead. `channelLive` is a
 *     SESSION-level lookup (isSidPrefixLiveOnChannel), probed LAZILY (Q2 — the
 *     scan fires only when the cheaper AND-terms pass); without it, `--apply`
 *     deletes a LIVE peer's presence
 *     heartbeat — the data-loss class B#2 fixed for the worktree reaper, applied
 *     here to the presence-GC mutation.
 *   - pid-alive (C1 S2): a same-host `kill(pid, 0)` probe on the session's
 *     RECORDED OS pid (recordSessionOsPid) — a pid-alive session is never GC'd,
 *     CEILING-bounded: the protect fires ONLY while `ageMs <=
 *     PID_PROTECT_CEILING_MS` (gated in the enumeratePresence thunk), so a
 *     reused-pid false-protect cannot leak past the ceiling (degrades to mtime).
 */
function isGcEligible(
  classification: Liveness,
  ageMs: number,
  paused: boolean,
  channelLiveProbe: () => boolean,
  pidProtectProbe: () => boolean,
): boolean {
  // Q2 lazy-compute: channelLiveProbe + pidProtectProbe are THUNKS, invoked only
  // here. The preceding AND-terms (stale && past-window && !paused) short-circuit,
  // so the channel-dir scan + the kill(0) probe run ONLY for a candidate that is
  // otherwise gc-eligible — live/fresh/paused candidates skip both entirely.
  // Semantics-identical to the eager form; subtract-only preserved.
  return (
    classification === "stale" &&
    ageMs > GC_WINDOW_MS &&
    !paused &&
    !channelLiveProbe() &&
    !pidProtectProbe()
  );
}

/**
 * Enumerate + classify every presence heartbeat across all artifacts, AND
 * surface the entries that could not be evaluated. Returns both the candidates
 * (the valid, classified heartbeats) and the malformed-entry errors (corrupt
 * owner records / future-mtime garbage that {@link scanHeartbeats} routes into
 * its `malformed` set) so the report can be honest about its blind spots.
 */
function enumeratePresence(
  now: number,
  currentHost: string,
  isSessionPaused: (sessionId: string) => boolean,
  isSessionOsPidAlive: (sessionId: string) => boolean,
): { candidates: ReconcileBootCandidate[]; errors: ReconcileBootError[] } {
  const out: ReconcileBootCandidate[] = [];
  const errors: ReconcileBootError[] = [];

  // N1 (Bravo #173 nit, folded here since item-4 touches this read path): a
  // malformed artifact dir or unreadable heartbeat listing must not abort the
  // whole enumeration. Isolate the blast radius — an unreadable presence root
  // yields an empty reconcile (safe: nothing enumerated → nothing GC'd), and a
  // single bad artifact is skipped while every other artifact still reconciles.
  let artifactIds: readonly string[];
  try {
    artifactIds = listArtifactIds();
  } catch {
    return { candidates: out, errors };
  }
  for (const artifactId of artifactIds) {
    let scan: HeartbeatScan;
    try {
      scan = scanHeartbeats({ artifactId, now });
    } catch {
      continue;
    }
    // Surface what the walk could not evaluate (corrupt owner / future-mtime).
    // These never become candidates (we can't classify them), but they make
    // `ok` load-bearing → exit 3, so an operator knows the report skipped data.
    for (const m of scan.malformed) {
      errors.push({
        artifact_id: artifactId,
        error_class: "malformed-entry",
        detail: `${m.sessionId}: ${m.reason}`,
      });
    }
    for (const h of scan.valid) {
      const classification = classifyLiveness(h);
      // Compute the session-pause lookup ONCE — it feeds both the gc_eligible
      // AND-term and the operator-visible `paused` field (Cycle-6 item-4).
      const paused = isSessionPaused(h.sessionId);
      // Channel-liveness consult (L1049 slice-1, alive-anywhere contract): a
      // FRESH coordination-channel heartbeat means the session is alive even
      // when its active-sessions HB aged out. reconcile-boot holds the FULL sid
      // → exact-match (no prefix-collision). Subtract-only: it can only PROTECT
      // a presence HB from gc_eligible, never make it eligible. Fail-soft.
      // Q2 lazy-compute: passed as a THUNK so the channel-dir scan fires only
      // when the cheaper AND-terms (stale/window/paused) have already passed.
      out.push({
        artifact_class: "presence",
        artifact_id: artifactId,
        session_id: h.sessionId,
        classification,
        // split-brain is a cross-entry property; computed in a second pass.
        split_brain: false,
        gc_eligible: isGcEligible(
          classification,
          h.ageMs,
          paused,
          () =>
            isSidPrefixLiveOnChannel(
              h.sessionId,
              COORDINATION_CHANNEL_ID,
              now,
              GC_WINDOW_MS,
            ),
          // pid-protect (C1 S2): host-match + ceiling are per-candidate; the
          // recorded-pid kill(0) probe is SESSION-level (memoized in
          // runReconcileBoot). Subtract-only — can only PROTECT, never GC.
          () =>
            h.owner.host === currentHost &&
            h.ageMs <= PID_PROTECT_CEILING_MS &&
            isSessionOsPidAlive(h.sessionId),
        ),
        paused,
        failed_signals: failedSignals(h, currentHost),
        age_ms: h.ageMs,
      });
    }
  }
  return { candidates: out, errors };
}

/**
 * A session's freshest presence liveness — the cross-class basis for
 * classifying identity claims + worktrees, which have no heartbeat of their own.
 */
type SessionLiveness = {
  classification: Liveness;
  age_ms: number;
  failed_signals: ReconcileBootSignal[];
};

/**
 * Map each session_id to its FRESHEST (most-live = min age_ms) presence
 * candidate's liveness. A session is as-live-as its freshest heartbeat — the
 * most-live tiebreak avoids falsely-staling a session that is live on another
 * artifact. Identity/worktree claims inherit their session's entry; a session
 * absent from this map has no presence heartbeat (→ orphan).
 */
function buildSessionLivenessMap(
  presenceCandidates: ReconcileBootCandidate[],
): Map<string, SessionLiveness> {
  const map = new Map<string, SessionLiveness>();
  for (const c of presenceCandidates) {
    const existing = map.get(c.session_id);
    if (existing === undefined || c.age_ms < existing.age_ms) {
      map.set(c.session_id, {
        classification: c.classification,
        age_ms: c.age_ms,
        failed_signals: c.failed_signals,
      });
    }
  }
  return map;
}

/**
 * Enumerate identity sentinels across all channels as REPORT-ONLY candidates.
 * A sentinel has no heartbeat of its own (joined_at is not refreshed → not a
 * liveness signal), so a claim's liveness IS its session's presence liveness
 * (cross-ref {@link buildSessionLivenessMap}). A claim whose session has NO
 * presence heartbeat is NOT automatically an orphan (G2 alive-anywhere): the
 * coordination CHANNEL store is consulted (a coordination-only session is
 * channel-live with zero presence heartbeats) — channel-live → classified
 * `live`, `failed_signals:[]`; otherwise a genuine ORPHAN sentinel, classified
 * `stale`, `failed_signals:["no-presence-heartbeat"]`, with an INFORMATIONAL age
 * (how long the orphan has existed, NOT a liveness age). `gc_eligible` is ALWAYS
 * false — identity GC (unlinkIdentitySentinelOrLogOrphan) is deferred to a later
 * increment, so the channel consult is REPORT-ONLY + subtract-only (it can only
 * downgrade a false orphan to live). N1: a bad channel/listing is skipped, not
 * fatal (blast-radius isolation, mirroring enumeratePresence).
 */
function enumerateIdentity(
  now: number,
  sessionLiveness: Map<string, SessionLiveness>,
  isSessionPaused: (sessionId: string) => boolean,
): ReconcileBootCandidate[] {
  const out: ReconcileBootCandidate[] = [];
  let channels: ReturnType<typeof listChannels>;
  try {
    channels = listChannels();
  } catch {
    return out;
  }
  for (const channel of channels) {
    let claims: ReturnType<typeof listClaims>;
    try {
      claims = listClaims(channel.id);
    } catch {
      continue;
    }
    for (const { claim } of claims) {
      const sessionId = claim.session_id;
      const paused = isSessionPaused(sessionId);
      const live = sessionLiveness.get(sessionId);
      if (live !== undefined) {
        // WITH presence: inherit the session's freshest heartbeat liveness.
        out.push({
          artifact_class: "identity",
          artifact_id: channel.id,
          session_id: sessionId,
          classification: live.classification,
          split_brain: false,
          gc_eligible: false,
          paused,
          failed_signals: live.failed_signals,
          age_ms: live.age_ms,
        });
      } else {
        // No presence heartbeat for this session. G2 alive-anywhere report-fix:
        // a coordination-only session (cohort `cli.ts send` refreshes ONLY the
        // channel store) is channel-LIVE with ZERO presence heartbeats — alive,
        // NOT an orphan. OR-in the coordination channel before declaring an
        // orphan; without it the live cohort captain (presence-absent,
        // coordination-only) is mislabeled a `stale` orphan. The full sid is
        // EFFECTIVELY an exact match here — channel HB filenames ARE the full
        // UUID, so startsWith(fullSid) matches only that one session. Window =
        // LIVE_WINDOW_MS, the "actively coordinating" threshold (matching
        // classifySessionLiveness) — it drives the CLASSIFICATION axis, NOT a
        // GC-protect (enumeratePresence floors at GC_WINDOW_MS, and
        // sessionLivePrefixSource widens reaper windows to it); we deliberately
        // do NOT widen, because a 30-60min-band false-stale here is a cosmetic
        // mis-report, never data loss — gc_eligible stays false either way
        // (identity GC deferred) → REPORT-ONLY + subtract-only: can ONLY
        // downgrade a false orphan to live, never enable a GC. `paused` (computed
        // above) reads the presence anchor — null/false for a coordination-only
        // session, so a paused such session is not detectable as paused here
        // (mirrors the worktree branch). age_ms is the claim's own age
        // (now - joined_at) — INFORMATIONAL, NOT a liveness age; unparseable → 0.
        const channelLive = isSidPrefixLiveOnChannel(
          sessionId,
          COORDINATION_CHANNEL_ID,
          now,
          LIVE_WINDOW_MS,
        );
        const joinedMs = Date.parse(claim.joined_at);
        const orphanAgeMs = Number.isNaN(joinedMs)
          ? 0
          : Math.max(0, now - joinedMs);
        out.push({
          artifact_class: "identity",
          artifact_id: channel.id,
          session_id: sessionId,
          classification: channelLive ? "live" : "stale",
          split_brain: false,
          gc_eligible: false,
          paused,
          failed_signals: channelLive ? [] : ["no-presence-heartbeat"],
          age_ms: orphanAgeMs,
        });
      }
    }
  }
  return out;
}

/**
 * Find the FIRST presence session whose full id starts with `prefix` (the
 * 8-char sid-prefix a worktree path encodes). Worktree paths carry only the
 * prefix — the full UUID is not recoverable from the path — so the cross-ref is
 * a prefix-match, not an exact lookup (the repo-worktree-gc sid-prefix model).
 * First match wins (prefix collisions across live sessions are vanishingly
 * unlikely for an 8-hex-char prefix).
 */
function findSessionByPrefix(
  sessionLiveness: Map<string, SessionLiveness>,
  prefix: string,
): { sessionId: string; live: SessionLiveness } | undefined {
  for (const [sessionId, live] of sessionLiveness) {
    if (sessionId.startsWith(prefix)) return { sessionId, live };
  }
  return undefined;
}

/** A worktree dir's own mtime-age — INFORMATIONAL (how long an orphan worktree
 *  has lingered), NOT a session-liveness age. 0 if the dir vanished mid-walk. */
function worktreeAgeMs(now: number, worktreePath: string): number {
  try {
    return Math.max(0, now - statSync(worktreePath).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * Enumerate per-session worktrees across the auto-provisioned repos as
 * REPORT-ONLY candidates. A worktree has no heartbeat of its own; its path
 * encodes only the 8-char sid-PREFIX, so liveness is cross-ref'd by prefix-match
 * against the presence sessions ({@link findSessionByPrefix}). A worktree with
 * no live presence session for its prefix is NOT automatically an orphan (G2
 * alive-anywhere): the coordination CHANNEL store is consulted by prefix — a
 * coordination-only session is channel-live with no presence heartbeat — so
 * channel-live → `live`, otherwise an ORPHAN (stale + ["no-presence-heartbeat"]),
 * the disk-consuming residue this surfaces. `gc_eligible` is ALWAYS false —
 * worktree GC (removeWorktree) is deferred, so the channel consult is
 * REPORT-ONLY + subtract-only. Fail-soft: readRepoConfig + listWorktrees both
 * return empty/absent on error.
 */
function enumerateWorktree(
  now: number,
  sessionLiveness: Map<string, SessionLiveness>,
  isSessionPaused: (sessionId: string) => boolean,
): ReconcileBootCandidate[] {
  const out: ReconcileBootCandidate[] = [];
  const config = readRepoConfig();
  if (config.kind !== "ok") return out; // absent / malformed → no candidates
  for (const repo of config.repos) {
    if (repo.auto !== true) continue; // only auto-provisioned repos hold worktrees
    for (const wt of listWorktrees(repo.canonical)) {
      const match = findSessionByPrefix(sessionLiveness, wt.sessionId);
      if (match !== undefined) {
        // WITH presence: inherit the matched session's freshest liveness. We now
        // hold the FULL session id, so paused resolves normally.
        out.push({
          artifact_class: "worktree",
          artifact_id: wt.path,
          session_id: match.sessionId,
          classification: match.live.classification,
          split_brain: false,
          gc_eligible: false,
          paused: isSessionPaused(match.sessionId),
          failed_signals: match.live.failed_signals,
          age_ms: match.live.age_ms,
        });
      } else {
        // No live presence session for this prefix (findSessionByPrefix miss).
        // G2 alive-anywhere report-fix: consult the coordination channel by
        // prefix before declaring an orphan — a coordination-only session is
        // channel-LIVE with no presence HB. The path yields ONLY the 8-char
        // prefix (full sid unrecoverable), so this is a prefix-match channel
        // probe and `paused` cannot be resolved (readSessionPausedAt needs the
        // full sid) → false. LIVE_WINDOW_MS (the classification axis, matching
        // classifySessionLiveness), NOT the GC-protect GC_WINDOW_MS and NOT
        // sessionLivePrefixSource's reaper floor — a 30-60min-band false-stale
        // here is a cosmetic mis-report, never data loss, since gc_eligible
        // stays false (worktree GC deferred) → REPORT-ONLY + subtract-only.
        // age_ms is the worktree dir's own age (informational), never a liveness age.
        const channelLive = isSidPrefixLiveOnChannel(
          wt.sessionId,
          COORDINATION_CHANNEL_ID,
          now,
          LIVE_WINDOW_MS,
        );
        out.push({
          artifact_class: "worktree",
          artifact_id: wt.path,
          session_id: wt.sessionId,
          classification: channelLive ? "live" : "stale",
          split_brain: false,
          gc_eligible: false,
          paused: false,
          failed_signals: channelLive ? [] : ["no-presence-heartbeat"],
          age_ms: worktreeAgeMs(now, wt.path),
        });
      }
    }
  }
  return out;
}

/**
 * Mark split-brain: more than one NON-stale (live or likely-dead) claim on the
 * same artifact_id means two sessions believe they hold it. Stale entries don't
 * count — they're the residue split-brain leaves, not the contention itself.
 */
function markSplitBrain(candidates: ReconcileBootCandidate[]): void {
  const nonStaleByArtifact = new Map<string, number>();
  for (const c of candidates) {
    // Split-brain is a PRESENCE property: one coordination artifact should have
    // one live holder. Identity channels legitimately carry MANY claims (the
    // participants), so counting them would falsely flag every multi-participant
    // channel. (Worktree split-brain — two sids on one worktree path — is
    // considered when worktree enumeration lands in 2a-commit-3b.)
    if (c.artifact_class !== "presence") continue;
    if (c.classification !== "stale") {
      nonStaleByArtifact.set(
        c.artifact_id,
        (nonStaleByArtifact.get(c.artifact_id) ?? 0) + 1,
      );
    }
  }
  for (const c of candidates) {
    if (
      c.artifact_class === "presence" &&
      c.classification !== "stale" &&
      (nonStaleByArtifact.get(c.artifact_id) ?? 0) > 1
    ) {
      c.split_brain = true;
    }
  }
}

/**
 * Apply-time CAS re-read for one `gc_eligible` candidate. Re-reads the heartbeat
 * from disk (NOT the enumeration snapshot) and returns the cas-race reason if it
 * is NO LONGER safe to GC, or `null` if the recheck STILL holds (safe to
 * remove). Closes the enumeration→apply TOCTOU: a peer may have touched its
 * heartbeat (→ live / refreshed-under-floor) or `markSessionPaused`'d in the gap.
 */
function casRecheckFlip(
  c: ReconcileBootCandidate,
  now: number,
): ReconcileBootCasRace["reason"] | null {
  const fresh = reReadHeartbeat({
    artifactId: c.artifact_id,
    sessionId: c.session_id,
    now,
  });
  if (fresh === null) return "file-gone"; // gone / unparseable / future-mtime
  // Pause is a PROTECTION independent of liveness — check first.
  if (readSessionPausedAt(c.session_id) != null) return "now-paused";
  // L1049 slice-1 (apply-time half of the alive-anywhere contract): a channel
  // send in the enumeration→apply gap means the session is alive — cohort sends
  // refresh ONLY the channel store. enumeratePresence already excludes
  // channel-live candidates, but one that was channel-stale at enumeration can
  // go channel-live HERE; flip it out of GC (the data-loss-critical TOCTOU
  // guard — without it, `--apply` deletes a peer that just came back).
  if (
    isSidPrefixLiveOnChannel(
      c.session_id,
      COORDINATION_CHANNEL_ID,
      now,
      GC_WINDOW_MS,
    )
  ) {
    return "now-live";
  }
  // pid-protect apply-time mirror (C1 S2 — the A1 "recheck every protecting
  // store at apply-time" contract): a same-host RECORDED pid that probes alive
  // within the ceiling means the session is alive → flip out of GC. Subtract-only
  // (can only protect). Uses the FRESH re-read's host + age, like the channel
  // recheck above. Probed after the cheaper rechecks (same lazy spirit).
  {
    const osPid = readSessionOsPid(c.session_id);
    if (
      fresh.owner.host === hostname() &&
      fresh.ageMs <= PID_PROTECT_CEILING_MS &&
      osPid !== null &&
      isOsPidAlive(osPid)
    ) {
      return "pid-alive";
    }
  }
  // A touch since enumeration flips it out of the stale bucket ...
  if (classifyLiveness(fresh) !== "stale") return "now-live";
  // ... or refreshes it back under the GC floor (still stale, but no longer
  // past the safety floor — so no longer gc_eligible).
  if (fresh.ageMs <= GC_WINDOW_MS) return "mtime-refreshed";
  return null; // still stale, still past the floor, still not paused → GC
}

/**
 * The `--apply` GC pass — the ONLY path in reconcile-boot that deletes state.
 * For each `gc_eligible` PRESENCE candidate that is NOT split-brain, CAS-recheck
 * at apply-time and remove only if the recheck holds.
 *
 * NEVER-auto-kill — FOUR independent guards: operator-explicit `--apply`;
 * presence-only + `gc_eligible`-only (already stale && age>floor && !paused);
 * the `!split_brain` DiD (split-brain needs operator resolution, not auto-GC);
 * and the CAS-recheck closing the enumeration→apply TOCTOU. A recheck-flip → a
 * HEALTHY skip into `cas_races` (exit/ok-neutral). A real unlink failure →
 * `errors`{gc-failed}; a benign already-gone ("absent") is not surfaced.
 *
 * Exported for direct safety-testing: the CAS-recheck FLIP cases (now-live /
 * now-paused / file-gone / mtime-refreshed) require the disk to differ from the
 * enumeration snapshot, which cannot happen within a single runReconcileBoot
 * call (one `now`, one disk read) — so they are exercised by constructing a
 * candidate + a controlled on-disk heartbeat and calling this directly.
 */
export function applyGc(
  candidates: ReconcileBootCandidate[],
  now: number,
): { cas_races: ReconcileBootCasRace[]; errors: ReconcileBootError[] } {
  const cas_races: ReconcileBootCasRace[] = [];
  const errors: ReconcileBootError[] = [];
  for (const c of candidates) {
    if (c.artifact_class !== "presence" || !c.gc_eligible || c.split_brain) {
      continue;
    }
    const flip = casRecheckFlip(c, now);
    if (flip !== null) {
      cas_races.push({
        artifact_id: c.artifact_id,
        session_id: c.session_id,
        reason: flip,
      });
      continue;
    }
    const outcome = removeOwnHeartbeat(c.artifact_id, c.session_id, {
      reason: "reconcile-gc",
      actorPid: process.pid,
    });
    if (outcome === "failed") {
      errors.push({
        artifact_id: c.artifact_id,
        error_class: "gc-failed",
        detail: `${c.session_id}: heartbeat unlink failed`,
      });
    }
    // "removed" → success; "absent" → benign final-gap (vanished post-recheck).
  }
  return { cas_races, errors };
}

/**
 * Boot reconciliation entry point. Report-mode by default; `--apply` (2b) runs
 * the CAS-recheck GC pass — the ONLY state-deleting path. Presence is ALWAYS
 * enumerated — both its own output (when in scope) AND the cross-ref basis for
 * identity/worktree liveness (a claim/worktree has no heartbeat of its own).
 * identity + worktree are report-only (never `--apply`-GC'd — presence-only).
 */
export function runReconcileBoot(
  opts: ReconcileBootOptions,
): ReconcileBootOutput {
  const { now } = opts;
  const scope = opts.scope ?? "all";
  const currentHost = hostname();

  // Session-level pause lookup, memoized ONCE across ALL classes. Pause is
  // session-state (markSessionPaused writes pausedAt on the canonical-claude-
  // home ANCHOR heartbeat, not per-artifact), and a session may surface in
  // presence AND identity AND worktree — so one shared memo protects every one
  // of its candidates with a single anchor read. readSessionPausedAt is
  // defensive (never throws → null), so the lookup needs no guard of its own.
  const pausedMemo = new Map<string, boolean>();
  const isSessionPaused = (sessionId: string): boolean => {
    const cached = pausedMemo.get(sessionId);
    if (cached !== undefined) return cached;
    const paused = readSessionPausedAt(sessionId) != null;
    pausedMemo.set(sessionId, paused);
    return paused;
  };

  // Session-level OS-pid liveness, memoized like the pause lookup (C1 S2). The
  // recorded harness pid lives on the canonical anchor (recordSessionOsPid), so
  // one read + one kill(0) probe per session covers all its candidates. Absent
  // pid (legacy / flag-off record) or a dead pid → false → no protect (degrades
  // to mtime). The host-match + ceiling gate is applied per-candidate in the
  // enumeratePresence thunk; this memo answers only "is the recorded pid alive?".
  const osPidAliveMemo = new Map<string, boolean>();
  const isSessionOsPidAlive = (sessionId: string): boolean => {
    const cached = osPidAliveMemo.get(sessionId);
    if (cached !== undefined) return cached;
    const pid = readSessionOsPid(sessionId);
    const alive = pid !== null && isOsPidAlive(pid);
    osPidAliveMemo.set(sessionId, alive);
    return alive;
  };

  // Presence is enumerated UNCONDITIONALLY: identity/worktree classification
  // cross-refs each session's presence liveness (buildSessionLivenessMap), so
  // the presence pass must run even when only identity/worktree are in scope.
  // Its candidates/errors are OUTPUT only when presence is in scope.
  const presence = enumeratePresence(
    now,
    currentHost,
    isSessionPaused,
    isSessionOsPidAlive,
  );
  const sessionLiveness = buildSessionLivenessMap(presence.candidates);

  const candidates: ReconcileBootCandidate[] = [];
  const errors: ReconcileBootError[] = [];
  if (scope === "all" || scope === "presence") {
    candidates.push(...presence.candidates);
    errors.push(...presence.errors);
  }
  if (scope === "all" || scope === "identity") {
    candidates.push(
      ...enumerateIdentity(now, sessionLiveness, isSessionPaused),
    );
  }
  if (scope === "all" || scope === "worktree") {
    candidates.push(
      ...enumerateWorktree(now, sessionLiveness, isSessionPaused),
    );
  }
  // N1 reminder: the session-start HOOK integration MUST wrap runReconcileBoot
  // in try/catch — listArtifactIds/scanHeartbeats/listChannels can throw at the
  // fs level (malformed *entries* are surfaced as errors[]; an fs-level throw of
  // a whole listing is a different class). A hook throwing at session-start is
  // worse than a CLI exit, which this report-only caller tolerates.

  markSplitBrain(candidates);

  // `--apply` GC — the ONLY state-deleting path. Runs AFTER markSplitBrain so
  // the `!split_brain` DiD sees the computed flag. Report-mode (no `--apply`)
  // skips it entirely: cas_races empty, applied false. Presence-only,
  // gc_eligible-only, CAS-rechecked at apply-time (NEVER-auto-kill).
  const cas_races: ReconcileBootCasRace[] = [];
  let applied = false;
  if (opts.apply === true) {
    const gc = applyGc(candidates, now);
    cas_races.push(...gc.cas_races);
    errors.push(...gc.errors);
    applied = true;
  }

  return {
    // Load-bearing (§3 #174 F2/F3 + 2b gc-failed): `ok` only if the report could
    // read everything it found AND every attempted GC succeeded. A
    // malformed-entry → exit 3; a gc-failed → exit 1. cas_races are HEALTHY
    // recheck-skips → exit/ok-NEUTRAL (never flip `ok`).
    ok: errors.length === 0,
    total_enumerated: candidates.length,
    live_count: candidates.filter((c) => c.classification === "live").length,
    likely_dead_count: candidates.filter(
      (c) => c.classification === "likely-dead",
    ).length,
    stale_count: candidates.filter((c) => c.classification === "stale").length,
    split_brain_count: candidates.filter((c) => c.split_brain).length,
    // Snapshot count of what WAS gc_eligible at enumeration (the candidates array
    // is the enumeration snapshot; --apply does not mutate it). The CLI derives
    // "gc_eligible_remaining" for exit 2 from this minus what --apply removed
    // (i.e. minus cas_races minus gc-failed).
    gc_eligible_count: candidates.filter((c) => c.gc_eligible).length,
    applied,
    candidates,
    errors,
    cas_races,
  };
}
