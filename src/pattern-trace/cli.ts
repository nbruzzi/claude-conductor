#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Pattern-trace CLI (Tier 3-D D2) — driver layer.
 *
 * Composes git log + gh PR body + channel JSONL scans into a unified
 * RawEvent[] stream, dispatches to the pure-logic detector, and emits
 * either a PropagationGraph JSON, a human-readable summary, or a V2
 * kind=memory-proposal payload for piping to `channels send`.
 *
 * Usage:
 *   claude-conductor pattern-trace --symbol <name>
 *                                  [--since <ISO>]
 *                                  [--source git|prs|channel|all]
 *                                  [--propagation-threshold <N>]
 *                                  [--format json|human]
 *                                  [--emit-memory-proposal]
 *
 * Default --since resolves to the prior handoff's `ended_at` per the
 * V3 resolveCycleWindow pattern.
 *
 * Plan: slice-T3D-pattern-trace-2026-05-20.md v0.1 (D2 portion).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { listChannelArchiveFilePaths } from "../channels/index.ts";

import {
  aggregateGraph,
  buildMemoryProposalPayload,
  type RawEvent,
} from "./detector.ts";
import { runGit } from "../git/index.ts";
import { runGh } from "../gh/index.ts";
import { channelsDir, handoffsDir } from "../shared/paths.ts";

const SCRIPT_DIR = import.meta.dir;
const PACKAGE_ROOT = dirname(dirname(SCRIPT_DIR));

function die(message: string, code: number = 2): never {
  process.stderr.write(`[pattern-trace] ${message}\n`);
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

type Source = "git" | "prs" | "channel" | "all";
type Format = "json" | "human";

type Flags = {
  symbol: string;
  since: string | null;
  source: Source;
  threshold: number;
  format: Format;
  emit_memory_proposal: boolean;
};

function parseFlags(argv: readonly string[]): Flags {
  let symbol = "";
  let since: string | null = null;
  let source: Source = "all";
  let threshold = 3;
  let format: Format = "json";
  let emit_memory_proposal = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--symbol" || arg.startsWith("--symbol=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--symbol");
      symbol = value;
      i += consumed;
    } else if (arg === "--since" || arg.startsWith("--since=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--since");
      if (!Number.isFinite(Date.parse(value))) {
        die(`invalid --since '${value}' (expected ISO-8601)`);
      }
      since = value;
      i += consumed;
    } else if (arg === "--source" || arg.startsWith("--source=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--source");
      if (
        value !== "git" &&
        value !== "prs" &&
        value !== "channel" &&
        value !== "all"
      ) {
        die(`invalid --source '${value}' (expected git|prs|channel|all)`);
      }
      source = value;
      i += consumed;
    } else if (
      arg === "--propagation-threshold" ||
      arg.startsWith("--propagation-threshold=")
    ) {
      const { value, consumed } = consumeStringValue(
        argv,
        i,
        "--propagation-threshold",
      );
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        die(
          `invalid --propagation-threshold '${value}' (expected positive integer)`,
        );
      }
      threshold = n;
      i += consumed;
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--format");
      if (value !== "json" && value !== "human") {
        die(`invalid --format '${value}' (expected json|human)`);
      }
      format = value;
      i += consumed;
    } else if (arg === "--emit-memory-proposal") {
      emit_memory_proposal = true;
      i += 1;
    } else {
      die(`unknown flag '${arg}'`);
    }
  }
  if (symbol.length === 0) {
    die("--symbol <name> is required");
  }
  return { symbol, since, source, threshold, format, emit_memory_proposal };
}

/**
 * Resolve --since default from prior handoff's `ended_at` frontmatter.
 * Mirrors V3 resolveCycleWindow pattern; falls back to die() on missing
 * frontmatter (no silent mtime-fallback).
 */
function resolveDefaultSince(): string {
  const latestPath = join(handoffsDir(), "LATEST.md");
  let raw: string;
  try {
    raw = readFileSync(latestPath, "utf8");
  } catch {
    die(
      `--since default needs handoffs LATEST symlink readable; specify --since <ISO> explicitly (looked for ${latestPath})`,
    );
  }
  if (!raw.startsWith("---\n")) {
    die(`handoffs LATEST has no frontmatter; specify --since <ISO> explicitly`);
  }
  const fmEnd = raw.indexOf("\n---\n", 4);
  if (fmEnd === -1) {
    die(
      `handoffs LATEST frontmatter unterminated; specify --since <ISO> explicitly`,
    );
  }
  const fm = raw.slice(4, fmEnd);
  const endedAtLine = fm.split("\n").find((l) => l.startsWith("ended_at:"));
  if (endedAtLine === undefined) {
    die(
      `handoffs LATEST frontmatter has no 'ended_at:'; specify --since <ISO> explicitly`,
    );
  }
  const value = endedAtLine.slice("ended_at:".length).trim();
  if (!Number.isFinite(Date.parse(value))) {
    die(`handoffs LATEST 'ended_at: ${value}' is not parseable ISO-8601`);
  }
  return value;
}

/**
 * Gather git-log events: each commit referencing the symbol becomes a
 * RawEvent with source_kind="git". Uses `git log -S<symbol>` to find
 * commits where the symbol's introducing/absorbing count changed.
 *
 * Window-boundary semantic (Charlie F1 / Alpha cross-pair-shadow fold):
 * NO `--since` filter at scanner layer — full history is passed to
 * aggregateGraph which window-filters AND detects pre-window introducing
 * via `options.window`. This ensures substrate-self-validation bake-test
 * #9 #2 (parseAuditVerdictBody introduced 2026-05-19; queried with
 * cycle-2026-05-20-start window) correctly returns introducing_event=null
 * rather than mislabeling the first in-window event as introducing.
 */
function gatherGitEvents(symbol: string): RawEvent[] {
  const result = runGit(process.cwd(), [
    "log",
    "--all",
    "-S",
    symbol,
    "--format=%H%x09%aI%x09%an",
  ]);
  if (result.status !== 0) return [];
  const stdout = result.stdout.toString("utf8");
  const events: RawEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const sha = parts[0];
    const ts = parts[1];
    const author = parts[2];
    if (sha === undefined || ts === undefined || author === undefined) continue;
    events.push({
      source_kind: "git",
      source_ref: sha,
      ts,
      author,
    });
  }
  return events;
}

/**
 * Gather PR-body events via `gh pr list --search`.
 * F2 rate-limit defense: single batched call per invocation.
 * Window-boundary: no `merged:>=` filter; detector window-filters via
 * `options.window` per Charlie F1 fold semantic.
 */
function gatherPrEvents(symbol: string): RawEvent[] {
  const result = runGh([
    "pr",
    "list",
    "--state",
    "merged",
    "--search",
    symbol,
    "--json",
    "number,mergedAt,body,author",
    "--limit",
    "100",
  ]);
  if (result.status !== 0) return [];
  const stdout = result.stdout.toString("utf8").trim();
  if (stdout.length === 0) return [];
  let prs: unknown;
  try {
    prs = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(prs)) return [];
  const events: RawEvent[] = [];
  for (const pr of prs) {
    if (pr === null || typeof pr !== "object") continue;
    const obj = pr as Record<string, unknown>;
    const number = obj["number"];
    const mergedAt = obj["mergedAt"];
    const body = obj["body"];
    const author = obj["author"];
    if (typeof number !== "number") continue;
    if (typeof mergedAt !== "string") continue;
    if (typeof body !== "string") continue;
    if (!body.includes(symbol)) continue;
    let authorLogin = "unknown";
    if (
      author !== null &&
      typeof author === "object" &&
      !Array.isArray(author)
    ) {
      const a = author as Record<string, unknown>;
      if (typeof a["login"] === "string") authorLogin = a["login"];
    }
    events.push({
      source_kind: "pr",
      source_ref: `#${number}`,
      ts: mergedAt,
      author: authorLogin,
    });
  }
  return events;
}

/**
 * Gather channel-JSONL events: scan messages.jsonl for each channel,
 * resolve body / body_ref text (mirror T3-C lexicon body_ref handling),
 * text-contains symbol → emit RawEvent with author=identity.
 */
/**
 * Gather channel-JSONL events. Window-boundary: no since filter; detector
 * window-filters via `options.window` per Charlie F1 fold semantic.
 */
function gatherChannelEvents(symbol: string): RawEvent[] {
  const dir = channelsDir();
  let channelIds: readonly string[];
  try {
    channelIds = readdirSync(dir);
  } catch {
    return [];
  }
  const events: RawEvent[] = [];
  for (const channelId of channelIds) {
    const channelPath = join(dir, channelId);
    let stat;
    try {
      stat = statSync(channelPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    // Span sealed rotation archives (oldest-seq first) + the live file so
    // full-history pattern analytics is not silently truncated post-rotation.
    let raw = "";
    let anyRead = false;
    for (const messagesPath of [
      ...listChannelArchiveFilePaths(channelPath),
      join(channelPath, "messages.jsonl"),
    ]) {
      try {
        raw += readFileSync(messagesPath, "utf8");
        anyRead = true;
      } catch {
        /* missing file in the set — skip */
      }
    }
    if (!anyRead) continue;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
        continue;
      }
      const m = msg as Record<string, unknown>;
      const ts = m["ts"];
      const identity = m["identity"];
      if (typeof ts !== "string") continue;
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs)) continue;
      if (typeof identity !== "string" || identity.length === 0) continue;
      let body = "";
      if (typeof m["body"] === "string") {
        body = m["body"];
      } else if (typeof m["body_ref"] === "string") {
        const bodyPath = join(channelPath, "bodies", `${m["body_ref"]}.txt`);
        try {
          body = readFileSync(bodyPath, "utf8");
        } catch {
          continue;
        }
      } else {
        continue;
      }
      if (!body.includes(symbol)) continue;
      events.push({
        source_kind: "channel",
        source_ref: `${channelId}:${ts}`,
        ts,
        author: identity,
      });
    }
  }
  return events;
}

function formatHumanOutput(
  graph: ReturnType<typeof aggregateGraph>,
  sourcesScanned: { git: number; prs: number; channel: number },
  generated_at: string,
  window: { start: string; end: string },
): string {
  const lines: string[] = [];
  lines.push(`Pattern: ${graph.symbol}`);
  lines.push(`Window:  ${window.start} → ${window.end}`);
  lines.push(
    `Sources: git=${sourcesScanned.git} prs=${sourcesScanned.prs} channel=${sourcesScanned.channel}`,
  );
  if (graph.introducing_event === null) {
    lines.push("Introducing: (not found in window)");
  } else {
    const e = graph.introducing_event;
    lines.push(
      `Introducing: ${e.ts} ${e.author} (${e.source_kind}:${e.source_ref})`,
    );
  }
  lines.push(`Absorbing events: ${graph.absorbing_events.length}`);
  for (const e of graph.absorbing_events) {
    lines.push(`  ${e.ts} ${e.author} (${e.source_kind}:${e.source_ref})`);
  }
  lines.push(
    `Distinct peers: ${graph.distinct_peers_count} (${graph.distinct_peers.join(", ")})`,
  );
  if (graph.latency_to_first_absorption_ms !== null) {
    lines.push(
      `Latency to first absorption: ${Math.floor(graph.latency_to_first_absorption_ms / 60000)}m`,
    );
  }
  if (graph.latency_to_cross_author_absorption_ms !== null) {
    lines.push(
      `Latency to cross-author absorption: ${Math.floor(graph.latency_to_cross_author_absorption_ms / 60000)}m`,
    );
  }
  if (graph.memory_suggest_triggered) {
    lines.push(
      `Memory suggest: TRIGGERED — ${graph.memory_suggest_reason ?? ""}`,
    );
  } else {
    lines.push(`Memory suggest: not triggered`);
  }
  lines.push(`Generated at: ${generated_at}`);
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    process.stdout.write(
      [
        "pattern-trace CLI — code-symbol propagation tracer.",
        "",
        "Usage:",
        "  pattern-trace --symbol <name> [--since <ISO>] [--source git|prs|channel|all]",
        "                                [--propagation-threshold <N>] [--format json|human]",
        "                                [--emit-memory-proposal]",
        "",
        "Default --since: prior handoff's `ended_at` frontmatter.",
        "Default --source: all. Default --propagation-threshold: 3. Default --format: json.",
        "",
        "Output: PropagationGraph JSON with introducing + absorbing events,",
        "distinct-peer count, both latency metrics (raw + cross-author), and",
        "auto-memory-suggest trigger. With --emit-memory-proposal, embeds a",
        "V2 kind=memory-proposal payload in the output for piping to channels send.",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
  const flags = parseFlags(argv);
  const since = flags.since ?? resolveDefaultSince();
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    die(`internal: resolved --since '${since}' is not parseable ISO-8601`);
  }
  const nowMs = Date.now();

  let events: RawEvent[] = [];
  const sourcesScanned = { git: 0, prs: 0, channel: 0 };
  if (flags.source === "git" || flags.source === "all") {
    const gitEvents = gatherGitEvents(flags.symbol);
    events = events.concat(gitEvents);
    sourcesScanned.git = gitEvents.length;
  }
  if (flags.source === "prs" || flags.source === "all") {
    const prEvents = gatherPrEvents(flags.symbol);
    events = events.concat(prEvents);
    sourcesScanned.prs = prEvents.length;
  }
  if (flags.source === "channel" || flags.source === "all") {
    const channelEvents = gatherChannelEvents(flags.symbol);
    events = events.concat(channelEvents);
    sourcesScanned.channel = channelEvents.length;
  }

  // Charlie F1 fold + Alpha cross-pair-shadow: pass {window} so the
  // detector window-filters + sets introducing_event=null when the
  // symbol's chronologically-first event predates window.start_ms.
  const graph = aggregateGraph(events, flags.symbol, flags.threshold, {
    window: { start_ms: sinceMs, end_ms: nowMs },
  });
  const generated_at = new Date(nowMs).toISOString();
  const window = { start: since, end: new Date(nowMs).toISOString() };

  const memoryPayload = flags.emit_memory_proposal
    ? buildMemoryProposalPayload(graph)
    : null;

  if (flags.format === "human") {
    process.stdout.write(
      formatHumanOutput(graph, sourcesScanned, generated_at, window),
    );
    if (memoryPayload !== null) {
      process.stdout.write("\nMemory-proposal payload:\n");
      process.stdout.write(JSON.stringify(memoryPayload, null, 2));
      process.stdout.write("\n");
    }
    process.exit(0);
  }

  const output: Record<string, unknown> = {
    generated_at,
    symbol: flags.symbol,
    window: { start_ms: sinceMs, end_ms: nowMs },
    sources_scanned: sourcesScanned,
    graph,
  };
  if (memoryPayload !== null) {
    output["memory_proposal_payload"] = memoryPayload;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

void PACKAGE_ROOT;
main();
