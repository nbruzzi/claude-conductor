// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CG2 (Lane A) — cohort-sight is the THIRD liveness primitive (the harness
 * observe rung), and it is ADVISORY-OBSERVE-ONLY (CG6): a consumer may SUPPRESS
 * an advisory warn from it, but NO reaper / GC / `--apply` path may EVER import
 * it (the harness pidfile is an undocumented CC-version-coupled artifact — see
 * the cohort-sight module JSDoc + docs/conventions/liveness-gate-store-contract.md
 * "Gate class C").
 *
 * This contract test pins the AUGMENT-ONLY bound STRUCTURALLY: it scans every
 * src/ TypeScript file for an import of `cohort-sight` and asserts the external
 * importer set is EXACTLY the advisory allowlist. A NEW reaper/GC module that
 * imports cohort-sight fails HERE, forcing the CG6 review before it ships — the
 * cohort-sight analogue of the LGC-001 prefix-helper tripwire (which does NOT
 * scan cohort-sight, since `buildHarnessStatusIndex` is not a prefix-helper).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");

// The ONLY modules permitted to import cohort-sight (path relative to src/).
// teammate-idle-reminder is the advisory idle-suppress consumer (Lane A). NONE
// of these is a reaper / GC / mutating-gate path. Adding a reaper here would be
// a CG6 violation — that is the whole point of the assertion.
const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set([
  "hooks/checks/teammate-idle-reminder.ts",
]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const IMPORTS_COHORT_SIGHT =
  /(?:from|import)\s*\(?\s*["'][^"']*cohort-sight[^"']*["']/;

describe("CG2 — cohort-sight is ADVISORY-OBSERVE-ONLY (no reaper imports it)", () => {
  it("only the advisory allowlist imports cohort-sight outside cohort-sight/ itself", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel.startsWith("cohort-sight/")) continue; // the module + its CLI (self)
      if (!IMPORTS_COHORT_SIGHT.test(readFileSync(file, "utf-8"))) continue;
      if (!ALLOWED_IMPORTERS.has(rel)) offenders.push(rel);
    }
    // A non-empty list means a NEW (likely reaper/GC) module imported the
    // observe rung — classify it under CG6 (and extend this allowlist only if
    // it is a genuine advisory-suppress consumer, never a reaper).
    expect(offenders).toEqual([]);
  });

  it("the allowlist itself actually imports cohort-sight (no stale allowlist entry)", () => {
    for (const rel of ALLOWED_IMPORTERS) {
      const src = readFileSync(join(SRC, rel), "utf-8");
      expect(IMPORTS_COHORT_SIGHT.test(src)).toBe(true);
    }
  });
});
