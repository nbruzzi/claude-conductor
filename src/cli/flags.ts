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
 * - Standalone-flag forms for `--json`/`--quiet`/`--help`.
 * - Value-consuming flags (`--since-mtime <value>`) added in Phase 2 Slice 8.
 * - Unknown flags pass through as positional. Verbs that want strict
 *   validation can check `positional` for unexpected `--*` entries.
 * - The spec controls which flags this verb accepts. Default accepts all.
 * - **Pure parser:** no DieContext threading, no die() calls. Validation
 *   errors return as `parseErrors: string[]`; callers decide how to surface
 *   (channels/cli.ts uses `die(ctx, ...)`, todos/cli.ts uses its own
 *   `die(msg)`). Layering: flags.ts is consumed by both; neither downstream
 *   die signature is the wrong choice for the other.
 */

export type FlagSpec = {
  /** Accept `--json` to switch output mode to structured JSON. */
  readonly json?: boolean;
  /** Accept `--quiet` to suppress non-error output. */
  readonly quiet?: boolean;
  /** Accept `--help` / `-h` to print the verb's help text. */
  readonly help?: boolean;
  /**
   * Accept `--since-mtime <value>` (consumes next argv) — value is epoch
   * ms (`/^\d+$/`) OR ISO 8601 (`/^\d{4}-\d{2}-\d{2}/`). Phase 2 Slice 8.
   */
  readonly sinceMtime?: boolean;
  /**
   * Accept `--since-cursor` (no value — uses stored cursor at
   * `<channel-dir>/last-seen/<sid>.json`). Phase 2 Slice 8. Mutually
   * exclusive with `--since-mtime`.
   */
  readonly sinceCursor?: boolean;
};

export type FlagValues = {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly help: boolean;
  /**
   * Resolved `--since-mtime` value as epoch ms. `undefined` when flag
   * absent. ISO 8601 input is converted to ms via `Date.parse`. Strict
   * validation: integer >= 1, <= MAX_SAFE_INTEGER (digits-only — rejects
   * scientific notation, decimals, signs); ISO requires `^\d{4}-\d{2}-\d{2}`
   * prefix (rejects ambiguous strings).
   */
  readonly sinceMtime: number | undefined;
  /** True when `--since-cursor` was present. */
  readonly sinceCursor: boolean;
};

const DEFAULT_SPEC: Required<FlagSpec> = {
  json: true,
  quiet: true,
  help: true,
  sinceMtime: false,
  sinceCursor: false,
};

export type ParsedFlags = {
  /** Args left over after flag extraction. Preserves order. */
  readonly positional: readonly string[];
  /** Which flags fired (false if absent; resolved values for value-flags). */
  readonly flags: FlagValues;
  /**
   * Validation errors accumulated during parse. Caller surfaces via its
   * domain-specific die(). Empty when all flags parsed successfully.
   */
  readonly parseErrors: readonly string[];
};

/**
 * Parse standard CLI flags from an argv tail. Returns positional args
 * (flags removed), resolved flag values, and accumulated parse errors.
 *
 * `--quiet` is mutually compatible with `--json`: `--json --quiet` would
 * suppress informational stdout but still emit structured output for the
 * caller's primary value, and stderr errors still surface as JSON.
 *
 * `--since-mtime <value>` and `--since-cursor` are mutually exclusive
 * (CLI-3 closure): passing both is a parse error.
 */
export function parseFlags(
  argv: readonly string[],
  spec: FlagSpec = DEFAULT_SPEC,
): ParsedFlags {
  const acceptJson = spec.json ?? DEFAULT_SPEC.json;
  const acceptQuiet = spec.quiet ?? DEFAULT_SPEC.quiet;
  const acceptHelp = spec.help ?? DEFAULT_SPEC.help;
  const acceptSinceMtime = spec.sinceMtime ?? DEFAULT_SPEC.sinceMtime;
  const acceptSinceCursor = spec.sinceCursor ?? DEFAULT_SPEC.sinceCursor;

  const positional: string[] = [];
  const parseErrors: string[] = [];
  let json = false;
  let quiet = false;
  let help = false;
  let sinceMtime: number | undefined = undefined;
  let sinceCursor = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (acceptJson && arg === "--json") {
      json = true;
    } else if (acceptQuiet && arg === "--quiet") {
      quiet = true;
    } else if (acceptHelp && (arg === "--help" || arg === "-h")) {
      help = true;
    } else if (acceptSinceMtime && arg === "--since-mtime") {
      const next = argv[i + 1];
      if (next === undefined || next.length === 0 || next.startsWith("--")) {
        parseErrors.push(
          `--since-mtime: expected non-negative integer milliseconds or ISO 8601 timestamp, got missing value`,
        );
        // Don't consume next; let it parse normally as positional/flag.
      } else {
        const parsed = parseSinceMtimeValue(next);
        if (parsed === null) {
          parseErrors.push(
            `--since-mtime: expected non-negative integer milliseconds or ISO 8601 timestamp, got "${next}"`,
          );
        } else {
          sinceMtime = parsed;
        }
        i += 1; // Consume the value regardless (success or fail) so it's not treated as positional.
      }
    } else if (acceptSinceCursor && arg === "--since-cursor") {
      sinceCursor = true;
    } else {
      positional.push(arg);
    }
  }

  if (sinceMtime !== undefined && sinceCursor) {
    parseErrors.push(
      `--since-mtime and --since-cursor are mutually exclusive — pass only one`,
    );
  }

  return {
    positional,
    flags: { json, quiet, help, sinceMtime, sinceCursor },
    parseErrors,
  };
}

/**
 * Parse a `--since-mtime` value as either epoch ms or ISO 8601. Returns
 * the resolved ms number, or null on validation failure.
 *
 * Validation rules (RE-2 + CLI-6 + RE-14 closures):
 * - ISO path: value matches `/^\d{4}-\d{2}-\d{2}/` (require ISO-date prefix
 *   to avoid ambiguous strings like `1-foo`); `Date.parse` must yield a
 *   finite positive ms value.
 * - Integer path: value matches `/^\d+$/` (digits only — rejects leading
 *   `+`/`-`, scientific notation, decimals, empty string); `parseInt`
 *   must yield an integer in `[1, Number.MAX_SAFE_INTEGER]` (CLI-9: 0 is
 *   rejected as ambiguous "rebase-to-now" intent that the caller should
 *   express via no flag).
 */
function parseSinceMtimeValue(raw: string): number | null {
  // ISO path — require date-prefix (`YYYY-MM-DD`).
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms >= 1) return ms;
    return null;
  }
  // Integer path — strict digits-only, range [1, MAX_SAFE_INTEGER].
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= Number.MAX_SAFE_INTEGER) return n;
    return null;
  }
  return null;
}
