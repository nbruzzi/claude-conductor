#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for the cycle-character classifier (Tier 3-F).
 *
 * Usage:
 *   claude-conductor cycle-character                       Classify LATEST handoff
 *   claude-conductor cycle-character --classify <path>     Classify the specified handoff
 *   claude-conductor cycle-character --human               Text-table output (default: JSON)
 *
 * Reads the target handoff, applies the rubric, and emits a
 * `CycleClassification` JSON object (or human-readable text).
 *
 * Plan: slice-T3F-cycle-character-classifier-2026-05-20.md v0.1.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { handoffsDir } from "../shared/paths.ts";
import { classifyHandoff, type CycleClassification } from "./classifier.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[cycle-character] ${message}\n`);
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
  handoff_path: string;
  human: boolean;
};

function parseFlags(argv: readonly string[]): Flags {
  let handoff_path = "";
  let human = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--classify" || arg.startsWith("--classify=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--classify");
      handoff_path = value;
      i += consumed;
    } else if (arg === "--human") {
      human = true;
      i += 1;
    } else if (arg === "--json") {
      human = false;
      i += 1;
    } else {
      die(`unknown flag '${arg}' for cycle-character`);
    }
  }
  if (handoff_path.length === 0) {
    handoff_path = join(handoffsDir(), "LATEST.md");
  }
  return { handoff_path, human };
}

function emitHuman(result: CycleClassification, handoff_path: string): void {
  process.stdout.write(`Cycle-character for ${handoff_path}\n`);
  process.stdout.write(`  class:           ${result.class}\n`);
  process.stdout.write(`  confidence:      ${result.confidence}\n`);
  process.stdout.write(`  source:          ${result.source}\n`);
  process.stdout.write(
    `  self_declared:   ${result.self_declared_class ?? "(none)"}\n`,
  );
  process.stdout.write(`  rubric_class:    ${result.rubric_class}\n`);
  process.stdout.write(`  signals:\n`);
  for (const s of result.signals) {
    process.stdout.write(`    - ${s}\n`);
  }
}

function classifyCommand(argv: readonly string[]): void {
  const { handoff_path, human } = parseFlags(argv);
  let body: string;
  try {
    body = readFileSync(handoff_path, "utf8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    die(`could not read handoff at ${handoff_path}: ${reason}`);
  }
  const result = classifyHandoff(body);
  if (human) {
    emitHuman(result, handoff_path);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "cycle-character CLI — classify handoff bodies into cycle-character class.",
      "",
      "Usage:",
      "  cycle-character                       Classify LATEST handoff",
      "  cycle-character --classify <path>     Classify the specified handoff",
      "  cycle-character --human               Text-table output (default: JSON)",
      "",
      "Flags:",
      "  --classify <path>  Handoff path; default = LATEST symlink in handoffs dir",
      "  --json             JSON output (default)",
      "  --human            Human-readable text table",
      "",
      "Output: CycleClassification with class + confidence + signals.",
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
  classifyCommand(argv);
}

main();
