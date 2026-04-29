// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TS subcommand resolver for the claude-conductor binary.
 *
 * Routes top-level subcommands (`channels`, `todos`) to per-domain CLI
 * scripts via Bun.spawnSync. The bash dispatcher at bin/claude-conductor
 * invokes this with the full argv.
 *
 * Per Phase 1 plan v2 §Slice 0 (Phase 0 gap surfaced by Wave 0 audit
 * CLI-DX-CRIT-2 — recovery hints in error messages reference a binary
 * that didn't exist).
 *
 * Design choice: spawn over import. The per-domain CLIs (`channels/cli.ts`,
 * `todos/cli.ts`) end with `await main();` at module scope — they are
 * scripts, not libraries. Importing them would execute main() at import
 * time, which is not the dispatcher's job. spawnSync gives the sub-CLI a
 * clean process with isolated stdin/stdout/exit-code. Bun.spawnSync's
 * cmd-array form (NOT shell-string) is injection-safe by construction.
 */

import { dirname, join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const PACKAGE_ROOT = dirname(dirname(SCRIPT_DIR));

const SUBCOMMANDS = {
  channels: join(PACKAGE_ROOT, "src", "channels", "cli.ts"),
  todos: join(PACKAGE_ROOT, "src", "todos", "cli.ts"),
} as const satisfies Record<string, string>;

type Subcommand = keyof typeof SUBCOMMANDS;

function isSubcommand(s: string): s is Subcommand {
  return s in SUBCOMMANDS;
}

function printHelp(): void {
  process.stdout.write(
    [
      "claude-conductor — disciplined multi-agent coordination for Claude Code",
      "",
      "Usage:",
      "  claude-conductor <subcommand> [args...]",
      "  claude-conductor --help | -h",
      "",
      "Subcommands:",
      "  channels   Channel coordination operations (create/join/send/read/...)",
      "  todos      Per-handoff todo state (read-active/count-active/exists/...)",
      "",
      "Run 'claude-conductor <subcommand> --help' for subcommand details.",
      "",
      "Phase 1 status: presence/active-sessions verb routing deferred to a",
      "later phase. Direct invocation via 'bun run src/active-sessions/cli.ts'",
      "(in dotfiles canonical) remains the supported path until then.",
    ].join("\n") + "\n",
  );
}

function printUnknown(subcommand: string): void {
  process.stderr.write(
    `claude-conductor: unknown subcommand '${subcommand}'\n` +
      `Run 'claude-conductor --help' for usage.\n`,
  );
}

// Flags that propagate to the spawned subcommand regardless of where the
// operator types them. Pulling them out of pre-verb position (then re-
// appending to subArgs) means `claude-conductor --json channels meta x`
// and `claude-conductor channels meta x --json` both reach the verb's
// parseFlags with --json present. Position-insensitivity matters because
// every per-domain CLI's structured-output mode hangs off these flags.
const PROPAGATED_FLAGS = new Set(["--json", "--quiet"]);

function partitionPreVerbFlags(argv: readonly string[]): {
  propagated: readonly string[];
  remaining: readonly string[];
} {
  const propagated: string[] = [];
  const remaining: string[] = [];
  let foundCmd = false;
  for (const arg of argv) {
    if (foundCmd) {
      remaining.push(arg);
      continue;
    }
    if (PROPAGATED_FLAGS.has(arg)) {
      propagated.push(arg);
      continue;
    }
    remaining.push(arg);
    foundCmd = true;
  }
  return { propagated, remaining };
}

const rawArgv = process.argv.slice(2);
const { propagated, remaining } = partitionPreVerbFlags(rawArgv);
const subcommand = remaining[0];

if (
  subcommand === undefined ||
  subcommand === "--help" ||
  subcommand === "-h" ||
  subcommand === "help"
) {
  printHelp();
  process.exit(0);
}

if (!isSubcommand(subcommand)) {
  printUnknown(subcommand);
  process.exit(1);
}

const targetScript = SUBCOMMANDS[subcommand];
const subArgs = [...remaining.slice(1), ...propagated];

const result = Bun.spawnSync({
  cmd: ["bun", targetScript, ...subArgs],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(result.exitCode ?? 1);
