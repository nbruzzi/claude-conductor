#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — D-ARCH5 slash-command prelude resolver CLI.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §Slash command
 * audit + §Path resolution helper.
 *
 * P0 follow-up (backlog L:894, 2026-05-17): `--print` mode added so slash
 * commands can drop `eval "$(...)"` and use plain `VAR=$(... --print)`
 * direct-assign. Removes the 27-prompts-per-session eval permission tax.
 *
 * Usage:
 *   bun run src/cli/resolve-dotfiles-root.ts --print [--session-id <uuid>]
 *
 *     Preferred path. Prints the resolved dotfiles root on a single
 *     newline-terminated line. No shell escaping; no `export` keyword.
 *     Callers assign directly:
 *       VAR="$(bun run ... --print --session-id "$CLAUDE_SESSION_ID")"
 *
 *   bun run src/cli/resolve-dotfiles-root.ts --session-id <uuid>
 *
 *     Legacy default (unchanged for backwards-compat). Emits a single
 *     `export CLAUDE_DOTFILES_ROOT_RESOLVED='<resolved-path>'` line for
 *     shell eval consumers. Preserved so any operator scripts still using
 *     `eval "$(...)"` continue to work; new callers should prefer `--print`.
 *
 *   bun run src/cli/resolve-dotfiles-root.ts --help
 *   bun run src/cli/resolve-dotfiles-root.ts -h
 *
 *     Print usage block on stdout. Exit 0.
 *
 * Output contract:
 *
 *   --print mode: exactly one line, newline-terminated, no trailing
 *     whitespace; content is the resolved absolute path. No shell escaping
 *     (single-line path; embedded newlines unreachable via os.path.join
 *     construction in the resolver).
 *
 *   Legacy mode: exactly one line, newline-terminated, of the shape
 *     `export CLAUDE_DOTFILES_ROOT_RESOLVED=<shell-escaped-path>`.
 *
 * Exit codes:
 *
 *   0 — success (either output mode, or `--help`)
 *   2 — argv parse error (unknown flag, missing required value, malformed
 *       `--session-id`); error message on stderr; nothing on stdout. Slash
 *       command preludes' `|| { ... fallback ... }` chain handles this.
 *
 * Failure mode (REV 0.2 ARCH-5 + L:894 DEFAULT-1 CLI breadcrumb fold):
 *   If this CLI fails for any reason (broken lockfile, missing exports map
 *   entry, plugin not yet `bun install`'d), bun produces an exit non-zero
 *   and nothing usable on stdout. Slash command preludes now breadcrumb the
 *   failure to stderr (DEFAULT-1 CLI fold) before falling through to
 *   `${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}`. Silent absence of the
 *   var is replaced with an explicit "[prelude] resolver failed; falling
 *   back" line so operators can distinguish "plugin not bootstrapped" from
 *   "plugin substrate corrupted."
 *
 * Slash command preludes (post-L:894):
 *
 *   CLAUDE_DOTFILES_ROOT_RESOLVED="$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --print --session-id "${CLAUDE_SESSION_ID:-}" 2>/dev/null)" \
 *     || { echo "[prelude] resolve-dotfiles-root failed; falling back" >&2; CLAUDE_DOTFILES_ROOT_RESOLVED=""; }
 *   cd "${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}"
 *
 * The integration test `test/integration/slash-command-prelude.test.ts`
 * exercises legacy + `--print` + `--help` + argv-parse-error paths.
 */

import { dotfilesRoot } from "../shared/dotfiles-root.ts";

type ParsedArgs =
  | { kind: "help" }
  | { kind: "resolve"; print: boolean; sessionId: string | null }
  | { kind: "error"; detail: string };

const HELP_TEXT = `Usage:
  resolve-dotfiles-root.ts --print [--session-id <uuid>]
  resolve-dotfiles-root.ts --session-id <uuid>          (legacy export form)
  resolve-dotfiles-root.ts --help | -h

Flags:
  --print              Emit the resolved dotfiles root path on a single line,
                       no shell escaping. Preferred for direct-assign callers:
                         VAR="$(... --print)"
  --session-id <uuid>  Session id used by tier-2 (heartbeat-body) resolution.
                       Optional; tiers 1/3/4 still work without it.
  --help, -h           Print this usage block and exit 0.

Without --print, emits a single \`export CLAUDE_DOTFILES_ROOT_RESOLVED=...\` line
suitable for shell \`eval\`. Preserved for backwards-compat; new callers should
prefer --print.

Exit codes:
  0  success
  2  argv parse error (unknown flag, missing/malformed --session-id value)
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  let print = false;
  let sessionId: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--print") {
      print = true;
      continue;
    }
    if (arg === "--session-id") {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        return {
          kind: "error",
          detail:
            "--session-id requires a non-empty value (got missing or flag-prefixed)",
        };
      }
      sessionId = value;
      i++;
      continue;
    }
    return { kind: "error", detail: `unknown flag: ${arg ?? "(empty)"}` };
  }

  return { kind: "resolve", print, sessionId };
}

function shellEscape(s: string): string {
  // Single-quote-wrap and replace any embedded single quotes with the
  // standard `'\''` escape. This is shell-injection-safe for any
  // arbitrary path string under bash / zsh / sh.
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.kind === "error") {
    process.stderr.write(`resolve-dotfiles-root: ${parsed.detail}\n`);
    process.exit(2);
  }

  if (parsed.kind === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }

  // Resolve unconditionally — even with no sessionId, the resolver falls
  // through to env / default per Bravo B8 spec. Empty sessionId means we
  // can't read tier 2 (heartbeat-body sentinel), but tiers 1/3/4 still
  // work and that's an honest answer for a slash command without an
  // active CLAUDE_SESSION_ID.
  const resolved = dotfilesRoot(parsed.sessionId ?? undefined);

  if (parsed.print) {
    process.stdout.write(`${resolved}\n`);
    return;
  }

  process.stdout.write(
    `export CLAUDE_DOTFILES_ROOT_RESOLVED=${shellEscape(resolved)}\n`,
  );
}

main();
