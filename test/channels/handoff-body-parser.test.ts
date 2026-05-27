// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L141 handoff body parser unit tests.
 *
 * Coverage:
 *   - basic shape: extracts single id from `\`<id>\`` markdown
 *   - multiple distinct ids preserved in body-order
 *   - dedup: same id mentioned multiple times yields one entry
 *   - prose context invariance: ids in any prose context work
 *   - slug suffix accepted (e.g., `2026-05-15_18-26-coord`)
 *   - rejects malformed ids (wrong shape)
 *   - rejects backtick strings that aren't channel-id-shaped
 *   - empty body, no-backticks body
 *   - file-reading wrapper (happy path + ENOENT throw)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseHandoffBodyForChannels,
  parseHandoffBodyForChannelsFromFile,
  parseHandoffFrontmatter,
  parseHandoffFrontmatterFromFile,
  type HandoffFrontmatter,
} from "../../src/channels/handoff-body-parser.ts";
import type { LineageEnvelope } from "../../src/channels/lineage-envelope.ts";

describe("parseHandoffBodyForChannels — pure parser", () => {
  it("extracts a single channel id from a basic inline-code reference", () => {
    const body = "Channel `2026-05-15_18-26` armed; Monitor running.";
    expect(parseHandoffBodyForChannels(body)).toEqual(["2026-05-15_18-26"]);
  });

  it("extracts multiple distinct ids in body-order", () => {
    const body = `
**Channel:** \`2026-05-15_18-26\` HELD OPEN.

Bridge reference to prior coord channel \`2026-05-11_08-15\`.
    `;
    expect(parseHandoffBodyForChannels(body)).toEqual([
      "2026-05-15_18-26",
      "2026-05-11_08-15",
    ]);
  });

  it("deduplicates repeated ids; first occurrence wins ordering", () => {
    const body = `
Channel \`2026-05-15_18-26\` armed.

Recovery: Channel \`2026-05-15_18-26\` may be stale; \`channel-gc\` may have archived it.

Bridge: \`2026-05-11_08-15\` prior cycle.
    `;
    expect(parseHandoffBodyForChannels(body)).toEqual([
      "2026-05-15_18-26",
      "2026-05-11_08-15",
    ]);
  });

  it("is invariant to prose context (lowercase, asterisks, parens, etc.)", () => {
    const body = `
- **Channel:** \`2026-05-15_18-26\` (Alpha + Bravo coord)
- the channel \`2026-05-11_08-15\` is now closed
- (channel \`2026-05-13_09-50\`)
    `;
    expect(parseHandoffBodyForChannels(body)).toEqual([
      "2026-05-15_18-26",
      "2026-05-11_08-15",
      "2026-05-13_09-50",
    ]);
  });

  it("accepts the slug-suffix variant (`<id>-<slug>`)", () => {
    const body = "Coord channel `2026-05-15_18-26-coord` open.";
    expect(parseHandoffBodyForChannels(body)).toEqual([
      "2026-05-15_18-26-coord",
    ]);
  });

  it("rejects malformed ids — missing time component", () => {
    const body = "Date code `2026-05-15` is not a channel id.";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  it("rejects malformed ids — wrong separator", () => {
    const body = "Pattern `2026-05-15-18-26` (dash not underscore) is invalid.";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  it("rejects backtick strings that aren't channel-shaped", () => {
    const body = `
Helper \`channelIdFromHandoff\` exists at \`src/channels/index.ts:254\`.
SHA \`f6bf73e\` and CI run \`25975416897\` referenced.
    `;
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  it("returns empty for empty body", () => {
    expect(parseHandoffBodyForChannels("")).toEqual([]);
  });

  it("returns empty for body with no backticks", () => {
    expect(
      parseHandoffBodyForChannels("Plain prose. No code. No channel refs."),
    ).toEqual([]);
  });

  it("does not cross newlines mid-inline-code (rejects orphan backticks)", () => {
    const body = "Orphan backtick on line one `2026-05-15_18-26\nnext line";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  it("mixed-content body extracts only the channel-shaped backticks", () => {
    const body = `
**Channel:** \`2026-05-15_18-26\` armed.

Diff at \`src/channels/index.ts:1317\` shipped via SHA \`f6bf73e\`.

Prior cycle \`2026-05-13_09-50\` closed.
    `;
    expect(parseHandoffBodyForChannels(body)).toEqual([
      "2026-05-15_18-26",
      "2026-05-13_09-50",
    ]);
  });

  // T2X — bold-prefix bare-id extraction (handoff write-template form).
  // Previously slipped through inline-code-only path; `/handoff-resume parallel`
  // Step 4a returned `derived-empty-no-body-refs` on real handoffs.

  it("Pos T-1: matches **Channel:** <bare-id> (colon inside bold)", () => {
    const body = "**Channel:** 2026-05-18_10-50 (4 NATO peers active)";
    expect(parseHandoffBodyForChannels(body)).toEqual(["2026-05-18_10-50"]);
  });

  it("Pos T-2: matches **Channel**: <bare-id> (colon outside bold)", () => {
    const body = "**Channel**: 2026-05-18_10-50 alternate form";
    expect(parseHandoffBodyForChannels(body)).toEqual(["2026-05-18_10-50"]);
  });

  it("Pos T-3: matches plain Channel: <bare-id> at line-start", () => {
    const body = "Channel: 2026-05-18_10-50 plain prefix";
    expect(parseHandoffBodyForChannels(body)).toEqual(["2026-05-18_10-50"]);
  });

  it("Pos T-4: body-order preserved across inline-code + bold-prefix passes", () => {
    const body = `
**Channel:** 2026-05-18_10-50 first mention here.

Later inline-code ref: \`2026-05-15_18-26\` previous cycle.
    `;
    expect(parseHandoffBodyForChannels(body)).toEqual([
      "2026-05-18_10-50",
      "2026-05-15_18-26",
    ]);
  });

  it("Pos T-5: bold-prefix-bare-id with slug suffix accepted", () => {
    const body = "**Channel:** 2026-05-18_10-50-coord";
    expect(parseHandoffBodyForChannels(body)).toEqual([
      "2026-05-18_10-50-coord",
    ]);
  });

  it("Neg T-6: bold-prefix bare-date (no time component) rejected by shape", () => {
    const body = "**Date:** 2026-05-18 not a channel.";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  it("Neg T-7: bold-prefix bare-uuid rejected by shape", () => {
    const body = "**Session:** a02fa5fc-e7ba-4cc0-97c5-f2023c6e7de7";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  it("Neg T-8: bold WITHOUT colon REJECTED (Q2 disposition; ambiguous prose)", () => {
    const body = "**Channel** 2026-05-18_10-50 — no colon at all";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  it("Dedup T-9: same id in BOTH inline-code AND bold-prefix dedups (first occurrence)", () => {
    const body = `
**Channel:** 2026-05-18_10-50 first mention.

Later inline ref: \`2026-05-18_10-50\` again.
    `;
    expect(parseHandoffBodyForChannels(body)).toEqual(["2026-05-18_10-50"]);
  });

  it("Pos T-10: bold-key with internal spaces", () => {
    const body = "**Channel Coord:** 2026-05-18_10-50";
    expect(parseHandoffBodyForChannels(body)).toEqual(["2026-05-18_10-50"]);
  });

  it("Neg T-11: bare bold-bold with no keyword does not match", () => {
    const body = "** ** 2026-05-18_10-50 no valid keyword";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });

  // NIT-1 (Alpha audit-verdict) — positive-rejection-case so future regex
  // tweaks don't accidentally relax the whitespace requirement.
  it("Neg T-12 (NIT-1): NO whitespace after `**:` REJECTED", () => {
    const body = "**Channel:**2026-05-18_10-50 missing whitespace between";
    expect(parseHandoffBodyForChannels(body)).toEqual([]);
  });
});

describe("parseHandoffBodyForChannelsFromFile — file wrapper", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "l141-parser-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("happy path: reads handoff file + extracts channels", () => {
    const path = join(tmpDir, "HANDOFF_test.md");
    writeFileSync(
      path,
      "# Handoff\n\n**Channel:** `2026-05-15_18-26` armed.\n",
    );
    expect(parseHandoffBodyForChannelsFromFile(path)).toEqual([
      "2026-05-15_18-26",
    ]);
  });

  it("throws ENOENT on missing file", () => {
    expect(() =>
      parseHandoffBodyForChannelsFromFile(join(tmpDir, "does-not-exist.md")),
    ).toThrow(/ENOENT|no such file/);
  });

  // T2X — round-trip integration against real handoff body shapes.
  // Fixtures mirror actual `~/.claude/handoffs/HANDOFF_*.md` body text
  // (verified by hand-survey before fixture authoring).

  it("RT-1: HANDOFF_2026-05-19_22-40 shape — bold-prefix bare-id (the v0.1 bug case)", () => {
    const path = join(tmpDir, "HANDOFF_2026-05-19_22-40.md");
    writeFileSync(
      path,
      "# Handoff\n\n**Branch:** main\n**Channel:** 2026-05-18_10-50 (4 NATO peers active)\n\nSome prose body content here.\n",
    );
    expect(parseHandoffBodyForChannelsFromFile(path)).toEqual([
      "2026-05-18_10-50",
    ]);
  });

  it("RT-2: HANDOFF_2026-05-19_18-55 shape — mixed bold-prefix bare-id + bold-wrap inline-code dedupes", () => {
    const path = join(tmpDir, "HANDOFF_2026-05-19_18-55.md");
    writeFileSync(
      path,
      "# Handoff\n\n**Channel:** 2026-05-18_10-50 (4 NATO peers: Alpha + Bravo + Charlie + Delta)\n\nMore prose.\n\n- **Channel `2026-05-18_10-50`** alive; 4 NATO identities held\n\nMonitor task `boqvouxw4` (id-shape filter rejects this short token).\n",
    );
    expect(parseHandoffBodyForChannelsFromFile(path)).toEqual([
      "2026-05-18_10-50",
    ]);
  });

  // RT-3 — Alpha audit-verdict NIT-2 absorption.
  // Provenance correction: NIT-2 cited HANDOFF_2026-05-19_16-30.md but
  // primary-source verification showed the two-channel-per-line shape
  // actually lives in SESSION_LOG.md:624, AND the `2026-05-15_backlog-100-333`
  // example fails current CHANNEL_ID_SHAPE (no `_HH-MM` time component).
  // Substituted real two-distinct-channels-per-line shape from
  // HANDOFF_2026-04-19_18-34: `stale channels (` + two conforming ids.
  it("RT-3 (NIT-2): two distinct channels on the SAME line both extracted (real handoff shape)", () => {
    const path = join(tmpDir, "HANDOFF_2026-04-19_18-34.md");
    writeFileSync(
      path,
      "# Handoff\n\n**Channel cleanup** — both stale channels (`2026-04-26_01-30`, `2026-04-22_06-13`) removed; one was a context-load-only join with no substantive content.\n",
    );
    expect(parseHandoffBodyForChannelsFromFile(path)).toEqual([
      "2026-04-26_01-30",
      "2026-04-22_06-13",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────
// PR-A5 — parseHandoffFrontmatter coverage
// ─────────────────────────────────────────────────────────────────

const MIN_FM = `---
session_id: 7a18d5a2-a07f-4082-ac60-0dd147a19355
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
---

# Handoff body
`;

const VALID_LINEAGE: LineageEnvelope = {
  kind_version: 1,
  producer_session_id: "7a18d5a2-a07f-4082-ac60-0dd147a19355",
  input_body_refs: ["body-ref-1", "body-ref-2"],
};

describe("parseHandoffFrontmatter — required fields", () => {
  it("FM-1: parses minimal valid frontmatter (4 required fields + empty entries_touched)", () => {
    const fm = parseHandoffFrontmatter(MIN_FM);
    expect(fm).not.toBeNull();
    expect(fm).toEqual({
      session_id: "7a18d5a2-a07f-4082-ac60-0dd147a19355",
      started_at: "2026-05-26T17:03:42Z",
      ended_at: "2026-05-26T20:50:00Z",
      entries_touched: [],
    });
  });

  it("FM-2: returns null when source has no frontmatter block", () => {
    expect(parseHandoffFrontmatter("just body, no fm")).toBeNull();
  });

  it("FM-3: returns null when frontmatter opens but never closes", () => {
    expect(
      parseHandoffFrontmatter("---\nsession_id: abc\nstarted_at: t1\n"),
    ).toBeNull();
  });

  it("FM-4: returns null when session_id is missing", () => {
    const fm = `---
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
---
`;
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });

  it("FM-5: returns null when started_at is empty", () => {
    const fm = `---
session_id: abc
started_at:
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
---
`;
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });

  it("FM-6: returns null when ended_at is missing", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
entries_touched: []
---
`;
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });

  it("FM-7: returns null when entries_touched is missing entirely", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
---
`;
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });
});

describe("parseHandoffFrontmatter — entries_touched", () => {
  it("FM-8: parses block-style list of memory filenames", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched:
  - feedback-foo.md
  - feedback-bar.md
  - feedback-baz.md
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.entries_touched).toEqual([
      "feedback-foo.md",
      "feedback-bar.md",
      "feedback-baz.md",
    ]);
  });

  it("FM-9: parses `[]` flow-empty form", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
---
`;
    expect(parseHandoffFrontmatter(fm)?.entries_touched).toEqual([]);
  });
});

describe("parseHandoffFrontmatter — optional fields", () => {
  it("FM-10: parses nato + pair + cohort_channel + cohort_arc + supersedes", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
cohort_channel: 2026-05-25_23-30
cohort_arc: bernstein-review-arc Cycle 1
nato: Alpha
pair: A (with Bravo)
supersedes: HANDOFF_2026-05-26_19-55_alpha.md
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.nato).toBe("Alpha");
    expect(result?.pair).toBe("A (with Bravo)");
    expect(result?.cohort_channel).toBe("2026-05-25_23-30");
    expect(result?.cohort_arc).toBe("bernstein-review-arc Cycle 1");
    expect(result?.supersedes).toBe("HANDOFF_2026-05-26_19-55_alpha.md");
  });

  it("FM-11: parses cohort handoff pair_a + pair_b form", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
pair_a: Alpha + Bravo
pair_b: Charlie + Delta
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.pair_a).toBe("Alpha + Bravo");
    expect(result?.pair_b).toBe("Charlie + Delta");
  });

  it("FM-12: returns null on invalid nato value", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
nato: NotANatoLetter
---
`;
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });

  it("FM-13: parses cohort_arcs multi-line flow objects", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
cohort_arcs:
  - { arc: agetor, channel: "2026-05-25_20-15", role: synthesis-driver }
  - {
      arc: bernstein,
      channel: "2026-05-25_23-30",
      role: Pair-A-partner-audit-shadow,
    }
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.cohort_arcs).toEqual([
      {
        arc: "agetor",
        channel: "2026-05-25_20-15",
        role: "synthesis-driver",
      },
      {
        arc: "bernstein",
        channel: "2026-05-25_23-30",
        role: "Pair-A-partner-audit-shadow",
      },
    ]);
  });
});

describe("parseHandoffFrontmatter — verifications_run", () => {
  it("FM-14: parses flat-string verifications", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
verifications_run:
  - typecheck (PR-A1 / PR-A2 / PR-A3 / PR-A4 all green)
  - format
  - lint
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.verifications_run).toEqual([
      "typecheck (PR-A1 / PR-A2 / PR-A3 / PR-A4 all green)",
      "format",
      "lint",
    ]);
  });

  it("FM-15: parses flow-style structured verifications", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
verifications_run:
  - { cmd: "bun run typecheck", ts: "2026-05-26T18:13:00Z", exit_code: 0 }
  - { cmd: "bun run lint", ts: "2026-05-26T18:13:00Z", exit_code: 0 }
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.verifications_run).toEqual([
      {
        cmd: "bun run typecheck",
        ts: "2026-05-26T18:13:00Z",
        exit_code: 0,
      },
      {
        cmd: "bun run lint",
        ts: "2026-05-26T18:13:00Z",
        exit_code: 0,
      },
    ]);
  });

  it("FM-16: parses multi-line flow-style verifications (real handoff shape)", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
verifications_run:
  - { cmd: "bun run typecheck", ts: "2026-05-26T18:13:00Z", exit_code: 0 }
  - {
      cmd: "bun run check-generic-paths",
      ts: "2026-05-26T20:27:00Z",
      exit_code: 0,
    }
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.verifications_run).toEqual([
      {
        cmd: "bun run typecheck",
        ts: "2026-05-26T18:13:00Z",
        exit_code: 0,
      },
      {
        cmd: "bun run check-generic-paths",
        ts: "2026-05-26T20:27:00Z",
        exit_code: 0,
      },
    ]);
  });

  it("FM-17: returns null on flow-object missing required cmd", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
verifications_run:
  - { ts: "2026-05-26T18:13:00Z", exit_code: 0 }
---
`;
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });
});

describe("parseHandoffFrontmatter — lineage extension", () => {
  it("FM-18: parser tolerates absent lineage (back-compat)", () => {
    const result = parseHandoffFrontmatter(MIN_FM);
    expect(result?.lineage).toBeUndefined();
  });

  it("FM-19: parses block-style lineage envelope", () => {
    const fm = `---
session_id: 7a18d5a2-a07f-4082-ac60-0dd147a19355
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
lineage:
  kind_version: 1
  producer_session_id: 7a18d5a2-a07f-4082-ac60-0dd147a19355
  input_body_refs:
    - body-ref-1
    - body-ref-2
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.lineage).toEqual(VALID_LINEAGE);
  });

  it("FM-20: parses block-style lineage with all optional fields", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
lineage:
  kind_version: 1
  producer_session_id: producer-uuid
  input_body_refs:
    - ref-a
  produced_at: 2026-05-26T17:00:00Z
  model: claude-opus-4-7
  prompt_sha: deadbeef
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.lineage).toEqual({
      kind_version: 1,
      producer_session_id: "producer-uuid",
      input_body_refs: ["ref-a"],
      produced_at: "2026-05-26T17:00:00Z",
      model: "claude-opus-4-7",
      prompt_sha: "deadbeef",
    });
  });

  it("FM-21: parses inline JSON-flow lineage", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
lineage: {"kind_version":1,"producer_session_id":"producer-uuid","input_body_refs":["ref-a"]}
---
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result?.lineage).toEqual({
      kind_version: 1,
      producer_session_id: "producer-uuid",
      input_body_refs: ["ref-a"],
    });
  });

  it("FM-22: returns null on malformed lineage (delegates to parseLineageEnvelope)", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
lineage:
  kind_version: 2
  producer_session_id: producer-uuid
  input_body_refs:
    - ref-a
---
`;
    // kind_version: 2 is rejected by parseLineageEnvelope → outer null
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });

  it("FM-23: returns null on lineage missing required producer_session_id", () => {
    const fm = `---
session_id: abc
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
lineage:
  kind_version: 1
  input_body_refs:
    - ref-a
---
`;
    expect(parseHandoffFrontmatter(fm)).toBeNull();
  });
});

describe("parseHandoffFrontmatter — roundtrip with real handoff shapes", () => {
  it("FM-24: parses HANDOFF_2026-05-26_20-50 (Alpha) actual frontmatter", () => {
    const fm = `---
session_id: 7a18d5a2-a07f-4082-ac60-0dd147a19355
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
verifications_run:
  - { cmd: "bun run typecheck", ts: "2026-05-26T18:13:00Z", exit_code: 0 }
  - { cmd: "bun run lint", ts: "2026-05-26T18:13:00Z", exit_code: 0 }
  - {
      cmd: "bun run check-generic-paths",
      ts: "2026-05-26T20:27:00Z",
      exit_code: 0,
    }
  - { cmd: "bun test (full suite)", ts: "2026-05-26T20:27:00Z", exit_code: 0 }
cohort_channel: 2026-05-25_23-30
cohort_arc: bernstein-review-arc Cycle 1 SUBSTANTIVE COMPLETION
nato: Alpha
pair: A (with Bravo)
---

# Body
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("7a18d5a2-a07f-4082-ac60-0dd147a19355");
    expect(result?.nato).toBe("Alpha");
    expect(result?.cohort_channel).toBe("2026-05-25_23-30");
    expect(result?.verifications_run?.length).toBe(4);
    const firstRun = result?.verifications_run?.[0];
    expect(firstRun).toEqual({
      cmd: "bun run typecheck",
      ts: "2026-05-26T18:13:00Z",
      exit_code: 0,
    });
  });

  it("FM-25: parses HANDOFF_2026-05-26_01-30_cohort (cohort form with pair_a + pair_b)", () => {
    const fm = `---
session_id: 2c647f18-42b9-4afb-8deb-3be22cf0b8cd
started_at: 2026-05-25T22:49:00.776Z
ended_at: 2026-05-26T01:30:00Z
entries_touched:
  - feedback-monitor-filter-jsonl-json-field-shape.md
  - feedback-cohort-cold-review-protocol.md
verifications_run: []
cohort_channel: 2026-05-25_23-30
cohort_arc: bernstein-review-arc (2nd same-day cohort arc; chained from agetor-review-arc on 2026-05-25_20-15)
pair_a: Alpha + Bravo
pair_b: Charlie + Delta
---

# Body
`;
    const result = parseHandoffFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result?.entries_touched).toHaveLength(2);
    expect(result?.pair_a).toBe("Alpha + Bravo");
    expect(result?.pair_b).toBe("Charlie + Delta");
    expect(result?.verifications_run).toEqual([]);
  });
});

describe("parseHandoffFrontmatterFromFile — file wrapper", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-frontmatter-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("FM-26: reads + parses a real-shape handoff file", () => {
    const path = join(tmpDir, "HANDOFF_2026-05-26_20-50.md");
    writeFileSync(
      path,
      `---
session_id: 7a18d5a2-a07f-4082-ac60-0dd147a19355
started_at: 2026-05-26T17:03:42Z
ended_at: 2026-05-26T20:50:00Z
entries_touched: []
nato: Alpha
---

# Body
`,
    );
    const result = parseHandoffFrontmatterFromFile(path);
    expect(result?.session_id).toBe("7a18d5a2-a07f-4082-ac60-0dd147a19355");
    expect(result?.nato).toBe("Alpha");
  });

  it("FM-27: throws ENOENT on missing file", () => {
    const missing = join(tmpDir, "does-not-exist.md");
    expect(() => parseHandoffFrontmatterFromFile(missing)).toThrow();
  });

  it("FM-28: returns null when file has no frontmatter", () => {
    const path = join(tmpDir, "no-fm.md");
    writeFileSync(path, "# Just a body\n\nNo frontmatter here.\n");
    expect(parseHandoffFrontmatterFromFile(path)).toBeNull();
  });
});

describe("parseHandoffFrontmatter — type narrowing surface", () => {
  it("FM-29: returned value is structurally HandoffFrontmatter (compile-time)", () => {
    const result = parseHandoffFrontmatter(MIN_FM);
    if (result !== null) {
      const narrowed: HandoffFrontmatter = result;
      expect(narrowed.session_id).toBe("7a18d5a2-a07f-4082-ac60-0dd147a19355");
    }
  });
});
