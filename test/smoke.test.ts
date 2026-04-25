// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Smoke test — establishes the test directory convention and unblocks the
 * pre-commit `bun test` gate (which exits non-zero when zero tests are
 * found). Real test scaffolding lands in Phase 0 sub-step 0.7 (test
 * scaffolding pull from `nbruzzi/claude-dotfiles/src/__tests__/` patterns).
 *
 * @see ../decisions/phase-0.md for active sequencing decisions
 */

import { expect, test } from "bun:test";

test("smoke — test runner is wired and bun:test imports resolve", () => {
  expect(true).toBe(true);
});
