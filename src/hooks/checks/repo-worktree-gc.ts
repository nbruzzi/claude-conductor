// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Generic repo-worktree-gc session-start orphan reaper.
 *
 * Slice 3 of Stream 3 generic-worktree-provisioner per RFC v0.2 at
 * ~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md.
 *
 * Mirrors dotfiles-worktree-gc shape but parameterized across all
 * opted-in repos from `~/.claude/worktree-provisioner.json` (Slice 2 config).
 * Each opted-in repo with `gc !== false` gets its own per-repo cursor
 * file + sweep.
 *
 * Staleness model — different from dotfiles:
 *
 *   Dotfiles GC reverse-maps worktree-path → sessionId via the
 *   `dotfilesRoot` field on the canonical-claude-home anchor heartbeat,
 *   then ages by that anchor's `ageMs`. With anchor + ageMs map present,
 *   a missing-anchor-record OR a stale-anchor-age both trigger reap;
 *   the sid-prefix-liveness-fallback is defense-in-depth against
 *   raw-vs-realpath drift in the sentinel.
 *
 *   Generic-repo GC has NO per-repo anchor sentinel (deferred to Slice 3+
 *   when per-repo anchors materialize per RFC v0.2 §Q4 disposition). So
 *   we PROMOTE the sid-prefix-liveness check from defense-in-depth to
 *   primary staleness signal: for each worktree, extract sid-prefix from
 *   the path tail (after `<canonical>-`) and check `listAllHeartbeats`
 *   across ALL artifact-ids for any heartbeat matching that sid-prefix
 *   with `ageMs < GC_WINDOW_MS`. If ANY live heartbeat shares the
 *   sid-prefix → worktree is live → skip reap. Otherwise → stale → reap.
 *
 *   Per-repo `cleanupAfterIdleHours` overrides the default
 *   `GC_WINDOW_MS_DEFAULT=60min` per FOLD-ARCH-3 precedence ratification.
 *
 * Safety guards mirror dotfiles-worktree-gc:
 *   - `.git/index.lock` mtime < 1hr → skip (mid-checkout/commit)
 *   - `node_modules/.bun-tmp-*` mtime < 5min → skip (mid-install)
 *   - `~/.claude/session-state-forensic/<sid-prefix>` exists → skip
 *
 * Per-repo cursor: `~/.claude/logs/.repo-worktree-gc-cursor.<repoName>`
 * (5-min rate gate per repo). Per-repo independence keeps the rate-gate
 * from blocking other repos if one repo's sweep ran recently.
 *
 * Self-heal: no per-repo unregisterActiveSession/clearSentinel writes
 * (Slice 3+ when per-repo anchors materialize). Post-reap reconciliation
 * guard still fires — if reap succeeded but path still exists, log
 * incomplete; otherwise log reaped breadcrumb.
 *
 * Plan: ~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md
 * §v0.2 Slice 3.
 */

import {
  existsSync,
  mkdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { sessionLivePrefixSource } from "../../active-sessions/session-liveness.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { effectiveHome } from "../../shared/home.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import {
  formatNamedWorktreeReapCandidate,
  isNamedWorktreeReapReportEnabled,
  isSidPrefixWorktreeId,
  listWorktrees,
  NAMED_WORKTREE_STALE_FLOOR_MS,
  removeWorktree,
} from "../../worktrees/index.ts";
import { gatedNamedWorktreeReapCandidates } from "../../worktrees/liveness.ts";
import {
  readRepoConfig,
  type RepoConfigEntry,
} from "../../worktrees/repo-config.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass } from "../types.ts";

const SOURCE = "repo-worktree-gc";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";

/** Rate-gate interval — 5 minutes between sweeps per repo. Mirrors the
 *  dotfiles-worktree-gc cadence. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Default staleness threshold: 60min — mirrors dotfiles GC_WINDOW_MS.
 *  Per-repo `cleanupAfterIdleHours` overrides this per FOLD-ARCH-3
 *  precedence ratification. */
const GC_WINDOW_MS_DEFAULT = 60 * 60 * 1000;

/** Safety-guard mtime gates — mirror dotfiles GC. */
const INDEX_LOCK_FRESH_MS = 60 * 60 * 1000;
const BUN_TMP_FRESH_MS = 5 * 60 * 1000;

const FORENSIC_MARKER_DIR_NAME = "session-state-forensic";
const CURSOR_FILE_PREFIX = ".repo-worktree-gc-cursor.";

export async function check(input: HookInput): Promise<HookResult> {
  let sessionId: string | null = null;
  try {
    sessionId = resolveSessionIdOrNull(input);
    if (process.env[FEATURE_FLAG_ENV] !== "1") return pass();

    const configResult = readRepoConfig();
    if (configResult.kind !== "ok") return pass();
    if (configResult.repos.length === 0) return pass();

    const now = getWallClockNow();

    for (const repo of configResult.repos) {
      if (repo.gc === false) continue;
      if (repo.auto !== true) continue; // gc only the auto-provisioned set
      reapRepo({ repo, sessionId, now });
    }

    return pass();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "dispatcher",
      kind: "worktree-cleanup-failed",
      artifactPath: null,
      detail,
    });
    return pass();
  }
}

/** Sweep one repo's worktrees. Per-repo cursor rate-gates separately
 *  so one repo's recent sweep doesn't block another repo's overdue sweep. */
function reapRepo(args: {
  readonly repo: RepoConfigEntry;
  readonly sessionId: string | null;
  readonly now: number;
}): void {
  const { repo, sessionId, now } = args;
  const cursorPath = cursorFilePath(repo.name);
  if (recentSweep(cursorPath, now)) return;

  const worktrees = listWorktrees(repo.canonical);
  if (worktrees.length === 0) {
    touchCursor(cursorPath);
    return;
  }

  const windowMs = stalenessThresholdMs(repo);
  const source = `${SOURCE}:${repo.name}`;

  for (const wt of worktrees) {
    // G6-P1 reaper-coverage (subtract-only scope filter; CG5-exempt). Only
    // AUTO-provisioned sid-prefix worktrees are safely sid-attributable; a
    // MANUAL named worktree (slug tail, not 8-hex) can't be sid-attributed AND
    // removeWorktree's slice(0,8) truncates its slug to a wrong path (a silent
    // no-op). Skip it (operator-sweep territory) until G6-P2's safe-by-content
    // named-reap. This only ADDS a skip — it can never enable a reap.
    if (!isSidPrefixWorktreeId(wt.sessionId)) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-gc-skipped-named",
        artifactPath: wt.path,
        detail: `[${source}] ${wt.sessionId} is a named (non-sid-prefix) worktree — outside the reaper's sid-prefix model; left to operator-sweep until G6-P2`,
      });
      continue;
    }
    // Cross-artifact liveness (backlog L1049): the canonical OR-composer
    // `sessionLivePrefixSource` (C1 S1) scans ALL active-sessions artifacts AND
    // the coordination CHANNEL store (cohort sends refresh ONLY that store),
    // returning WHICH store proved liveness. windowMs is this repo's per-repo
    // threshold; the channel window is FLOORED at GC_WINDOW_MS (60min) INSIDE the
    // composer — channel sends are SPARSE, so a short per-repo cleanupAfterIdleHours
    // would else false-dead a channel-only-fresh session (the 3/3 victim class).
    // Live in EITHER store → skip the reap.
    const liveSource = sessionLivePrefixSource(wt.sessionId, now, windowMs);
    if (liveSource !== null) {
      // m7: breadcrumb the channel-store skip (this site was silent pre-2b) so a
      // channel-only save is auditable, matching the dotfiles reaper.
      if (liveSource === "channel") {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          sessionId,
          source: "dispatcher",
          kind: "worktree-gc-liveness-fallback-fired",
          artifactPath: wt.path,
          detail: `[${source}] sid-prefix ${wt.sessionId} is live on the coordination channel (fresh channel heartbeat; window=max(repo ${windowMs}ms, 60min floor)) but the active-sessions store was stale/missing — skipping reap of a live worktree (L1049 slice-2b)`,
        });
      }
      continue;
    }

    if (forensicMarkerActive(wt.sessionId)) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-failed",
        artifactPath: wt.path,
        detail: `[${source}] forensic marker active for ${wt.sessionId} — skipping reap`,
      });
      continue;
    }

    const guard = guardReason(wt.path, now);
    if (guard !== null) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-failed",
        artifactPath: wt.path,
        detail: `[${source}] safety guard active: ${guard} — skipping reap`,
      });
      continue;
    }

    const removeResult = removeWorktree(wt.sessionId, {
      dotfilesCanonical: repo.canonical,
    });
    if (removeResult.kind === "error") {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-failed",
        artifactPath: wt.path,
        detail: `[${source}] ${removeResult.detail}`,
      });
      continue;
    }

    // Reconciliation guard — post-reap, did the path actually disappear?
    if (existsSync(wt.path)) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-incomplete",
        artifactPath: wt.path,
        detail: `[${source}] post-reap path still exists`,
      });
      continue;
    }

    // F4 never-kill-silently (L1049, mirror of dotfiles-worktree-gc): this reap
    // survived the cross-artifact liveness gate above (sessionLivePrefixSource
    // === null), so the owning session had no live heartbeat on any artifact
    // within the window. Record it so the reap is auditable.
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "dispatcher",
      kind: "worktree-gc-reaped",
      artifactPath: wt.path,
      detail: `[${source}] reaped sid-prefix ${wt.sessionId} — no live heartbeat on any artifact within window`,
    });
  }

  // G6-P2 named-worktree-reap REPORT (opt-in, default-off = silent; NEVER reaps).
  // The loop above SKIPS named worktrees; when opted-in, surface the clean+stale
  // ones with their landed-signals so the user can review + explicitly apply-reap
  // (the destructive apply is user-driven — dotfiles named-worktree-reap --apply).
  // SPAWN-3: the GATED enumerator withholds live / indeterminate /
  // fresh-deep-activity rows (Decision 5 — NOT reapable), surfaced as excluded
  // breadcrumbs so the report is honest about machine-withheld rows.
  if (isNamedWorktreeReapReportEnabled()) {
    const gated = gatedNamedWorktreeReapCandidates(repo.canonical, now, {
      staleFloorMs: NAMED_WORKTREE_STALE_FLOOR_MS,
    });
    for (const c of gated.candidates) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-gc-named-reap-candidate",
        artifactPath: c.path,
        detail: `[${source}] named-reap CANDIDATE (report-only): ${formatNamedWorktreeReapCandidate(c, now)}`,
      });
    }
    for (const ex of gated.excluded) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-gc-named-reap-excluded",
        artifactPath: ex.path,
        detail: `[${source}] named-reap candidate WITHHELD (NOT reapable): ${ex.slug} — ${ex.reason}`,
      });
    }
  }

  touchCursor(cursorPath);
}

/** Per-repo staleness threshold. `cleanupAfterIdleHours` (if set + >0)
 *  overrides the default GC_WINDOW_MS_DEFAULT per FOLD-ARCH-3. */
function stalenessThresholdMs(repo: RepoConfigEntry): number {
  if (
    repo.cleanupAfterIdleHours !== undefined &&
    repo.cleanupAfterIdleHours > 0
  ) {
    return repo.cleanupAfterIdleHours * 60 * 60 * 1000;
  }
  return GC_WINDOW_MS_DEFAULT;
}

function cursorFilePath(repoName: string): string {
  // Per-repo cursor: `<effectiveHome>/.claude/logs/.repo-worktree-gc-cursor.<repoName>`.
  // Repo name is operator-controlled; sanitize for filesystem safety
  // (replace `/` and `\0` with `_`; bound length). Path parts kept
  // separate (not as `.claude/logs`) per check-generic-paths discipline.
  const safeName = repoName.replace(/[/\\\0]/gu, "_").slice(0, 80);
  return join(
    effectiveHome(),
    ".claude",
    "logs",
    `${CURSOR_FILE_PREFIX}${safeName}`,
  );
}

function recentSweep(cursorPath: string, now: number): boolean {
  try {
    const mtime = statSync(cursorPath).mtimeMs;
    return now - mtime < REAP_INTERVAL_MS;
  } catch {
    return false;
  }
}

function touchCursor(cursorPath: string): void {
  try {
    mkdirSync(join(effectiveHome(), ".claude", "logs"), { recursive: true });
    if (existsSync(cursorPath)) {
      const now = new Date();
      utimesSync(cursorPath, now, now);
    } else {
      writeFileSync(cursorPath, "", { flag: "w" });
    }
  } catch {
    /* best-effort */
  }
}

function forensicMarkerActive(sidPrefix: string): boolean {
  const path = join(
    effectiveHome(),
    ".claude",
    FORENSIC_MARKER_DIR_NAME,
    sidPrefix,
  );
  return existsSync(path);
}

function guardReason(worktreePath: string, now: number): string | null {
  const indexLock = join(worktreePath, ".git", "index.lock");
  if (existsSync(indexLock)) {
    try {
      const age = now - statSync(indexLock).mtimeMs;
      if (age >= 0 && age < INDEX_LOCK_FRESH_MS) {
        return ".git/index.lock active (mid-checkout/commit)";
      }
    } catch {
      /* skip — treat as stale lock */
    }
  }
  const nodeModulesDir = join(worktreePath, "node_modules");
  try {
    if (existsSync(nodeModulesDir)) {
      // Lightweight heuristic: dir's mtime reflects any recent .bun-tmp-*
      // activity. Under-reaping is safer than over-reaping; skip if mtime
      // is recent regardless of the specific .bun-tmp-* file presence.
      const stat = statSync(nodeModulesDir);
      const age = now - stat.mtimeMs;
      if (age >= 0 && age < BUN_TMP_FRESH_MS) {
        return "node_modules recently modified (possible mid-install)";
      }
    }
  } catch {
    /* skip — treat as inactive */
  }
  return null;
}
