// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Lexicon scanner (Tier 3-C) — pure logic layer.
 *
 * Extracts terms-of-art from prose corpora (memory files, handoff bodies,
 * channel message bodies). Three regex classes capture distinct shapes:
 *
 *   - hyphenated_lower: `feedback-foo-bar-baz` (min 3 hyphens)
 *   - identifier_camelOrPascal: `parseAuditVerdictBody`, `CycleCharacter`
 *   - acronym_caps: `SHIP-CLEAN`, `CGP-003`, `T3-A`, `RFC`
 *
 * Code-block contents (between ``` fences) are excluded.
 *
 * Plan: slice-T3C-lexicon-2026-05-20.md v0.1.
 */

export type SourceKind = "memory" | "handoffs" | "channels";

export type TermEntry = {
  term: string;
  first_seen: string;
  first_seen_source: string;
  last_seen: string;
  last_seen_source: string;
  occurrence_count: number;
  source_breakdown: { memory: number; handoffs: number; channels: number };
};

export type Lexicon = {
  generated_at: string;
  sources_scanned: { memory: number; handoffs: number; channels: number };
  total_terms: number;
  terms: readonly TermEntry[];
};

const HYPHENATED_LOWER = /\b[a-z][a-z0-9]+(?:-[a-z0-9]+){2,}\b/g;
const IDENTIFIER_CAMEL_OR_PASCAL = /\b[a-zA-Z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]+\b/g;
const ACRONYM_CAPS = /\b[A-Z][A-Z0-9]+-?[A-Z0-9]+\b/g;

/**
 * Strip markdown code-block fences from text before regex extraction.
 * Code blocks are CODE, not lexicon prose; their identifier-shaped
 * symbols would inflate the term list with imports + type names that
 * aren't terms-of-art.
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ");
}

/**
 * Extract terms from prose text. Returns a deduplicated array of terms.
 * Term canonicalization:
 *   - hyphenated_lower: already lowercase by definition
 *   - identifier + acronym: case-preserved
 */
export function extractTerms(text: string): readonly string[] {
  const stripped = stripCodeBlocks(text);
  const found = new Set<string>();
  for (const match of stripped.matchAll(HYPHENATED_LOWER)) {
    if (match[0] !== undefined) found.add(match[0]);
  }
  for (const match of stripped.matchAll(IDENTIFIER_CAMEL_OR_PASCAL)) {
    if (match[0] !== undefined) found.add(match[0]);
  }
  for (const match of stripped.matchAll(ACRONYM_CAPS)) {
    if (match[0] !== undefined) found.add(match[0]);
  }
  return Array.from(found);
}

export type AggregateInput = {
  kind: SourceKind;
  source: string;
  ts: string;
  body: string;
};

/**
 * Aggregate extracted terms across multiple inputs into a Lexicon.
 * Deterministic output: terms sorted by first_seen ASC, then term ASC
 * (F1 fold).
 */
export function aggregateLexicon(
  inputs: readonly AggregateInput[],
  generated_at: string,
): Lexicon {
  const termToFirst = new Map<string, { ts: string; source: string }>();
  const termToLast = new Map<string, { ts: string; source: string }>();
  const termCounts = new Map<string, number>();
  const termBreakdown = new Map<
    string,
    { memory: number; handoffs: number; channels: number }
  >();
  const sourcesScanned = { memory: 0, handoffs: 0, channels: 0 };
  const sourcesSeen = new Set<string>();

  for (const input of inputs) {
    const sourceKey = `${input.kind}:${input.source}`;
    if (!sourcesSeen.has(sourceKey)) {
      sourcesSeen.add(sourceKey);
      if (input.kind === "memory") sourcesScanned.memory += 1;
      else if (input.kind === "handoffs") sourcesScanned.handoffs += 1;
      else sourcesScanned.channels += 1;
    }
    const terms = extractTerms(input.body);
    for (const term of terms) {
      const prev = termToFirst.get(term);
      if (prev === undefined || input.ts < prev.ts) {
        termToFirst.set(term, { ts: input.ts, source: input.source });
      }
      const prevLast = termToLast.get(term);
      if (prevLast === undefined || input.ts > prevLast.ts) {
        termToLast.set(term, { ts: input.ts, source: input.source });
      }
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      const breakdown = termBreakdown.get(term) ?? {
        memory: 0,
        handoffs: 0,
        channels: 0,
      };
      if (input.kind === "memory") breakdown.memory += 1;
      else if (input.kind === "handoffs") breakdown.handoffs += 1;
      else breakdown.channels += 1;
      termBreakdown.set(term, breakdown);
    }
  }

  const entries: TermEntry[] = [];
  for (const [term, first] of termToFirst) {
    const last = termToLast.get(term) ?? first;
    const count = termCounts.get(term) ?? 0;
    const breakdown = termBreakdown.get(term) ?? {
      memory: 0,
      handoffs: 0,
      channels: 0,
    };
    entries.push({
      term,
      first_seen: first.ts,
      first_seen_source: first.source,
      last_seen: last.ts,
      last_seen_source: last.source,
      occurrence_count: count,
      source_breakdown: breakdown,
    });
  }

  entries.sort((a, b) => {
    if (a.first_seen < b.first_seen) return -1;
    if (a.first_seen > b.first_seen) return 1;
    return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  });

  return {
    generated_at,
    sources_scanned: sourcesScanned,
    total_terms: entries.length,
    terms: entries,
  };
}
