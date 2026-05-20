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
  pr: join(PACKAGE_ROOT, "src", "pr", "cli.ts"),
  audits: join(PACKAGE_ROOT, "src", "audits", "cli.ts"),
  bandwidth: join(PACKAGE_ROOT, "src", "bandwidth", "cli.ts"),
} as const satisfies Record<string, string>;

type Subcommand = keyof typeof SUBCOMMANDS;

function isSubcommand(s: string): s is Subcommand {
  return s in SUBCOMMANDS;
}

/** Subcommands documented in --help but deliberately not yet routed in this
 *  phase. Per Decision C: `presence`/active-sessions routing waits for the
 *  active-sessions module shimming (Phase 2 hooks layer). Hitting one of
 *  these prints a recovery hint pointing at the supported fallback path —
 *  beats the bare "unknown subcommand" wall (Wave 2 ARCH-W2-4).
 */
const KNOWN_DEFERRED: Record<string, string> = {
  presence: `'presence' verb routing is deferred to Phase 2 per decisions/phase-1.md Decision C. Until then, invoke the canonical CLI directly: cd "\${CLAUDE_DOTFILES_ROOT:-\$HOME/.claude-dotfiles}" && bun run src/active-sessions/cli.ts <verb>`,
};

/** Plugin version. Mirrors package.json:version. Hardcoded to avoid a runtime
 *  JSON read on every dispatcher invocation; CHANGELOG cap discipline keeps
 *  these in lockstep at tag time. Update both together. */
const VERSION = "0.1.0";

function printHelp(): void {
  process.stdout.write(
    [
      `claude-conductor v${VERSION} — disciplined multi-agent coordination for Claude Code`,
      "",
      "Usage:",
      "  claude-conductor [global-flags...] <subcommand> [args...]",
      "  claude-conductor <subcommand> [args...] [global-flags...]",
      "  claude-conductor --help | -h",
      "  claude-conductor --version | -V",
      "",
      "Subcommands:",
      "  channels   Channel coordination operations (create/join/send/read/...)",
      "  todos      Per-handoff todo state (read-active/count-active/exists/...)",
      "  pr         Pull-request operations (cascade-rebase/...)",
      "  audits     Audit-discipline queries (queue --for <identity>)",
      "  bandwidth  Derive identity bandwidth state from artifacts (show --for ...)",
      "",
      "Global flags (position-insensitive — accepted before or after subcommand):",
      "  --json     Emit structured JSON output where the subcommand supports it.",
      "  --quiet    Suppress non-essential informational stderr writes.",
      "  --help     Print this help (or per-subcommand help when paired with a verb).",
      "  --version  Print the plugin version and exit (also -V).",
      "",
      "Run 'claude-conductor <subcommand> --help' for subcommand details.",
      "",
      "Phase 1 status: presence/active-sessions verb routing deferred to a",
      "later phase per decisions/phase-1.md Decision C. Direct invocation via",
      "'bun run src/active-sessions/cli.ts' (in dotfiles canonical) remains",
      "the supported path until then.",
    ].join("\n") + "\n",
  );
}

function printVersion(): void {
  process.stdout.write(`claude-conductor ${VERSION}\n`);
}

function printUnknown(subcommand: string): void {
  process.stderr.write(
    `claude-conductor: unknown subcommand '${subcommand}'\n` +
      `Run 'claude-conductor --help' for usage.\n`,
  );
}

function printDeferred(subcommand: string, hint: string): void {
  process.stderr.write(`claude-conductor: ${hint}\n`);
  void subcommand;
}

// Flags that propagate to the spawned subcommand regardless of where the
// operator types them. Position-insensitive: `claude-conductor --json
// channels meta x`, `claude-conductor channels --json meta x`, and
// `claude-conductor channels meta x --json` all reach the verb's parseFlags
// with --json present. Wave 2 CLI-W2-1 widened this from pre-verb-only
// (which was a half-promise) to full-argv extraction.
const PROPAGATED_FLAGS = new Set(["--json", "--quiet"]);

function partitionPropagatedFlags(argv: readonly string[]): {
  propagated: readonly string[];
  remaining: readonly string[];
} {
  const propagated: string[] = [];
  const remaining: string[] = [];
  for (const arg of argv) {
    if (PROPAGATED_FLAGS.has(arg)) {
      propagated.push(arg);
    } else {
      remaining.push(arg);
    }
  }
  return { propagated, remaining };
}

const rawArgv = process.argv.slice(2);
const { propagated, remaining } = partitionPropagatedFlags(rawArgv);
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

if (subcommand === "--version" || subcommand === "-V") {
  printVersion();
  process.exit(0);
}

const deferredHint = KNOWN_DEFERRED[subcommand];
if (deferredHint !== undefined) {
  printDeferred(subcommand, deferredHint);
  process.exit(1);
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
