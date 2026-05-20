// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Integration tests for memory-attention CLI E1 (Tier 3-E).
 *
 * Pattern: spawnSync against the real CLI with synthetic memory dir +
 * sidecar state via env-var overrides.
 *
 * Coverage per plan §9 E1 cli test plan:
 *   - --help exits 0 with usage text
 *   - empty memory dir → empty output, exit 0
 *   - synthetic memory dir + sidecar state → expected scored entries
 *   - --top 3 caps output to 3 entries
 *   - --format human emits text-table
 *   - unknown flag exits 2
 *   - invalid --since shape exits 2
 *
 * Plan: slice-T3E-memory-attention-2026-05-20.md v0.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const CLI = resolvePath(import.meta.dir, "../../src/memory-attention/cli.ts");

let tmpRoot: string;
let memoryDir: string;
let sidecarPath: string;

function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", CLI, ...args], {
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_MEMORIES_DIR: memoryDir,
      CLAUDE_CONDUCTOR_MEMORY_ATTENTION_STATE: sidecarPath,
    },
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "memory-attention-cli-test-"));
  memoryDir = join(tmpRoot, "memories");
  mkdirSync(memoryDir, { recursive: true });
  sidecarPath = join(tmpRoot, "memory-attention.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memory-attention CLI", () => {
  it("--help exits 0 with usage text", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("memory-attention CLI");
    expect(result.stdout).toContain("--since");
    expect(result.stdout).toContain("--top");
  });

  it("empty memory dir → empty entries, exit 0", () => {
    const result = runCli(["--format", "json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      total_memories: number;
      entries: readonly unknown[];
    };
    expect(parsed.total_memories).toBe(0);
    expect(parsed.entries).toEqual([]);
  });

  it("synthetic memory dir + sidecar state → expected scored entries", () => {
    writeFileSync(join(memoryDir, "feedback-foo.md"), "# foo\n");
    writeFileSync(join(memoryDir, "feedback-bar.md"), "# bar\n");
    const now = new Date().toISOString();
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 1,
        last_updated: now,
        memories: {
          "feedback-foo": {
            last_apply: now,
            apply_count_recent: 5,
            violation_count_recent: 0,
            apply_history: [{ ts: now }],
          },
          "feedback-bar": {
            last_apply: now,
            apply_count_recent: 1,
            violation_count_recent: 0,
            apply_history: [{ ts: now }],
          },
        },
      }),
    );
    const result = runCli(["--format", "json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      total_memories: number;
      scored_memories: number;
      entries: ReadonlyArray<{ memory: string; score: number }>;
    };
    expect(parsed.total_memories).toBe(2);
    expect(parsed.scored_memories).toBe(2);
    expect(parsed.entries[0]?.memory).toBe("feedback-foo");
    expect(parsed.entries[1]?.memory).toBe("feedback-bar");
  });

  it("--top N caps output", () => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      writeFileSync(join(memoryDir, `feedback-${name}.md`), `# ${name}\n`);
    }
    const result = runCli(["--top", "2", "--format", "json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      entries: readonly unknown[];
    };
    expect(parsed.entries).toHaveLength(2);
  });

  it("--format human emits text-table", () => {
    writeFileSync(join(memoryDir, "feedback-foo.md"), "# foo\n");
    const result = runCli(["--format", "human"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Memory-attention scores");
    expect(result.stdout).toContain("feedback-foo");
  });

  it("unknown flag exits 2", () => {
    const result = runCli(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown flag");
  });

  it("invalid --since shape exits 2", () => {
    const result = runCli(["--since", "7days"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--since");
  });
});
