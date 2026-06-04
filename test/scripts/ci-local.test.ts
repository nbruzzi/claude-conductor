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
