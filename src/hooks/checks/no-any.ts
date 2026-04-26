// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Catch `: any` patterns in TypeScript files (per-edit feedback).
 * Grep-based — fast but may false-positive on comments.
 * ESLint provides AST-aware second layer at commit time.
 *
 * In strict profile: blocks the edit. In standard: warns only.
 * False-positive mitigation: skips .d.ts files, comment lines, eslint-disable lines.
 */

import type { HookInput, HookResult } from "../types.ts";
import { block, pass, warn } from "../types.ts";

const SOURCE = "no-any";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ANY_PATTERN = /:\s*any\b|<any>|as any/;

export async function check(input: HookInput): Promise<HookResult> {
  const file = input.filePath;
  if (!file) return pass();

  // Skip .d.ts files — type declarations often require `any` for third-party compat
  if (file.endsWith(".d.ts")) return pass();

  const ext = file.substring(file.lastIndexOf("."));
  if (!TS_EXTENSIONS.has(ext)) return pass();

  const bunFile = Bun.file(file);
  if (!(await bunFile.exists())) return pass();

  const content = await bunFile.text();
  const lines = content.split("\n");
  const matches: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (isCommentOrSuppressed(line)) continue;
    if (ANY_PATTERN.test(line)) {
      matches.push(`  ${i + 1}: ${line.trim()}`);
      if (matches.length >= 3) break;
    }
  }

  if (matches.length === 0) return pass();

  const detail = `${matches.length} match${matches.length === 1 ? "" : "es"} for pattern: ${ANY_PATTERN.source}`;
  const msg = `WARNING: \`any\` detected in ${file} — use explicit types (per CLAUDE.md).\n${matches.join("\n")}`;

  if (input.dispatch.profile === "strict") {
    return block(SOURCE, `BLOCKED: ${msg}`, detail);
  }
  return warn(SOURCE, msg, detail);
}

function isCommentOrSuppressed(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return true;
  if (
    trimmed.includes("// eslint-disable") ||
    trimmed.includes("@ts-expect-error")
  )
    return true;
  return false;
}
