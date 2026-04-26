// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  recordCheckTiming,
  type TimingRecord,
} from "../../src/hooks/timing.ts";

const DIR = "/tmp/test-hook-timing";
const LOG = join(DIR, "hook-timing.jsonl");

function setup(): void {
  cleanup();
  mkdirSync(DIR, { recursive: true });
  process.env["HOOK_TIMING_LOG_PATH"] = LOG;
}

function cleanup(): void {
  delete process.env["HOOK_TIMING_LOG_PATH"];
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
}

function readRows(): TimingRecord[] {
  if (!existsSync(LOG)) return [];
  const content = readFileSync(LOG, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TimingRecord);
}

describe("recordCheckTiming", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("writes a row with the full schema when all fields present", () => {
    recordCheckTiming(
      { session_id: "abc-123" },
      "pre-tool-use",
      "destructive-cmd",
      "Bash",
      12.345,
      0,
    );

    const rows = readRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(row?.session_id).toBe("abc-123");
    expect(row?.event).toBe("pre-tool-use");
    expect(row?.check_name).toBe("destructive-cmd");
    expect(row?.tool_name).toBe("Bash");
    expect(row?.ms).toBe(12.35);
    expect(row?.exit_code).toBe(0);
  });

  it("omits session_id when not present in raw input", () => {
    recordCheckTiming({}, "stop", "my-check", "Bash", 5, 0);

    const rows = readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("session_id");
  });

  it("omits session_id when it is an empty string", () => {
    recordCheckTiming({ session_id: "" }, "stop", "my-check", "Bash", 5, 0);

    const rows = readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("session_id");
  });

  it("omits tool_name when undefined", () => {
    recordCheckTiming(
      { session_id: "s1" },
      "session-start",
      "briefing",
      undefined,
      3,
      0,
    );

    const rows = readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("tool_name");
  });

  it("omits exit_code when undefined (crash case)", () => {
    recordCheckTiming(
      { session_id: "s1" },
      "post-tool-use",
      "crasher",
      "Edit",
      1.5,
      undefined,
    );

    const rows = readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("exit_code");
  });

  it("preserves non-zero exit codes", () => {
    recordCheckTiming(
      { session_id: "s1" },
      "pre-tool-use",
      "blocker",
      "Bash",
      0.5,
      2,
    );

    const rows = readRows();
    expect(rows[0]?.exit_code).toBe(2);
  });

  it("rounds ms to 2 decimal places", () => {
    recordCheckTiming({}, "stop", "c", "Bash", 1.23456789, 0);

    const rows = readRows();
    expect(rows[0]?.ms).toBe(1.23);
  });

  it("appends multiple rows as separate JSONL lines", () => {
    recordCheckTiming({ session_id: "s1" }, "pre-tool-use", "a", "Bash", 1, 0);
    recordCheckTiming({ session_id: "s1" }, "pre-tool-use", "b", "Bash", 2, 0);
    recordCheckTiming({ session_id: "s1" }, "pre-tool-use", "c", "Bash", 3, 2);

    const rows = readRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.check_name)).toEqual(["a", "b", "c"]);
  });

  it("fails silently when log path is unwritable", () => {
    process.env["HOOK_TIMING_LOG_PATH"] =
      "/nonexistent-dir-xyz/hook-timing.jsonl";
    expect(() => {
      recordCheckTiming({ session_id: "s1" }, "stop", "c", "Bash", 1, 0);
    }).not.toThrow();
  });

  it("ignores non-string session_id values", () => {
    recordCheckTiming({ session_id: 42 }, "stop", "c", "Bash", 1, 0);

    const rows = readRows();
    expect(rows[0]).not.toHaveProperty("session_id");
  });
});
