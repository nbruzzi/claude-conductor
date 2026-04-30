#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — D-CLIDX2 worktrees inspector CLI.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §File
 * inventory `src/cli/worktrees-show.ts` + §Runbook scenario manifest §9
 * "Working from a second terminal".
 *
 * Usage:
 *   bun run src/cli/worktrees-show.ts <session-id>
 *
 * Output (human-readable to stdout):
 *   Session: <sid>
 *   Resolved DOTFILES_ROOT: <path>
 *   Heartbeat-body sentinel: <path or "(not pinned)">
 *   Canonical: <path>
 *   Live worktrees:
 *     - <path>  branch: <branch or "(detached)">  sid: <sid-prefix-8>
 *     ...
 *
 * Operator-facing — printed in the runbook §"Working from a second
 * terminal" recipe so an operator can `cd $(claude-conductor session
 * resolve-dotfiles-root --session-id <sid>)` after this command tells
 * them where the worktree lives.
 *
 * Errors print to stderr with exit code 1. The CLI verb is read-only;
 * never mutates state.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readSentinelDotfilesRoot } from "../active-sessions/index.ts";
import { dotfilesRoot } from "../shared/dotfiles-root.ts";
import { listWorktrees } from "../worktrees/index.ts";

function parseArgs(argv: readonly string[]): { sessionId: string } | null {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const sid = positional[0];
  if (sid === undefined || sid.length === 0) return null;
  return { sessionId: sid };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(
      "usage: claude-conductor worktrees show <session-id>\n",
    );
    process.exit(1);
  }

  const { sessionId } = args;
  const resolved = dotfilesRoot(sessionId);
  const sentinel = readSentinelDotfilesRoot(sessionId);
  const canonical =
    process.env["CLAUDE_DOTFILES_ROOT"] ?? join(homedir(), ".claude-dotfiles");
  const worktrees = listWorktrees(canonical);

  const lines: string[] = [
    `Session: ${sessionId}`,
    `Resolved DOTFILES_ROOT: ${resolved}`,
    `Heartbeat-body sentinel: ${sentinel ?? "(not pinned)"}`,
    `Canonical: ${canonical}`,
    "Live worktrees:",
  ];

  if (worktrees.length === 0) {
    lines.push("  (none)");
  } else {
    for (const wt of worktrees) {
      lines.push(
        `  - ${wt.path}  branch: ${wt.branch ?? "(detached)"}  sid: ${wt.sessionId}`,
      );
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
}

main();
