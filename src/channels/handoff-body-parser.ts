// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L141 — pure parser for channel-id references in a handoff body.
 *
 * Strategy: TWO extraction passes merged by body-index for document-order
 * dedup-by-first-occurrence:
 *
 *   (1) Inline-code (backtick-quoted) channel-id-shaped strings.
 *       Original L141 strategy; covers `Channel `<id>` alive` form.
 *
 *   (2) Bold/plain key-prefix + bare-id (T2X extension). Covers handoff
 *       write-template bold-without-backticks forms like
 *       `**Channel:** 2026-05-18_10-50` which previously slipped through
 *       (parser returned `derived-empty-no-body-refs` on real handoffs).
 *
 * Both passes feed the same CHANNEL_ID_SHAPE validator. The shape is
 * specific enough that prose mentions don't false-match; trailing
 * punctuation (`,` `;`) fails shape validation silently.
 *
 * Returns deduplicated channel ids in body-order (first-seen wins).
 * Pure function: no fs, no globals, no side effects. Caller reads
 * the handoff file and passes the body string in (testability).
 *
 * Consumer: `handoff-resolver.ts:resolveActiveChannelForHandoff` —
 * surfaces L141's closeout-handoff mismatch (derived channel empty
 * AND body names live alternative) for `/handoff-resume parallel`
 * Step 4a per backlog L141 design (c).
 */

import { readFileSync } from "node:fs";

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
