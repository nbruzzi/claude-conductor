// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * memory-attention-updater (Tier 3-E E2) — Stop-hook turn-end updater.
 *
 * Fires once per turn-end. Reads the session transcript, detects
 * Read/Edit/Write tool calls on memory files, and updates the sidecar
 * MemoryAttentionState (apply_count_recent + last_apply + apply_history
 * ring-buffer) for each detected memory reference.
 *
 * Concurrent-write safety (F1 plan-tier fold): 4-NATO-peer sessions can
 * concurrently fire Stop hooks; bare tmp+rename has a lost-update class.
 * The read-modify-write cycle runs inside `withLockAsync` so concurrent
 * updaters serialize against the sidecar's lock dir.
 *
 * Fail-open discipline: any failure (transcript unparseable, sidecar
 * malformed, lock IO error, write failure) logs via appendPresenceFailure
 * and returns pass(). Memory-attention is advisory, never blocking.
 *
 * v2-evolution path (per Charlie PR-tier cross-pair-shadow N1 disposition):
 * future iterations may add rule-fire events from `.feedback-events.jsonl`
 * (emitted by feedback-rule-reminder hook) as a more-empirical
 * application-moment signal complementary to or replacing the tool-call
 * detection here. v0.1 ships tool-call-only per master-plan-default +
 * plan-tier RE-N1 disposition (deferred to avoid schema migration in v0.1).
 *
 * Plan: slice-T3E-memory-attention-2026-05-20.md v0.1 (E2 portion).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  memoriesDir,
  memoriesDirForSlug,
  projectSlugFromTranscriptPath,
} from "../../shared/paths.ts";
import { withLockAsync } from "../lock.ts";
import {
  parseMemoryAttentionState,
  SCHEMA_VERSION,
  type MemoryAttentionEntry,
  type MemoryAttentionState,
} from "../../memory-attention/scorer.ts";
import { pass, type HookInput, type HookResult } from "../types.ts";

const SOURCE = "memory-attention-updater";
const APPLY_HISTORY_CAP = 50;

function statePath(): string {
  const override = process.env["CLAUDE_CONDUCTOR_MEMORY_ATTENTION_STATE"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".claude", "conductor", "memory-attention.json");
}

function lockDir(path: string): string {
  return `${path}.lock`;
}

type ToolUseEvent = {
  ts: string;
  memory_name: string;
};

/**
 * Parse a transcript JSONL line and extract memory-file Read/Edit/Write
 * tool-use events. Returns empty array on parse failure or non-tool-use
 * lines. Memory file detection: tool input has `file_path` matching the
 * memoriesDir() path pattern with a `.md` suffix; MEMORY.md TOC excluded.
 */
function extractMemoryToolUseEvents(
  line: string,
  memDir: string,
): ToolUseEvent[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  const obj = entry as Record<string, unknown>;
  const ts = obj["timestamp"];
  if (typeof ts !== "string") return [];

  const message = obj["message"];
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return [];
  }
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return [];

  const events: ToolUseEvent[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b["type"] !== "tool_use") continue;
    const toolName = b["name"];
    if (
      toolName !== "Read" &&
      toolName !== "Edit" &&
      toolName !== "Write" &&
      toolName !== "NotebookEdit"
    ) {
      continue;
    }
    const input = b["input"];
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      continue;
    }
    const filePath = (input as Record<string, unknown>)["file_path"];
    if (typeof filePath !== "string") continue;
    if (!filePath.startsWith(memDir)) continue;
    if (!filePath.endsWith(".md")) continue;
    const name = basename(filePath, ".md");
    if (name === "MEMORY") continue; // skip TOC index file
    events.push({ ts, memory_name: name });
  }
  return events;
}

function readState(path: string): MemoryAttentionState {
  if (!existsSync(path)) {
    return {
      schema_version: SCHEMA_VERSION,
      last_updated: new Date(0).toISOString(),
      memories: {},
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {
      schema_version: SCHEMA_VERSION,
      last_updated: new Date(0).toISOString(),
      memories: {},
    };
  }
  const parsed = parseMemoryAttentionState(raw);
  if (parsed === null) {
    // Malformed sidecar — reset to empty state (writes overwrite).
    return {
      schema_version: SCHEMA_VERSION,
      last_updated: new Date(0).toISOString(),
      memories: {},
    };
  }
  return parsed;
}

function applyEventsToState(
  state: MemoryAttentionState,
  events: readonly ToolUseEvent[],
  now: string,
): MemoryAttentionState {
  const memories: Record<string, MemoryAttentionEntry> = { ...state.memories };
  for (const event of events) {
    const existing = memories[event.memory_name];
    const apply_history = existing
      ? [...existing.apply_history, { ts: event.ts }].slice(-APPLY_HISTORY_CAP)
      : [{ ts: event.ts }];
    memories[event.memory_name] = {
      last_apply:
        existing && existing.last_apply > event.ts
          ? existing.last_apply
          : event.ts,
      apply_count_recent: (existing?.apply_count_recent ?? 0) + 1,
      violation_count_recent: existing?.violation_count_recent ?? 0,
      apply_history,
    };
  }
  return {
    schema_version: SCHEMA_VERSION,
    last_updated: now,
    memories,
  };
}

function writeStateAtomic(path: string, state: MemoryAttentionState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export async function check(input: HookInput): Promise<HookResult> {
  const transcriptPath = input.transcriptPath;
  if (transcriptPath === undefined || transcriptPath.length === 0) {
    return pass();
  }
  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, "utf-8");
  } catch {
    return pass();
  }

  // T4-Y1 cycle 2026-05-22 — prefer transcriptPath-extracted slug over
  // memoriesDir() fallback. transcriptPath is the most reliable slug source
  // inside Stop hook context (input.transcriptPath is always the canonical
  // ~/.claude/projects/<slug>/<sid>.jsonl shape).
  const slug = projectSlugFromTranscriptPath(transcriptPath);
  const memDir = slug !== undefined ? memoriesDirForSlug(slug) : memoriesDir();

  const events: ToolUseEvent[] = [];
  for (const line of transcript.split("\n")) {
    if (line.length === 0) continue;
    events.push(...extractMemoryToolUseEvents(line, memDir));
  }
  if (events.length === 0) {
    // NIT-1 (T4-Y1 Charlie plan-tier fold) — debug visibility on silent-no-op.
    // Surfaces the "transcriptPath shape unrecognized + cwd-fallback also
    // empty" failure mode early so operators don't lose days waiting for
    // sidecar that never populates. Single stderr line; non-blocking.
    if (slug === undefined) {
      console.error(
        `[memory-attention-updater] transcriptPath shape unrecognized + memoriesDir() fallback path matched no events. transcriptPath=${transcriptPath} memDir=${memDir}`,
      );
    }
    return pass();
  }

  const path = statePath();
  const now = new Date().toISOString();

  try {
    await withLockAsync(
      async () => {
        const state = readState(path);
        const updated = applyEventsToState(state, events, now);
        writeStateAtomic(path, updated);
      },
      { lockDir: lockDir(path), ownerTag: SOURCE },
    );
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[${SOURCE}] state update failed (${path}): ${detail}\n`,
    );
  }
  return pass();
}
