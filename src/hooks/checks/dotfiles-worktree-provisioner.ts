// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — `dotfiles-worktree-provisioner` session-start hook.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §Provisioner
 * hook step list. **P0 substrate canary (backlog L:892, 2026-05-17):**
 * Path B integration — `linkCanonicalNodeModules` composed unconditionally
 * after worktree-path materialization (covers fresh-provision, idempotent
 * re-entry, and provisionWorktree-internal "exists" branches uniformly).
 *
 * Default-off in this slice (per D9): the feature flag
 * `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES` must equal `"1"` for the hook
 * to do anything. The flag-default flip happens as a separate follow-up
 * commit on main after Bravo first-dogfood ack.
 *
 * Step list (per REV 0.2 + P0 fold):
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
 *   7. Materialize the worktree: provision if absent, accept if present.
 *      provisionWorktree errors short-circuit with a `worktree-provision-
 *      failed` breadcrumb; feature-disabled short-circuits silently.
 *   8. **P0 link step** (Path B fold): `linkCanonicalNodeModules` composed
 *      unconditionally after Step 7. Idempotent via `already-linked`. Error
 *      paths emit `worktree-deps-link-failed` breadcrumb but session continues.
 *   9. verifyProvision with `cross-edge-dep-missing` facet — pins the
 *      cross-edge resolution invariant (`<wt>/node_modules/claude-conductor/
 *      package.json` resolvable) post-link.
 *
 * Fail-open + breadcrumb is the entire failure-mode policy — provisioning
 * MUST NOT break session-start.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { effectiveHome } from "../../shared/home.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import {
  artifactIdFromPath,
  listLivePeers,
  readSentinelDotfilesRoot,
  setSentinelDotfilesRoot,
} from "../../active-sessions/index.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import {
  linkCanonicalNodeModules,
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

    // Step 7 — Materialize worktree. Three terminal materialization states
    // (existsSync-early, provisionWorktree="ok", provisionWorktree="exists")
    // all converge on "worktreePath is now usable." Path B fold (P0 substrate
    // canary L:892, 2026-05-17) lifted the link + verify steps OUTSIDE the
    // conditional so they run uniformly across all three terminal states.
    if (!existsSync(worktreePath)) {
      const result = provisionWorktree(sessionId, { dotfilesCanonical });
      if (result.kind === "feature-disabled") {
        // Defensive — we already checked the flag above. Keep as belt-and-
        // suspenders for the case where provisionWorktree's internal flag-read
        // diverges from this hook's read (e.g., a featureFlagOverride somehow
        // flips between calls).
        return pass();
      }
      if (result.kind === "error") {
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
        // Short-circuit: no worktree means nothing to link or verify.
        return warn(SOURCE, messages.join("\n"));
      }
      // result.kind === "ok" || "exists" — worktree path is materialized.
      messages.push(
        result.kind === "ok"
          ? `[${SOURCE}] created ${worktreePath}`
          : `[${SOURCE}] using existing ${result.path}`,
      );
    } else {
      messages.push(
        `[${SOURCE}] using existing worktree at ${worktreePath} (idempotent re-run)`,
      );
    }

    // Step 8 — P0 substrate canary fix (backlog L:892). Compose
    // `linkCanonicalNodeModules` AFTER worktree materialization regardless of
    // which path got us there (Path B per Bravo cross-audit L93 catch + Alpha
    // confirmation 2026-05-17 ~13:20Z). Symlink is idempotent via
    // `already-linked`; race-safe via EEXIST catch in the primitive.
    const link = linkCanonicalNodeModules(dotfilesCanonical, worktreePath);
    if (link.kind === "error") {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-deps-link-failed",
        artifactPath: worktreePath,
        detail: link.detail,
      });
      messages.push(
        `[${SOURCE}] node_modules symlink failed: ${link.detail.slice(0, 240)}; cross-edge imports will break — investigate and fix with \`ln -s ${dotfilesCanonical}/node_modules ${worktreePath}/node_modules\``,
      );
      // Fail-soft: continue to verify so cross-edge-dep-missing fires too,
      // giving the operator both the "why" (link error) and "what's broken"
      // (verifyProvision facet) signals in the same session-start surface.
    } else if (link.kind === "skip") {
      // Canonical has no `node_modules/` yet — likely first-ever invocation
      // before any `bun install` ran at canonical. Breadcrumb-only; not a
      // failure (the operator's next action is "bun install at canonical").
      messages.push(
        `[${SOURCE}] canonical has no node_modules — run \`bun install\` at ${dotfilesCanonical} once, then this fix engages on subsequent worktrees`,
      );
    }
    // kind: "ok" and "already-linked" are happy paths — no breadcrumb noise.

    // Step 9 — verifyProvision with `cross-edge-dep-missing` facet extension.
    // Pins the cross-edge resolution invariant post-link.
    const verdict = verifyProvision({
      sessionId,
      worktreePath,
      dotfilesCanonical,
    });
    if (!verdict.complete) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-provision-incomplete",
        artifactPath: worktreePath,
        detail: verdict.detail,
      });
      messages.push(
        `[${SOURCE}] INCOMPLETE: ${verdict.facet}; logged to presence-failure-log for substrate diagnosis`,
      );
    }

    return messages.length > 0 ? warn(SOURCE, messages.join("\n")) : pass();
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
      now: getWallClockNow(),
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

type VerifyResult =
  | { complete: true; detail: string; facet: null }
  | { complete: false; detail: string; facet: string };

/**
 * Post-provisionWorktree verification.
 *
 * Returns `complete: true` when post-provision state matches what a future
 * GC reaper would expect (path is statable, no realpath-vs-raw drift,
 * sentinel readback returns the worktreePath, and cross-edge dep resolution
 * is intact). Otherwise returns the incomplete facet that fired and a stable
 * key=value detail string for presence-failure-log ingestion.
 *
 * The realpath-vs-raw mismatch facet is the load-bearing diagnostic for
 * the H2 hypothesis (provisioner stores raw `dotfilesRoot` at the sentinel;
 * GC's `listWorktrees` realpath-resolves the canonical → drift → orphan →
 * reap). One realpathSync call directly answers "will GC reap us?"
 *
 * Sentinel-readback is a defensive-tautology within a single hook execution
 * (the value was just written by `setSentinelDotfilesRoot`), but kept for
 * cross-session diagnostic — a sentinel-readback-null in production would
 * indicate the registry write itself failed silently.
 *
 * P0 substrate canary fold (backlog L:892, 2026-05-17): the
 * `cross-edge-dep-missing` facet pins the post-link invariant that
 * `<worktreePath>/node_modules/claude-conductor/package.json` resolves.
 * Fires when canonical lacks `claude-conductor` in node_modules, when
 * the symlink target points at a moved/missing canonical, or when the
 * link step itself failed (operator collision or fs error). Probed last
 * so earlier substrate-shape facets take precedence (a missing worktree
 * dir is more diagnostic than a missing cross-edge dep within it).
 */
function verifyProvision(args: {
  sessionId: string;
  worktreePath: string;
  dotfilesCanonical: string;
}): VerifyResult {
  const { sessionId, worktreePath, dotfilesCanonical } = args;

  let statErrno = "none";
  try {
    statSync(worktreePath);
  } catch (err: unknown) {
    statErrno = (err as NodeJS.ErrnoException).code ?? "EUNKNOWN";
  }

  let pathRealpath: string | null = null;
  if (statErrno === "none") {
    try {
      pathRealpath = realpathSync(worktreePath);
    } catch {
      /* best-effort */
    }
  }

  let canonicalRealpath: string | null = null;
  try {
    canonicalRealpath = realpathSync(dotfilesCanonical);
  } catch {
    /* best-effort */
  }

  const realpathMismatch =
    pathRealpath !== null &&
    canonicalRealpath !== null &&
    pathRealpath !== worktreePath &&
    pathRealpath.startsWith(`${canonicalRealpath}-`);

  let sentinelReadback: string | null = null;
  try {
    sentinelReadback = readSentinelDotfilesRoot(sessionId);
  } catch {
    /* best-effort */
  }

  // P0 substrate canary (backlog L:892, 2026-05-17) — cross-edge dep
  // resolution probe. Cheap existence check on the load-bearing target
  // (`claude-conductor/package.json`); bun resolution walks up from a
  // script's location to find this file, so its presence is the necessary
  // condition for cross-edge imports to resolve from the worktree.
  let crossEdgeDepMissing = false;
  if (statErrno === "none") {
    const claudeConductorPkgJson = join(
      worktreePath,
      "node_modules",
      "claude-conductor",
      "package.json",
    );
    crossEdgeDepMissing = !existsSync(claudeConductorPkgJson);
  }

  let facet: string | null = null;
  if (statErrno !== "none") {
    facet = `stat-errno=${statErrno}`;
  } else if (realpathMismatch) {
    facet = "realpath-mismatch";
  } else if (sentinelReadback === null) {
    facet = "sentinel-readback-null";
  } else if (crossEdgeDepMissing) {
    facet = "cross-edge-dep-missing";
  }

  let branchExists = false;
  if (facet !== null) {
    const sidPrefix = sessionId.slice(0, 8);
    try {
      const probe = spawnSync(
        "git",
        [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/worktree/${sidPrefix}`,
        ],
        { cwd: dotfilesCanonical, stdio: ["ignore", "ignore", "ignore"] },
      );
      branchExists = probe.status === 0;
    } catch {
      /* best-effort */
    }
  }

  const detail = formatIncompleteDetail({
    sessionId,
    worktreePath,
    dotfilesCanonical,
    canonicalRealpath,
    statErrno,
    sentinelReadback,
    realpathMismatch,
    branchExists,
  });

  if (facet === null) {
    return { complete: true, detail, facet: null };
  }
  return { complete: false, detail, facet };
}

/**
 * Stable key=value detail string for `worktree-provision-incomplete` events.
 *
 * Key order is locked via the parseEvent round-trip unit test —
 * downstream parsers in the next-slice race-fix design depend on this
 * being stable.
 */
function formatIncompleteDetail(args: {
  sessionId: string;
  worktreePath: string;
  dotfilesCanonical: string;
  canonicalRealpath: string | null;
  statErrno: string;
  sentinelReadback: string | null;
  realpathMismatch: boolean;
  branchExists: boolean;
}): string {
  return [
    `sid=${args.sessionId}`,
    `path=${args.worktreePath}`,
    `canonical=${args.dotfilesCanonical}`,
    `realpath=${args.canonicalRealpath ?? "null"}`,
    `stat-errno=${args.statErrno}`,
    `sentinel-readback=${args.sentinelReadback ?? "null"}`,
    `realpath-mismatch=${String(args.realpathMismatch)}`,
    `branch-exists=${String(args.branchExists)}`,
  ].join(" ");
}

export const INTERNAL = {
  formatIncompleteDetail,
  verifyProvision,
};
