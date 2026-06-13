// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for memory-attention-updater Stop hook (Tier 3-E E2).
 *
 * Coverage per plan §9 E2:
 *   - empty transcript → no sidecar state change
 *   - transcript with N Read calls on memory files → sidecar updated
 *   - non-memory Read calls (other paths) → ignored
 *   - missing transcriptPath → pass() with no error
 *   - apply_history bounded at 50 entries (push then drop oldest)
 *
 * Plan: slice-T3E-memory-attention-2026-05-20.md v0.1 (E2 portion).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../../../src/hooks/checks/memory-attention-updater.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";
import { parseMemoryAttentionState } from "../../../src/memory-attention/scorer.ts";

const SID = "f9e8d7c6-b5a4-3210-9876-543210fedcba";
const MEM_DIR_ENV = "CLAUDE_CONDUCTOR_MEMORIES_DIR";
const STATE_PATH_ENV = "CLAUDE_CONDUCTOR_MEMORY_ATTENTION_STATE";

let tmpHome: string;
let memDir: string;
let statePath: string;
let transcriptPath: string;
let prevMemEnv: string | undefined;
let prevStateEnv: string | undefined;

function makeInput(transcript: string | undefined): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: tmpHome,
    transcriptPath: transcript,
    raw: { session_id: SID },
    dispatch: DEFAULT_DISPATCH,
  };
}

function writeTranscriptLines(lines: readonly object[]): void {
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(transcriptPath, content);
}

function toolUseLine(
  ts: string,
  toolName: string,
  filePath: string,
): Record<string, unknown> {
  return {
    timestamp: ts,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${ts.replace(/[^a-z0-9]/gi, "")}`,
          name: toolName,
          input: { file_path: filePath },
        },
      ],
    },
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "mem-attn-updater-test-"));
  memDir = join(tmpHome, "memories");
  statePath = join(tmpHome, "conductor", "memory-attention.json");
  transcriptPath = join(tmpHome, "transcript.jsonl");
  mkdirSync(memDir, { recursive: true });

  prevMemEnv = process.env[MEM_DIR_ENV];
  prevStateEnv = process.env[STATE_PATH_ENV];
  process.env[MEM_DIR_ENV] = memDir;
  process.env[STATE_PATH_ENV] = statePath;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevMemEnv !== undefined) process.env[MEM_DIR_ENV] = prevMemEnv;
  else delete process.env[MEM_DIR_ENV];
  if (prevStateEnv !== undefined) process.env[STATE_PATH_ENV] = prevStateEnv;
  else delete process.env[STATE_PATH_ENV];
});

describe("memory-attention-updater Stop hook", () => {
  it("missing transcriptPath returns pass() without writing state", async () => {
    const result = await check(makeInput(undefined));
    expect(result.exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("empty transcript file returns pass() without writing state", async () => {
    writeFileSync(transcriptPath, "");
    const result = await check(makeInput(transcriptPath));
    expect(result.exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("transcript with non-memory Read calls is ignored (no state written)", async () => {
    writeTranscriptLines([
      toolUseLine(
        "2026-05-20T17:00:00Z",
        "Read",
        join(tmpHome, "elsewhere", "file.md"),
      ),
      toolUseLine(
        "2026-05-20T17:01:00Z",
        "Edit",
        join(tmpHome, "src", "code.ts"),
      ),
    ]);
    const result = await check(makeInput(transcriptPath));
    expect(result.exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("transcript with 2 Read calls on memory file updates sidecar with apply_count=2", async () => {
    const memPath = join(memDir, "feedback-test-pattern.md");
    writeFileSync(memPath, "# test memory\n");
    writeTranscriptLines([
      toolUseLine("2026-05-20T17:00:00Z", "Read", memPath),
      toolUseLine("2026-05-20T17:30:00Z", "Read", memPath),
    ]);

    const result = await check(makeInput(transcriptPath));
    expect(result.exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(true);

    const raw = readFileSync(statePath, "utf-8");
    const state = parseMemoryAttentionState(raw);
    expect(state).not.toBeNull();
    const entry = state?.memories["feedback-test-pattern"];
    expect(entry?.apply_count_recent).toBe(2);
    expect(entry?.last_apply).toBe("2026-05-20T17:30:00Z");
    expect(entry?.apply_history.length).toBe(2);
  });

  it("MEMORY.md TOC reads are excluded (not tracked as memory apply)", async () => {
    const tocPath = join(memDir, "MEMORY.md");
    writeFileSync(tocPath, "# index\n");
    writeTranscriptLines([
      toolUseLine("2026-05-20T17:00:00Z", "Read", tocPath),
    ]);
    const result = await check(makeInput(transcriptPath));
    expect(result.exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  });

  // tiered-memory-index PR-0 site 9 (HIGHEST impact): MEMORY-FULL.md is
  // regenerated constantly; if it were tracked as an applied memory it would
  // inflate its attention score and corrupt the AW1 archival apply-data. The
  // exclusion routes through isIndexFile on the un-stripped basename — this
  // pins it so the extension-stripped-stem check can't regress.
  it("MEMORY-FULL.md edits are excluded (not tracked — apply-data integrity)", async () => {
    const fullPath = join(memDir, "MEMORY-FULL.md");
    writeFileSync(fullPath, "# complete index\n");
    writeTranscriptLines([
      toolUseLine("2026-05-20T17:00:00Z", "Write", fullPath),
      toolUseLine("2026-05-20T17:01:00Z", "Edit", fullPath),
    ]);
    const result = await check(makeInput(transcriptPath));
    expect(result.exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("apply_history is bounded at 50 entries (oldest dropped on push)", async () => {
    const memPath = join(memDir, "feedback-bounded.md");
    writeFileSync(memPath, "# bounded memory\n");
    const firstBatch: Record<string, unknown>[] = [];
    for (let i = 0; i < 50; i += 1) {
      const minutes = String(i).padStart(2, "0");
      firstBatch.push(
        toolUseLine(`2026-05-20T17:${minutes}:00Z`, "Read", memPath),
      );
    }
    writeTranscriptLines(firstBatch);
    let result = await check(makeInput(transcriptPath));
    expect(result.exitCode).toBe(0);

    let state = parseMemoryAttentionState(readFileSync(statePath, "utf-8"));
    expect(state?.memories["feedback-bounded"]?.apply_history.length).toBe(50);
    expect(state?.memories["feedback-bounded"]?.apply_history[0]?.ts).toBe(
      "2026-05-20T17:00:00Z",
    );

    const secondBatch: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      secondBatch.push(toolUseLine(`2026-05-20T18:0${i}:00Z`, "Read", memPath));
    }
    writeTranscriptLines(secondBatch);
    result = await check(makeInput(transcriptPath));
    expect(result.exitCode).toBe(0);

    state = parseMemoryAttentionState(readFileSync(statePath, "utf-8"));
    expect(state?.memories["feedback-bounded"]?.apply_history.length).toBe(50);
    expect(state?.memories["feedback-bounded"]?.apply_history[0]?.ts).toBe(
      "2026-05-20T17:05:00Z",
    );
    expect(state?.memories["feedback-bounded"]?.apply_history[49]?.ts).toBe(
      "2026-05-20T18:04:00Z",
    );
    expect(state?.memories["feedback-bounded"]?.apply_count_recent).toBe(55);
  });
});
