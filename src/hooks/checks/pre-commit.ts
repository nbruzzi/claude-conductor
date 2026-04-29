// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Hard-block git commit unless typecheck/format/lint/test pass.
 * Per CLAUDE.md: "Always run in this order before committing."
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookInput, HookResult } from "../types.ts";
import { block, pass, warn } from "../types.ts";

const SOURCE = "pre-commit";
// Per-script timeout. Bumped from 30_000 → 60_000 in 2026-04-28 (dotfiles
// test suite grew past 30s budget); bumped again 60_000 → 180_000 in
// 2026-04-29 (Phase 2 Slice 7 substrate-gap fix per
// `feedback-self-monitoring-failures-are-architectural`) after plugin's
// test suite grew to ~99s on dev hardware (35 files / 461 tests). Tests
// growing past the budget made the gate fire on time-out regardless of
// test correctness — broken self-monitoring. Aggregate cap bumped 120_000
// → 240_000 to keep the same 4× headroom-over-script ratio.
const SCRIPT_TIMEOUT_MS = 180_000;
const AGGREGATE_TIMEOUT_MS = 240_000;

/**
 * Match `git commit` with optional interposed global flags.
 * Handles: git commit, git -c key=val commit, git -C /path commit,
 * git --no-pager commit, git  commit (double space).
 * Does NOT match: git commit-tree, /usr/bin/git commit.
 */
export const COMMIT_PATTERN =
  /(^|\s|&&|\|\||;)git\s+(-[-\w]+(\s+\S+)?\s+)*commit(\s|$)/;

export async function check(input: HookInput): Promise<HookResult> {
  const cmd = input.command;
  if (!cmd) return pass();

  if (!COMMIT_PATTERN.test(cmd)) return pass();

  const cwd = input.cwd;
  if (!cwd) return pass();

  const pkg = join(cwd, "package.json");
  if (!existsSync(pkg)) return pass();

  let scripts: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkg, "utf-8"));
    scripts =
      typeof parsed === "object" &&
      parsed !== null &&
      "scripts" in parsed &&
      typeof (parsed as Record<string, unknown>)["scripts"] === "object"
        ? ((parsed as Record<string, Record<string, string>>)["scripts"] ?? {})
        : {};
  } catch {
    return pass(); // Malformed package.json — skip
  }

  const output: string[] = ["── Pre-Commit Checks (per CLAUDE.md) ──"];
  const aggregateStart = performance.now();

  function remainingMs(): number {
    return Math.max(
      0,
      AGGREGATE_TIMEOUT_MS - (performance.now() - aggregateStart),
    );
  }

  function aggregateExceeded(): boolean {
    return performance.now() - aggregateStart >= AGGREGATE_TIMEOUT_MS;
  }

  // 1. Typecheck
  const typecheckResult = await runScript(
    cwd,
    scripts,
    ["typecheck", "check"],
    "typecheck",
    remainingMs(),
  );
  if (typecheckResult) {
    output.push(typecheckResult.output);
    if (!typecheckResult.ok) {
      return block(
        SOURCE,
        [...output, "", "BLOCKED: typecheck failed."].join("\n"),
      );
    }
  }
  if (aggregateExceeded()) {
    return block(
      SOURCE,
      [...output, "", "BLOCKED: aggregate timeout exceeded (120s)."].join("\n"),
    );
  }

  // 2. Format
  const formatResult = await runScript(
    cwd,
    scripts,
    ["format:check", "format"],
    "format",
    remainingMs(),
  );
  if (formatResult) {
    output.push(formatResult.output);
    if (!formatResult.ok) {
      return block(
        SOURCE,
        [...output, "", "BLOCKED: formatting issues found."].join("\n"),
      );
    }
  }
  if (aggregateExceeded()) {
    return block(
      SOURCE,
      [...output, "", "BLOCKED: aggregate timeout exceeded (120s)."].join("\n"),
    );
  }

  // 3. Lint
  const lintResult = await runScript(
    cwd,
    scripts,
    ["lint"],
    "lint",
    remainingMs(),
  );
  if (lintResult) {
    output.push(lintResult.output);
    if (!lintResult.ok) {
      return block(
        SOURCE,
        [...output, "", "BLOCKED: lint errors found."].join("\n"),
      );
    }
  }
  if (aggregateExceeded()) {
    return block(
      SOURCE,
      [...output, "", "BLOCKED: aggregate timeout exceeded (120s)."].join("\n"),
    );
  }

  // 4. Tests — only if test files exist
  if (scripts["test"]) {
    const hasTestFiles = await findTestFiles(cwd);
    if (hasTestFiles) {
      const testResult = await runBunTest(cwd, remainingMs());
      output.push(testResult.output);
      if (!testResult.ok) {
        return block(
          SOURCE,
          [...output, "", "BLOCKED: tests failed."].join("\n"),
        );
      }
    }
  }

  output.push("All checks passed.");
  return warn(SOURCE, output.join("\n"));
}

type ScriptResult = { ok: boolean; output: string };

async function runScript(
  cwd: string,
  scripts: Record<string, string>,
  scriptNames: string[],
  label: string,
  timeoutMs: number,
): Promise<ScriptResult | null> {
  const script = scriptNames.find((s) => s in scripts);
  if (!script) return null;

  const timeout = Math.min(timeoutMs, SCRIPT_TIMEOUT_MS);
  const proc = Bun.spawn(["bun", "run", script], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (proc.signalCode === "SIGTERM") {
    return { ok: false, output: `→ ${label} TIMED OUT (${timeout / 1000}s)` };
  }

  const combined = [stdout, stderr].filter(Boolean).join("\n");

  return {
    ok: exitCode === 0,
    output: exitCode === 0 ? `→ ${label} ✓` : `→ ${label}\n${combined}`,
  };
}

async function runBunTest(
  cwd: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  const timeout = Math.min(timeoutMs, SCRIPT_TIMEOUT_MS);
  const proc = Bun.spawn(["bun", "test"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (proc.signalCode === "SIGTERM") {
    return { ok: false, output: `→ test TIMED OUT (${timeout / 1000}s)` };
  }

  const combined = [stdout, stderr].filter(Boolean).join("\n");

  return {
    ok: exitCode === 0,
    output: exitCode === 0 ? "→ test ✓" : `→ test\n${combined}`,
  };
}

async function findTestFiles(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "find",
      cwd,
      "-maxdepth",
      "4",
      "(",
      "-name",
      "*.test.*",
      "-o",
      "-name",
      "*.spec.*",
      ")",
      "-print",
      "-quit",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length > 0;
}
