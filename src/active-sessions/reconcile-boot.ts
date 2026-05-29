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

/** Which substrate class a candidate belongs to. Presence is fully enumerated
 *  this slice; identity + worktree are report-only (enumeration deepens next
 *  increment per Pair-B §10 Q4). */
export type ReconcileBootArtifactClass = "presence" | "identity" | "worktree";

/**
 * The three liveness signals that "live" requires (active-sessions/index.ts
 * §"Liveness of a heartbeat requires all three"): mtime within the live window,
 * a parseable OwnerRecord body (anti-ghost), and a host match.
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
): { candidates: ReconcileBootCandidate[]; errors: ReconcileBootError[] } {
  const out: ReconcileBootCandidate[] = [];
  const errors: ReconcileBootError[] = [];

  // Session-level pause lookup, memoized (Cycle-6 item-4, Option X). `pausedAt`
  // is written on the session's canonical-claude-home ANCHOR heartbeat
  // (markSessionPaused), NOT per-artifact — so one anchor read protects every
  // one of a paused session's candidates across all artifacts. Memoize per
  // sessionId: a session typically holds heartbeats on several artifacts and
  // the anchor read is identical for each. readSessionPausedAt is defensive
  // (never throws — readOwnerRecord swallows parse/IO errors → null), so the
  // lookup needs no guard of its own.
  const pausedMemo = new Map<string, boolean>();
  const isSessionPaused = (sessionId: string): boolean => {
    const cached = pausedMemo.get(sessionId);
    if (cached !== undefined) return cached;
    const paused = readSessionPausedAt(sessionId) != null;
    pausedMemo.set(sessionId, paused);
    return paused;
  };

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
 * Mark split-brain: more than one NON-stale (live or likely-dead) claim on the
 * same artifact_id means two sessions believe they hold it. Stale entries don't
 * count — they're the residue split-brain leaves, not the contention itself.
 */
function markSplitBrain(candidates: ReconcileBootCandidate[]): void {
  const nonStaleByArtifact = new Map<string, number>();
  for (const c of candidates) {
    if (c.classification !== "stale") {
      nonStaleByArtifact.set(
        c.artifact_id,
        (nonStaleByArtifact.get(c.artifact_id) ?? 0) + 1,
      );
    }
  }
  for (const c of candidates) {
    if (
      c.classification !== "stale" &&
      (nonStaleByArtifact.get(c.artifact_id) ?? 0) > 1
    ) {
      c.split_brain = true;
    }
  }
}

/**
 * Boot reconciliation entry point. Report-mode by default. `--apply` GC + the
 * identity/worktree report-only enumeration land in the next increment (§10
 * Q4); this pass enumerates the presence class fully and lands the report
 * contract that the CLI verb + subprocess tests assert against.
 */
export function runReconcileBoot(
  opts: ReconcileBootOptions,
): ReconcileBootOutput {
  const { now } = opts;
  const scope = opts.scope ?? "all";
  const currentHost = hostname();

  const candidates: ReconcileBootCandidate[] = [];
  const errors: ReconcileBootError[] = [];
  if (scope === "all" || scope === "presence") {
    const presence = enumeratePresence(now, currentHost);
    candidates.push(...presence.candidates);
    errors.push(...presence.errors);
  }
  // identity + worktree enumeration: report-only, next increment (§10 Q4).
  // TODO(increment-2, N1): listArtifactIds / scanHeartbeats can throw on a
  // filesystem-level error (malformed *entries* are now surfaced as
  // errors[]{malformed-entry}, distinct from an fs-level throw of the whole
  // walk). Acceptable for this report-only CLI caller (an uncaught throw → CLI
  // exit), but the session-start HOOK integration MUST wrap enumeration in
  // try/catch — a hook throwing at session-start is worse than a CLI exit.

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
