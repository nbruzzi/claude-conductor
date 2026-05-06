// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Plugin-side paired test for the `./active-sessions` exports-map entry.
 *
 * Per `feedback-cross-edge-contract-via-paired-tests.md` — when two units
 * maintain a cross-edge contract (plugin exports + dotfiles consumes via
 * shim), enforce the contract via paired structural tests, one on each
 * side. Dotfiles' shim invariant test asserts the consumer half; this
 * file asserts the owner half.
 *
 * Without this test, drift on the plugin side (someone removes the
 * `./active-sessions` exports entry, or changes the path) only surfaces
 * when dotfiles' shim test runs — and dotfiles tests don't run on plugin
 * PRs. Asymmetric drift detection. This test catches at plugin-side
 * merge time.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ExportEntry = {
  readonly types: string;
  readonly import: string;
  readonly default: string;
};

const PKG = JSON.parse(
  readFileSync(join(import.meta.dir, "../../package.json"), "utf-8"),
) as { exports: Record<string, ExportEntry> };

describe("active-sessions exports-map entry", () => {
  test("./active-sessions entry exists with all three conditions", () => {
    expect(PKG.exports["./active-sessions"]).toBeDefined();
    const entry = PKG.exports["./active-sessions"];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.types).toBe("./src/active-sessions/index.ts");
    expect(entry.import).toBe("./src/active-sessions/index.ts");
    expect(entry.default).toBe("./src/active-sessions/index.ts");
  });
});
