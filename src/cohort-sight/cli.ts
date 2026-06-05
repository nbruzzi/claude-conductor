#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI for the `cohort-sight` subcommand (D2) — a read-only captain board of
 * live sessions. Renders {@link buildCohortSight} (the harness
 * `~/.claude/sessions/<pid>.json` registry + the coordination channel
 * identities + a `kill(pid,0)` liveness probe) as a human table or `--json`.
 *
 * Usage:
 *   claude-conductor cohort-sight [--json] [--quiet]
 *   claude-conductor cohort-sight --help
 *
 * Mirrors src/pr/cli.ts shape; the impl lives in the sibling index.ts. The
 * dispatcher (src/cli/dispatcher.ts) routes `cohort-sight` here via spawnSync.
 * READ-ONLY: never mutates state — safe to run anytime, augment-only.
 */

import { parseFlags } from "../cli/flags.ts";
import { getWallClockNow } from "../shared/clock.ts";
import {
  buildCohortSight,
  type CohortSight,
  type CohortSightRow,
} from "./index.ts";

const HELP_TEXT = [
  "claude-conductor cohort-sight — read-only captain board of live sessions",
  "",
  "Usage:",
  "  claude-conductor cohort-sight [--json] [--quiet]",
  "  claude-conductor cohort-sight --help | -h",
  "",
  "Reads (ZERO writes): the harness per-session sessions/<pid>.json registry +",
  "the coordination channel identities, fused with a kill(pid,0) liveness probe.",
  "",
  "Columns: IDENTITY  PID  STATUS  ALIVE  AGE  CWD",
  "  STATUS  harness-declared busy/idle (unknown if absent)",
  "  ALIVE   kill(pid,0): the OS confirms the process exists",
  "  AGE     elapsed since the harness last updated the pidfile",
  "",
  "Flags: --json (structured output), --quiet (suppress the blind-spot footer)",
].join("\n");

/** Compact human age: "42s" / "7m" / "1h3m" / "—" when unknown. */
export function fmtAge(ageMs: number | null): string {
  if (ageMs === null) return "—";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function rowLine(r: CohortSightRow): string {
  return (
    (r.identity ?? "—").padEnd(9) +
    String(r.pid).padEnd(8) +
    r.status.padEnd(9) +
    (r.pidAlive ? "alive" : "DEAD").padEnd(7) +
    fmtAge(r.ageMs).padEnd(7) +
    (r.cwd ?? "—")
  );
}

export function renderTable(sight: CohortSight, quiet: boolean): string {
  const lines: string[] = [
    `cohort-sight @ ${new Date(sight.generatedAt).toISOString()} — channel '${sight.channel}' — ${sight.rows.length} session(s)`,
  ];
  if (sight.rows.length === 0) {
    lines.push("  (no live session pidfiles found)");
  } else {
    lines.push(
      "  " +
        "IDENTITY".padEnd(9) +
        "PID".padEnd(8) +
        "STATUS".padEnd(9) +
        "ALIVE".padEnd(7) +
        "AGE".padEnd(7) +
        "CWD",
    );
    for (const r of sight.rows) lines.push(`  ${rowLine(r)}`);
  }
  if (!quiet && sight.blindSpots.length > 0) {
    const detail = sight.blindSpots
      .map((b) => `${b.file}(${b.reason})`)
      .join(", ");
    lines.push(
      `  ! ${sight.blindSpots.length} unreadable pidfile(s): ${detail}`,
    );
  }
  return lines.join("\n");
}

export function runCohortSightCli(
  argv: readonly string[] = process.argv.slice(2),
): number {
  const first = argv[0];
  if (first === "help" || first === "--help" || first === "-h") {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  const parsed = parseFlags(argv, { json: true, quiet: true, help: true });
  if (parsed.parseErrors.length > 0) {
    for (const err of parsed.parseErrors) {
      process.stderr.write(`claude-conductor cohort-sight: ${err}\n`);
    }
    return 2;
  }
  if (parsed.flags.help === true) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  // cohort-sight takes no positional args — an unexpected one is a typo, not a
  // silent default-render. (Delta NIT-1 / Charlie shadow fold; cohort-sight is a
  // no-verb command, unlike pr/cli.ts whose positionals are verbs.)
  if (parsed.positional.length > 0) {
    process.stderr.write(
      `claude-conductor cohort-sight: unexpected argument(s): ${parsed.positional.join(" ")}\n`,
    );
    return 2;
  }

  const sight = buildCohortSight(getWallClockNow());

  if (parsed.flags.json === true) {
    process.stdout.write(`${JSON.stringify(sight, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${renderTable(sight, parsed.flags.quiet === true)}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(runCohortSightCli());
}
