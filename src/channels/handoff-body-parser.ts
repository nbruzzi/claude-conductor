// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Two parser surfaces for handoff documents:
 *
 *   (1) L141 — pure parser for channel-id references in a handoff BODY.
 *       Pre-existing surface; consumer is `handoff-resolver.ts`.
 *
 *   (2) PR-A5 — typed parser for handoff FRONTMATTER. Layer 2 lineage
 *       envelope extension per slice plan
 *       `cycle-1-substrate-extension-slice-plan-2026-05-26.md` §7 row 5.
 *       Consumer: future handoff-emitting skills (PR-A8) and handoff-
 *       reading callers currently grep'ing `ended_at:` ad-hoc
 *       (`src/pattern-trace/cli.ts` + `src/reciprocation/cli.ts`).
 *
 * Both surfaces are pure (file-reading wrappers throw on I/O failure;
 * core parsers operate on already-read strings for testability).
 */

import { readFileSync } from "node:fs";

import {
  parseLineageEnvelope,
  type LineageEnvelope,
} from "./lineage-envelope.ts";
import { isValidIdentity, type NatoIdentity } from "./identity.ts";

// ─────────────────────────────────────────────────────────────────
// L141 — channel-id body parser (pre-existing surface)
// ─────────────────────────────────────────────────────────────────

/**
 * Channel-id shape: `YYYY-MM-DD_HH-MM` optionally followed by
 * `-<slug>` where slug is alphanumeric + dash + underscore.
 *
 * Anchored (^...$) when applied to a single backtick-extracted
 * candidate string. The slug optional suffix accommodates lifecycle
 * variants without expanding regex complexity.
 */
const CHANNEL_ID_SHAPE =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}(?:-[a-zA-Z0-9_-]+)?$/u;

/**
 * Inline-code extraction: backtick-quoted content, non-greedy,
 * does not cross newlines. Standard markdown inline-code grammar.
 */
const INLINE_CODE = /`([^`\n]+)`/gu;

/**
 * Bold-keyword + bare-id extraction (T2X extension). Matches markdown
 * patterns where the channel id is NOT backticked:
 *
 *   - `**Channel:** 2026-05-18_10-50` (colon INSIDE bold) — pattern A1
 *   - `**Channel:**: 2026-05-18_10-50` (colon both inside and outside) — pattern A1
 *   - `**Channel**: 2026-05-18_10-50` (colon OUTSIDE bold) — pattern A2
 *   - `Channel: 2026-05-18_10-50` (plain key at line-start) — pattern B
 *
 * **At least one colon is REQUIRED.** Bold WITHOUT colon (`**Channel**
 * <id>`) is EXPLICITLY REJECTED — ambiguous prose could otherwise
 * false-match. The three alternation patterns encode the colon-required
 * invariant structurally rather than with optional `:?` (an earlier
 * `:?\*\*:?` triple-optional collapsed to "no colon at all matches").
 *
 * REQUIRED: minimum one whitespace between key and id
 * (`**Channel:**<id>` is REJECTED — see Neg T-12).
 *
 * Pattern A (bold-prefix) accepts anywhere on the line. Pattern B
 * (plain-prefix) anchors at line-start to avoid false-matching
 * mid-sentence "Channel: ..." prose. Captured `\S+` is shape-validated
 * through CHANNEL_ID_SHAPE so trailing punctuation is filtered (e.g.
 * `2026-05-18_10-50,` fails shape).
 */
const KEY_PREFIX_BARE_ID =
  /\*\*[A-Za-z][A-Za-z _-]*?:\*\*:?\s+(\S+)|\*\*[A-Za-z][A-Za-z _-]*?\*\*:\s+(\S+)|(?:^|\n)[A-Za-z][A-Za-z _-]*?:\s+(\S+)/gmu;

export function parseHandoffBodyForChannels(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // Collect matches from BOTH regex passes with their body-index, then
  // sort by index so dedup-by-first-occurrence respects document-reading
  // order across the two extraction passes. (Q1 disposition: sorted-index
  // merge — downstream resolver presents body-mentioned channels in
  // textual order to the operator.)
  const matches: Array<{ index: number; candidate: string }> = [];
  for (const m of body.matchAll(INLINE_CODE)) {
    if (m.index !== undefined && m[1] !== undefined) {
      matches.push({ index: m.index, candidate: m[1] });
    }
  }
  for (const m of body.matchAll(KEY_PREFIX_BARE_ID)) {
    if (m.index === undefined) continue;
    // Three alternation patterns: A1 (group 1), A2 (group 2), B (group 3).
    const candidate = m[1] ?? m[2] ?? m[3];
    if (candidate !== undefined) {
      matches.push({ index: m.index, candidate });
    }
  }
  matches.sort((a, b) => a.index - b.index);

  for (const { candidate } of matches) {
    if (!CHANNEL_ID_SHAPE.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }

  return out;
}

/**
 * File-reading wrapper. Throws on read error (ENOENT, EACCES, etc.).
 * Caller in `handoff-resolver.ts` catches + maps to a `derive-failed`
 * resolution result with a structured reason.
 */
export function parseHandoffBodyForChannelsFromFile(
  handoffPath: string,
): string[] {
  const body = readFileSync(handoffPath, "utf-8");
  return parseHandoffBodyForChannels(body);
}

// ─────────────────────────────────────────────────────────────────
// PR-A5 — handoff frontmatter parser (typed; lineage-extension surface)
// ─────────────────────────────────────────────────────────────────

/**
 * Cohort-arcs entry — used in bridge handoffs that span multiple cohort
 * arcs (observed in `HANDOFF_2026-05-26_01-35_bravo.md` where a single
 * session served two consecutive arcs).
 */
export type CohortArc = {
  arc: string;
  channel: string;
  role: string;
};

/**
 * Verification-run entry. Real handoffs use either flat strings
 * (`- typecheck (PR-A1 / PR-A2 ... all green)`) or structured flow
 * objects (`- { cmd: "bun run typecheck", ts: "...", exit_code: 0 }`).
 * Parser accepts both.
 */
export type HandoffVerificationRun =
  | string
  | {
      cmd: string;
      ts?: string;
      exit_code?: number;
    };

/**
 * Typed handoff frontmatter shape.
 *
 * **Required fields** (parser rejects with `null` if absent or
 * shape-invalid):
 *   - `session_id`: non-empty string
 *   - `started_at`: non-empty string (commonly ISO-8601)
 *   - `ended_at`: non-empty string (commonly ISO-8601)
 *   - `entries_touched`: array of strings (`[]` allowed)
 *
 * **Optional fields** (undefined when absent; rejected with `null` if
 * present but shape-invalid):
 *   - `nato`: validated against `NatoIdentity` enum
 *   - `pair`, `pair_a`, `pair_b`: strings (alternate pair-encoding
 *     conventions across single-NATO vs cohort handoffs)
 *   - `cohort_channel`: string
 *   - `cohort_arc`: string (single-arc form)
 *   - `cohort_arcs`: array of `CohortArc` records (multi-arc bridge form)
 *   - `supersedes`: string (referencing a prior handoff filename)
 *   - `verifications_run`: array of `HandoffVerificationRun`
 *
 * **PR-A5 extension** — `lineage?: LineageEnvelope`. When present, the
 * value is dispatched through {@link parseLineageEnvelope} (SSOT in
 * `lineage-envelope.ts`) — mismatch returns `null` from the outer
 * parser (delegating shape-validation per Bravo PR-A1 Condition 3
 * pattern).
 *
 * Per `feedback-substrate-shim-mirror-on-plugin-export-changes`:
 * re-exports via `api.ts` land in PR-A5 itself; dotfiles
 * `~/.claude-dotfiles/src/channels/index.ts` shim mirror lands in the
 * same PR window per substrate-shim-mirror discipline.
 */
export type HandoffFrontmatter = {
  session_id: string;
  started_at: string;
  ended_at: string;
  entries_touched: readonly string[];
  nato?: NatoIdentity;
  pair?: string;
  pair_a?: string;
  pair_b?: string;
  cohort_channel?: string;
  cohort_arc?: string;
  cohort_arcs?: readonly CohortArc[];
  supersedes?: string;
  verifications_run?: readonly HandoffVerificationRun[];
  lineage?: LineageEnvelope;
};

/**
 * Extract the YAML frontmatter block from a handoff document source.
 *
 * Returns the inner text between the `---` markers, OR `null` when:
 *   - Source does not start with `---\n` (no frontmatter)
 *   - Opening `---` has no matching closing `---`
 *
 * Caller passes the result to {@link parseHandoffFrontmatter} which
 * tolerates BOTH a full document source AND a pre-extracted block;
 * this helper is exposed for test introspection and resolver reuse.
 */
function extractFrontmatterBlock(source: string): string | null {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return null;
  }
  const afterOpener = source.startsWith("---\r\n") ? 5 : 4;
  const closeMarker = source.indexOf("\n---", afterOpener);
  if (closeMarker === -1) return null;
  return source.slice(afterOpener, closeMarker);
}

/**
 * Split a frontmatter block into top-level key entries. A top-level
 * key is identified by `^[a-zA-Z_][a-zA-Z0-9_]*:` at column zero.
 * Continuation lines (indented, OR multi-line flow-object continuation)
 * accumulate into the current entry's `valueLines`.
 *
 * The `valueOnSameLine` captures the substring after the `:` on the
 * key line; `valueLines` holds subsequent indented lines (including
 * empty lines preserved for indentation tracking). Mid-line `#`
 * comments are NOT stripped (no observed handoffs use them; KISS).
 */
type FrontmatterEntry = {
  key: string;
  valueOnSameLine: string;
  valueLines: string[];
};

const TOP_LEVEL_KEY = /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/u;

function splitFrontmatterEntries(block: string): FrontmatterEntry[] {
  const out: FrontmatterEntry[] = [];
  const lines = block.split("\n");
  let current: FrontmatterEntry | null = null;
  for (const line of lines) {
    const m = line.match(TOP_LEVEL_KEY);
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      if (current !== null) out.push(current);
      current = {
        key: m[1],
        valueOnSameLine: m[2].trim(),
        valueLines: [],
      };
      continue;
    }
    if (current !== null) {
      current.valueLines.push(line);
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * Strip a single layer of YAML quoting from a scalar value. Tolerates:
 *   - Double-quoted: `"foo bar"` → `foo bar`
 *   - Single-quoted: `'foo bar'` → `foo bar`
 *   - Unquoted: `foo bar` → `foo bar`
 *
 * Does NOT unescape backslash sequences inside double-quoted strings
 * (handoff frontmatter doesn't use them). Returns the trimmed input
 * for unquoted values.
 */
function unquoteScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed.charAt(0);
    const last = trimmed.charAt(trimmed.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Parse a YAML flow-style object body (the inner of `{ ... }`) into a
 * plain key/value record. Tolerates:
 *   - Quoted + unquoted scalar values
 *   - Integer values (`exit_code: 0`)
 *   - Whitespace + trailing commas
 *
 * Returns `null` on malformed input. Does NOT recurse into nested
 * flow objects (no observed handoff frontmatter uses them inside
 * verifications_run or cohort_arcs).
 */
function parseFlowObjectInner(
  inner: string,
): Record<string, string | number> | null {
  const obj: Record<string, string | number> = {};
  let i = 0;
  const len = inner.length;
  while (i < len) {
    while (i < len && /\s|,/.test(inner.charAt(i))) i++;
    if (i >= len) break;
    // Parse key
    let keyStart = i;
    while (i < len && inner.charAt(i) !== ":") i++;
    if (i >= len) return null;
    const key = inner.slice(keyStart, i).trim();
    if (key.length === 0) return null;
    i++; // skip ':'
    while (i < len && /\s/.test(inner.charAt(i))) i++;
    if (i >= len) return null;
    // Parse value — quoted or until comma/end
    let value: string;
    const firstChar = inner.charAt(i);
    if (firstChar === '"' || firstChar === "'") {
      const quote = firstChar;
      i++;
      const valStart = i;
      while (i < len && inner.charAt(i) !== quote) i++;
      if (i >= len) return null;
      value = inner.slice(valStart, i);
      i++; // skip closing quote
    } else {
      const valStart = i;
      while (i < len && inner.charAt(i) !== ",") i++;
      value = inner.slice(valStart, i).trim();
    }
    // Coerce integer if pure digits (with optional leading -)
    if (/^-?\d+$/.test(value)) {
      obj[key] = Number(value);
    } else {
      obj[key] = value;
    }
  }
  return obj;
}

/**
 * Pre-process indented block lines: glue any multi-line flow-object
 * continuation. A flow object opens with `{` and closes with `}`. When
 * the opener appears unmatched on a line (e.g., `- {`), subsequent
 * lines are appended (joined with a single space) until the matching
 * `}` is found.
 *
 * This normalization makes downstream line-by-line scanners trivial
 * (each list item or sub-key fits on one line).
 */
function glueFlowObjects(lines: string[]): string[] {
  const out: string[] = [];
  let pending: string | null = null;
  let depth = 0;
  for (const line of lines) {
    if (pending !== null) {
      pending = `${pending} ${line.trim()}`;
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0) {
        out.push(pending);
        pending = null;
        depth = 0;
      }
      continue;
    }
    // Count braces on this line
    let lineDepth = 0;
    for (const ch of line) {
      if (ch === "{") lineDepth++;
      else if (ch === "}") lineDepth--;
    }
    if (lineDepth > 0) {
      pending = line;
      depth = lineDepth;
    } else {
      out.push(line);
    }
  }
  if (pending !== null) out.push(pending);
  return out;
}

/**
 * Parse a value as a block-style list of scalars OR flow objects.
 *
 * Recognized forms (`-` prefix at 2-space indent):
 *   - `  - scalar`                        → string
 *   - `  - "quoted string"`               → string (unquoted)
 *   - `  - { k: v, k: v }`                → Record (parsed via parseFlowObjectInner)
 *   - `  - { k: v,\n      k: v\n    }`    → Record (after glueFlowObjects)
 *
 * Returns `null` when ANY list item fails to parse. Empty block list
 * (no `-` lines) is a parse error in this context — callers handle
 * `[]` via `valueOnSameLine` BEFORE invoking this helper.
 */
function parseBlockList(
  valueLines: string[],
): Array<string | Record<string, string | number>> | null {
  const glued = glueFlowObjects(valueLines);
  const out: Array<string | Record<string, string | number>> = [];
  for (const raw of glued) {
    const line = raw;
    if (line.trim().length === 0) continue;
    const match = line.match(/^(\s+)-\s+(.*)$/u);
    if (match === null) return null;
    const item = match[2];
    if (item === undefined) return null;
    const itemTrim = item.trim();
    if (itemTrim.startsWith("{")) {
      // Flow object — strip outer braces, parse inner
      const closeIdx = itemTrim.lastIndexOf("}");
      if (closeIdx === -1) return null;
      const inner = itemTrim.slice(1, closeIdx);
      const parsed = parseFlowObjectInner(inner);
      if (parsed === null) return null;
      out.push(parsed);
    } else {
      out.push(unquoteScalar(itemTrim));
    }
  }
  return out;
}

/**
 * Parse a value as a block-style nested object. Recognizes 2-space-
 * indented `subkey: subvalue` lines. Sub-values may themselves be:
 *   - Inline scalars (`subkey: foo`)
 *   - Block lists (`subkey:` followed by `    - item` lines at 4-space
 *     indent — supports one level of nesting for arrays under sub-keys,
 *     used by the lineage envelope's `input_body_refs`)
 *
 * Returns `null` on malformed input. The result is a plain
 * Record<string, unknown> ready to be passed to per-shape parsers
 * (e.g., `parseLineageEnvelope`).
 */
function parseBlockObject(
  valueLines: string[],
): Record<string, unknown> | null {
  const obj: Record<string, unknown> = {};
  const total = valueLines.length;
  let i = 0;
  while (i < total) {
    const line = valueLines[i];
    if (line === undefined) {
      i++;
      continue;
    }
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const match = line.match(/^(\s+)([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/u);
    if (match === null) return null;
    const indent = match[1];
    const subKey = match[2];
    const rest = match[3];
    if (indent === undefined || subKey === undefined || rest === undefined) {
      return null;
    }
    // First-encountered indent sets the level. Sub-keys must share it.
    if (indent.length !== 2) return null;
    const restTrim = rest.trim();
    if (restTrim.length > 0) {
      // Inline scalar — coerce number if pure-digit
      if (/^-?\d+$/.test(restTrim)) {
        obj[subKey] = Number(restTrim);
      } else if (restTrim === "null") {
        obj[subKey] = null;
      } else if (restTrim === "[]") {
        obj[subKey] = [];
      } else {
        obj[subKey] = unquoteScalar(restTrim);
      }
      i++;
      continue;
    }
    // Block follows — collect sub-indented lines (4-space) until next
    // 2-space-indented sub-key or end-of-block.
    const subLines: string[] = [];
    let j = i + 1;
    while (j < total) {
      const next = valueLines[j];
      if (next === undefined) break;
      if (next.trim().length === 0) {
        subLines.push(next);
        j++;
        continue;
      }
      const indentLen = next.length - next.trimStart().length;
      if (indentLen <= 2) break;
      subLines.push(next);
      j++;
    }
    // Sub-block is a list (lines starting with `- ` after 4-space indent)
    // OR a nested object. Detect by first non-empty subLine.
    let kind: "list" | "object" | null = null;
    for (const subLine of subLines) {
      if (subLine.trim().length === 0) continue;
      const trimmed = subLine.trimStart();
      kind = trimmed.startsWith("- ") || trimmed === "-" ? "list" : "object";
      break;
    }
    if (kind === null) {
      // No content — treat as empty scalar
      obj[subKey] = "";
    } else if (kind === "list") {
      const parsed = parseBlockList(subLines);
      if (parsed === null) return null;
      obj[subKey] = parsed;
    } else {
      // De-indent by 2 so the recursive call sees 2-space indented sub-keys.
      const dedented = subLines.map((s) => (s.length >= 2 ? s.slice(2) : s));
      const parsed = parseBlockObject(dedented);
      if (parsed === null) return null;
      obj[subKey] = parsed;
    }
    i = j;
  }
  return obj;
}

/**
 * Parse a handoff document source (full content OR pre-extracted
 * frontmatter block) into a typed {@link HandoffFrontmatter}.
 *
 * Returns `null` when:
 *   - Source has no parseable frontmatter block
 *   - Any required field is missing OR shape-invalid
 *   - Any optional field is present but shape-invalid
 *   - `lineage` is present but {@link parseLineageEnvelope} rejects it
 *
 * Per Bravo PR-A1 Condition 3 + PR-A2 mirror pattern (see
 * `audit-verdict.ts:529`): lineage shape validation delegates entirely
 * to `parseLineageEnvelope`; this parser only handles the YAML →
 * Record<string, unknown> step.
 *
 * Tolerates the full source OR a pre-extracted block (no `---`
 * markers required when caller has already extracted). Detection is
 * cheap: source starting with `---\n` triggers block extraction;
 * otherwise the whole input is treated as the block.
 */
export function parseHandoffFrontmatter(
  source: string,
): HandoffFrontmatter | null {
  const block =
    source.startsWith("---\n") || source.startsWith("---\r\n")
      ? extractFrontmatterBlock(source)
      : source;
  if (block === null) return null;

  const entries = splitFrontmatterEntries(block);
  if (entries.length === 0) return null;

  const fields: Record<string, FrontmatterEntry> = {};
  for (const entry of entries) {
    fields[entry.key] = entry;
  }

  // ─── Required: session_id ───
  const sessionEntry = fields["session_id"];
  if (sessionEntry === undefined) return null;
  const sessionId = unquoteScalar(sessionEntry.valueOnSameLine);
  if (sessionId.length === 0) return null;

  // ─── Required: started_at ───
  const startedEntry = fields["started_at"];
  if (startedEntry === undefined) return null;
  const startedAt = unquoteScalar(startedEntry.valueOnSameLine);
  if (startedAt.length === 0) return null;

  // ─── Required: ended_at ───
  const endedEntry = fields["ended_at"];
  if (endedEntry === undefined) return null;
  const endedAt = unquoteScalar(endedEntry.valueOnSameLine);
  if (endedAt.length === 0) return null;

  // ─── Required: entries_touched ───
  const entriesEntry = fields["entries_touched"];
  if (entriesEntry === undefined) return null;
  let entriesTouched: readonly string[];
  const entriesScalar = entriesEntry.valueOnSameLine;
  if (entriesScalar === "[]") {
    entriesTouched = [];
  } else if (entriesScalar.length > 0) {
    // Unexpected inline non-empty value — not a known shape
    return null;
  } else {
    const parsed = parseBlockList(entriesEntry.valueLines);
    if (parsed === null) return null;
    for (const item of parsed) {
      if (typeof item !== "string") return null;
    }
    entriesTouched = parsed as readonly string[];
  }

  // ─── Optional: nato ───
  let nato: NatoIdentity | undefined;
  const natoEntry = fields["nato"];
  if (natoEntry !== undefined) {
    const value = unquoteScalar(natoEntry.valueOnSameLine);
    if (value.length === 0) return null;
    if (!isValidIdentity(value)) return null;
    nato = value;
  }

  // ─── Optional: pair / pair_a / pair_b ───
  const pair = optionalScalar(fields, "pair");
  if (pair === null) return null;
  const pairA = optionalScalar(fields, "pair_a");
  if (pairA === null) return null;
  const pairB = optionalScalar(fields, "pair_b");
  if (pairB === null) return null;

  // ─── Optional: cohort_channel / cohort_arc / supersedes ───
  const cohortChannel = optionalScalar(fields, "cohort_channel");
  if (cohortChannel === null) return null;
  const cohortArc = optionalScalar(fields, "cohort_arc");
  if (cohortArc === null) return null;
  const supersedes = optionalScalar(fields, "supersedes");
  if (supersedes === null) return null;

  // ─── Optional: cohort_arcs (list of flow objects) ───
  let cohortArcs: readonly CohortArc[] | undefined;
  const cohortArcsEntry = fields["cohort_arcs"];
  if (cohortArcsEntry !== undefined) {
    if (cohortArcsEntry.valueOnSameLine === "[]") {
      cohortArcs = [];
    } else if (cohortArcsEntry.valueOnSameLine.length > 0) {
      return null;
    } else {
      const parsed = parseBlockList(cohortArcsEntry.valueLines);
      if (parsed === null) return null;
      const out: CohortArc[] = [];
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) return null;
        const arc = item["arc"];
        const channel = item["channel"];
        const role = item["role"];
        if (
          typeof arc !== "string" ||
          arc.length === 0 ||
          typeof channel !== "string" ||
          channel.length === 0 ||
          typeof role !== "string" ||
          role.length === 0
        ) {
          return null;
        }
        out.push({ arc, channel, role });
      }
      cohortArcs = out;
    }
  }

  // ─── Optional: verifications_run (flat strings OR flow objects) ───
  let verificationsRun: readonly HandoffVerificationRun[] | undefined;
  const verifEntry = fields["verifications_run"];
  if (verifEntry !== undefined) {
    if (verifEntry.valueOnSameLine === "[]") {
      verificationsRun = [];
    } else if (verifEntry.valueOnSameLine.length > 0) {
      return null;
    } else {
      const parsed = parseBlockList(verifEntry.valueLines);
      if (parsed === null) return null;
      const out: HandoffVerificationRun[] = [];
      for (const item of parsed) {
        if (typeof item === "string") {
          out.push(item);
        } else {
          const cmd = item["cmd"];
          if (typeof cmd !== "string" || cmd.length === 0) return null;
          const entry: HandoffVerificationRun = { cmd };
          const ts = item["ts"];
          if (ts !== undefined) {
            if (typeof ts !== "string") return null;
            entry.ts = ts;
          }
          const exitCode = item["exit_code"];
          if (exitCode !== undefined) {
            if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
              return null;
            }
            entry.exit_code = exitCode;
          }
          out.push(entry);
        }
      }
      verificationsRun = out;
    }
  }

  // ─── PR-A5 extension: lineage (block-style nested object) ───
  let lineage: LineageEnvelope | undefined;
  const lineageEntry = fields["lineage"];
  if (lineageEntry !== undefined) {
    // Lineage may be inline JSON-flow (`lineage: {"kind_version":1,...}`)
    // OR block-style nested object. Detect by inline value presence.
    let lineageRecord: Record<string, unknown> | null;
    if (lineageEntry.valueOnSameLine.length > 0) {
      const inline = lineageEntry.valueOnSameLine;
      if (inline.startsWith("{") && inline.endsWith("}")) {
        // Flow-style: parse via JSON
        try {
          const parsed: unknown = JSON.parse(inline);
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            return null;
          }
          lineageRecord = parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      } else {
        return null;
      }
    } else {
      lineageRecord = parseBlockObject(lineageEntry.valueLines);
    }
    if (lineageRecord === null) return null;
    const parsedLineage = parseLineageEnvelope(lineageRecord);
    if (parsedLineage === null) return null;
    lineage = parsedLineage;
  }

  return {
    session_id: sessionId,
    started_at: startedAt,
    ended_at: endedAt,
    entries_touched: entriesTouched,
    ...(nato !== undefined ? { nato } : {}),
    ...(pair !== undefined ? { pair } : {}),
    ...(pairA !== undefined ? { pair_a: pairA } : {}),
    ...(pairB !== undefined ? { pair_b: pairB } : {}),
    ...(cohortChannel !== undefined ? { cohort_channel: cohortChannel } : {}),
    ...(cohortArc !== undefined ? { cohort_arc: cohortArc } : {}),
    ...(cohortArcs !== undefined ? { cohort_arcs: cohortArcs } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    ...(verificationsRun !== undefined
      ? { verifications_run: verificationsRun }
      : {}),
    ...(lineage !== undefined ? { lineage } : {}),
  };
}

/**
 * Optional-scalar helper: returns `undefined` when absent, the
 * unquoted value when present + non-empty, OR `null` to signal a
 * parse error to the caller (present-but-empty is rejected).
 */
function optionalScalar(
  fields: Record<string, FrontmatterEntry>,
  key: string,
): string | undefined | null {
  const entry = fields[key];
  if (entry === undefined) return undefined;
  const value = unquoteScalar(entry.valueOnSameLine);
  if (value.length === 0) return null;
  return value;
}

/**
 * File-reading wrapper for {@link parseHandoffFrontmatter}. Throws on
 * I/O failure (ENOENT, EACCES, etc.) — caller handles per their error
 * convention.
 */
export function parseHandoffFrontmatterFromFile(
  handoffPath: string,
): HandoffFrontmatter | null {
  const source = readFileSync(handoffPath, "utf-8");
  return parseHandoffFrontmatter(source);
}
