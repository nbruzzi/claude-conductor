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
  /**
   * Accept `--as <NATO-identity>` (consumes next argv) — value passed
   * through verbatim; verb-level dispatch validates against `isValidIdentity`
   * (NATO letter Alpha..Zulu). P2 — `join --as <Identity>` flag for
   * named-claim semantics per plan giggly-bouncing-spark.md.
   */
  readonly as?: boolean;
  /**
   * Accept `--role <pen|queue|out>` (consumes next argv) — value passed
   * through verbatim; verb-level dispatch validates against the
   * `ChannelRole` union. Optional companion to `--as` for landing
   * directly in a role at claim time (default `queue`).
   */
  readonly role?: boolean;
  /**
   * Accept `--force` (standalone — no value). Operator-explicit takeover
   * commitment. Required for ALL `--as` takeovers per Decision §4 of plan
   * giggly-bouncing-spark.md (drops the staleness-auto path that would
   * false-positive on Monitor-wake-delayed sessions).
   */
  readonly force?: boolean;
  /**
   * Accept `--from-session <session-id>` (consumes next argv) — optional
   * CAS-check value for `--force` takeovers. Verb-level dispatch validates
   * via `isValidSessionId` and CAS-checks `meta.identities[<Letter>].session_id`
   * matches before takeover. Mismatch → die. Mitigates ping-pong-takeover
   * hazard for paranoid invocations (Decision §9).
   */
  readonly fromSession?: boolean;
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
  /**
   * Raw `--as <value>` string when flag was present and accepted, otherwise
   * `undefined`. Verb-level dispatch validates NATO-letter shape via
   * `isValidIdentity`.
   */
  readonly as: string | undefined;
  /**
   * Raw `--role <value>` string when flag was present and accepted,
   * otherwise `undefined`. Verb-level dispatch validates ChannelRole shape.
   */
  readonly role: string | undefined;
  /** True when `--force` was present and accepted. */
  readonly force: boolean;
  /**
   * Raw `--from-session <value>` string when flag was present and accepted,
   * otherwise `undefined`. Verb-level dispatch validates session-id shape
   * via `isValidSessionId` and CAS-checks against the held identity claim.
   */
  readonly fromSession: string | undefined;
};

const DEFAULT_SPEC: Required<FlagSpec> = {
  json: true,
  quiet: true,
  help: true,
  sinceMtime: false,
  sinceCursor: false,
  as: false,
  role: false,
  force: false,
  fromSession: false,
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
  const acceptAs = spec.as ?? DEFAULT_SPEC.as;
  const acceptRole = spec.role ?? DEFAULT_SPEC.role;
  const acceptForce = spec.force ?? DEFAULT_SPEC.force;
  const acceptFromSession = spec.fromSession ?? DEFAULT_SPEC.fromSession;

  const positional: string[] = [];
  const parseErrors: string[] = [];
  let json = false;
  let quiet = false;
  let help = false;
  let sinceMtime: number | undefined = undefined;
  let sinceCursor = false;
  let as: string | undefined = undefined;
  let role: string | undefined = undefined;
  let force = false;
  let fromSession: string | undefined = undefined;

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
    } else if (acceptAs && arg === "--as") {
      const consumed = consumeStringValue(argv, i, "--as", parseErrors);
      if (consumed.value !== undefined) as = consumed.value;
      i += consumed.advance;
    } else if (acceptRole && arg === "--role") {
      const consumed = consumeStringValue(argv, i, "--role", parseErrors);
      if (consumed.value !== undefined) role = consumed.value;
      i += consumed.advance;
    } else if (acceptForce && arg === "--force") {
      force = true;
    } else if (acceptFromSession && arg === "--from-session") {
      const consumed = consumeStringValue(
        argv,
        i,
        "--from-session",
        parseErrors,
      );
      if (consumed.value !== undefined) fromSession = consumed.value;
      i += consumed.advance;
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
    flags: {
      json,
      quiet,
      help,
      sinceMtime,
      sinceCursor,
      as,
      role,
      force,
      fromSession,
    },
    parseErrors,
  };
}

/**
 * Extract a value-consuming string flag from `argv` at position `i`. Used
 * by `--as`, `--role`, and `--from-session` per plan giggly-bouncing-spark.md
 * §change-list #1. The parser is value-extraction-only — domain validation
 * (NATO letter for `--as`, ChannelRole for `--role`, session-id shape for
 * `--from-session`) happens at verb-level dispatch.
 *
 * Returns `{ value, advance }`:
 * - `value`: the consumed string value, or `undefined` when missing/empty.
 * - `advance`: how many additional argv positions were consumed past `i`
 *   (0 if no value found — leaves the next arg to parse normally; 1 on
 *   successful value extraction).
 *
 * Pushes a parseError on missing value (matches the `--since-mtime`
 * "missing value" shape at flags.ts:122-125).
 */
function consumeStringValue(
  argv: readonly string[],
  i: number,
  flagName: string,
  parseErrors: string[],
): { value: string | undefined; advance: number } {
  const next = argv[i + 1];
  if (next === undefined || next.length === 0 || next.startsWith("--")) {
    parseErrors.push(`${flagName}: expected value, got missing value`);
    return { value: undefined, advance: 0 };
  }
  return { value: next, advance: 1 };
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
