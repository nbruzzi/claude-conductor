// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Integration tests for the lexicon CLI (Tier 3-C).
 *
 * Pattern: spawnSync against the real CLI file with synthetic memory +
 * handoff fixtures via HOME override for the substrate dirs.
 *
 * Coverage per plan §9:
 *   - --help exits 0 with usage text
 *   - --source memory against synthetic tempdir → expected terms JSON
 *   - --top N limits output
 *   - invalid --source value exits 2
 *   - unknown flag exits 2
 *
 * Plan: slice-T3C-lexicon-2026-05-20.md v0.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const LEXICON_CLI = resolvePath(import.meta.dir, "../../src/lexicon/cli.ts");

let tmpHome: string;

function runLexicon(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", LEXICON_CLI, ...args], {
    env: {
      ...process.env,
      HOME: tmpHome,
      CLAUDE_CONDUCTOR_MEMORIES_DIR: join(tmpHome, "memories"),
      CLAUDE_CONDUCTOR_HANDOFFS_DIR: join(tmpHome, "handoffs"),
      CLAUDE_CONDUCTOR_CHANNELS_DIR: join(tmpHome, "channels"),
    },
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "lexicon-cli-test-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("lexicon CLI", () => {
  it("--help exits 0 with usage text", () => {
    const result = runLexicon(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lexicon CLI");
    expect(result.stdout).toContain("--source");
  });

  it("--source memory against tempdir → JSON with expected terms", () => {
    const memDir = join(tmpHome, "memories");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "feedback-foo-bar-baz.md"),
      "Content includes feedback-foo-bar-baz and CycleCharacter.\nAlso SHIP-CLEAN.\n",
    );
    const result = runLexicon(["--source", "memory", "--format", "json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      total_terms: number;
      terms: ReadonlyArray<{ term: string }>;
    };
    const termNames = parsed.terms.map((t) => t.term);
    expect(termNames).toContain("feedback-foo-bar-baz");
    expect(termNames).toContain("CycleCharacter");
    expect(termNames).toContain("SHIP-CLEAN");
  });

  it("--top N limits output", () => {
    const memDir = join(tmpHome, "memories");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "alpha.md"),
      "feedback-a-b-c feedback-d-e-f feedback-g-h-i feedback-j-k-l feedback-m-n-o",
    );
    const result = runLexicon([
      "--source",
      "memory",
      "--top",
      "2",
      "--format",
      "json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      terms: ReadonlyArray<{ term: string }>;
    };
    expect(parsed.terms.length).toBe(2);
  });

  it("invalid --source exits 2", () => {
    const result = runLexicon(["--source", "bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid --source");
  });

  it("unknown flag exits 2", () => {
    const result = runLexicon(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown flag");
  });
});
