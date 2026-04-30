// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — dotfiles-root resolver per Bravo B8 spec + REV 0.2.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §Path
 * resolution helper.
 *
 * Resolves the dotfiles working-tree root for the current session via the
 * 4-tier precedence chain:
 *
 *   1. process.env["CLAUDE_DOTFILES_ROOT"] — explicit operator override
 *      (testing, CI, manual escape hatch). Always highest priority.
 *
 *   2. Heartbeat-body sentinel via canonical `~/.claude` artifact-id
 *      (per D-ARCH3 anchor). Set by the provisioner hook at session-start
 *      (REV 0.2 ARCH-1 anchor-pin); read here when the session is operating
 *      in a per-session worktree under the Phase 3 Slice 2 substrate.
 *
 *   3. process.env["DOTFILES_ROOT"] — LEGACY env var (deprecation breadcrumb
 *      emitted once per process via `appendPresenceFailure`). Operators with
 *      the legacy var still work; the breadcrumb nudges them to migrate.
 *
 *   4. Default fallback: `${HOME}/.claude-dotfiles` — the canonical install
 *      location. Always-resolvable; never throws.
 *
 * Memoization (per Bravo B8): module-level cache keyed at first call.
 * `DOTFILES` const replaced by this function across 32+ call sites; without
 * memoization the per-fire fs cost is ~3ms over a dispatcher invocation.
 *
 * Reset hooks:
 *   - `__resetDotfilesRootForTests` — full reset (cache + deprecation
 *     emit-once flag). Test-isolation-only; underscore-prefix marks it.
 *   - `resetDotfilesRoot` — cache-only reset; preserves the deprecation
 *     emit-once flag. Defensive runtime use (e.g., dispatcher detects
 *     sentinel-mutation mid-process). T9: deprecation stays emit-once
 *     even across runtime cache resets.
 */

import { homedir } from "node:os";
import { readSentinelDotfilesRoot } from "../active-sessions/index.ts";
import { appendPresenceFailure } from "./presence-failure-log.ts";

let cached: string | undefined = undefined;
let deprecationEmitted = false;

export function dotfilesRoot(sessionId?: string): string {
  if (cached !== undefined) return cached;

  // Tier 1 — operator override.
  const explicit = process.env["CLAUDE_DOTFILES_ROOT"];
  if (explicit !== undefined && explicit.length > 0) {
    cached = explicit;
    return cached;
  }

  // Tier 2 — heartbeat-body sentinel via canonical-claude-home anchor.
  if (sessionId !== undefined && sessionId.length > 0) {
    const sentinel = readSentinelDotfilesRoot(sessionId);
    if (sentinel !== null) {
      cached = sentinel;
      return cached;
    }
  }

  // Tier 3 — legacy env var with one-shot deprecation breadcrumb.
  const legacy = process.env["DOTFILES_ROOT"];
  if (legacy !== undefined && legacy.length > 0) {
    if (!deprecationEmitted) {
      deprecationEmitted = true;
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? null,
        source: "dispatcher",
        kind: "deprecation",
        artifactPath: null,
        detail: "DOTFILES_ROOT is deprecated; use CLAUDE_DOTFILES_ROOT",
      });
    }
    cached = legacy;
    return cached;
  }

  // Tier 4 — default fallback.
  cached = `${homedir()}/.claude-dotfiles`;
  return cached;
}

/**
 * Test-isolation reset. Clears BOTH the resolution cache AND the
 * deprecation emit-once flag so per-test setups can re-exercise tier 3.
 * Underscore-prefix marks this as test-only — never call from production
 * code paths.
 */
export function __resetDotfilesRootForTests(): void {
  cached = undefined;
  deprecationEmitted = false;
}

/**
 * Defensive runtime reset. Clears ONLY the resolution cache; preserves
 * the deprecation emit-once flag (T9: operators see the deprecation
 * breadcrumb once per process regardless of any runtime cache resets).
 *
 * Currently unused at production call sites (the dispatcher fire-once
 * model means the cache never stales within a single process). Kept
 * exported as defense-in-depth for any future long-lived dispatcher
 * variant per Bravo B8 Q-B8c.
 */
export function resetDotfilesRoot(): void {
  cached = undefined;
}
