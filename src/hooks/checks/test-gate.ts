// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Stop-time test gate for autonomous mode.
 * Only active when ~/.claude/test-gate-on exists.
 * Exit 2 = block (tests failed). Exit 0 = pass.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookInput, HookResult } from "../types.ts";
import { block, pass, warn } from "../types.ts";

const SOURCE = "test-gate";

const HOME = process.env["HOME"] ?? "";
const GATE_FILE = `${HOME}/.claude/test-gate-on`;

export async function check(input: HookInput): Promise<HookResult> {
  if (!existsSync(GATE_FILE)) return pass();

  const cwd = input.cwd ?? process.cwd();
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return pass();

  const pkgContent = readFileSync(pkgPath, "utf-8");

  // Skip if no test script defined
  if (!pkgContent.includes('"test"')) return pass();

  const output: string[] = ["── Test Gate ──"];

  // Typecheck if available
  if (pkgContent.includes('"typecheck"')) {
    output.push("Running typecheck...");
    const proc = Bun.spawn(["bun", "run", "typecheck"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      return block(
        SOURCE,
        [...output, stdout, stderr, "", "BLOCKED: typecheck failed."].join(
          "\n",
        ),
      );
    }
  }

  // Tests
  output.push("Running tests...");
  const proc = Bun.spawn(["bun", "test"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    return block(
      SOURCE,
      [...output, stdout, stderr, "", "BLOCKED: tests failed."].join("\n"),
    );
  }

  output.push("All checks passed.");
  return warn(SOURCE, output.join("\n"));
}
