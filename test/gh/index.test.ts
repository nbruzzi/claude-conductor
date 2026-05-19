// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, test } from "bun:test";

import { decodeStdio } from "../../src/git/index.ts";
import { runGh } from "../../src/gh/index.ts";

/**
 * Slice 0 §Test grid §10 (T10.3, T10.4) — runGh smoke coverage.
 *
 * These are environment-dependent smoke tests: assume `gh` is present on
 * PATH in dev + CI. T10.3 uses `gh --version` (no auth required, works
 * unconditionally if gh is installed). T10.4 uses `gh` with an unknown
 * subcommand to force a non-zero exit without needing a fixture-repo or
 * network reach (gh validates argv shape locally first).
 *
 * NOTE: end-to-end cascade-rebase integration tests against real PRs live
 * in test/pr/cascade-rebase.test.ts and inject a mocked runGh adapter
 * rather than calling real gh.
 */

describe("runGh", () => {
  test("T10.3: happy path — `gh --version` exits 0 with non-empty stdout", () => {
    const result = runGh(["--version"]);
    expect(result.status).toBe(0);
    const stdout = decodeStdio(result.stdout);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).toMatch(/^gh version /);
  });

  test("T10.4: error path — gh with unknown subcommand exits non-zero with stderr captured", () => {
    // `gh __no_such_subcommand__` is rejected by gh's local subcommand
    // resolver before any network call; reliably non-zero on any auth
    // state.
    const result = runGh(["__no_such_subcommand__"]);
    expect(result.status).not.toBe(0);
    // gh writes error info to stderr; verify SOMETHING was captured.
    const stderr = decodeStdio(result.stderr);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
