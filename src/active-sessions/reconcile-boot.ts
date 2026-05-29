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

import { hostname } from "node:os";
import {
  GC_WINDOW_MS,
  LIVE_WINDOW_MS,
  classifyLiveness,
  listArtifactIds,
  readSessionPausedAt,
  scanHeartbeats,
  type HeartbeatListing,
  type HeartbeatScan,
  type Liveness,
} from "./index.ts";
import { listChannels } from "../channels/index.ts";
import { listClaims } from "../channels/identity.ts";

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
 * `pid-alive` is RESERVED forward-compat (Pair-B §10 Q2): a same-host
 * `kill(pid, 0)` probe that can only ever force `gc_eligible = false` (a safety
 * blocker for a paused-but-alive peer), never enable a GC. The probe is a
 * follow-up enhancement; it is NOT implemented this slice, so `failed_signals`
 * never lists `pid-alive` yet.
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
  error_class: "gc-failed" | "malformed-entry" | "cas-race";
  detail: string;
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
};

export type ReconcileBootOptions = {
  now: number;
  /**
   * Reserved for the next increment's `--apply` GC. UNREAD this increment:
   * runReconcileBoot is report-only and always returns `applied: false`, so
   * passing `apply: true` is a silent no-op until the GC path lands (N2). The
   * field is forward-declared so the CLI verb's flag surface is stable now.
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
 * bucket AND past the safety-floor AND not deliberately paused.
 *
 * Each AND-term can only SUBTRACT eligibility, never add, so a later signal can
 * never make reconcile-boot MORE aggressive:
 *   - pause-marker (Cycle-6 item-4, Alpha cross-pair): a deliberately
 *     `pause-session`'d session is never gc_eligible. `paused` is a SESSION-level
 *     lookup (readSessionPausedAt) computed in enumeratePresence — it protects
 *     ALL of a paused session's candidates across every artifact, not just its
 *     canonical anchor heartbeat (Option X, Delta-concurred).
 *   - pid-alive (§10 Q2, reserved): a same-host `kill(pid, 0)` probe — a
 *     paused-but-alive process is never GC'd. Deferred; not this slice.
 */
function isGcEligible(
  classification: Liveness,
  ageMs: number,
  paused: boolean,
): boolean {
  return classification === "stale" && ageMs > GC_WINDOW_MS && !paused;
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
      out.push({
        artifact_class: "presence",
        artifact_id: artifactId,
        session_id: h.sessionId,
        classification,
        // split-brain is a cross-entry property; computed in a second pass.
        split_brain: false,
        gc_eligible: isGcEligible(classification, h.ageMs, paused),
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
 * (cross-ref {@link buildSessionLivenessMap}). A claim whose session left NO
 * presence heartbeat is an ORPHAN sentinel — the meaningful signal this
 * surfaces: classified `stale`, `failed_signals:["no-presence-heartbeat"]`, and
 * an INFORMATIONAL age (how long the orphan has existed, NOT a liveness age).
 * `gc_eligible` is ALWAYS false — identity GC (unlinkIdentitySentinelOrLogOrphan)
 * is deferred to a later increment. N1: a bad channel/listing is skipped, not
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
        // ORPHAN: the session left no presence heartbeat. age_ms is the claim's
        // own age (now - joined_at) — INFORMATIONAL (how long the orphan has
        // lingered), NOT a session-liveness age. Unparseable joined_at → 0.
        const joinedMs = Date.parse(claim.joined_at);
        const orphanAgeMs = Number.isNaN(joinedMs)
          ? 0
          : Math.max(0, now - joinedMs);
        out.push({
          artifact_class: "identity",
          artifact_id: channel.id,
          session_id: sessionId,
          classification: "stale",
          split_brain: false,
          gc_eligible: false,
          paused,
          failed_signals: ["no-presence-heartbeat"],
          age_ms: orphanAgeMs,
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
 * Boot reconciliation entry point. Report-mode by default (the `--apply` GC
 * mutation is PR 2b). Presence is ALWAYS enumerated — it is both its own output
 * (when in scope) AND the cross-ref basis for identity/worktree liveness (a
 * claim/worktree has no heartbeat of its own). identity + worktree are
 * report-only candidates (never `--apply`-GC'd this increment).
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

  // Presence is enumerated UNCONDITIONALLY: identity/worktree classification
  // cross-refs each session's presence liveness (buildSessionLivenessMap), so
  // the presence pass must run even when only identity/worktree are in scope.
  // Its candidates/errors are OUTPUT only when presence is in scope.
  const presence = enumeratePresence(now, currentHost, isSessionPaused);
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
  // worktree report-only enumeration: 2a-commit-3b (next).
  // N1 reminder: the session-start HOOK integration MUST wrap runReconcileBoot
  // in try/catch — listArtifactIds/scanHeartbeats/listChannels can throw at the
  // fs level (malformed *entries* are surfaced as errors[]; an fs-level throw of
  // a whole listing is a different class). A hook throwing at session-start is
  // worse than a CLI exit, which this report-only caller tolerates.

  markSplitBrain(candidates);

  return {
    // Load-bearing (§3, #174 F2/F3): the report is `ok` only if it could read
    // everything it found. A surfaced malformed-entry → ok=false → exit 3.
    ok: errors.length === 0,
    total_enumerated: candidates.length,
    live_count: candidates.filter((c) => c.classification === "live").length,
    likely_dead_count: candidates.filter(
      (c) => c.classification === "likely-dead",
    ).length,
    stale_count: candidates.filter((c) => c.classification === "stale").length,
    split_brain_count: candidates.filter((c) => c.split_brain).length,
    gc_eligible_count: candidates.filter((c) => c.gc_eligible).length,
    // `--apply` GC is the next increment; report-mode never sets applied.
    applied: false,
    candidates,
    errors,
  };
}
