// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Plugin skill-content structural test slice (L:503).
 *
 * Asserts the load-bearing landmark sections of each plugin skill-class
 * artifact in strict order.
 *
 * Substrate-refactor 2026-05-27: `commands/session/{handoff,handoff-resume,
 * channel,presence}.md` moved from plugin-canonical to dotfiles-canonical
 * (user-workflow skills belong to user identity, not the plugin). Their
 * structure assertions now live in the dotfiles repo's parallel test (or
 * are dropped if not maintained there); this file retains only the
 * library-class skills (`skills/<name>/SKILL.md`) that stay plugin-canonical.
 *
 * Frontmatter class:
 *   - library-skills (`skills/<name>/SKILL.md`) — `name:` + `description:`
 *
 * Section ordering = strict-sequential: each landmark must appear in
 * source in declared order. New sections inserted between landmarks are
 * permitted; reorder or removal of a landmark fails.
 *
 * Landmark match = prefix-with-word-boundary: landmark "Step 4" matches
 * "## Step 4: Write the handoff document" but not "## Step 40".
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "../..");

type FrontmatterClass = "library";

type SkillSpec = {
  readonly path: string;
  readonly class: FrontmatterClass;
  readonly expectedSections: readonly string[];
};

const SKILLS: readonly SkillSpec[] = [
  {
    path: "skills/audit/SKILL.md",
    class: "library",
    expectedSections: [
      "Step 0",
      "Step 1",
      "Step 2",
      "Step 3",
      "Step 4",
      "Step 5",
      "Step 6",
    ],
  },
  {
    path: "skills/commit-push-pr/SKILL.md",
    class: "library",
    expectedSections: [],
  },
];

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const FRONTMATTER_LINE_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

function parseFrontmatter(source: string): Record<string, string> | null {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return null;
  const body = match[1] ?? "";
  const result: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const km = FRONTMATTER_LINE_RE.exec(line);
    if (!km) continue;
    const key = km[1];
    const value = km[2] ?? "";
    if (key) result[key] = value;
  }
  return result;
}

function extractH2Headings(source: string): string[] {
  const body = source.replace(FRONTMATTER_RE, "");
  return body
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

function headingMatchesLandmark(heading: string, landmark: string): boolean {
  if (heading === landmark) return true;
  if (!heading.startsWith(landmark)) return false;
  const next = heading.charAt(landmark.length);
  return !/[A-Za-z0-9]/.test(next);
}

describe("plugin skill structure (L:503)", () => {
  for (const spec of SKILLS) {
    describe(spec.path, () => {
      const fullPath = path.join(PLUGIN_ROOT, spec.path);
      const source = readFileSync(fullPath, "utf-8");
      const fm = parseFrontmatter(source);

      test("frontmatter present + parseable", () => {
        expect(fm).not.toBeNull();
      });

      test("frontmatter has description", () => {
        expect(fm?.["description"]).toBeTruthy();
      });

      if (spec.class === "library") {
        test("library-class frontmatter has name", () => {
          expect(fm?.["name"]).toBeTruthy();
        });
      }

      if (spec.expectedSections.length > 0) {
        test("expected sections present in declared order", () => {
          const headings = extractH2Headings(source);
          const found: string[] = [];
          let cursor = 0;
          for (const landmark of spec.expectedSections) {
            const remaining = headings.slice(cursor);
            const localIdx = remaining.findIndex((h) =>
              headingMatchesLandmark(h, landmark),
            );
            if (localIdx === -1) {
              throw new Error(
                `landmark "${landmark}" not found in ${spec.path} after cursor ${cursor}. ` +
                  `Remaining headings: ${JSON.stringify(remaining)}`,
              );
            }
            found.push(landmark);
            cursor += localIdx + 1;
          }
          expect(found).toEqual([...spec.expectedSections]);
        });
      }
    });
  }
});
