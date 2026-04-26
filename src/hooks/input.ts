// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Stdin JSON parser for Claude Code hooks.
 *
 * Reads stdin once, validates size and structure, extracts known fields
 * into a typed HookInput. Unknown fields preserved in `raw` but never
 * spread — no prototype pollution risk.
 */

import type { HookInput } from "./types.ts";
import { DEFAULT_DISPATCH } from "./types.ts";

// 1MB — previously 64KB, raised 2026-04-18 after HeatPrice.com/planning/decisions.md
// crossed 64KB (D20/D21 are multi-KB design-doc-style rows inside a markdown
// table). Edits on that file were silently dropping post-processing because the
// tool_input payload exceeded the old limit. Concern: the original 64KB cap
// reflected a thesis that "no hook input should ever be larger" — that thesis
// is wrong when users edit large governance/log files wholesale. If hook input
// ever exceeds 1MB, investigate the source file before raising again (it may
// signal a file that should be split, e.g. per-record detail files).
const MAX_STDIN_BYTES = 1_048_576;

export async function readInput(): Promise<HookInput> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_STDIN_BYTES) {
      throw new Error(
        `Stdin exceeds ${MAX_STDIN_BYTES} bytes — rejecting input`,
      );
    }
    chunks.push(value);
  }

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return emptyInput();
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stdin JSON must be an object");
  }

  // Strip __-prefixed keys from stdin — these are internal dispatcher fields
  // (__isolateCheck, __preserveChecks, __verbose) that must not be injectable
  // via crafted JSON input.
  const obj = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      ([k]) => !k.startsWith("__"),
    ),
  );

  const toolInput =
    typeof obj["tool_input"] === "object" && obj["tool_input"] !== null
      ? (obj["tool_input"] as Record<string, unknown>)
      : {};

  return {
    toolName: asString(obj["tool_name"]),
    filePath: asString(toolInput["file_path"]),
    command: asString(toolInput["command"]),
    cwd: asString(obj["cwd"]),
    transcriptPath: asString(obj["transcript_path"]),
    raw: obj,
    dispatch: { ...DEFAULT_DISPATCH },
  };
}

function emptyInput(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw: {},
    dispatch: { ...DEFAULT_DISPATCH },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
