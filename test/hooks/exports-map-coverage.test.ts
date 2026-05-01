// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 4 replacement-invariant — exports-map coverage for bundled checks.
 *
 * After Phase 4 retires the `check-bundled-registrations-parity.sh` script
 * (which kept dotfiles' shim layer in lockstep with plugin's bundled-check
 * names), this test pins one of the four invariants the parity script
 * enforced: every name in `BUNDLED_CHECK_NAMES` must have a matching
 * `./hooks/checks/<name>` entry in `package.json#exports`. Without this,
 * a future PR could accidentally remove an exports-map entry and silently
 * break dotfiles' cross-edge
 * `import { check } from "claude-conductor/hooks/checks/<name>"`.
 *
 * Sibling tests added in dotfiles' Phase 4 atomic commit:
 * - `cross-edge-imports.test.ts` — every cross-edge import resolves.
 * - `check-names-superset.test.ts` — `ALL_CHECK_NAMES ⊇ BUNDLED_CHECK_NAMES`.
 *
 * See `~/.claude/plans/p4-shim-drop.md` §4.7 for the full invariant table.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_CHECK_NAMES } from "../../src/hooks/bundled-check-names.ts";

type ExportEntry = {
  types: string;
  import: string;
  default: string;
};

type PackageJsonExports = Record<string, ExportEntry>;

const packageJsonPath = join(import.meta.dir, "..", "..", "package.json");
const packageJsonRaw = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonRaw) as {
  exports: PackageJsonExports;
};
const exportsMap = packageJson.exports;

describe("exports-map coverage for bundled checks", () => {
  it("every BUNDLED_CHECK_NAMES entry has a matching ./hooks/checks/<name> exports-map entry", () => {
    const missing: string[] = [];
    for (const name of BUNDLED_CHECK_NAMES) {
      if (exportsMap[`./hooks/checks/${name}`] === undefined) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("each ./hooks/checks/<bundled-name> entry points at ./src/hooks/checks/<name>.ts in all three conditions (types/import/default)", () => {
    const wrong: Array<{
      name: string;
      field: keyof ExportEntry;
      got: string;
    }> = [];
    for (const name of BUNDLED_CHECK_NAMES) {
      const entry = exportsMap[`./hooks/checks/${name}`];
      if (entry === undefined) continue;
      const expected = `./src/hooks/checks/${name}.ts`;
      for (const field of ["types", "import", "default"] as const) {
        if (entry[field] !== expected) {
          wrong.push({ name, field, got: entry[field] });
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
