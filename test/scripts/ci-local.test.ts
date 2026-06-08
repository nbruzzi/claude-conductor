// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi
//
// Drift-guard for scripts/ci-local.sh.
//
// ci-local.sh mirrors the CI gate set so that local-green == CI-green. The
// failure mode this test prevents: CI gains a gate (a new `bun run <x>` step in
// test.yml) but ci-local.sh is not updated to match. ci-local would then give
// false "local-green" confidence and the fix-amend-repush tax it was built to
// kill would silently return. This asserts parity statically (fast, no suite
// nesting): every `bun run <gate>` step CI runs MUST be invoked by ci-local.sh.
//
// The --fast block additionally guards the pre-push subset BEHAVIORALLY (via the
// `--list` plan seam, no gates run): --fast must equal the full plan MINUS
// exactly the slow trio {test, check-coverage-floor, actionlint}. A second
// gate-list drifting from test.yml is the exact staleness this enforces against
// (it is what made the CLAUDE.md #202 rationale stale).

import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CI_LOCAL = join(REPO_ROOT, "scripts", "ci-local.sh");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "test.yml");

const ciLocalSrc = readFileSync(CI_LOCAL, "utf8");
const workflowSrc = readFileSync(WORKFLOW, "utf8");

// Every `bun run <gate>` invocation in the CI workflow.
// SCOPE (Charlie #199 N1): this pins only `bun run <gate>` steps. A future CI
// step that is neither a `bun run <gate>` nor the bun-test + coverage-floor pair
// (covered by the second test below) — e.g. a direct binary/script call — would
// slip this parity assertion and must be added to the test consciously. Today
// every CI gate is a `bun run <gate>`.
function ciWorkflowGates(): string[] {
  const gates = new Set<string>();
  const re = /bun run ([A-Za-z0-9:_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(workflowSrc)) !== null) {
    const gate = match[1];
    if (gate !== undefined) {
      gates.add(gate);
    }
  }
  return [...gates].sort();
}

// Run ci-local.sh in `--list` mode (plan-only, no gates run) and return the
// planned gate names in run order. Throws on a non-zero exit so a broken plan
// surfaces loudly rather than as an empty list. The array-form spawn passes no
// shell — args are literal, not interpolated into a command line.
function ciLocalPlan(modeArgs: readonly string[]): string[] {
  const proc = Bun.spawnSync(["bash", CI_LOCAL, ...modeArgs, "--list"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString();
    throw new Error(
      `ci-local.sh --list (${modeArgs.join(" ")}) exit ${proc.exitCode}: ${stderr}`,
    );
  }
  return proc.stdout
    .toString()
    .split("\n")
    .filter((line) => line.length > 0);
}

// The slow trio --fast subtracts (deferred to full ci-local + CI). Plan names
// match the run_gate display names in ci-local.sh.
const SLOW_TRIO = [
  "test",
  "check-coverage-floor",
  "lint:workflows (actionlint)",
];

describe("scripts/ci-local.sh — CI gate parity (drift-guard)", () => {
  it("invokes every `bun run <gate>` step that CI runs", () => {
    const gates = ciWorkflowGates();
    // Sanity: the workflow parsed and actually has gate steps.
    expect(gates.length).toBeGreaterThan(0);
    const missing = gates.filter((g) => !ciLocalSrc.includes(`bun run ${g}`));
    expect(missing).toEqual([]);
  });

  it("covers the CI test + coverage steps (bun test --coverage + the floor gate)", () => {
    // The Test step is `bun test --coverage` (not a `bun run` gate); the floor
    // gate reads its output via --from-file. ci-local must do both.
    expect(ciLocalSrc).toContain("bun test --coverage");
    expect(ciLocalSrc).toContain("check-coverage-floor");
  });

  it("is executable and leads with shebang-before-SPDX", () => {
    const mode = statSync(CI_LOCAL).mode;
    expect(mode & 0o111).not.toBe(0);
    const [first, second] = ciLocalSrc.split("\n", 2);
    expect(first).toBe("#!/usr/bin/env bash");
    expect(second).toBe("# SPDX-License-Identifier: Apache-2.0");
  });
});

describe("scripts/ci-local.sh --fast — pre-push subset (subtraction-guarded)", () => {
  it("--fast plan is the full plan MINUS exactly the slow trio", () => {
    const full = ciLocalPlan([]);
    const fast = ciLocalPlan(["--fast"]);
    // Strict subset: no fast-only gate (--fast can only ever subtract).
    for (const g of fast) {
      expect(full).toContain(g);
    }
    const excluded = full.filter((g) => !fast.includes(g));
    expect([...excluded].sort()).toEqual([...SLOW_TRIO].sort());
  });

  it("--fast runs every CI `bun run <gate>` EXCEPT the slow coverage-floor gate (anti-drift)", () => {
    // Cross-check vs test.yml: a NEW CI `bun run` gate auto-flows into --fast
    // (subtraction), so this stays green only while the fast set tracks CI. The
    // sole `bun run` gate --fast omits is check-coverage-floor (it needs the
    // suite); test + actionlint are not `bun run` steps.
    const fast = ciLocalPlan(["--fast"]);
    const expectedInFast = ciWorkflowGates().filter(
      (g) => g !== "check-coverage-floor",
    );
    const missing = expectedInFast.filter((g) => !fast.includes(g));
    expect(missing).toEqual([]);
  });

  it("--fast defers the slow trio (none of {test, check-coverage-floor, actionlint} in the fast plan)", () => {
    const fast = ciLocalPlan(["--fast"]);
    for (const slow of SLOW_TRIO) {
      expect(fast).not.toContain(slow);
    }
  });

  it("--list is side-effect-free: exit 0, plan only, no run-phase markers", () => {
    const proc = Bun.spawnSync(["bash", CI_LOCAL, "--fast", "--list"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    // `=== <gate> ===` headers are printed only when a gate actually runs.
    expect(proc.stdout.toString()).not.toContain("===");
  });

  it("rejects an unknown flag with exit 2 (fails loud, never silently runs full)", () => {
    const proc = Bun.spawnSync(["bash", CI_LOCAL, "--bogus"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("unknown flag");
  });
});
