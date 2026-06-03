#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for reciprocation graph (Tier 2 Verb 3).
 *
 * Usage:
 *   claude-conductor reciprocation --channel <id> --window <ISO>..<ISO>
 *   claude-conductor reciprocation --channel <id> --window cycle
 *
 * Output: JSON object with `channel_id`, `window`, `edges[]`,
 * `per_peer_audit_debt`, and `balances[]`.
 *
 * `--window cycle` resolves the start bound from the prior handoff's
 * `ended_at` frontmatter (LATEST.md in the handoffs dir, resolved via
 * `handoffsDir()` from shared paths); end bound = now. Per plan D4 —
 * strict semantics, no mtime fallback.
 *
 * Single-purpose CLI for now — no sub-verb routing. If future read shapes
 * materialize (top-debtors, history, etc.), add a verb layer mirroring
 * `src/audits/cli.ts`. YAGNI today.
 *
 * Plan: slice-T2V3-reciprocation-cli-2026-05-20.md in the plans dir.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readBodyFile, readMessages } from "../channels/index.ts";
import { handoffsDir } from "../shared/paths.ts";

import { buildReciprocationGraph } from "./graph.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[reciprocation] ${message}\n`);
  process.exit(code);
}

function consumeStringValue(
  argv: readonly string[],
  i: number,
  flag: string,
): { value: string; consumed: number } {
  const head = argv[i];
  if (head === undefined) die(`missing argument for ${flag}`);
  if (head.startsWith(`${flag}=`)) {
    const value = head.slice(flag.length + 1);
    if (value.length === 0) die(`empty value for ${flag}`);
    return { value, consumed: 1 };
  }
  const next = argv[i + 1];
  if (next === undefined) die(`missing argument for ${flag}`);
  return { value: next, consumed: 2 };
}

type Window = { start_ms: number; end_ms: number };

type RecipFlags = {
  channel_id: string;
  window_spec: string;
};

function parseRecipFlags(argv: readonly string[]): RecipFlags {
  let channel_id = "";
  let window_spec = "";
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--channel" || arg.startsWith("--channel=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--channel");
      channel_id = value;
      i += consumed;
    } else if (arg === "--window" || arg.startsWith("--window=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--window");
      window_spec = value;
      i += consumed;
    } else {
      die(`unknown flag '${arg}' for reciprocation`);
    }
  }
  if (channel_id.length === 0) {
    die("--channel <id> is required (e.g., --channel 2026-05-18_10-50)");
  }
  if (window_spec.length === 0) {
    die("--window <ISO>..<ISO> | cycle is required");
  }
  return { channel_id, window_spec };
}

/**
 * Parse `--window=cycle` or `--window=<start>..<end>` (ISO-8601 bounds).
 * Returns a millisecond window. Dies loudly on shape mismatch — no
 * silent fallback (plan D4).
 */
function resolveWindow(window_spec: string): Window {
  if (window_spec === "cycle") {
    return resolveCycleWindow();
  }
  const range_idx = window_spec.indexOf("..");
  if (range_idx === -1) {
    die(
      `--window must be 'cycle' or '<ISO-start>..<ISO-end>' (got '${window_spec}')`,
    );
  }
  const start_iso = window_spec.slice(0, range_idx);
  const end_iso = window_spec.slice(range_idx + 2);
  const start_ms = Date.parse(start_iso);
  const end_ms = Date.parse(end_iso);
  if (!Number.isFinite(start_ms)) {
    die(`invalid ISO start in --window: '${start_iso}'`);
  }
  if (!Number.isFinite(end_ms)) {
    die(`invalid ISO end in --window: '${end_iso}'`);
  }
  if (end_ms < start_ms) {
    die(
      `--window end (${end_iso}) is before start (${start_iso}); refusing empty range`,
    );
  }
  return { start_ms, end_ms };
}

function resolveCycleWindow(): Window {
  const latestPath = join(handoffsDir(), "LATEST.md");
  let raw: string;
  try {
    raw = readFileSync(latestPath, "utf8");
  } catch {
    die(
      `--window=cycle requires a readable LATEST.md in handoffs dir (looked for ${latestPath})`,
    );
  }
  if (!raw.startsWith("---\n")) {
    die(
      `--window=cycle requires LATEST.md frontmatter with 'ended_at:' (no frontmatter detected)`,
    );
  }
  const fmEnd = raw.indexOf("\n---\n", 4);
  if (fmEnd === -1) {
    die(
      `--window=cycle: LATEST.md frontmatter is unterminated (no closing '---')`,
    );
  }
  const fm = raw.slice(4, fmEnd);
  const endedAtLine = fm.split("\n").find((l) => l.startsWith("ended_at:"));
  if (endedAtLine === undefined) {
    die(
      `--window=cycle requires 'ended_at:' in LATEST.md frontmatter (not found)`,
    );
  }
  const value = endedAtLine.slice("ended_at:".length).trim();
  const start_ms = Date.parse(value);
  if (!Number.isFinite(start_ms)) {
    die(`--window=cycle: 'ended_at: ${value}' is not parseable ISO-8601`);
  }
  return { start_ms, end_ms: Date.now() };
}

function recipCommand(argv: readonly string[]): void {
  const { channel_id, window_spec } = parseRecipFlags(argv);
  const window = resolveWindow(window_spec);

  // includeArchive: a reciprocation window can reach back across a rotation
  // boundary, so analytics must span the archives, not just the live tail.
  const messages = readMessages(channel_id, { includeArchive: true });

  const bodies_by_ref = new Map<string, string>();
  for (const m of messages) {
    if (m.body !== undefined) continue;
    if (m.body_ref === undefined) continue;
    const raw = readBodyFile(channel_id, m.body_ref);
    if (raw !== null) bodies_by_ref.set(m.body_ref, raw);
  }

  const graph = buildReciprocationGraph({
    messages,
    bodies_by_ref,
    channel_id,
    window,
  });

  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(
    [
      "reciprocation CLI — substrate-computed audit-verdict graph per cycle.",
      "",
      "Usage:",
      "  reciprocation --channel <id> --window <ISO-start>..<ISO-end>",
      "  reciprocation --channel <id> --window cycle",
      "",
      "Flags:",
      "  --channel <id>          Channel id (e.g., 2026-05-18_10-50). REQUIRED.",
      "  --window <range>|cycle  Time window. REQUIRED.",
      "                          'cycle' resolves start from prior handoff's",
      "                          'ended_at' frontmatter at",
      "                          LATEST.md in the handoffs dir (end = now).",
      "",
      "Output: JSON with channel_id, window, edges[], per_peer_audit_debt,",
      "and balances[] (canonical pair-keys sorted ASC).",
      "",
    ].join("\n"),
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    printHelp();
    process.exit(0);
  }
  recipCommand(argv);
}

main();
