// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for the lexicon scanner (Tier 3-C).
 *
 * Coverage per plan §9:
 *   - empty text → empty terms list
 *   - hyphenated-lower extraction
 *   - hyphenated-lower exclusion (min-3-hyphens enforced)
 *   - camelCase extraction
 *   - single PascalCase exclusion (no interior capital)
 *   - acronym extraction
 *   - code-block exclusion
 *   - aggregate first_seen + occurrence + sort determinism
 *
 * Plan: slice-T3C-lexicon-2026-05-20.md v0.1.
 */

import { describe, expect, it } from "bun:test";

import { aggregateLexicon, extractTerms } from "../../src/lexicon/scanner.ts";

describe("extractTerms", () => {
  it("empty text → empty terms list", () => {
    expect(extractTerms("")).toEqual([]);
  });

  it("hyphenated-lower extraction (min-3-hyphens)", () => {
    const terms = extractTerms("feedback-foo-bar-baz applies");
    expect(terms).toContain("feedback-foo-bar-baz");
  });

  it("hyphenated-lower exclusion (well-known has only 1 hyphen)", () => {
    const terms = extractTerms("This is well-known but also well-loved");
    expect(terms).not.toContain("well-known");
    expect(terms).not.toContain("well-loved");
  });

  it("camelCase / PascalCase extraction", () => {
    const terms = extractTerms(
      "Call parseAuditVerdictBody on the CycleCharacter input",
    );
    expect(terms).toContain("parseAuditVerdictBody");
    expect(terms).toContain("CycleCharacter");
  });

  it("single PascalCase exclusion (no interior capital)", () => {
    const terms = extractTerms("Cycle alone is not a term");
    expect(terms).not.toContain("Cycle");
  });

  it("acronym extraction", () => {
    const terms = extractTerms(
      "SHIP-CLEAN with CGP-003 from T3-A and RFC notes",
    );
    expect(terms).toContain("SHIP-CLEAN");
    expect(terms).toContain("CGP-003");
    expect(terms).toContain("T3-A");
    expect(terms).toContain("RFC");
  });

  it("code-block exclusion (terms inside ``` fences are skipped)", () => {
    const text = [
      "Prose with feedback-foo-bar-baz",
      "```",
      "import { CodeFenceSymbol } from './x';",
      "feedback-inside-code-block",
      "```",
      "After code: parseAuditVerdictBody",
    ].join("\n");
    const terms = extractTerms(text);
    expect(terms).toContain("feedback-foo-bar-baz");
    expect(terms).toContain("parseAuditVerdictBody");
    expect(terms).not.toContain("CodeFenceSymbol");
    expect(terms).not.toContain("feedback-inside-code-block");
  });
});

describe("aggregateLexicon", () => {
  it("aggregates first_seen + occurrence_count across inputs", () => {
    const lex = aggregateLexicon(
      [
        {
          kind: "memory",
          source: "memory/a.md",
          ts: "2026-05-19T10:00:00Z",
          body: "feedback-foo-bar-baz first appearance",
        },
        {
          kind: "handoffs",
          source: "handoff/b.md",
          ts: "2026-05-20T11:00:00Z",
          body: "feedback-foo-bar-baz second appearance with CycleCharacter",
        },
        {
          kind: "channels",
          source: "channel/c:2026-05-20T12:00:00Z",
          ts: "2026-05-20T12:00:00Z",
          body: "CycleCharacter only",
        },
      ],
      "2026-05-20T13:00:00Z",
    );

    expect(lex.sources_scanned).toEqual({
      memory: 1,
      handoffs: 1,
      channels: 1,
    });

    const fooEntry = lex.terms.find((t) => t.term === "feedback-foo-bar-baz");
    expect(fooEntry).toBeDefined();
    expect(fooEntry?.first_seen).toBe("2026-05-19T10:00:00Z");
    expect(fooEntry?.first_seen_source).toBe("memory/a.md");
    expect(fooEntry?.occurrence_count).toBe(2);
    expect(fooEntry?.source_breakdown.memory).toBe(1);
    expect(fooEntry?.source_breakdown.handoffs).toBe(1);

    const cycleEntry = lex.terms.find((t) => t.term === "CycleCharacter");
    expect(cycleEntry).toBeDefined();
    expect(cycleEntry?.first_seen).toBe("2026-05-20T11:00:00Z");
    expect(cycleEntry?.occurrence_count).toBe(2);
  });

  it("terms sorted by first_seen ASC (F1 deterministic)", () => {
    const lex = aggregateLexicon(
      [
        {
          kind: "memory",
          source: "z.md",
          ts: "2026-05-19T00:00:00Z",
          body: "term-z-comes-first",
        },
        {
          kind: "memory",
          source: "a.md",
          ts: "2026-05-20T00:00:00Z",
          body: "term-a-comes-later",
        },
      ],
      "2026-05-20T13:00:00Z",
    );
    expect(lex.terms[0]?.term).toBe("term-z-comes-first");
    expect(lex.terms[1]?.term).toBe("term-a-comes-later");
  });
});
