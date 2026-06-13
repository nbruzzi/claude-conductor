#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Memory-attention CLI (Tier 3-E E1) — Alpha portion.
 *
 * Usage:
 *   claude-conductor memory-attention [--since <Nd>] [--top <N>]
 *                                     [--format json|human]
 *                                     [--memory-dir <path>]
 *
 * Loads the substrate-owned sidecar state from
 * `<conductor-state>/memory-attention.json` (written by E2 Stop-hook
 * `memory-attention-updater`); enumerates memory files in
 * `memoriesDir()`; computes Bravo's score for each; emits sorted output.
 *
 * Plan: slice-T3E-memory-attention-2026-05-20.md v0.1.
 */

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isIndexFile, memoriesDir } from "../shared/paths.ts";
import { effectiveHome } from "../shared/home.ts";
import {
  buildAttentionOutput,
  parseMemoryAttentionState,
  type AttentionOutput,
  type MemoryAttentionState,
} from "./scorer.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[memory-attention] ${message}\n`);
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

type Flags = {
  window_days: number;
  top: number | null;
  format: "json" | "human";
  memory_dir: string | null;
};

const SINCE_RE = /^(\d+)d$/;

function parseFlags(argv: readonly string[]): Flags {
  let window_days = 7;
  let top: number | null = null;
  let format: Flags["format"] = "json";
  let memory_dir: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--since");
      const m = SINCE_RE.exec(value);
      if (m === null || m[1] === undefined) {
        die(`invalid --since '${value}' (expected '<N>d' shape e.g. '7d')`);
      }
      const n = Number.parseInt(m[1], 10);
      if (!Number.isFinite(n) || n <= 0) {
        die(`invalid --since '${value}' (expected positive integer days)`);
      }
      window_days = n;
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
      if (value !== "json" && value !== "human") {
        die(`invalid --format '${value}' (expected json|human)`);
      }
      format = value;
      i += consumed;
    } else if (arg === "--memory-dir" || arg.startsWith("--memory-dir=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--memory-dir");
      memory_dir = value;
      i += consumed;
    } else {
      die(`unknown flag '${arg}' for memory-attention`);
    }
  }
  return { window_days, top, format, memory_dir };
}

function listMemoryFiles(dir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (isIndexFile(name)) continue; // exclude both index files (MEMORY.md + MEMORY-FULL.md)
    const fullPath = join(dir, name);
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    out.push(name.replace(/\.md$/, ""));
  }
  return out;
}

/**
 * Sidecar state location resolution. Override-able via
 * `CLAUDE_CONDUCTOR_MEMORY_ATTENTION_STATE` env var for testing;
 * default `<effectiveHome>/.claude/conductor/memory-attention.json`.
 */
function memoryAttentionStatePath(): string {
  const override = process.env["CLAUDE_CONDUCTOR_MEMORY_ATTENTION_STATE"];
  if (override !== undefined && override.length > 0) return override;
  return join(effectiveHome(), ".claude", "conductor", "memory-attention.json");
}

function loadSidecarState(): MemoryAttentionState | null {
  const path = memoryAttentionStatePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseMemoryAttentionState(raw);
}

function emitJson(output: AttentionOutput): void {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function emitHuman(output: AttentionOutput): void {
  process.stdout.write(
    `Memory-attention scores (window ${output.window_days}d; ${output.scored_memories}/${output.total_memories} scored)\n`,
  );
  process.stdout.write(`generated_at: ${output.generated_at}\n\n`);
  if (output.entries.length === 0) {
    process.stdout.write("  (no memories)\n");
    return;
  }
  for (const e of output.entries) {
    const scoreStr = e.score.toFixed(3).padStart(8);
    const days =
      e.days_since_last_apply === null
        ? "  -  "
        : e.days_since_last_apply.toFixed(1).padStart(5);
    process.stdout.write(
      `  ${scoreStr}  applies=${String(e.apply_count_recent).padStart(3)}  days_since=${days}  violations=${e.violation_count_recent}  ${e.memory}\n`,
    );
  }
}

function attentionCommand(argv: readonly string[]): void {
  const flags = parseFlags(argv);
  const dir = flags.memory_dir ?? memoriesDir();
  const memory_names = [...listMemoryFiles(dir)].sort();
  const state = loadSidecarState();
  const now_ms = Date.now();
  const output = buildAttentionOutput({
    memory_names,
    state,
    now_ms,
    window_days: flags.window_days,
    top: flags.top,
  });
  if (flags.format === "json") emitJson(output);
  else emitHuman(output);
}

function printHelp(): void {
  process.stdout.write(
    [
      "memory-attention CLI — score memories by recent-apply utility per Bravo's algorithm.",
      "",
      "Usage:",
      "  memory-attention [--since <Nd>] [--top <N>] [--format json|human] [--memory-dir <path>]",
      "",
      "Flags:",
      "  --since <Nd>          Recent window in days (default: 7d)",
      "  --top <N>             Limit output to top N entries (default: all)",
      "  --format <json|human> Output format (default: json)",
      "  --memory-dir <path>   Override memoriesDir() resolution (env-var equivalent)",
      "",
      "Score: apply_count_recent x 0.95^days_since_last_apply - 0.5 x violation_count_recent",
      "",
      "Sidecar state path:",
      "  $CLAUDE_CONDUCTOR_MEMORY_ATTENTION_STATE OR <home>/<conductor-state-dir>/memory-attention.json",
      "  (written by Stop-hook 'memory-attention-updater'; reader-only here)",
      "",
      "Output: sorted score DESC (tie-break memory name ASC) per F1 deterministic-sort fold.",
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
  attentionCommand(argv);
}

main();
