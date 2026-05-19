#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for the `pr` subcommand (Slice 0 substrate).
 *
 * Usage:
 *   claude-conductor pr cascade-rebase --base <branch-name> [--dry-run] [--json] [--quiet]
 *   claude-conductor pr --help
 *
 * Slice 0 origin: plan ~/.claude/plans/slice-0-cascade-rebase-2026-05-19.md.
 * Forward-paves future `pr` verbs (e.g., `pr stack-show` Tier 2).
 *
 * Mirrors src/channels/cli.ts shape: thin verb-switch entry; impl lives in
 * the sibling `cascade-rebase.ts` module. The dispatcher (src/cli/dispatcher.ts)
 * routes `pr` here via Bun.spawnSync.
 */

import { parseFlags } from "../cli/flags.ts";
import { runCascadeRebase } from "./cascade-rebase.ts";

const HELP_TEXT = [
  "claude-conductor pr — pull-request operations",
  "",
  "Usage:",
  "  claude-conductor pr <verb> [args...] [flags...]",
  "  claude-conductor pr --help | -h",
  "",
  "Verbs:",
  "  cascade-rebase --base <branch> [--onto <branch>]",
  "                                  Rebase stacked PRs after a base PR squash-merges.",
  "                                  Sequential rebase + force-push-with-lease, then",
  "                                  parallel CI-watch. HALT-ON-FIRST-CONFLICT.",
  "                                  --base is stack-detection axis (the just-squashed branch).",
  "                                  --onto is rebase-target axis (default 'main').",
  "                                  Flags: --dry-run, --json, --quiet",
  "",
  "Run 'claude-conductor pr <verb> --help' for verb-specific help.",
].join("\n");

export async function runPrCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const verb = argv[0];

  if (
    verb === undefined ||
    verb === "help" ||
    verb === "--help" ||
    verb === "-h"
  ) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  // parseFlags consumes flags from argv-after-verb. Slice 0 enables:
  //   --base (value-consuming), --dry-run (standalone),
  //   + the standard --json / --quiet / --help propagated set.
  const parsed = parseFlags(argv.slice(1), {
    json: true,
    quiet: true,
    help: true,
    base: true,
    dryRun: true,
    onto: true,
  });

  if (parsed.parseErrors.length > 0) {
    for (const err of parsed.parseErrors) {
      process.stderr.write(`claude-conductor pr ${verb}: ${err}\n`);
    }
    return 2;
  }

  switch (verb) {
    case "cascade-rebase":
      return runCascadeRebase(parsed.positional, parsed.flags);
    default:
      process.stderr.write(
        `claude-conductor pr: unknown verb '${verb}'\n` +
          `Run 'claude-conductor pr --help' to list valid verbs.\n`,
      );
      return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runPrCli();
  process.exit(exitCode);
}
