// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 1 — `CLAUDE_CONDUCTOR_DISABLE_HOOKS` env-var parser.
 *
 * Operator emergency-stop primitive: comma-separated hook names, validated
 * against the full sealed registry, **fail-OPEN with breadcrumb** on any
 * misuse (typo, blocking-hook disable, empty-after-trim).
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 1.1.
 * Backlog: wiki/backlog.md `dispatcher-kill-switch` (CLI-W2-1 deferral).
 * Decision: decisions/phase-3.md Decisions A + B + C.
 *
 * **Composition rule** (canonical source-of-truth — runbook + DispatchContext
 * docstring quote this):
 *
 *   1. Profile-filter applies first (set by HOOK_PROFILE).
 *   2. Env-var-disable applies second (set by CLAUDE_CONDUCTOR_DISABLE_HOOKS).
 *   3. `--check=NAME` isolation applies third (manual CLI only).
 *
 *   A check is skipped if ANY of (1), (2), (3) excludes it. File-toggle
 *   kill-switches (`~/.claude/<hook-name>-off`, `~/.claude/test-gate-on`)
 *   compose orthogonally — each individual hook checks them in its own
 *   `check()` body. The env-var-disable list trumps these: if the env var
 *   lists `test-gate`, the dispatcher skips it before the hook's `check()`
 *   body runs, so the file-toggle is never read.
 *
 * **INVARIANT**: if `raw` is non-undefined and non-empty after trim, AT
 * LEAST ONE of `disabled`, `unknown`, `cross_event` MUST be non-empty,
 * OR `stderrLines` MUST include the empty-after-trim message. A result
 * of all-empty fields for a non-empty raw input is a parser bug (silent
 * swallow). Tests assert this invariant.
 */

const EMPTY_AFTER_TRIM_MSG =
  "CLAUDE_CONDUCTOR_DISABLE_HOOKS is set but resolved to empty disable list (after trim/split). No hooks disabled. Set to a comma-separated list of hook names or unset the variable.";

/**
 * Per-name classification result.
 *
 * @property name           The trimmed hook name as the operator wrote it.
 * @property actual_events  Events the name is registered for (only set when
 *                          the name exists in the registry but doesn't run
 *                          on the dispatcher's currentEvent).
 */
export type CrossEventEntry = {
  readonly name: string;
  readonly actual_events: readonly string[];
};

/**
 * Result of parsing the env var. Non-discriminated by design — fail-OPEN
 * semantics mean every error class is tracked alongside any valid disables
 * (partial-success). Consumer iterates fields independently.
 */
export type DisableHooksResult = {
  /** Names to actually skip — intersection of (raw input ∩ knownNames ∩ runs-on-currentEvent). */
  readonly disabled: ReadonlySet<string>;
  /** Names that didn't match any known check — logged but NOT applied. */
  readonly unknown: readonly string[];
  /**
   * Names that match a check on a DIFFERENT event than the dispatcher's
   * currentEvent. The name IS valid in the registry, just not for THIS
   * invocation. Will be applied when dispatcher fires for the right event
   * (assuming env var is still set then).
   */
  readonly cross_event: readonly CrossEventEntry[];
  /**
   * Pre-formatted stderr lines the dispatcher should print BEFORE any
   * hook fires. Includes "did-you-mean" fuzzy suggestions, blocking-hook
   * louder warnings, empty-after-trim message, cross-event hints. One
   * concern, one line.
   */
  readonly stderrLines: readonly string[];
  /**
   * Breadcrumb events the dispatcher should append via
   * appendPresenceFailure. Each carries `source: "dispatcher"` and
   * `kind: "kill-switch"`.
   */
  readonly breadcrumbs: readonly { readonly detail: string }[];
};

/**
 * Parse `CLAUDE_CONDUCTOR_DISABLE_HOOKS` env var.
 *
 * @param raw           process.env["CLAUDE_CONDUCTOR_DISABLE_HOOKS"] (string | undefined).
 * @param knownNames    Full union from the sealed registry across all events.
 * @param blockingNames Subset of knownNames where canBlock=true.
 * @param nameToEvents  Map: name → events[] for cross-event hint computation.
 * @param currentEvent  Dispatcher's current event. Only names that run on
 *                      this event end up in `disabled`; other-event names
 *                      go to `cross_event`.
 */
export function parseDisableHooksEnv(
  raw: string | undefined,
  knownNames: ReadonlySet<string>,
  blockingNames: ReadonlySet<string>,
  nameToEvents: ReadonlyMap<string, readonly string[]>,
  currentEvent: string,
): DisableHooksResult {
  // Path 1: env not set or whitespace-only. Operator didn't intend anything;
  // return empty result with NO breadcrumbs (no env set ≠ misconfig).
  if (raw === undefined || raw.trim() === "") {
    return {
      disabled: new Set(),
      unknown: [],
      cross_event: [],
      stderrLines: [],
      breadcrumbs: [],
    };
  }

  // Split, trim, drop empties (tolerates trailing commas + whitespace).
  const tokens: string[] = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Path 2: env set but tokens-after-trim is empty (just commas/whitespace).
  // Fail-loud per RE-5 / CLI-DX-4 — silent no-op defeats the loud-fail premise.
  if (tokens.length === 0) {
    return {
      disabled: new Set(),
      unknown: [],
      cross_event: [],
      stderrLines: [EMPTY_AFTER_TRIM_MSG],
      breadcrumbs: [{ detail: EMPTY_AFTER_TRIM_MSG }],
    };
  }

  // Path 3: classify each token.
  const disabled = new Set<string>();
  const unknownSet = new Set<string>(); // dedup unknowns
  const crossEventMap = new Map<string, readonly string[]>(); // dedup cross-events
  const blockingDisabled: string[] = []; // for louder warning

  for (const name of tokens) {
    if (knownNames.has(name)) {
      const events = nameToEvents.get(name) ?? [];
      if (events.includes(currentEvent)) {
        // Valid + runs on this event → apply.
        if (!disabled.has(name)) {
          disabled.add(name);
          if (blockingNames.has(name)) blockingDisabled.push(name);
        }
      } else {
        // Valid but cross-event → hint, not disable.
        if (!crossEventMap.has(name)) {
          crossEventMap.set(name, events);
        }
      }
    } else {
      unknownSet.add(name);
    }
  }

  // Build stderrLines + breadcrumbs.
  const stderrLines: string[] = [];
  const breadcrumbs: { readonly detail: string }[] = [];

  if (unknownSet.size > 0) {
    const lines = formatUnknownLines([...unknownSet], knownNames);
    stderrLines.push(...lines);
    breadcrumbs.push({
      detail: `unknown hook name(s): ${[...unknownSet].join(", ")}`,
    });
  }

  if (crossEventMap.size > 0) {
    for (const [name, events] of crossEventMap) {
      stderrLines.push(formatCrossEventLine(name, events, currentEvent));
    }
    breadcrumbs.push({
      detail: `cross-event hint(s) for current event "${currentEvent}": ${[...crossEventMap.keys()].join(", ")}`,
    });
  }

  if (blockingDisabled.length > 0) {
    for (const name of blockingDisabled) {
      stderrLines.push(formatBlockingWarning(name));
    }
    breadcrumbs.push({
      detail: `BLOCKING hook(s) disabled by env var: ${blockingDisabled.join(", ")}`,
    });
  }

  return {
    disabled,
    unknown: [...unknownSet],
    cross_event: [...crossEventMap].map(([name, actual_events]) => ({
      name,
      actual_events,
    })),
    stderrLines,
    breadcrumbs,
  };
}

/**
 * Format the stderr lines for one or more unknown hook names.
 *
 * Single unknown → one block; multiple → enumerated block per CLI-DX-1.
 * Each unknown gets a Levenshtein-1 fuzzy "did you mean" suggestion when
 * a known name within edit-distance 1 exists.
 */
function formatUnknownLines(
  unknowns: readonly string[],
  knownNames: ReadonlySet<string>,
): readonly string[] {
  if (unknowns.length === 1) {
    const name = unknowns[0] ?? "";
    const suggestion = fuzzyMatch(name, knownNames);
    const lines: string[] = [
      `CLAUDE_CONDUCTOR_DISABLE_HOOKS unknown hook name: "${name}"`,
    ];
    if (suggestion !== null) {
      lines.push(`  Did you mean: "${suggestion}"?`);
    }
    lines.push(
      "  Run the dispatcher's --list to see all valid names.",
      "  Continuing with no hooks disabled (fail-open).",
    );
    return lines;
  }

  // Multi-name enumeration in ONE pass (not first-match-wins per CLI-DX-1).
  const header = `CLAUDE_CONDUCTOR_DISABLE_HOOKS contains ${unknowns.length} unknown hook names:`;
  const rows: string[] = unknowns.map((name) => {
    const suggestion = fuzzyMatch(name, knownNames);
    return suggestion !== null
      ? `  - "${name}"   Did you mean: "${suggestion}"?`
      : `  - "${name}"`;
  });
  return [
    header,
    ...rows,
    "  Run the dispatcher's --list to see all valid names.",
    "  Continuing with no hooks disabled from this env value (fail-open).",
  ];
}

/**
 * Format the cross-event hint line for one name.
 *
 * Wording per CLI-DX-NEW-1 + RE-NEW-3 — explicit about the conditional
 * nature ("IF env var is still set") and the operator's recourse.
 */
function formatCrossEventLine(
  name: string,
  actualEvents: readonly string[],
  currentEvent: string,
): string {
  const eventList = actualEvents.join(", ");
  return `CLAUDE_CONDUCTOR_DISABLE_HOOKS contains "${name}" but it does not run on the current event "${currentEvent}". This name is valid for: ${eventList}. No effect on this event; the disable will apply when dispatcher fires for ${eventList} IF the env var is still set at that time.`;
}

/**
 * Format the blocking-hook louder warning per Bravo C4.
 *
 * Repeated per dispatch (no rate-limit) by design — the audit trail is
 * the loud-on-every-fire stderr + the persistent breadcrumb log.
 */
function formatBlockingWarning(name: string): string {
  return `WARNING: CLAUDE_CONDUCTOR_DISABLE_HOOKS is disabling BLOCKING hook "${name}". Safety gates are off for this hook. This message will repeat on every dispatch until the env var is cleared. To disable individually with audit trail: touch ~/.claude/${name}-off (Logged to ~/.claude/logs/.presence-gate-failures.log with kind="kill-switch" for post-incident audit.)`;
}

/**
 * Levenshtein-1 fuzzy match. Returns the closest known name within edit
 * distance 1 of `name`, or null if no such match exists.
 *
 * Distance 1 only — covers single-character typos (insertion / deletion /
 * substitution). Distance 2+ is too permissive ("foo" → "bar" is 3 edits;
 * "destructive-cmd" → "constructive-cmd" is 1 — the intent matters).
 */
function fuzzyMatch(
  name: string,
  knownNames: ReadonlySet<string>,
): string | null {
  for (const known of knownNames) {
    if (editDistance(name, known) === 1) return known;
  }
  return null;
}

/**
 * Compute Levenshtein edit distance between two strings, with early exit
 * once the running distance exceeds 1 (we only care about ≤ 1).
 *
 * Linear-space DP — O(min(a, b)) memory, O(a × b) time, but bounded by
 * the early exit so worst case is small for the typical case (similar
 * strings).
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const lengthDiff = Math.abs(a.length - b.length);
  if (lengthDiff > 1) return 2; // pre-screen: distance ≥ lengthDiff

  // Two-row DP with early exit.
  const m = a.length;
  const n = b.length;
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let minRow = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const insert = (curr[j - 1] ?? 0) + 1;
      const del = (prev[j] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(insert, del, sub);
      const c = curr[j] ?? 0;
      if (c < minRow) minRow = c;
    }
    if (minRow > 1) return 2; // early exit — distance will only grow
    [prev, curr] = [curr, prev];
  }

  return prev[n] ?? 2;
}

/** Internal exports for test access. */
export const INTERNAL = {
  EMPTY_AFTER_TRIM_MSG,
  fuzzyMatch,
  editDistance,
  formatUnknownLines,
  formatCrossEventLine,
  formatBlockingWarning,
};
