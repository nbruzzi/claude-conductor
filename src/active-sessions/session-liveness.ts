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

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  GC_WINDOW_MS,
  LIKELY_DEAD_MS,
  LIVE_WINDOW_MS,
  artifactIdFromPath,
  canonicalClaudeHomeArtifactId,
  heartbeatPath,
  isSessionLiveByPrefix,
  listAllHeartbeats,
  listArtifactIds,
  readSessionPausedAt,
  scanHeartbeats,
  type HeartbeatListing,
  type Liveness,
} from "./index.ts";
import {
  COORDINATION_CHANNEL_ID,
  isSidPrefixLiveOnChannel,
} from "../channels/index.ts";
import { isOsPidAlive } from "../shared/os-pid.ts";
import { isSidPrefixWorktreeId } from "../worktrees/index.ts";

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

// ─── Worktree-path attachment liveness (SPAWN-3) ───────────────────

/**
 * The three-valued verdict of {@link isWorktreePathLive}. Three-valued ON
 * PURPOSE (cohort-ratified Decision 5, board 2026-06-10): `indeterminate` is
 * DISTINCT from `not-live` because the reap callers must treat unverifiable
 * as NOT reapable — collapsing the two would launder "I could not check" into
 * "nobody is there", the exact fail-direction class that produced four
 * live-reap incidents (G6-P2 troubles log; `decisions/phase-3.md` G6-P2 F1(b)).
 */
export type WorktreePathLiveness =
  | {
      verdict: "live";
      source: "pidfile-cwd" | "sentinel-dotfilesroot" | "sid-prefix-store";
      detail: string;
    }
  | { verdict: "not-live" }
  | { verdict: "indeterminate"; reason: string };

/**
 * Is a session ATTACHED to the worktree at `worktreePath`? The path-keyed
 * member of this module's liveness family (SPAWN-3) — the machine-liveness
 * gate G6-P2 deferred, consumed by the named-worktree reap surfaces
 * (`worktrees/liveness.ts` gated enumerator + the dotfiles apply script).
 *
 * TIER-APPLICABILITY MATRIX (be honest about which tier can fire for which
 * worktree class — over-claiming machine coverage is how live-reaps happen):
 *
 *   - AUTO-provisioned sid-prefix worktree (`<canonical>-<sid8>`):
 *     T3 sid-prefix (the OR-composed stores) + T2 sentinel (the provisioner
 *     pins `dotfilesRoot` on the anchor heartbeat). Strong coverage.
 *   - Session LAUNCHED INSIDE any worktree: T1 pidfile-cwd. Precise.
 *   - MANUAL named worktree (`<canonical>-<nato>-<slug>`) worked from a
 *     home-launched session (the cohort pattern): NO live tier can fire —
 *     heartbeats fold to the CANONICAL artifact (`artifactIdFromPath` RE-1
 *     canonicalization via `--git-common-dir`), the pidfile cwd is the launch
 *     dir, there is no sentinel, and the slug is not a sid. For this class
 *     machine-liveness degrades to the deep-activity probe
 *     (`worktrees/liveness.ts`) + the HUMAN slug-confirm, which therefore
 *     remains LOAD-BEARING, not redundant (G6-P2 F1(b)).
 *
 * Store classification (liveness-gate-store-contract): T1 reads the harness
 * pidfile store (`~/.claude/sessions/<pid>.json` — cwd + pid ONLY, never the
 * `status` field: CG6 keeps harness-STATUS observe-only, off reaper gates);
 * T2 reads the active-sessions store via {@link scanHeartbeats} (an
 * enumeration read INSIDE the liveness module — the contract's sanctioned
 * home); T3 routes through {@link sessionLivePrefixSource} (the canonical
 * OR-composer over BOTH stores). Subtract-only-protect: a verdict here can
 * only PREVENT a reap, never enable one (mirrors the C1-S2 pid-protect lane).
 *
 * T1 is deliberately UN-ceilinged (a live pid counts regardless of pidfile
 * mtime age), unlike reconcile-boot's `PID_PROTECT_CEILING_MS`: that ceiling
 * bounds a recycled-pid false-protect on a state-DELETING path, where the
 * cost of over-protecting forever is unreclaimable state. Here the cost is a
 * worktree lingering one more human review — benign-linger, so the simpler
 * unbounded protect wins.
 *
 * Error discipline (the scanHeartbeats-consumer hardening flagged at review):
 * per-tier AND per-entry catch-continue; a malformed-but-FRESH entry on a
 * PLAUSIBLE-attribution artifact routes to `indeterminate`, never to
 * "not-live" — but indeterminate contributions are SCOPED to the anchor
 * (`canonicalClaudeHomeArtifactId`) + the candidate repo-family artifact
 * (`artifactIdFromPath(dotfilesCanonical)`) so a single poison file in an
 * UNRELATED repo's artifact cannot vacuous-block every reap globally. STALE
 * malformed entries are residue and are ignored. LIVE evidence is accepted
 * from ANY artifact (over-protecting on a real signal is the safe direction).
 *
 * All signals are LOCAL (fs + same-host pid probe) — the G6-P2 network-free
 * constraint holds.
 */
export function isWorktreePathLive(
  worktreePath: string,
  now: number,
  windowMs: number = GC_WINDOW_MS,
  opts?: {
    /** Enables T3 (sid-prefix tail strip) + scopes T2's indeterminate set. */
    dotfilesCanonical?: string;
    /** Test seam — harness pidfile dir (default `$HOME/.claude/sessions`). */
    sessionsDir?: string;
  },
): WorktreePathLiveness {
  // RE-5: realpath the candidate ONCE; an unresolvable target is UNVERIFIABLE
  // (deleted mid-scan, permission, dangling symlink) → indeterminate, never a
  // silent no-match that would read as not-live.
  const realTarget = tryRealpath(worktreePath);
  if (realTarget === null) {
    return {
      verdict: "indeterminate",
      reason: `realpath failed for ${worktreePath} — target unverifiable`,
    };
  }

  const indeterminate: string[] = [];

  const t1 = pidfileCwdTier(realTarget, now, windowMs, indeterminate, opts);
  if (t1 !== null) return t1;

  const t2 = sentinelDotfilesRootTier(
    realTarget,
    now,
    windowMs,
    indeterminate,
    opts,
  );
  if (t2 !== null) return t2;

  const t3 = sidPrefixTailTier(realTarget, now, windowMs, indeterminate, opts);
  if (t3 !== null) return t3;

  if (indeterminate.length > 0) {
    return { verdict: "indeterminate", reason: indeterminate.join("; ") };
  }
  return { verdict: "not-live" };
}

/**
 * T1 — harness eager-pidfile cwd attribution. The `~/.claude/sessions/` dir
 * holds TWO unrelated file shapes (verified empirically, 2026-06-10): the
 * harness `<pid>.json` pidfiles ({pid, sessionId, cwd, ...}) AND the
 * session-telemetry `<uuid>.json` files ({session_id, entries_touched, ...})
 * — a FOREIGN artifact that merely shares the directory. The filename gate
 * below (`/^\d+\.json$/`) is LOAD-BEARING: without it the ~15:1 telemetry
 * majority would parse as "unparseable pidfiles" and vacuous-block every
 * verdict into indeterminate (design-audit RE-1).
 */
function pidfileCwdTier(
  realTarget: string,
  now: number,
  windowMs: number,
  indeterminate: string[],
  opts?: { sessionsDir?: string },
): WorktreePathLiveness | null {
  const dir =
    opts?.sessionsDir ??
    join(process.env["HOME"] ?? homedir(), ".claude", "sessions");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Absent/unreadable pidfile dir is a clean no-evidence state (fresh
    // machine, harness too old to write pidfiles) — NOT indeterminate: the
    // tier has nothing it failed to evaluate.
    return null;
  }
  for (const entry of entries) {
    const m = /^(\d+)\.json$/.exec(entry);
    if (m === null || m[1] === undefined) continue; // foreign <uuid>.json telemetry — not this population
    const pidFromName = Number.parseInt(m[1], 10);
    if (!Number.isFinite(pidFromName) || pidFromName <= 0) continue;
    const path = join(dir, entry);
    const rec = readPidfileCwd(path);
    if (rec === null) {
      // Unparseable <pid>.json: meaningful ONLY when fresh AND the
      // filename-pid is alive — a live session whose cwd we cannot read could
      // be attached HERE. Dead-pid or stale files are residue; a vanished
      // file is a benign race.
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      // No `age >= 0` lower bound: a future-dated mtime (just-written race,
      // clock skew, sync restore) is fresh-or-suspicious — both route to the
      // protective direction, never to "residue".
      if (now - mtimeMs < windowMs && isOsPidAlive(pidFromName)) {
        indeterminate.push(
          `unparseable pidfile ${entry} with alive pid ${String(pidFromName)} (cwd unknowable)`,
        );
      }
      continue;
    }
    const realCwd = tryRealpath(rec.cwd);
    if (realCwd === null) continue; // recorded cwd no longer resolves — cannot be attached there
    if (realCwd !== realTarget && !realCwd.startsWith(`${realTarget}/`)) {
      continue;
    }
    if (!isOsPidAlive(rec.pid)) continue; // dead session — pidfile residue
    return {
      verdict: "live",
      source: "pidfile-cwd",
      detail: `live pid ${String(rec.pid)} (${entry}) launched with cwd inside ${realTarget}`,
    };
  }
  return null;
}

/** Parse the two T1-load-bearing fields of a harness pidfile; null = unparseable. */
function readPidfileCwd(path: string): { pid: number; cwd: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const pid = obj["pid"];
    const cwd = obj["cwd"];
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    return { pid, cwd };
  } catch {
    return null;
  }
}

/**
 * T2 — anchor-sentinel attribution: a FRESH heartbeat whose
 * `owner.dotfilesRoot` realpath-matches the candidate proves the provisioned
 * owner is alive. LIVE evidence accepted from ANY artifact; indeterminate
 * contributions SCOPED to the plausible-attribution artifacts (anchor +
 * candidate repo family) — see the module JSDoc's blast-radius rationale.
 */
function sentinelDotfilesRootTier(
  realTarget: string,
  now: number,
  windowMs: number,
  indeterminate: string[],
  opts?: { dotfilesCanonical?: string },
): WorktreePathLiveness | null {
  let artifactIds: readonly string[];
  try {
    artifactIds = listArtifactIds();
  } catch {
    indeterminate.push("active-sessions registry unreadable (sentinel tier)");
    return null;
  }

  const plausible = new Set<string>();
  try {
    plausible.add(canonicalClaudeHomeArtifactId());
  } catch {
    indeterminate.push("anchor artifact id underivable (sentinel tier)");
  }
  if (opts?.dotfilesCanonical !== undefined) {
    try {
      plausible.add(artifactIdFromPath(opts.dotfilesCanonical));
    } catch {
      indeterminate.push("repo-family artifact id underivable (sentinel tier)");
    }
  }

  for (const artifactId of artifactIds) {
    let scan: ReturnType<typeof scanHeartbeats>;
    try {
      scan = scanHeartbeats({ artifactId, now });
    } catch (err: unknown) {
      if (plausible.has(artifactId)) {
        const msg = err instanceof Error ? err.message : String(err);
        indeterminate.push(`heartbeat scan failed on ${artifactId}: ${msg}`);
      }
      continue;
    }
    for (const h of scan.valid) {
      const root = h.owner.dotfilesRoot;
      if (root === undefined || root.length === 0) continue;
      if (h.ageMs >= windowMs) continue;
      // Read-side realpath with resolve() fallback — mirrors the
      // dotfiles-worktree-gc `mapByDotfilesRoot` L588 symmetric-realpath fix.
      const realRoot = tryRealpath(root) ?? resolve(root);
      if (realRoot !== realTarget) continue;
      return {
        verdict: "live",
        source: "sentinel-dotfilesroot",
        detail: `session ${h.sessionId} holds a fresh dotfilesRoot sentinel (artifact ${artifactId}, age ${String(Math.round(h.ageMs / 1000))}s)`,
      };
    }
    if (!plausible.has(artifactId)) continue;
    for (const mal of scan.malformed) {
      if (mal.reason === "future-mtime") {
        // Future-dated garbage is fresh-by-construction (clock skew) — the
        // exact corruption class CLOCK_SKEW_TOLERANCE_MS exists for.
        indeterminate.push(
          `future-mtime heartbeat ${artifactId}/${mal.sessionId}`,
        );
        continue;
      }
      let mtimeMs: number;
      try {
        mtimeMs = statSync(heartbeatPath(artifactId, mal.sessionId)).mtimeMs;
      } catch {
        continue; // vanished mid-walk — benign race
      }
      // No lower bound (see the pidfile-tier note): future-dated corruption
      // is at least as suspicious as fresh corruption.
      if (now - mtimeMs < windowMs) {
        indeterminate.push(
          `fresh malformed heartbeat ${artifactId}/${mal.sessionId} (${mal.reason})`,
        );
      }
    }
  }
  return null;
}

/**
 * T3 — sid-prefix tail attribution through the canonical OR-composer. Only
 * meaningful when the caller supplies the canonical (the tail is `path` minus
 * `${realpath(canonical)}-`; a slug can contain dashes, so basename parsing
 * cannot substitute). Named-reap callers exclude sid-prefix worktrees
 * upstream; this tier makes the helper TOTAL over any worktree path.
 */
function sidPrefixTailTier(
  realTarget: string,
  now: number,
  windowMs: number,
  indeterminate: string[],
  opts?: { dotfilesCanonical?: string },
): WorktreePathLiveness | null {
  if (opts?.dotfilesCanonical === undefined) return null;
  const realCanonical = tryRealpath(opts.dotfilesCanonical);
  if (realCanonical === null) {
    indeterminate.push(
      "canonical realpath failed (sid-prefix tier unverifiable)",
    );
    return null;
  }
  const prefix = `${realCanonical}-`;
  if (!realTarget.startsWith(prefix)) return null;
  const tail = realTarget.slice(prefix.length);
  if (!isSidPrefixWorktreeId(tail)) return null;
  const store = sessionLivePrefixSource(tail, now, windowMs);
  if (store === null) return null;
  return {
    verdict: "live",
    source: "sid-prefix-store",
    detail: `sid-prefix ${tail} live in the ${store} store`,
  };
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
