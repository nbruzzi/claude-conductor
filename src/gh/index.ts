// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared `gh` (GitHub CLI) subprocess wrappers.
 *
 * Slice 0 origin (plan ~/.claude/plans/slice-0-cascade-rebase-2026-05-19.md
 * §D2 + Q12 Option X): introduces the `gh` subprocess pattern to the
 * plugin. `pr cascade-rebase` + Slice 3 audit-queue + future consumers
 * share this hand-rolled wrapper. Convention parallels `src/git/runGit`:
 * cmd-array form (injection-safe), captured stdout + stderr.
 *
 * Auth prereq: caller must verify `gh auth status` succeeds upstream
 * before invoking other `gh` verbs. cascade-rebase Phase 0a wires it.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/**
 * Run a `gh` subprocess with the given args.
 *
 * stdio: ["ignore", "pipe", "pipe"] — discards stdin, captures stdout +
 * stderr. `gh` is repo-context-aware via the process cwd (callers do not
 * pass an explicit cwd; the inherited cwd determines the target repo via
 * the local remote config). For repo-explicit calls, callers pass `--repo
 * <owner>/<name>` in args.
 *
 * Caller is responsible for: checking `result.status`, decoding buffers
 * via `decodeStdio` from `src/git/index.ts`, parsing JSON output via
 * `JSON.parse(decodeStdio(result.stdout))`, and handling non-zero exits.
 */
export function runGh(args: readonly string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("gh", [...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
