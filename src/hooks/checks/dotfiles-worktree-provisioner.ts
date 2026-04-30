// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — `dotfiles-worktree-provisioner` session-start hook.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §Provisioner
 * hook step list.
 *
 * Default-off in this slice (per D9): the feature flag
 * `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES` must equal `"1"` for the hook
 * to do anything. The flag-default flip happens as a separate follow-up
 * commit on main after Bravo first-dogfood ack.
 *
 * Step list (per REV 0.2 + plan):
 *   1. Extract sessionId.
 *   2. Read feature flag; return pass() (no-op) when off.
 *   3. Soft-ceiling check (REV 0.2 RE-105): if listWorktrees().length >= 20,
 *      emit reminder but continue. Hard guarantee comes from GC reaper
 *      steady-state convergence; brief over-shoot tolerated by design.
 *   4. RE-8 mixed-state warning: if any live peer in the canonical-claude-
 *      home anchor lacks `dotfilesRoot`, they're operating in flag-off mode
 *      while we're flag-on. Emit informational reminder.
 *   5. Compute worktreePath.
 *   6. ANCHOR-PIN (REV 0.2 ARCH-1 critical fix): setSentinelDotfilesRoot
 *      regardless of CWD. Force-creates the canonical-claude-home anchor
 *      heartbeat record if absent so the resolver's read path is
 *      reachable from any later context.
 *   7. If worktree path exists already, return pass() with informational
 *      reminder ("[worktree-provisioner] using existing worktree …").
 *   8. Otherwise provisionWorktree() and report.
 *   9. Errors: appendPresenceFailure(kind: "worktree-provision-failed");
 *      session continues against canonical (degraded but functional).
 *
 * Fail-open + breadcrumb is the entire failure-mode policy — provisioning
 * MUST NOT break session-start.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { effectiveHome } from "../../shared/home.ts";
import {
  artifactIdFromPath,
  listLivePeers,
  setSentinelDotfilesRoot,
} from "../../active-sessions/index.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import {
  listWorktrees,
  provisionWorktree,
  worktreePathForSession,
} from "../../worktrees/index.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "dotfiles-worktree-provisioner";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";
const SOFT_CEILING = 20;

export async function check(input: HookInput): Promise<HookResult> {
  let sessionId: string | null = null;
  try {
    sessionId = resolveSessionIdOrNull(input);
    if (sessionId === null || sessionId.length === 0) return pass();

    if (process.env[FEATURE_FLAG_ENV] !== "1") return pass();

    const dotfilesCanonical = resolveCanonical();
    const messages: string[] = [];

    // RE-105 soft-ceiling check.
    const liveWorktrees = listWorktrees(dotfilesCanonical);
    if (liveWorktrees.length >= SOFT_CEILING) {
      messages.push(
        `[${SOURCE}] soft ceiling reached: ${String(liveWorktrees.length)} live worktrees (>= ${String(SOFT_CEILING)}). Provisioning anyway; run \`claude-conductor worktrees gc --force\` if cleanup is needed.`,
      );
    }

    // RE-8 mixed-state warning.
    const mixedStateMsg = detectMixedFlagState(sessionId);
    if (mixedStateMsg !== null) messages.push(mixedStateMsg);

    const worktreePath = worktreePathForSession(sessionId, dotfilesCanonical);

    // ANCHOR-PIN (REV 0.2 ARCH-1) — always before the provision step so the
    // anchor exists even if provision fails or returns "exists".
    setSentinelDotfilesRoot({ sessionId, dotfilesRoot: worktreePath });

    if (existsSync(worktreePath)) {
      messages.push(
        `[${SOURCE}] using existing worktree at ${worktreePath} (idempotent re-run)`,
      );
      return messages.length > 0 ? warn(SOURCE, messages.join("\n")) : pass();
    }

    const result = provisionWorktree(sessionId, { dotfilesCanonical });
    if (result.kind === "ok") {
      messages.push(`[${SOURCE}] created ${worktreePath}`);
      return warn(SOURCE, messages.join("\n"));
    }
    if (result.kind === "exists") {
      messages.push(`[${SOURCE}] using existing ${result.path}`);
      return warn(SOURCE, messages.join("\n"));
    }
    if (result.kind === "feature-disabled") {
      // Defensive — we already checked the flag above. Keep as belt-and-
      // suspenders for the case where provisionWorktree's internal flag-read
      // diverges from this hook's read (e.g., a featureFlagOverride somehow
      // flips between calls).
      return pass();
    }
    // result.kind === "error"
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "dispatcher",
      kind: "worktree-provision-failed",
      artifactPath: dotfilesCanonical,
      detail: result.detail,
    });
    messages.push(
      `[${SOURCE}] provision failed: ${result.detail.slice(0, 240)}; session continues against canonical`,
    );
    return warn(SOURCE, messages.join("\n"));
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "dispatcher",
      kind: "worktree-provision-failed",
      artifactPath: null,
      detail,
    });
    return pass();
  }
}

function resolveCanonical(): string {
  // The canonical for `git worktree` operations is the dotfiles install
  // location. `CLAUDE_DOTFILES_ROOT` operator override is honored; tier 4
  // default is `${HOME}/.claude-dotfiles` (matching dotfilesRoot tier 4).
  // We do NOT use `dotfilesRoot()` here because that resolver can return
  // a worktree path (tier 2 sentinel) — and the provisioner needs to run
  // git from the CANONICAL, not from a worktree.
  const explicit = process.env["CLAUDE_DOTFILES_ROOT"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(effectiveHome(), ".claude-dotfiles");
}

function detectMixedFlagState(self: string): string | null {
  try {
    const anchorArtifactId = artifactIdFromPath(
      join(effectiveHome(), ".claude"),
    );
    const peers = listLivePeers({
      artifactId: anchorArtifactId,
      self,
      now: Date.now(),
    });
    const flagOffPeers = peers.filter(
      (p) => p.owner.dotfilesRoot === undefined,
    );
    if (flagOffPeers.length === 0) return null;
    return `[${SOURCE}] mixed flag-state detected: ${String(flagOffPeers.length)} live peer(s) without dotfilesRoot sentinel (likely running with ${FEATURE_FLAG_ENV} unset). Set the flag globally in shell rc to avoid heterogeneous behavior.`;
  } catch {
    /* never throw from a fail-open hook — best-effort observation only */
    return null;
  }
}
