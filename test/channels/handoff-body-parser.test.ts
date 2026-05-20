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
} from "../../src/channels/handoff-body-parser.ts";

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
