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
});
