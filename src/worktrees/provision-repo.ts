// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Generic repo-worktree provisioning flow.
 *
 * Extracts the hook-flow body of `dotfiles-worktree-provisioner.ts` (Phase
 * 3 Slice 2; ~413 LOC) into a config-driven helper so Phase 3 Slice 3
 * (generic-worktree-provisioner per vault L991+ backlog + RFC v0.2) can
 * compose the same flow for non-dotfiles repos without duplicating the
 * soft-ceiling + mixed-state + provision + link sequence.
 *
 * **Scope of this Slice 1 (refactor-only, behavior-preserving):**
 * extract steps 3-8 of the original hook flow (soft-ceiling → mixed-state
 * → path-compute → anchor-pin → provision + breadcrumb → link-deps) into
 * `materializeRepoWorktree`. The caller (today: the dotfiles hook) runs
 * verifyProvision AFTER and emits the final pass/warn HookResult.
 *
 * verifyProvision stays in the dotfiles hook because its 8 facets are
 * tightly coupled to dotfiles-specific reads (`readSentinelDotfilesRoot`,
 * cross-edge `claude-conductor/package.json` probe). Slice 2/3 will
 * generalize verify via a `verifyExtraFacets` callback when the new
 * `repo-worktree-provisioner` consumer materializes; this Slice 1 is
 * deliberately bounded to the steps that ALREADY have no dotfiles-
 * specific blast.
 *
 * Plan: ~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md
 * §v0.2 Slice 1 + companion §v0.3 extraction map.
 *
 * Cross-references:
 * - feedback-cross-edge-contract-via-paired-tests.md (the test gate
 *   discipline this refactor relies on — existing dotfiles tests are
 *   the regression-gate)
 * - feedback-parallel-session-shared-tree-branch-race.md (the failure-
 *   mode memory documenting why this primitive must generalize)
 */

import { existsSync } from "node:fs";

import { appendPresenceFailure } from "../shared/presence-failure-log.ts";

import {
  linkCanonicalNodeModules,
  listWorktrees,
  provisionWorktree,
  worktreePathForSession,
  type LinkResult,
  type WorktreePath,
} from "./index.ts";

/** Per-repo configuration the generic flow needs. Dotfiles is one
 *  instance; future opt-in repos (Slice 3) are siblings. */
export type RepoProvisionConfig = {
  /** Breadcrumb identifier — substituted into all messages.
   *  E.g., "dotfiles-worktree-provisioner". */
  readonly source: string;
  /** Canonical repo path. `worktreePathForSession` composes
   *  `<canonical>-<sid-prefix-8>` from this. */
  readonly canonical: string;
  /** Soft-ceiling: provision continues past this, but emits a
   *  breadcrumb urging GC. */
  readonly softCeiling: number;
  /** Repo-specific anchor-pin callback. For dotfiles: writes the
   *  `setSentinelDotfilesRoot` heartbeat record. Always-fires
   *  (before provision attempt) so the anchor exists even if
   *  provision returns "exists" or fails. */
  readonly pinAnchor: (args: {
    readonly sessionId: string;
    readonly worktreePath: WorktreePath;
  }) => void;
  /** Optional mixed-flag-state warning callback. For dotfiles: checks
   *  if live peers lack `dotfilesRoot` (running flag-off while we're
   *  flag-on). Returns a one-line breadcrumb or null. */
  readonly detectMixedState?: (sessionId: string) => string | null;
  /** Optional cross-edge dep-link callback. For dotfiles:
   *  `linkCanonicalNodeModules` so `claude-conductor` resolves cross-edge
   *  from the worktree. Other repos may have different file:.. wiring
   *  OR omit entirely. */
  readonly linkDeps?: (
    canonical: string,
    worktreePath: WorktreePath,
  ) => LinkResult;
};

/** Result of the materialization steps (3-8 of the original flow).
 *  Caller composes verifyProvision + final pass/warn after this. */
export type MaterializeResult =
  | {
      readonly kind: "ok";
      readonly worktreePath: WorktreePath;
      readonly messages: readonly string[];
      readonly didProvision: boolean;
    }
  | {
      readonly kind: "feature-disabled";
      readonly messages: readonly string[];
    }
  | {
      readonly kind: "provision-failed";
      readonly worktreePath: WorktreePath;
      readonly messages: readonly string[];
      readonly detail: string;
    };

/**
 * Run steps 3-8 of the original dotfiles-worktree-provisioner flow:
 *
 * 1. Soft-ceiling check (`listWorktrees(canonical).length >= softCeiling`).
 * 2. Mixed-state warning (optional callback).
 * 3. Compute `worktreePath`.
 * 4. Anchor-pin (callback — repo-specific).
 * 5. Provision via `provisionWorktree` if path absent; breadcrumb on success
 *    + presence-failure-log + early-return on error.
 * 6. Link cross-edge deps (optional callback).
 *
 * Caller (the dotfiles hook today; the generic repo hook in Slice 2)
 * runs verifyProvision over the returned `worktreePath` and emits the
 * final HookResult. The breakdown is intentional: this slice is bounded
 * to the steps where dotfiles + generic-repo flows are IDENTICAL — only
 * verify (and feature-flag-check) differ.
 *
 * Feature-flag check is intentionally NOT done here — caller handles it
 * upstream because `pass()` short-circuit must happen before any of
 * this fires. Keeps the function semantics tight: when called, the flow
 * is intended; no in-helper feature gating.
 */
export function materializeRepoWorktree(
  config: RepoProvisionConfig,
  sessionId: string,
): MaterializeResult {
  const messages: string[] = [];

  // Step 3: Soft-ceiling check.
  const liveWorktrees = listWorktrees(config.canonical);
  if (liveWorktrees.length >= config.softCeiling) {
    messages.push(
      `[${config.source}] soft ceiling reached: ${String(liveWorktrees.length)} live worktrees (>= ${String(config.softCeiling)}). Provisioning anyway; run \`claude-conductor worktrees gc --force\` if cleanup is needed.`,
    );
  }

  // Step 4: Mixed-state warning (optional).
  if (config.detectMixedState !== undefined) {
    const mixedStateMsg = config.detectMixedState(sessionId);
    if (mixedStateMsg !== null) messages.push(mixedStateMsg);
  }

  // Step 5: Compute worktreePath.
  const worktreePath = worktreePathForSession(sessionId, config.canonical);

  // Step 6: Anchor-pin — always before provision so the anchor exists
  // even if provision fails or returns "exists".
  config.pinAnchor({ sessionId, worktreePath });

  // Step 7: Provision (or accept existing).
  let didProvision = false;
  if (!existsSync(worktreePath)) {
    const result = provisionWorktree(sessionId, {
      dotfilesCanonical: config.canonical,
    });
    if (result.kind === "feature-disabled") {
      return { kind: "feature-disabled", messages };
    }
    if (result.kind === "error") {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "dispatcher",
        kind: "worktree-provision-failed",
        artifactPath: config.canonical,
        detail: result.detail,
      });
      messages.push(
        `[${config.source}] provision failed: ${result.detail.slice(0, 240)}; session continues against canonical`,
      );
      return {
        kind: "provision-failed",
        worktreePath,
        messages,
        detail: result.detail,
      };
    }
    didProvision = result.kind === "ok";
    messages.push(
      result.kind === "ok"
        ? `[${config.source}] created ${worktreePath}`
        : `[${config.source}] using existing ${result.path}`,
    );
  } else {
    messages.push(
      `[${config.source}] using existing worktree at ${worktreePath} (idempotent re-run)`,
    );
  }

  // Step 8: Link cross-edge deps (optional).
  if (config.linkDeps !== undefined) {
    const link = config.linkDeps(config.canonical, worktreePath);
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
        `[${config.source}] node_modules symlink failed: ${link.detail.slice(0, 240)}; cross-edge imports will break — investigate and fix with \`ln -s ${config.canonical}/node_modules ${worktreePath}/node_modules\``,
      );
    } else if (link.kind === "skip") {
      messages.push(
        `[${config.source}] canonical has no node_modules — run \`bun install\` at ${config.canonical} once, then this fix engages on subsequent worktrees`,
      );
    }
    // `ok` and `already-linked` are happy paths — no breadcrumb noise.
  }

  return { kind: "ok", worktreePath, messages, didProvision };
}

/** Re-export `linkCanonicalNodeModules` for caller convenience — the
 *  dotfiles config passes this as its `linkDeps` callback. Other Slice 3
 *  configs may use a different link strategy and won't import this. */
export { linkCanonicalNodeModules };
