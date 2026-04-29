// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 3a atomic-wiring sentinels for runChannelsCli + import.meta.main.
 *
 * Plan: ~/.claude/plans/vivid-seeking-crayon.md §8 (ARCH-2 + RE-3 + TA-3 fix).
 *
 * Three tests cover the full half-wired matrix:
 *
 *   Test 1 (import safety, RE inline-fix for runner-hang):
 *     Spawn `bun -e <import>` in a subprocess and assert exit 0.
 *     If `import.meta.main` guard is missing, the imported module would
 *     auto-execute `await runChannelsCli()` with the bun-eval'd argv,
 *     hit the unknown-subcommand path, and `process.exit(1)`. Subprocess
 *     captures the failure cleanly; in-process Promise.race would race
 *     a process.exit() that kills the test runner. Subprocess isolation
 *     is the safe pattern.
 *
 *   Test 2 (programmatic invocation):
 *     Import the module in-process (the guard already passed Test 1's
 *     subprocess assertion, so import is safe here) and call
 *     `runChannelsCli(["help"])`. Assert it returns without throwing
 *     and writes help text to stdout via a captured stream. Catches:
 *     `runChannelsCli` not exported but `import.meta.main` guard wraps
 *     everything (false-positive guard).
 *
 *   Test 3 (subprocess entry path):
 *     Spawn `bun run src/channels/cli.ts help` directly. Assert exit 0
 *     + stdout contains help text. Catches: `import.meta.main` guard
 *     too aggressive (e.g., always false), preventing direct execution.
 */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../../src/channels/cli.ts");

describe("cli-import-safety (atomic-wiring sentinel)", () => {
  it("Test 1: importing the module does NOT auto-execute (import.meta.main guard works)", () => {
    // Run a subprocess that imports the module via `bun -e`. If the guard
    // is missing, the import side-effects `await runChannelsCli()` with
    // bun -e's argv ["bun", "-e", "<code>"], hits the default
    // unknown-subcommand path, and dies with exit 1. With the guard,
    // import.meta.main is false (this is a `-e` eval, not the entry
    // point), runChannelsCli is NOT called, the .then() exits 0.
    const result = spawnSync(
      "bun",
      [
        "-e",
        `import("${CLI_PATH}").then(() => process.exit(0)).catch((e) => { process.stderr.write(String(e)); process.exit(2); })`,
      ],
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result.status).toBe(0);
    // Stderr should be empty — module import emits nothing.
    expect(result.stderr).toBe("");
  });

  it("Test 2: runChannelsCli is exported and callable programmatically", async () => {
    const cli = await import("../../src/channels/cli.ts");
    expect(typeof cli.runChannelsCli).toBe("function");
    // Capture stdout via override; runChannelsCli(["help"]) writes help to it.
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await cli.runChannelsCli(["help"]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured).toContain("channels CLI");
    expect(captured).toContain("Subcommands:");
  });

  it("Test 3: subprocess entry path executes (guard's true branch fires under direct invocation)", () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "help"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("channels CLI");
    expect(result.stdout).toContain("Subcommands:");
  });
});

/**
 * Phase 2 Slice 0 RE-W2-3 closure — DieContext per-invocation output mode.
 *
 * The bug being prevented: prior to Slice 0, `outputJson` was a module-
 * level toggle set at the top of `runChannelsCli`. In-process callers
 * (Phase 2 hooks) calling `runChannelsCli(['--json', ...])` then
 * `runChannelsCli([...])` would silently inherit the `--json` mode on
 * the second call because the module-level toggle was never reset.
 *
 * Subprocess tests (the existing CLI-A / CLI-B tests in cli.test.ts +
 * dispatcher.test.ts) couldn't catch this — each spawn is a fresh
 * process with fresh module state. The leak only manifests in-process,
 * which is exactly the surface Phase 2 hooks are about to consume.
 *
 * The matrix below mocks `process.exit` + `process.stderr.write` and
 * calls `runChannelsCli` twice — once with `--json`, once without —
 * asserting that the SECOND call's stderr is plain text, NOT structured
 * JSON inherited from the first call. The DieContext refactor (REQUIRED
 * ctx parameter on `die()`) is what makes this leak impossible.
 */
describe("cli DieContext per-invocation isolation (RE-W2-3)", () => {
  it("Matrix: --json then plain — second call emits plain stderr (no leak)", async () => {
    const cli = await import("../../src/channels/cli.ts");

    const originalExit = process.exit;
    const originalStderr = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    // Mock process.exit so die() returns instead of terminating the
    // test runner. die()'s body ends with process.exit; after the mock
    // returns, the function returns undefined (TypeScript permits via
    // the `as never` cast in production code).
    process.exit = (() => undefined) as typeof process.exit;

    try {
      // First call: --json mode → stderr should be a structured JSON line.
      // Note: --json is post-verb. runChannelsCli's parseFlags only sees
      // flags AFTER the cmd; pre-verb position-insensitivity is handled by
      // the bash dispatcher (bin/claude-conductor) when invoked end-to-end.
      stderr = "";
      await cli.runChannelsCli([
        "meta",
        "definitely-no-such-channel-1",
        "--json",
      ]);
      const firstStderr = stderr;
      const firstFirstLine = firstStderr.trim().split("\n")[0] ?? "";
      let firstParsed: Record<string, unknown> | null = null;
      try {
        firstParsed = JSON.parse(firstFirstLine) as Record<string, unknown>;
      } catch {
        firstParsed = null;
      }
      expect(firstParsed).not.toBeNull();
      expect(firstParsed?.["category"]).toBe("UNCAUGHT");

      // Second call: plain mode → stderr should be a bare error string,
      // NOT structured JSON. Pre-Slice-0 this would still be JSON because
      // `outputJson = true` from the first call leaked through the
      // module-level toggle. Post-Slice-0 the per-call DieContext makes
      // this impossible.
      stderr = "";
      await cli.runChannelsCli(["meta", "definitely-no-such-channel-2"]);
      const secondStderr = stderr;
      const secondFirstLine = secondStderr.trim().split("\n")[0] ?? "";
      let secondParsed: Record<string, unknown> | null = null;
      try {
        secondParsed = JSON.parse(secondFirstLine) as Record<string, unknown>;
      } catch {
        secondParsed = null;
      }
      // The load-bearing assertion: second call's stderr is plain text
      // (JSON.parse fails OR the parsed object lacks the structured
      // category/message fields the first call had). With the leak,
      // secondParsed would have been a valid JSON object with
      // category=UNCAUGHT — same as firstParsed.
      const looksStructured =
        secondParsed !== null &&
        typeof secondParsed["category"] === "string" &&
        typeof secondParsed["message"] === "string";
      expect(looksStructured).toBe(false);
      // Sanity: the second call DID produce stderr (we hit die path).
      expect(secondStderr.length).toBeGreaterThan(0);
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalStderr;
    }
  });
});
