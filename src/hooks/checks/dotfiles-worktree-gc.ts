// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — `dotfiles-worktree-gc` session-start orphan reaper.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §GC reaper
 * hook step list.
 *
 * Mirrors the Phase 2 Slice 4 `channels-gc-reaper` rate-gate cursor
 * pattern (`<logs>/.worktree-gc-cursor`).
 *
 * Step list (REV 0.2 RE-102/103/104 fixes folded):
 *   1. Rate-gate: skip if cursor mtime within 5 minutes.
 *   2. listWorktrees(canonical) — git-tracked session worktrees only.
 *   3. listAllHeartbeats(canonical-claude-home anchor) — build the
 *      reverse map from worktree-path to fullSessionId via the anchor's
 *      `dotfilesRoot` field.
 *   4. For each worktree:
 *      a. Match anchor heartbeat. If matched: fullSessionId + ageMs.
 *         If unmatched: orphan (heartbeat absent or sentinel cleared).
 *      b. STALE CHECK (REV 0.2 RE-102 single threshold): only reap when
 *         heartbeat is absent OR ageMs > GC_WINDOW_MS (60min). Sessions
 *         in the 30-60min "no longer live but not yet reapable" grace
 *         zone are deliberately untouched.
 *      c. RE-2 SAFETY GUARDS (REV 0.2 RE-103 mtime-filtered):
 *         - `<worktree>/.git/index.lock` with mtime < 1 hour → skip
 *         - `<worktree>/node_modules/.bun-tmp-*` with mtime < 5 min → skip
 *         - `~/.claude/session-state-forensic/<sid-prefix>` exists → skip
 *      d. removeWorktree(prefix, opts).
 *      e. RE-3 SELF-HEAL: unregisterActiveSession(fullSessionId) when
 *         fullSessionId known.
 *      f. clearSentinelDotfilesRoot(fullSessionId).
 *      g. RECONCILIATION GUARD (REV 0.2 RE-104): re-check end state;
 *         emit `worktree-cleanup-incomplete` breadcrumb on partial.
 *      h. Emit `worktree-gc-reaped` breadcrumb on success.
 *   5. Update cursor mtime on completion.
 *
 * Forensic-recovery escape hatch: operators `touch
 * ~/.claude/session-state-forensic/<sid-prefix>` BEFORE inspecting; reaper
 * skips. Rm marker when done; next pass cleans up.
 *
 * Fail-open + breadcrumb is the entire failure-mode policy. The reaper
 * MUST NOT break session-start.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { effectiveHome } from "../../shared/home.ts";
import {
  artifactIdFromPath,
  clearSentinelDotfilesRoot,
  isSessionLiveByPrefix,
  listAllHeartbeats,
  unregisterActiveSession,
  type HeartbeatListing,
} from "../../active-sessions/index.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import {
  listWorktrees,
  removeWorktree,
  worktreeUncommittedPaths,
} from "../../worktrees/index.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass } from "../types.ts";

const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";

/** Rate-gate interval — 5 minutes between sweeps. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Heartbeat staleness threshold for worktree reaping. Mirrors
 *  active-sessions GC_WINDOW_MS (=60min); deliberately distinct from
 *  LIVE_WINDOW_MS (=30min) so the 30-min grace zone covers idle / lunch /
 *  build-wait scenarios. */
const GC_WINDOW_MS = 60 * 60 * 1000;

/** Index-lock mtime gate — older than 1 hour is a crashed git process. */
const INDEX_LOCK_FRESH_MS = 60 * 60 * 1000;

/** bun-tmp mtime gate — typical bun-install completes within 5 minutes. */
const BUN_TMP_FRESH_MS = 5 * 60 * 1000;

const FORENSIC_MARKER_DIR_NAME = "session-state-forensic";
const CURSOR_FILE_NAME = ".worktree-gc-cursor";

export async function check(input: HookInput): Promise<HookResult> {
  let sessionId: string | null = null;
  try {
    sessionId = resolveSessionIdOrNull(input);
    if (process.env[FEATURE_FLAG_ENV] !== "1") return pass();

    const cursorPath = cursorFilePath();
    if (recentSweep(cursorPath)) return pass();

    const dotfilesCanonical = resolveCanonical();
    const worktrees = listWorktrees(dotfilesCanonical);
    if (worktrees.length === 0) {
      touchCursor(cursorPath);
      return pass();
    }

    const now = getWallClockNow();
    const anchorArtifactId = artifactIdFromPath(
      join(effectiveHome(), ".claude"),
    );
    const anchors = listAllHeartbeats({ artifactId: anchorArtifactId, now });
    const byDotfilesRoot = mapByDotfilesRoot(anchors);

    for (const wt of worktrees) {
      const matched = byDotfilesRoot.get(wt.path);
      const heartbeatAge = matched?.ageMs ?? null;
      const isStale =
        matched === undefined ||
        (heartbeatAge !== null && heartbeatAge > GC_WINDOW_MS);
      if (!isStale) continue;

      // Defense-in-depth fallback liveness check (slice 7 — substrate fix
      // for live-sibling reap observed 2026-05-18 during 3-session
      // Alpha+Bravo+Charlie cycle). The `byDotfilesRoot` map can miss
      // when (a) the heartbeat's `dotfilesRoot` sentinel is absent on
      // the record (heartbeat overwritten without preserving the field),
      // or (b) raw-vs-realpath resolution drifts between write-time
      // (setSentinelDotfilesRoot) and read-time (mapByDotfilesRoot's
      // realpathSync). In either case, the worktree directory's name
      // embeds an 8-char session-id prefix; if ANY anchor heartbeat
      // shares that prefix AND is live within GC_WINDOW_MS, the session
      // whose worktree this is must still be alive — skip the reap and
      // emit a diagnostic breadcrumb instead.
      // Cross-artifact liveness gate (backlog L1049; 2026-06-02 4/4 live-reap
      // fix). byDotfilesRoot above scans ONLY the ~/.claude anchor, which
      // refreshes just at session-start + channel-send; per-tool heartbeats
      // land on the session's CWD artifact (its worktree). So a live session
      // editing files is fresh on its cwd artifact while its anchor went
      // stale/absent — the old anchor-only check (`sidPrefixHasLiveAnchor`)
      // mis-read it as dead and reaped a LIVE worktree. `isSessionLiveByPrefix`
      // scans ALL artifacts: if the owning session is fresh anywhere, do NOT
      // reap.
      if (isSessionLiveByPrefix(wt.sessionId, now)) {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          sessionId,
          source: "dispatcher",
          kind: "worktree-gc-liveness-fallback-fired",
          artifactPath: wt.path,
          detail: `sid-prefix ${wt.sessionId} is live cross-artifact (fresh heartbeat on some artifact) but the ~/.claude anchor was stale/missing — skipping reap of a live worktree (L1049)`,
        });
        continue;
      }

      if (forensicMarkerActive(wt.sessionId)) {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          sessionId,
          source: "dispatcher",
          kind: "worktree-cleanup-failed",
          artifactPath: wt.path,
          detail: `forensic marker active for ${wt.sessionId} — skipping reap`,
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
          detail: `safety guard active: ${guard} — skipping reap`,
        });
        continue;
      }

      const removeResult = removeWorktree(wt.sessionId, { dotfilesCanonical });
      if (removeResult.kind === "error") {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          sessionId,
          source: "dispatcher",
          kind: "worktree-cleanup-failed",
          artifactPath: wt.path,
          detail: removeResult.detail,
        });
        continue;
      }

      // Self-heal — RE-3.
      const fullSid = matched?.sessionId ?? null;
      if (fullSid !== null) {
        unregisterActiveSession(fullSid);
        clearSentinelDotfilesRoot(fullSid);
      }

      // Reconciliation guard — RE-104.
      if (existsSync(wt.path)) {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          sessionId,
          source: "dispatcher",
          kind: "worktree-cleanup-incomplete",
          artifactPath: wt.path,
          detail: "post-reap path still exists",
        });
        continue;
      }

      // F4 never-kill-silently (L1049): this reap survived the cross-artifact
      // liveness gate above (isSessionLiveByPrefix === false), so the owning
      // session had NO live heartbeat (age<window) on ANY artifact — not merely
      // stale on the anchor. (No-heartbeat is not provably-dead; the
      // 2-sweep-confirm follow-up adds that — NIT-RE.) Record it so the reap is
      // auditable rather than a blind anchor-age reap.
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-gc-reaped",
        artifactPath: wt.path,
        detail: `reaped ${wt.sessionId}${fullSid !== null ? ` (sid=${fullSid})` : " (orphan; no anchor)"} — no live heartbeat on any artifact within window`,
      });
    }

    touchCursor(cursorPath);
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

function resolveCanonical(): string {
  const explicit = process.env["CLAUDE_DOTFILES_ROOT"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(effectiveHome(), ".claude-dotfiles");
}

function cursorFilePath(): string {
  return join(effectiveHome(), ".claude", "logs", CURSOR_FILE_NAME);
}

function recentSweep(cursorPath: string): boolean {
  try {
    const mtime = statSync(cursorPath).mtimeMs;
    return getWallClockNow() - mtime < REAP_INTERVAL_MS;
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
    /* best effort — cursor failure just means a duplicate sweep next time */
  }
}

function mapByDotfilesRoot(
  anchors: readonly HeartbeatListing[],
): Map<string, HeartbeatListing> {
  const out = new Map<string, HeartbeatListing>();
  for (const a of anchors) {
    const root = a.owner.dotfilesRoot;
    if (root === undefined || root.length === 0) continue;
    // L588 symmetric realpath at compare time — closes the asymmetric
    // migration window where a pre-fix OwnerRecord (stored non-canonical)
    // would mis-match against canonical on-disk worktree paths
    // enumerated by `listWorktrees`. The matching `realpathSync` in
    // `setSentinelDotfilesRoot` canonicalizes the WRITE side; this
    // canonicalizes the READ side so both pre-fix + post-fix records
    // resolve to the same key. resolve() fallback mirrors the write-site
    // pattern for the "target doesn't exist yet" edge.
    let canonical: string;
    try {
      canonical = realpathSync(root);
    } catch {
      canonical = resolve(root);
    }
    out.set(canonical, a);
  }
  return out;
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
  // RE-2 data-loss guard (L1049 2a): removeWorktree uses `git worktree remove
  // --force`, which destroys uncommitted work; its JSDoc defers this refusal to
  // the caller. A worktree carrying WIP (staged/modified/untracked, excluding
  // the provisioner node_modules symlink) must NOT be reaped — the 3/3 live
  // reap of 2026-06-03 hit ALIVE sessions, which are exactly the ones likely to
  // hold WIP. Orthogonal to the liveness gate above: even a correctly
  // reap-eligible (no-live-heartbeat) worktree is preserved if it holds WIP.
  const dirty = worktreeUncommittedPaths(worktreePath);
  if (dirty.length > 0) {
    const sample = dirty.slice(0, 3).join(", ");
    return `dirty working tree — ${String(dirty.length)} uncommitted/untracked path(s) (e.g. ${sample}); --force removal would destroy WIP`;
  }

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

  const nodeModules = join(worktreePath, "node_modules");
  if (existsSync(nodeModules)) {
    try {
      const entries = readdirSync(nodeModules);
      for (const entry of entries) {
        if (!entry.startsWith(".bun-tmp-")) continue;
        try {
          const age = now - statSync(join(nodeModules, entry)).mtimeMs;
          if (age >= 0 && age < BUN_TMP_FRESH_MS) {
            return `node_modules/${entry} active (mid-bun-install)`;
          }
        } catch {
          /* skip individual entry */
        }
      }
    } catch {
      /* skip — treat as no guard */
    }
  }

  return null;
}
