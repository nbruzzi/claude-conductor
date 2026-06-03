#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Lexicon CLI (Tier 3-C).
 *
 * Usage:
 *   claude-conductor lexicon [--source memory|handoffs|channels|all] [--since <ISO>] [--top <N>] [--format json|csv|human]
 *
 * Scans memory files + handoff bodies + channel JSONL bodies for
 * terms-of-art; emits a `Lexicon` sorted by first-introduction with
 * per-term occurrence counts + source breakdown.
 *
 * Plan: slice-T3C-lexicon-2026-05-20.md v0.1.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listChannelArchiveFilePaths } from "../channels/index.ts";

import { channelsDir, handoffsDir, memoriesDir } from "../shared/paths.ts";
import {
  aggregateLexicon,
  type AggregateInput,
  type Lexicon,
  type SourceKind,
} from "./scanner.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[lexicon] ${message}\n`);
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

type Source = SourceKind | "all";

type Flags = {
  source: Source;
  since: string | null;
  top: number | null;
  format: "json" | "csv" | "human";
};

function parseFlags(argv: readonly string[]): Flags {
  let source: Source = "all";
  let since: string | null = null;
  let top: number | null = null;
  let format: Flags["format"] = "json";
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--source" || arg.startsWith("--source=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--source");
      if (
        value !== "memory" &&
        value !== "handoffs" &&
        value !== "channels" &&
        value !== "all"
      ) {
        die(
          `invalid --source '${value}' (expected memory|handoffs|channels|all)`,
        );
      }
      source = value as Source;
      i += consumed;
    } else if (arg === "--since" || arg.startsWith("--since=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--since");
      if (!Number.isFinite(Date.parse(value))) {
        die(`invalid --since '${value}' (expected ISO-8601)`);
      }
      since = value;
      i += consumed;
    } else if (arg === "--top" || arg.startsWith("--top=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--top");
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        die(`invalid --top '${value}' (expected positive integer)`);
      }
      top = n;
      i += consumed;
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--format");
      if (value !== "json" && value !== "csv" && value !== "human") {
        die(`invalid --format '${value}' (expected json|csv|human)`);
      }
      format = value;
      i += consumed;
    } else {
      die(`unknown flag '${arg}' for lexicon`);
    }
  }
  return { source, since, top, format };
}

function listMarkdownFiles(dir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const fullPath = join(dir, name);
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

function realIsoMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function scanMemorySource(): AggregateInput[] {
  const dir = memoriesDir();
  const files = listMarkdownFiles(dir);
  const out: AggregateInput[] = [];
  for (const path of files) {
    if (path.endsWith("MEMORY.md")) continue;
    let body = "";
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    out.push({
      kind: "memory",
      source: path,
      ts: realIsoMtime(path),
      body,
    });
  }
  return out;
}

const HANDOFF_DATE_RE = /^HANDOFF_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})\.md$/;

function scanHandoffSource(): AggregateInput[] {
  const dir = handoffsDir();
  const files = listMarkdownFiles(dir);
  const out: AggregateInput[] = [];
  for (const path of files) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const m = HANDOFF_DATE_RE.exec(name);
    let ts: string;
    if (
      m !== null &&
      m[1] !== undefined &&
      m[2] !== undefined &&
      m[3] !== undefined
    ) {
      ts = `${m[1]}T${m[2]}:${m[3]}:00Z`;
    } else {
      ts = realIsoMtime(path);
    }
    let body = "";
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    out.push({ kind: "handoffs", source: path, ts, body });
  }
  return out;
}

function scanChannelSource(): AggregateInput[] {
  const dir = channelsDir();
  let channelIds: readonly string[];
  try {
    channelIds = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AggregateInput[] = [];
  for (const id of channelIds) {
    const channelPath = join(dir, id);
    let stats;
    try {
      stats = statSync(channelPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    // Span sealed rotation archives (oldest-seq first) + the live file so the
    // lexicon aggregation is not silently truncated post-rotation.
    let raw = "";
    let anyRead = false;
    for (const jsonlPath of [
      ...listChannelArchiveFilePaths(channelPath),
      join(channelPath, "messages.jsonl"),
    ]) {
      try {
        raw += readFileSync(jsonlPath, "utf8");
        anyRead = true;
      } catch {
        /* missing file in the set — skip */
      }
    }
    if (!anyRead) continue;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const obj = parsed as Record<string, unknown>;
      const ts = typeof obj["ts"] === "string" ? (obj["ts"] as string) : "";
      if (ts === "") continue;
      let body = "";
      if (typeof obj["body"] === "string") {
        body = obj["body"] as string;
      } else if (typeof obj["body_ref"] === "string") {
        const bodyRef = obj["body_ref"] as string;
        const bodyPath = join(channelPath, "bodies", `${bodyRef}.txt`);
        try {
          body = readFileSync(bodyPath, "utf8");
        } catch {
          continue;
        }
      } else {
        continue;
      }
      out.push({
        kind: "channels",
        source: `channel/${id}:${ts}`,
        ts,
        body,
      });
    }
  }
  return out;
}

function filterBySince(
  inputs: readonly AggregateInput[],
  since: string | null,
): readonly AggregateInput[] {
  if (since === null) return inputs;
  const sinceMs = Date.parse(since);
  return inputs.filter((i) => Date.parse(i.ts) >= sinceMs);
}

function applyTop(lexicon: Lexicon, top: number | null): Lexicon {
  if (top === null || lexicon.terms.length <= top) return lexicon;
  return { ...lexicon, terms: lexicon.terms.slice(0, top) };
}

function emitJson(lexicon: Lexicon): void {
  process.stdout.write(`${JSON.stringify(lexicon, null, 2)}\n`);
}

function emitCsv(lexicon: Lexicon): void {
  process.stdout.write(
    "term,first_seen,first_seen_source,last_seen,last_seen_source,occurrences,memory,handoffs,channels\n",
  );
  for (const t of lexicon.terms) {
    const csvCell = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    process.stdout.write(
      [
        csvCell(t.term),
        t.first_seen,
        csvCell(t.first_seen_source),
        t.last_seen,
        csvCell(t.last_seen_source),
        String(t.occurrence_count),
        String(t.source_breakdown.memory),
        String(t.source_breakdown.handoffs),
        String(t.source_breakdown.channels),
      ].join(",") + "\n",
    );
  }
}

function emitHuman(lexicon: Lexicon): void {
  process.stdout.write(
    `Lexicon (${lexicon.total_terms} terms across ` +
      `${lexicon.sources_scanned.memory} memory + ` +
      `${lexicon.sources_scanned.handoffs} handoffs + ` +
      `${lexicon.sources_scanned.channels} channels)\n\n`,
  );
  for (const t of lexicon.terms) {
    process.stdout.write(
      `  ${t.term}\n` +
        `    first: ${t.first_seen} ${t.first_seen_source}\n` +
        `    count: ${t.occurrence_count} (m:${t.source_breakdown.memory} h:${t.source_breakdown.handoffs} c:${t.source_breakdown.channels})\n`,
    );
  }
}

function lexiconCommand(argv: readonly string[]): void {
  const flags = parseFlags(argv);
  const inputs: AggregateInput[] = [];
  if (flags.source === "memory" || flags.source === "all") {
    inputs.push(...scanMemorySource());
  }
  if (flags.source === "handoffs" || flags.source === "all") {
    inputs.push(...scanHandoffSource());
  }
  if (flags.source === "channels" || flags.source === "all") {
    inputs.push(...scanChannelSource());
  }
  const filtered = filterBySince(inputs, flags.since);
  const lexicon = applyTop(
    aggregateLexicon(filtered, new Date().toISOString()),
    flags.top,
  );
  if (flags.format === "json") emitJson(lexicon);
  else if (flags.format === "csv") emitCsv(lexicon);
  else emitHuman(lexicon);
}

function printHelp(): void {
  process.stdout.write(
    [
      "lexicon CLI — extract terms-of-art from memory + handoffs + channels.",
      "",
      "Usage:",
      "  lexicon [--source memory|handoffs|channels|all] [--since <ISO>] [--top <N>] [--format json|csv|human]",
      "",
      "Flags:",
      "  --source <kind>   Restrict scan to one source kind (default: all)",
      "  --since <ISO>     Filter to entries with ts >= <ISO>",
      "  --top <N>         Limit output to top N terms (after sort by first_seen ASC)",
      "  --format <type>   json (default) | csv | human",
      "",
      "Output: Lexicon JSON with terms sorted by first_seen ASC (tie-break term ASC).",
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
  lexiconCommand(argv);
}

main();
