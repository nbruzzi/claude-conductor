#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — D-ARCH5 slash-command prelude eval CLI.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2 §Slash command
 * audit + §Path resolution helper.
 *
 * Usage:
 *   bun run src/cli/resolve-dotfiles-root.ts --session-id <uuid>
 *
 * Output (single line, for shell eval):
 *   export CLAUDE_DOTFILES_ROOT_RESOLVED='<resolved-path>'
 *
 * Slash commands (channel.md / handoff.md / handoff-resume.md /
 * presence.md) prepend a prelude:
 *
 *   eval "$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --session-id "$CLAUDE_SESSION_ID")"
 *   cd "${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}"
 *
 * Failure mode (REV 0.2 ARCH-5): if this CLI fails (broken lockfile,
 * missing exports map entry, plugin not yet `bun install`'d), the eval
 * produces empty stdout, `CLAUDE_DOTFILES_ROOT_RESOLVED` stays unset,
 * and the slash command's fallback chain (`$CLAUDE_DOTFILES_ROOT` env
 * → `$HOME/.claude-dotfiles` default) takes over. Silent fall-through
 * is by design — slash commands continue to work in degraded mode if
 * the plugin substrate is mis-installed.
 *
 * The integration test `test/integration/slash-command-prelude.test.ts`
 * (Commit 4) exercises both the success path AND the failure-fallthrough
 * to catch regressions where this CLI starts emitting noise on stdout.
 */

import { dotfilesRoot } from "../shared/dotfiles-root.ts";

function parseSessionId(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session-id" && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined && value.length > 0) return value;
    }
  }
  return null;
}

function shellEscape(s: string): string {
  // Single-quote-wrap and replace any embedded single quotes with the
  // standard `'\''` escape. This is shell-injection-safe for any
  // arbitrary path string under bash / zsh / sh.
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function main(): void {
  const sessionId = parseSessionId(process.argv.slice(2));
  // Resolve unconditionally — even with no sessionId, the resolver falls
  // through to env / default per Bravo B8 spec. Empty sessionId means we
  // can't read tier 2 (heartbeat-body sentinel), but tiers 1/3/4 still
  // work and that's an honest answer for a slash command without an
  // active CLAUDE_SESSION_ID.
  const resolved = dotfilesRoot(sessionId ?? undefined);
  process.stdout.write(
    `export CLAUDE_DOTFILES_ROOT_RESOLVED=${shellEscape(resolved)}\n`,
  );
}

main();
