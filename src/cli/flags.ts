// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared CLI flag-parsing infrastructure.
 *
 * Per Phase 1 plan v2 §Slice 4 (CLI-DX-MAJ-3 — die() rewrite + flag-parsing
 * infra). Single point of truth for the standard CLI flags `--json`,
 * `--quiet`, `--help` (alias `-h`) so each per-domain CLI verb doesn't
 * reinvent the parser.
 *
 * Design:
 * - Minimal: standalone-flag forms only (no `--key=value`). Each verb
 *   accepts richer args via the returned `positional` array.
 * - Unknown flags pass through as positional. Verbs that want strict
 *   validation can check `positional` for unexpected `--*` entries.
 * - The spec controls which flags this verb accepts. Default accepts all.
 */

export type FlagSpec = {
  /** Accept `--json` to switch output mode to structured JSON. */
  readonly json?: boolean;
  /** Accept `--quiet` to suppress non-error output. */
  readonly quiet?: boolean;
  /** Accept `--help` / `-h` to print the verb's help text. */
  readonly help?: boolean;
};

export type FlagValues = {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly help: boolean;
};

const DEFAULT_SPEC: Required<FlagSpec> = {
  json: true,
  quiet: true,
  help: true,
};

export type ParsedFlags = {
  /** Args left over after flag extraction. Preserves order. */
  readonly positional: readonly string[];
  /** Which flags fired (false if absent). */
  readonly flags: FlagValues;
};

/**
 * Parse standard CLI flags from an argv tail. Returns positional args
 * (flags removed) plus the resolved flag values.
 *
 * `--quiet` is mutually compatible with `--json`: `--json --quiet` would
 * suppress informational stdout but still emit structured output for the
 * caller's primary value, and stderr errors still surface as JSON.
 */
export function parseFlags(
  argv: readonly string[],
  spec: FlagSpec = DEFAULT_SPEC,
): ParsedFlags {
  const acceptJson = spec.json ?? DEFAULT_SPEC.json;
  const acceptQuiet = spec.quiet ?? DEFAULT_SPEC.quiet;
  const acceptHelp = spec.help ?? DEFAULT_SPEC.help;

  const positional: string[] = [];
  let json = false;
  let quiet = false;
  let help = false;

  for (const arg of argv) {
    if (acceptJson && arg === "--json") {
      json = true;
    } else if (acceptQuiet && arg === "--quiet") {
      quiet = true;
    } else if (acceptHelp && (arg === "--help" || arg === "-h")) {
      help = true;
    } else {
      positional.push(arg);
    }
  }

  return {
    positional,
    flags: { json, quiet, help },
  };
}
