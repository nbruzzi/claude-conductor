// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * channels CLI tests — uncaught-throw funneling (CLI-A).
 *
 * Per Phase 1 plan v2 §Slice 4.5 (Wave 1 CLI-DX finding CLI-A — main()
 * lacks try/catch; sid()/readMetadata throws bypass die() structured
 * output). The fix wraps the verb dispatch in try/catch; the catch funnels
 * the error message through die() with category="UNCAUGHT" so operators
 * see structured stderr under --json instead of an unhandled rejection.
 *
 * Strategy: invoke channels/cli.ts directly (NOT through the bin
 * dispatcher) on a verb that internally throws (readMetadata on a
 * non-existent channel). With --json, stderr should be structured
 * {code, category: "UNCAUGHT", message}; without, plain stderr.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const CLI_PATH = join(PACKAGE_ROOT, "src", "channels", "cli.ts");

// A valid UUID-shaped session id so the strict UUID gate inside
// resolveSessionId accepts the env. The throw we want to exercise comes
// from readMetadata on a missing channel, NOT from session-id discovery.
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000001";

let tempChannelsDir: string;

beforeAll(() => {
  tempChannelsDir = mkdtempSync(join(tmpdir(), "channels-cli-test-"));
});

afterAll(() => {
  rmSync(tempChannelsDir, { recursive: true, force: true });
});

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function run(args: readonly string[]): RunResult {
  const result = Bun.spawnSync({
    cmd: ["bun", CLI_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: tempChannelsDir,
      CLAUDE_SESSION_ID: TEST_SESSION_ID,
    },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("channels CLI — uncaught-throw funneling (CLI-A)", () => {
  it("non-existent channel meta exits non-zero with stderr (plain mode)", () => {
    const result = run(["meta", "definitely-does-not-exist-channel"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
  });

  it("non-existent channel meta with --json emits JSON stderr with UNCAUGHT category", () => {
    const result = run(["meta", "definitely-does-not-exist-channel", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(firstLine);
    }).not.toThrow();
    expect(typeof parsed).toBe("object");
    const obj = parsed as Record<string, unknown>;
    expect(obj["category"]).toBe("UNCAUGHT");
    expect(typeof obj["message"]).toBe("string");
    expect((obj["message"] as string).length).toBeGreaterThan(0);
    expect(obj["code"]).toBe(1);
  });

  it("plain-mode stderr on uncaught throw is not JSON-formatted", () => {
    const result = run(["meta", "definitely-does-not-exist-channel"]);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    let isStructuredJson = false;
    try {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      isStructuredJson =
        typeof parsed["category"] === "string" &&
        typeof parsed["message"] === "string";
    } catch {
      isStructuredJson = false;
    }
    expect(isStructuredJson).toBe(false);
  });

  it("known-shape errors (validation) still emit their explicit category, not UNCAUGHT", () => {
    // Trigger an explicit die() with category VALIDATION, not the catch.
    // Bogus channel-id (path-traversal shape) hits requireChannelId's die().
    const result = run(["meta", "../escape", "--json"]);
    expect(result.exitCode).not.toBe(0);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    // The explicit die() inside requireChannelId fires BEFORE readMetadata
    // throws — proving process.exit() short-circuits before the catch, so
    // categories from explicit die() callers are preserved.
    expect(parsed["category"]).toBe("VALIDATION");
  });
});
