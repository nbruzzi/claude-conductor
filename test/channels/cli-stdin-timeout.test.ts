// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Stdin TTFB-timeout regression slice (L:145 / TA-2 closure).
 *
 * Plan: ~/.claude/plans/crisp-watching-beacon.md Item 4 (slice 4 Bravo lane).
 *
 * Backlog L:145 documents that `bun run src/channels/cli.ts send <id> <kind>
 * <<EOF ... EOF` hangs indefinitely on Bun — `for await (... of process.stdin)`
 * never observes EOF until shell tear-down. This test suite asserts the new
 * `readStdin` time-to-first-byte deadline (`STDIN_TTFB_TIMEOUT_MS`, default
 * 3000ms; tests override to 500ms via `CLAUDE_CONDUCTOR_STDIN_TTFB_TIMEOUT_MS`):
 *
 *   1. Heredoc-hang — stdin pipe held open with no bytes written → fail
 *      loud after TTFB deadline with `--body-file` remediation in the error
 *      message (exit code 2, category `VALIDATION`).
 *   2. Normal stdin — body piped before TTFB → succeeds; timer does NOT
 *      fire on the happy path.
 *   3. --body-file set — readStdin is never called; TTFB timer never
 *      engaged; send completes regardless of stdin state.
 *   4. Slow first byte — stdin opens silent, first byte arrives after a
 *      sub-deadline delay → timer is cleared on first chunk; drain
 *      completes naturally; send succeeds.
 *
 * Tests are process-boundary via `child_process.spawn` because the hang
 * surface is only observable across a real process boundary (parent owns
 * stdin pipe; child blocks in for-await). In-process spying on `process.stdin`
 * would miss the actual semantic this fix targets.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const CLI_PATH = resolvePath(import.meta.dir, "../../src/channels/cli.ts");
const TEST_SESSION_ID = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";
const TEST_TTFB_MS = 500;

let tmpRoot: string;
let channelsDir: string;
let channelId: string;
let env: Record<string, string>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cli-stdin-timeout-test-"));
  channelsDir = join(tmpRoot, "channels");
  mkdirSync(channelsDir, { recursive: true });
  channelId = "stdin-timeout-test";

  env = {
    ...(process.env as Record<string, string>),
    CLAUDE_SESSION_ID: TEST_SESSION_ID,
    CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
    CLAUDE_CONDUCTOR_STDIN_TTFB_TIMEOUT_MS: String(TEST_TTFB_MS),
  };

  const create = spawnSync(
    "bun",
    ["run", CLI_PATH, "create", channelId, "test-handoff"],
    {
      env,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (create.status !== 0) {
    throw new Error(
      `channel create failed (status=${create.status}): ${create.stderr}`,
    );
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("readStdin TTFB timeout (L:145)", () => {
  test("heredoc-hang case — stdin pipe held open with no bytes fails loud after TTFB", async () => {
    const start = Date.now();
    const child = spawn("bun", ["run", CLI_PATH, "send", channelId, "status"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const elapsed = Date.now() - start;

    // Intentionally never write to or end child.stdin — the hang surface this
    // test asserts requires the parent's stdin pipe to stay open with no bytes.
    expect(result.code).toBe(2);
    expect(stderr).toContain("empty stdin");
    expect(stderr).toContain("TTFB");
    expect(stderr).toContain("--body-file");
    expect(elapsed).toBeGreaterThanOrEqual(TEST_TTFB_MS - 50);
    expect(elapsed).toBeLessThan(TEST_TTFB_MS + 4000);
  });

  test("normal stdin — body piped before TTFB succeeds; timer doesn't fire", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "send", channelId, "status"],
      {
        env,
        input: "happy-path body",
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("TTFB");
    expect(result.stderr).not.toContain("empty stdin");
  });

  test("--body-file set bypasses readStdin entirely; TTFB timer never engaged", () => {
    const bodyPath = join(tmpRoot, "body.txt");
    writeFileSync(bodyPath, "body-file payload");
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "send", channelId, "status", "--body-file", bodyPath],
      {
        env,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("TTFB");
    expect(result.stderr).not.toContain("empty stdin");
  });

  test("slow first byte — write after sub-deadline delay succeeds; TTFB resets", async () => {
    const start = Date.now();
    const child = spawn("bun", ["run", CLI_PATH, "send", channelId, "status"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    // Wait 200ms (well under TEST_TTFB_MS=500), then send + close.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    child.stdin.write("slow-first-byte body");
    child.stdin.end();

    const result = await new Promise<{ code: number | null }>((resolve) => {
      child.on("exit", (code) => resolve({ code }));
    });
    const elapsed = Date.now() - start;

    expect(result.code).toBe(0);
    expect(stderr).not.toContain("TTFB");
    expect(stderr).not.toContain("empty stdin");
    expect(elapsed).toBeLessThan(TEST_TTFB_MS + 4000);
  });
});
