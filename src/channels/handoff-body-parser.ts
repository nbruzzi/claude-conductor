// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L141 — pure parser for channel-id references in a handoff body.
 *
 * Strategy: extract all inline-code (backtick-quoted) strings matching
 * the channel-id shape `YYYY-MM-DD_HH-MM[-<slug>]`. Pure shape-match
 * rather than `Channel`-keyword anchoring — empirical scan of
 * `~/.claude/handoffs/HANDOFF_*.md` showed all backtick-strings
 * matching the shape are channel refs; the shape itself is
 * specific enough to filter prose-mention false positives.
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

export function parseHandoffBodyForChannels(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(INLINE_CODE)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
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
