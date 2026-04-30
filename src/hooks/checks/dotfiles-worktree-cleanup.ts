// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — `dotfiles-worktree-cleanup` Stop-event hook.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §Stop-hook
 * integration. Fires BEFORE `session-presence-unregister` so the
 * worktree teardown happens while the session's heartbeat is still live
 * (RE-3 self-heal is explicit, not relying on downstream unregister).
 *
 * Step list (REV 0.2 RE-104 reconciliation guard + CLI-DX-5 epilogue):
 *   1. Extract sessionId.
 *   2. Read sentinel; if absent (no per-session worktree), return pass().
 *   3. RE-2 safety pre-flight (same mtime-filtered guards as GC reaper):
 *      skip + breadcrumb if any guard fires; GC reaper picks up later.
 *   4. removeWorktree.
 *   5. unregisterActiveSession (RE-3 self-heal — explicit).
 *   6. clearSentinelDotfilesRoot.
 *   7. RECONCILIATION GUARD: re-check end state; emit
 *      `worktree-cleanup-incomplete` breadcrumb on partial completion.
 *   8. CLI-DX-5 EPILOGUE: emit informational reminder pointing operators
 *      at the runbook §"Working from a second terminal" recipe so they
 *      know the worktree they may have been `cd`'d into is gone.
 *   9. Errors: breadcrumb + return pass(). GC reaper sweeps on next
 *      session-start if Stop fires partial.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { effectiveHome } from "../../shared/home.ts";
import {
  clearSentinelDotfilesRoot,
  readSentinelDotfilesRoot,
  unregisterActiveSession,
} from "../../active-sessions/index.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { removeWorktree } from "../../worktrees/index.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "dotfiles-worktree-cleanup";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";

const INDEX_LOCK_FRESH_MS = 60 * 60 * 1000;
const BUN_TMP_FRESH_MS = 5 * 60 * 1000;
const FORENSIC_MARKER_DIR_NAME = "session-state-forensic";

export async function check(input: HookInput): Promise<HookResult> {
  let sessionId: string | null = null;
  try {
    sessionId = resolveSessionIdOrNull(input);
    if (sessionId === null || sessionId.length === 0) return pass();
    if (process.env[FEATURE_FLAG_ENV] !== "1") return pass();

    const worktreePath = readSentinelDotfilesRoot(sessionId);
    if (worktreePath === null) return pass();

    const dotfilesCanonical = resolveCanonical();
    const sidPrefix = sessionId.slice(0, 8);
    const now = Date.now();

    if (forensicMarkerActive(sidPrefix)) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-failed",
        artifactPath: worktreePath,
        detail: `forensic marker active for ${sidPrefix} — skipping cleanup; GC reaper will handle later`,
      });
      return pass();
    }

    const guard = guardReason(worktreePath, now);
    if (guard !== null) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-failed",
        artifactPath: worktreePath,
        detail: `safety guard active: ${guard} — skipping cleanup; GC reaper will retry`,
      });
      return pass();
    }

    const removeResult = removeWorktree(sessionId, { dotfilesCanonical });
    if (removeResult.kind === "error") {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-failed",
        artifactPath: worktreePath,
        detail: removeResult.detail,
      });
      return pass();
    }

    // RE-3 self-heal — explicit. Don't rely on session-presence-unregister
    // (which fires AFTER us in the stop chain) to handle this.
    unregisterActiveSession(sessionId);
    clearSentinelDotfilesRoot(sessionId);

    // RE-104 reconciliation guard.
    if (existsSync(worktreePath)) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-cleanup-incomplete",
        artifactPath: worktreePath,
        detail: "post-cleanup path still exists",
      });
      return pass();
    }

    // CLI-DX-5 epilogue. Best-effort — operators with CWD inside the
    // (now-gone) worktree need the breadcrumb pointer.
    return warn(
      SOURCE,
      `[${SOURCE}] removed ${worktreePath}. If you have other terminals in that path, see runbook §"Working from a second terminal" for recovery.`,
    );
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
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }

  return null;
}
