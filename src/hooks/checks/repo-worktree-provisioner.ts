// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Generic repo-worktree-provisioner session-start hook.
 *
 * Slice 2 of the Stream 3 generic-worktree-provisioner work per RFC v0.2
 * at ~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md.
 *
 * Provisions per-session worktrees for non-dotfiles repos when the
 * operator opts them in via `~/.claude/worktree-provisioner.json` with
 * `auto: true`. Closes the recurring shared-tree-branch-race failure mode
 * (`feedback-parallel-session-shared-tree-branch-race`) for any repo
 * declared in config.
 *
 * Flow:
 *   1. Resolve sessionId + feature flag (CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES).
 *   2. Subagent skip — CLAUDE_CODE_SUBAGENT=1 → subagents inherit parent's
 *      worktree; never spawn their own.
 *   3. Read config (3-case fail-discipline: absent → pass; ok → continue;
 *      malformed → warn() with breadcrumb).
 *   4. Topo-sort by siblingCloneOf dependency DAG (fails-closed on cycle
 *      or reference to absent repo).
 *   5. For each `auto: true` repo in topo order:
 *        a. Compose RepoProvisionConfig (Slice 1 helper).
 *        b. Call materializeRepoWorktree.
 *        c. Aggregate messages.
 *   6. Return warn() if any messages, else pass().
 *
 * Verify (step 9 of dotfiles hook) is intentionally NOT generalized here
 * — Slice 1 documented that as Slice 2/3 work via a verifyExtraFacets
 * callback. This Slice 2 hook calls only materializeRepoWorktree (steps
 * 3-8). The verify-extension is a Slice 3+ concern when a real consumer
 * needs facet-checking on a non-dotfiles repo.
 *
 * NIT-ARCH-1 + NIT-ARCH-2 closure (per Bravo's Slice 1 audit body_ref
 * 7aba10e6): this hook imports `linkCanonicalNodeModules` from
 * `../../worktrees/provision-repo.ts` (the Slice 1 re-export) rather
 * than from `../../worktrees/index.ts` directly. That commits to the
 * provision-repo.ts re-export as canonical for hooks composing the
 * Slice 1 helper; the re-export now has a real consumer.
 *
 * Anchor-pin in this slice: NO-OP function. Slice 1's dotfiles hook
 * wired `setSentinelDotfilesRoot`; that's dotfiles-specific. Slice 3
 * may add a generic per-repo anchor primitive; until then, the hook
 * passes a no-op pinAnchor and relies on git-worktree-list as the
 * source-of-truth for the reaper (per RFC v0.2 §Q4 disposition).
 *
 * Plan: ~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md
 * §v0.2 Slice 2 + companion §v0.3 extraction map.
 */

import {
  readRepoConfig,
  topoSortRepos,
  type RepoConfigEntry,
} from "../../worktrees/repo-config.ts";
import {
  linkCanonicalNodeModules,
  materializeRepoWorktree,
  type RepoProvisionConfig,
} from "../../worktrees/provision-repo.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "repo-worktree-provisioner";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";
const SUBAGENT_ENV = "CLAUDE_CODE_SUBAGENT";
const SOFT_CEILING_DEFAULT = 20;

/** Compose a RepoProvisionConfig for the materializeRepoWorktree helper
 *  from a config-file RepoConfigEntry. Translates the data shape to the
 *  callback shape Slice 1 expects. */
function entryToProvisionConfig(entry: RepoConfigEntry): RepoProvisionConfig {
  return {
    source: `${SOURCE}:${entry.name}`,
    canonical: entry.canonical,
    softCeiling: SOFT_CEILING_DEFAULT,
    // Slice 2 anchor-pin: no-op. Slice 3+ may add a per-repo sentinel
    // primitive (mirrors setSentinelDotfilesRoot pattern) — when added,
    // wire it here per-entry. For now git-worktree-list is the
    // authoritative source for the reaper.
    pinAnchor: () => {
      /* no-op in Slice 2 */
    },
    // Slice 2 uses linkCanonicalNodeModules generically — works for any
    // repo with `node_modules` at canonical. Repos without node_modules
    // hit the `skip` branch in the helper (breadcrumb-only). Slice 3+
    // may add per-repo link strategies for repos using non-Node deps.
    linkDeps: linkCanonicalNodeModules,
    // detectMixedState is dotfiles-specific (reads dotfilesRoot anchor).
    // Generic repos don't have an equivalent today; deferred to Slice 3+
    // when per-repo anchors materialize.
  };
}

export async function check(input: HookInput): Promise<HookResult> {
  const sessionId = resolveSessionIdOrNull(input);
  if (sessionId === null || sessionId.length === 0) return pass();

  // Feature flag — same env var as dotfiles provisioner. Operators
  // opt into per-session worktree behavior globally; the config file
  // then controls per-repo opt-in granularity.
  if (process.env[FEATURE_FLAG_ENV] !== "1") return pass();

  // Subagent skip — subagents inherit parent's worktree state; never
  // spawn their own per-session worktree.
  if (process.env[SUBAGENT_ENV] === "1") return pass();

  // Step 3: Read config.
  const configResult = readRepoConfig();
  if (configResult.kind === "absent") return pass();
  if (configResult.kind === "malformed") {
    return warn(
      SOURCE,
      `[${SOURCE}] config malformed at ${configResult.path}: ${configResult.reason}; session continues with no per-repo provisioning`,
    );
  }

  if (configResult.repos.length === 0) return pass();

  // Step 4: Topo-sort by siblingCloneOf DAG.
  const topoResult = topoSortRepos(configResult.repos);
  if (topoResult.kind === "error") {
    return warn(
      SOURCE,
      `[${SOURCE}] config topo-sort failed: ${topoResult.reason}; no repos provisioned this session-start`,
    );
  }

  // Step 5: Provision each `auto: true` repo in topo order.
  const messages: string[] = [];
  for (const entry of topoResult.ordered) {
    if (entry.auto !== true) continue;

    const config = entryToProvisionConfig(entry);
    const materialized = materializeRepoWorktree(config, sessionId);

    if (materialized.kind === "feature-disabled") {
      // Defensive — we pre-gated the flag at hook entry. Belt-and-
      // suspenders matches the dotfiles hook pattern.
      continue;
    }

    // Collect messages whether ok or provision-failed; the helper
    // already wrote presence-failure-log entries on error paths.
    messages.push(...materialized.messages);
  }

  return messages.length > 0 ? warn(SOURCE, messages.join("\n")) : pass();
}
