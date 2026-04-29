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
