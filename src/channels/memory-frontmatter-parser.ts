// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Typed parser for **user-auto-memory** frontmatter (the `feedback-*.md`
 * and sibling memory files under `~/.claude/projects/<encoded-cwd>/memory/`).
 *
 * Layer 2 lineage envelope extension surface #3 per slice plan
 * `cycle-1-substrate-extension-slice-plan-2026-05-26.md` §1.1 + §7 row 6.
 *
 * **Two MemoryFrontmatter types exist by design — DO NOT MERGE them:**
 *
 *   - **This module's `MemoryFrontmatter`** is the looser schema for
 *     user-auto-memory files. Required: `name + description + type`.
 *     All other fields optional. Tolerates BOTH flat (`type: feedback`)
 *     AND nested (`metadata: { type: feedback }`) forms — different
 *     memory-authoring vintages use different conventions; the parser
 *     normalizes them into one canonical record.
 *
 *   - **`src/memory-loader/index.ts:MemoryFrontmatter`** is the stricter
 *     schema for plugin-bundled memories (`memories/*.md` shipped with
 *     the plugin). Required: `name + description + type + cadence +
 *     scope + updated`. That module is intentionally strict — bundled
 *     memories must conform to the discipline schema before shipping.
 *
 * The two schemas serve distinct purposes; the namespace collision is
 * acceptable because (a) memory-loader's type is private (not re-
 * exported via `api.ts`), and (b) consumers importing from
 * `claude-conductor/channels/api` get THIS module's looser type
 * unambiguously. Future cleanup may rename memory-loader's local type
 * to `BundledMemoryFrontmatter` for clarity; not in PR-A6 scope.
 *
 * **Composition with PR-A5 + audit-verdict lineage extension:** the
 * `lineage?` field dispatches through `parseLineageEnvelope` (PR-A1
 * SSOT) — same pattern as `parseHandoffFrontmatter` (PR-A5) and
 * `parseAuditVerdictBody` (PR-A2). Three substrate-extension surfaces
 * + shared dispatch helper = consistent envelope semantics across
 * memory + handoff + audit-verdict.
 *
 * Per `feedback-substrate-shim-mirror-on-plugin-export-changes` —
 * re-exports via `api.ts` land in PR-A6; dotfiles
 * `~/.claude-dotfiles/src/channels/index.ts` shim mirror lands in the
 * paired follow-up dotfiles PR.
 */

import { readFileSync } from "node:fs";

import {
  parseLineageEnvelope,
  type LineageEnvelope,
} from "./lineage-envelope.ts";
import { isMemoryType, type MemoryType } from "./memory-type.ts";

// ─────────────────────────────────────────────────────────────────
// MemoryFrontmatter type
// ─────────────────────────────────────────────────────────────────

/**
 * Archive marker: if present, must be the literal string `"never"`.
 * Indicates that an empirical-archival pass should NOT move this memory
 * into `.archive/` (per CLAUDE.md `## Memory Conventions` § empirical
 * archival pass).
 */
export type MemoryArchiveMarker = "never";

/**
 * Typed user-auto-memory frontmatter shape.
 *
 * **Required fields** (parser rejects with `null` if absent or
 * shape-invalid):
 *   - `name`: non-empty string (the index hook field per memory-attention
 *     scoring discipline)
 *   - `description`: non-empty string (the on-demand summary field)
 *   - `type`: validated against {@link MemoryType} — parser accepts
 *     this from EITHER top-level `type:` OR nested `metadata.type:`
 *
 * **Optional fields** (undefined when absent; rejected with `null` if
 * present but shape-invalid):
 *   - `originSessionId`: UUID string (accepted from top-level OR
 *     nested `metadata.originSessionId`)
 *   - `archive`: must equal `"never"` if present (the exempt-from-
 *     auto-archival marker)
 *   - `cadence`: free-form string (memory-attention discipline tag)
 *   - `scope`: free-form string (memory-attention discipline tag)
 *   - `node_type`: free-form string (newer-vintage metadata; only seen
 *     under `metadata.node_type`)
 *
 * **PR-A6 extension** — `lineage?: LineageEnvelope`. When present, the
 * value is dispatched through {@link parseLineageEnvelope} (SSOT in
 * `lineage-envelope.ts`) — mismatch returns `null` from the outer
 * parser (delegating shape-validation per Bravo PR-A1 Condition 3
 * pattern, sibling to PR-A2 `AuditVerdictBody.lineage` + PR-A5
 * `HandoffFrontmatter.lineage`).
 */
export type MemoryFrontmatter = {
  name: string;
  description: string;
  type: MemoryType;
  originSessionId?: string;
  archive?: MemoryArchiveMarker;
  cadence?: string;
  scope?: string;
  node_type?: string;
  lineage?: LineageEnvelope;
};

// ─────────────────────────────────────────────────────────────────
// Parser internals — YAML subset
// ─────────────────────────────────────────────────────────────────

/**
 * Extract the YAML frontmatter block from a memory document source.
 *
 * Returns the inner text between the `---` markers, OR `null` when:
 *   - Source does not start with `---\n` (no frontmatter)
 *   - Opening `---` has no matching closing `---`
 *
 * Mirrors the handoff-body-parser pattern (PR-A5) for consistency.
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
 * Strip a single layer of YAML quoting from a scalar value. Tolerates
 * double-quoted, single-quoted, and unquoted values. Does NOT unescape
 * backslash sequences inside double-quoted strings.
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

const TOP_LEVEL_KEY = /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/u;

/**
 * Parse the body lines under a top-level key whose `valueOnSameLine`
 * was empty (the key opens a block). Returns a Record of sub-keys to
 * their RAW string values (un-typed; caller per-field-validates).
 *
 * Recognized: 2-space-indented `subkey: value` lines, where value is
 * an inline scalar. Deeper-than-2-level metadata is NOT supported (no
 * observed memory frontmatter uses it; KISS over speculative depth).
 *
 * Returns `null` when any non-empty body line is not a recognized
 * `subkey:` shape (defensive — surfaces malformed metadata blocks).
 */
function parseNestedRecord(bodyLines: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of bodyLines) {
    if (line.trim().length === 0) continue;
    const indentLen = line.length - line.trimStart().length;
    if (indentLen < 2) return null; // outside the block
    const stripped = line.trimStart();
    const match = stripped.match(TOP_LEVEL_KEY);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return null;
    }
    out[match[1]] = unquoteScalar(match[2]);
  }
  return out;
}

/**
 * Parse a block-style nested object for the lineage envelope. Mirrors
 * `parseBlockObject` in handoff-body-parser.ts (PR-A5) but specialized
 * for the lineage shape (handles `input_body_refs:\n  - ref` nested
 * list under a sub-key).
 */
function parseLineageBlock(
  bodyLines: string[],
): Record<string, unknown> | null {
  const obj: Record<string, unknown> = {};
  const total = bodyLines.length;
  let i = 0;
  while (i < total) {
    const line = bodyLines[i];
    if (line === undefined) {
      i++;
      continue;
    }
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const indentLen = line.length - line.trimStart().length;
    if (indentLen !== 2) return null; // top-of-block lineage keys live at indent 2
    const stripped = line.trimStart();
    const match = stripped.match(TOP_LEVEL_KEY);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return null;
    }
    const subKey = match[1];
    const rest = match[2].trim();
    if (rest.length > 0) {
      // Inline scalar
      if (/^-?\d+$/.test(rest)) {
        obj[subKey] = Number(rest);
      } else if (rest === "null") {
        obj[subKey] = null;
      } else if (rest === "[]") {
        obj[subKey] = [];
      } else {
        obj[subKey] = unquoteScalar(rest);
      }
      i++;
      continue;
    }
    // Block follows — collect 4-space-indented child lines (a list of
    // `  - item` form once the outer-block is stripped).
    const subLines: string[] = [];
    let j = i + 1;
    while (j < total) {
      const next = bodyLines[j];
      if (next === undefined) break;
      if (next.trim().length === 0) {
        subLines.push(next);
        j++;
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= 2) break;
      subLines.push(next);
      j++;
    }
    // List or object?
    let firstNonEmpty: string | null = null;
    for (const subLine of subLines) {
      if (subLine.trim().length > 0) {
        firstNonEmpty = subLine.trimStart();
        break;
      }
    }
    if (firstNonEmpty === null) {
      obj[subKey] = "";
    } else if (firstNonEmpty.startsWith("- ") || firstNonEmpty === "-") {
      // Block list of scalars
      const list: string[] = [];
      for (const subLine of subLines) {
        if (subLine.trim().length === 0) continue;
        const m = subLine.match(/^(\s+)-\s+(.*)$/u);
        if (m === null || m[2] === undefined) return null;
        list.push(unquoteScalar(m[2]));
      }
      obj[subKey] = list;
    } else {
      return null; // nested objects under lineage sub-keys not supported
    }
    i = j;
  }
  return obj;
}

// ─────────────────────────────────────────────────────────────────
// parseMemoryFrontmatter (public API)
// ─────────────────────────────────────────────────────────────────

type TopEntry = {
  key: string;
  valueOnSameLine: string;
  bodyLines: string[];
};

/**
 * Parse a memory document source (full content OR pre-extracted
 * frontmatter block) into a typed {@link MemoryFrontmatter}.
 *
 * Returns `null` when:
 *   - Source has no parseable frontmatter block
 *   - Required fields are missing OR shape-invalid (name / description /
 *     type — where `type` may live at top-level OR under `metadata.type`)
 *   - Any optional field is present but shape-invalid
 *   - `archive` is present but not the literal string `"never"`
 *   - `lineage` is present but {@link parseLineageEnvelope} rejects it
 *
 * Per Bravo PR-A1 Condition 3 + PR-A2 + PR-A5 mirror pattern:
 * lineage shape validation delegates entirely to `parseLineageEnvelope`.
 *
 * Tolerates the full source (with `---` markers) OR a pre-extracted
 * block. Detection is cheap: source starting with `---\n` triggers
 * block extraction; otherwise the whole input is treated as the block.
 */
export function parseMemoryFrontmatter(
  source: string,
): MemoryFrontmatter | null {
  const block =
    source.startsWith("---\n") || source.startsWith("---\r\n")
      ? extractFrontmatterBlock(source)
      : source;
  if (block === null) return null;

  const entries: TopEntry[] = [];
  const lines = block.split("\n");
  let current: TopEntry | null = null;
  for (const line of lines) {
    if (line.length === 0) {
      if (current !== null) current.bodyLines.push(line);
      continue;
    }
    // Only column-zero `<key>:` lines start a top-level entry
    if (
      line.charAt(0) !== " " &&
      line.charAt(0) !== "\t" &&
      TOP_LEVEL_KEY.test(line)
    ) {
      const match = line.match(TOP_LEVEL_KEY);
      if (match !== null && match[1] !== undefined && match[2] !== undefined) {
        if (current !== null) entries.push(current);
        current = {
          key: match[1],
          valueOnSameLine: match[2].trim(),
          bodyLines: [],
        };
        continue;
      }
    }
    if (current !== null) current.bodyLines.push(line);
  }
  if (current !== null) entries.push(current);
  if (entries.length === 0) return null;

  const byKey: Record<string, TopEntry> = {};
  for (const e of entries) byKey[e.key] = e;

  // ─── Required: name ───
  const nameEntry = byKey["name"];
  if (nameEntry === undefined) return null;
  const name = unquoteScalar(nameEntry.valueOnSameLine);
  if (name.length === 0) return null;

  // ─── Required: description ───
  const descEntry = byKey["description"];
  if (descEntry === undefined) return null;
  const description = unquoteScalar(descEntry.valueOnSameLine);
  if (description.length === 0) return null;

  // ─── Parse optional `metadata:` nested block (newer vintage form) ───
  let metadata: Record<string, string> | null = null;
  const metadataEntry = byKey["metadata"];
  if (metadataEntry !== undefined) {
    if (metadataEntry.valueOnSameLine.length > 0) {
      // Inline metadata not a known shape
      return null;
    }
    const parsed = parseNestedRecord(metadataEntry.bodyLines);
    if (parsed === null) return null;
    metadata = parsed;
  }

  // ─── Required: type (from flat OR metadata) ───
  let typeRaw: string | undefined;
  const flatTypeEntry = byKey["type"];
  if (flatTypeEntry !== undefined) {
    typeRaw = unquoteScalar(flatTypeEntry.valueOnSameLine);
  } else if (metadata !== null && metadata["type"] !== undefined) {
    typeRaw = metadata["type"];
  }
  if (typeRaw === undefined || !isMemoryType(typeRaw)) return null;
  const type: MemoryType = typeRaw;

  // ─── Optional: originSessionId (from flat OR metadata) ───
  let originSessionId: string | undefined;
  const flatOrigin = byKey["originSessionId"];
  if (flatOrigin !== undefined) {
    const value = unquoteScalar(flatOrigin.valueOnSameLine);
    if (value.length === 0) return null;
    originSessionId = value;
  } else if (metadata !== null && metadata["originSessionId"] !== undefined) {
    const value = metadata["originSessionId"];
    if (value.length === 0) return null;
    originSessionId = value;
  }

  // ─── Optional: archive (must be "never") ───
  let archive: MemoryArchiveMarker | undefined;
  const archiveEntry = byKey["archive"];
  if (archiveEntry !== undefined) {
    const value = unquoteScalar(archiveEntry.valueOnSameLine);
    if (value !== "never") return null;
    archive = "never";
  }

  // ─── Optional: cadence ───
  let cadence: string | undefined;
  const cadenceEntry = byKey["cadence"];
  if (cadenceEntry !== undefined) {
    const value = unquoteScalar(cadenceEntry.valueOnSameLine);
    if (value.length === 0) return null;
    cadence = value;
  }

  // ─── Optional: scope ───
  let scope: string | undefined;
  const scopeEntry = byKey["scope"];
  if (scopeEntry !== undefined) {
    const value = unquoteScalar(scopeEntry.valueOnSameLine);
    if (value.length === 0) return null;
    scope = value;
  }

  // ─── Optional: node_type (only from metadata) ───
  let nodeType: string | undefined;
  if (metadata !== null && metadata["node_type"] !== undefined) {
    const value = metadata["node_type"];
    if (value.length === 0) return null;
    nodeType = value;
  }

  // ─── PR-A6 extension: lineage ───
  let lineage: LineageEnvelope | undefined;
  const lineageEntry = byKey["lineage"];
  if (lineageEntry !== undefined) {
    let lineageRecord: Record<string, unknown> | null;
    if (lineageEntry.valueOnSameLine.length > 0) {
      // Inline flow-style JSON
      const inline = lineageEntry.valueOnSameLine;
      if (inline.startsWith("{") && inline.endsWith("}")) {
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
      lineageRecord = parseLineageBlock(lineageEntry.bodyLines);
    }
    if (lineageRecord === null) return null;
    const parsedLineage = parseLineageEnvelope(lineageRecord);
    if (parsedLineage === null) return null;
    lineage = parsedLineage;
  }

  return {
    name,
    description,
    type,
    ...(originSessionId !== undefined ? { originSessionId } : {}),
    ...(archive !== undefined ? { archive } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(nodeType !== undefined ? { node_type: nodeType } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
  };
}

/**
 * File-reading wrapper for {@link parseMemoryFrontmatter}. Throws on
 * I/O failure (ENOENT, EACCES, etc.) — caller handles per their error
 * convention.
 */
export function parseMemoryFrontmatterFromFile(
  memoryPath: string,
): MemoryFrontmatter | null {
  const source = readFileSync(memoryPath, "utf-8");
  return parseMemoryFrontmatter(source);
}
