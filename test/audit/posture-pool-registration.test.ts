// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L:506 audit-posture framework completion — posture-pool registration smoke
 * tests. Pins the 5 new posture auditor agents, the registry TSV updates, the
 * SKILL.md 2-pool selection model, and the 3 bundled framework memories.
 *
 * Per WP PREMISE-1 fold from Bravo's plan-v1 cross-audit (the "audit-skill
 * commission smoke-test" gate): make this a deterministic unit test in the
 * standard `bun test` gate, not a freeform manual verification.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

const PLUGIN_ROOT = join(import.meta.dir, "..", "..");

const POSTURE_AXES = [
  "premise",
  "scope",
  "reframe",
  "default-action",
  "sequence",
] as const;

const BUNDLED_FRAMEWORK_MEMORIES = [
  "feedback-audit-upstream-vs-downstream-posture",
  "feedback-audit-findings-prefix-distinguishes-mode",
  "feedback-audit-request-framing-by-stage",
] as const;

describe("L:506 posture-pool registration", () => {
  it("all 5 posture auditor files exist", () => {
    for (const axis of POSTURE_AXES) {
      const path = join(
        PLUGIN_ROOT,
        "agents",
        "audit",
        "posture",
        `${axis}.md`,
      );
      expect(existsSync(path)).toBe(true);
    }
  });

  it("each posture auditor has expected frontmatter shape", () => {
    for (const axis of POSTURE_AXES) {
      const path = join(
        PLUGIN_ROOT,
        "agents",
        "audit",
        "posture",
        `${axis}.md`,
      );
      const body = readFileSync(path, "utf8");
      expect(body).toMatch(/^---\n/);
      expect(body).toMatch(/^category: posture$/m);
      expect(body).toMatch(new RegExp(`^domain: ${axis}$`, "m"));
      expect(body).toMatch(/^triggers: \[\]$/m);
      expect(body).toContain(
        "memories/feedback-audit-upstream-vs-downstream-posture.md",
      );
      expect(body).toContain(
        "memories/feedback-audit-findings-prefix-distinguishes-mode.md",
      );
      expect(body).toContain(
        "memories/feedback-audit-request-framing-by-stage.md",
      );
      expect(body).toMatch(/^origin: extracted$/m);
    }
  });

  it("registry.md lists all 5 posture auditors with empty trigger fields", () => {
    const registry = readFileSync(
      join(PLUGIN_ROOT, "agents", "audit", "registry.md"),
      "utf8",
    );
    for (const axis of POSTURE_AXES) {
      // TSV row exists: posture path \t PREFIX \t Name \t [empty triggers]
      // Prettier may strip trailing tab after Name, so allow optional 4th column.
      const tsvRow = new RegExp(
        `posture/${axis}\\.md\\t[A-Z\\-]+\\t[A-Za-z\\- ]+(?:\\t[^\\n]*)?\\n`,
        "m",
      );
      expect(registry).toMatch(tsvRow);
    }
  });

  it("registry.md header counts 21 expert auditors with posture category", () => {
    const registry = readFileSync(
      join(PLUGIN_ROOT, "agents", "audit", "registry.md"),
      "utf8",
    );
    expect(registry).toContain("21 expert auditors");
    expect(registry).toContain("5 posture");
  });

  it("registry.md declares the 2-pool selection model", () => {
    const registry = readFileSync(
      join(PLUGIN_ROOT, "agents", "audit", "registry.md"),
      "utf8",
    );
    expect(registry).toContain("Pool A");
    expect(registry).toContain("Pool B");
    expect(registry).toContain("stage-gated");
  });

  it("SKILL.md Step 2 documents 2-pool selection model with stage-gated Pool B", () => {
    const skill = readFileSync(
      join(PLUGIN_ROOT, "skills", "audit", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("Pool A");
    expect(skill).toContain("Pool B");
    expect(skill).toMatch(/pre-plan-write[^\n]*all 5 posture/i);
    expect(skill).toMatch(/per-PR audit[^\n]*0 posture/i);
  });

  it("3 framework memories bundled under <plugin-root>/memories/", () => {
    for (const memSlug of BUNDLED_FRAMEWORK_MEMORIES) {
      const path = join(PLUGIN_ROOT, "memories", `${memSlug}.md`);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      expect(body).toMatch(/^cadence: /m);
      expect(body).toMatch(/^scope: /m);
      expect(body).toMatch(/^origin: extracted$/m);
      expect(body).toMatch(/^updated: /m);
      expect(body).not.toMatch(/^originSessionId:/m);
    }
  });

  it("bundled framework memories pass the anonymization leak gate", () => {
    // Patterns built dynamically so this test file itself doesn't trip the
    // CI `check-generic-paths.sh` substrate-leak gate. Plugin-bundled
    // memories must not contain the operating user's identifier,
    // user-canonical home paths, or upstream-project literals.
    const currentUser = userInfo().username;
    const leakPatterns: readonly RegExp[] = [
      /\bnick\b/i,
      new RegExp(`\\b${currentUser}\\b`, "i"),
      new RegExp(`/Users/${currentUser}`, ""),
      /\bHeatPrice\b/i,
      /^originSessionId:/m,
    ];
    for (const memSlug of BUNDLED_FRAMEWORK_MEMORIES) {
      const path = join(PLUGIN_ROOT, "memories", `${memSlug}.md`);
      const body = readFileSync(path, "utf8");
      for (const pat of leakPatterns) {
        expect(body).not.toMatch(pat);
      }
    }
  });

  it("posture-auditor adversarial-lens prefixes correspond to expected axes", () => {
    const expectedLensSubstrings: Record<string, string> = {
      premise: "assumptions are baked",
      scope: "outside the bundle",
      reframe: "design shape",
      "default-action": "conservative default",
      sequence: "ordering is implicit",
    };
    for (const [axis, lensSnippet] of Object.entries(expectedLensSubstrings)) {
      const path = join(
        PLUGIN_ROOT,
        "agents",
        "audit",
        "posture",
        `${axis}.md`,
      );
      const body = readFileSync(path, "utf8");
      expect(body).toContain(lensSnippet);
    }
  });

  it("posture-auditor output format documents the axis-specific prefix", () => {
    const prefixByAxis: Record<string, string> = {
      premise: "PREMISE",
      scope: "SCOPE",
      reframe: "REFRAME",
      "default-action": "DEFAULT",
      sequence: "SEQUENCE",
    };
    for (const [axis, prefix] of Object.entries(prefixByAxis)) {
      const path = join(
        PLUGIN_ROOT,
        "agents",
        "audit",
        "posture",
        `${axis}.md`,
      );
      const body = readFileSync(path, "utf8");
      expect(body).toContain(`[${prefix}-1]`);
    }
  });
});
