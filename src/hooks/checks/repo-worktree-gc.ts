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

import {
  artifactIdFromPath,
  listAllHeartbeats,
  type HeartbeatListing,
} from "../../active-sessions/index.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { effectiveHome } from "../../shared/home.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import {
  listWorktrees,
  removeWorktree,
  type WorktreeEntry,
} from "../../worktrees/index.ts";
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
    // Heartbeats fetched once across all repos. We use the canonical-
    // claude-home anchor (~/.claude) — all sessions write heartbeats
    // there via session-presence-register at session-start, regardless
    // of which repos they're working in. This gives a complete view
    // of all currently-live sessions for the sid-prefix-liveness check.
    const anchorArtifactId = artifactIdFromPath(
      join(effectiveHome(), ".claude"),
    );
    const anchors = listAllHeartbeats({
      artifactId: anchorArtifactId,
      now,
    });

    for (const repo of configResult.repos) {
      if (repo.gc === false) continue;
      if (repo.auto !== true) continue; // gc only the auto-provisioned set
      reapRepo({ repo, anchors, sessionId, now });
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
  readonly anchors: readonly HeartbeatListing[];
  readonly sessionId: string | null;
  readonly now: number;
}): void {
  const { repo, anchors, sessionId, now } = args;
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
    if (isWorktreeLive(anchors, wt, windowMs)) continue;

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

    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "dispatcher",
      kind: "worktree-gc-reaped",
      artifactPath: wt.path,
      detail: `[${source}] reaped sid-prefix ${wt.sessionId}`,
    });
  }

  touchCursor(cursorPath);
}

/** sid-prefix-liveness primary check: ANY heartbeat across all
 *  artifact-ids matching the worktree's sid-prefix + age < windowMs →
 *  worktree is live.
 *
 *  Deliberately ignores the `likelyDead` flag — that flag is set against
 *  the global LIVE_WINDOW_MS (30min) constant, which would override our
 *  per-repo cleanupAfterIdleHours threshold. The per-repo windowMs is
 *  the authoritative threshold here; ageMs-against-windowMs is the
 *  single source of truth. */
function isWorktreeLive(
  anchors: readonly HeartbeatListing[],
  wt: WorktreeEntry,
  windowMs: number,
): boolean {
  const sidPrefix = wt.sessionId;
  for (const a of anchors) {
    if (!a.sessionId.startsWith(sidPrefix)) continue;
    if (a.ageMs < 0) continue;
    if (a.ageMs < windowMs) return true;
  }
  return false;
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
