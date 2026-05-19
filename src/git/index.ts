// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared git subprocess wrappers.
 *
 * Slice 0 origin (plan ~/.claude/plans/slice-0-cascade-rebase-2026-05-19.md
 * §D2 + Q11 Option X-LITE): lifted from src/worktrees/index.ts so the
 * `pr cascade-rebase` verb + Slice 3 audit-queue + future consumers share
 * a single hand-rolled subprocess wrapper. Convention: cmd-array form
 * (injection-safe), captured stdout + stderr, no shell expansion.
 *
 * Migration scope (Option X-LITE per plan v0.2): only src/worktrees/index.ts
 * migrates to import from here. Two other inline git invocations
 * (src/active-sessions/index.ts + src/hooks/checks/dotfiles-worktree-provisioner.ts)
 * use different stdio shapes; a unifying options-param refactor is Tier 2.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Run a `git` subprocess in `cwd` with the given args.
 *
 * stdio: ["ignore", "pipe", "pipe"] — discards stdin, captures stdout +
 * stderr into the returned `SpawnSyncReturns.stdout` / `.stderr` buffers.
 *
 * Caller is responsible for: checking `result.status` (or `result.error`
 * for spawn failure), decoding buffers via `decodeStdio`, and handling
 * non-zero exits.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
): SpawnSyncReturns<Buffer> {
  return spawnSync("git", [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Normalize a `SpawnSyncReturns.stdout` / `.stderr` value to a trimmed
 * UTF-8 string. Handles all 4 surface shapes:
 *
 *   - null / undefined  → ""
 *   - string            → trimmed
 *   - Buffer            → toString("utf-8") + trimmed
 *
 * Used by runGit callers + (in cascade-rebase) runGh callers to extract
 * subprocess output without per-callsite null-handling.
 */
export function decodeStdio(buf: Buffer | string | null | undefined): string {
  if (buf === null || buf === undefined) return "";
  if (typeof buf === "string") return buf.trim();
  return buf.toString("utf-8").trim();
}
