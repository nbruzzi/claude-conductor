// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L:508 audit-request convention doc — registration smoke tests. Pins the
 * convention doc existence + 6 stage templates + SKILL.md imports + INDEX.md
 * catalog entry + bundled-memory pointer-line.
 *
 * Sibling-shape to `test/audit/posture-pool-registration.test.ts` from L:506.
 * Both pin documentation surfaces that the audit-skill depends on at
 * commission time.
 *
 * Substrate-refactor 2026-05-27: the `channel.md` "Audit-request templates"
 * subsection assertion (which previously pinned `commands/session/channel.md`
 * importing this convention doc) MOVED out of this file. `channel.md` is
 * now dotfiles-canonical (user-workflow vs plugin-primitive split). The
 * dotfiles repo's parallel test suite is where any channel.md content
 * assertion now lives. Conductor still pins the convention doc itself
 * (existence + 6 stages + 6 ask-fields + pool model + SKILL/INDEX entries).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ROOT = join(import.meta.dir, "..", "..");

const STAGES = [
  "pre-plan-write",
  "plan-v1",
  "plan-v2",
  "per-PR",
  "pre-merge",
  "post-merge",
] as const;

describe("L:508 audit-request convention doc", () => {
  it("convention doc exists at the agreed home", () => {
    const path = join(
      PLUGIN_ROOT,
      "docs",
      "conventions",
      "audit-request-by-stage.md",
    );
    expect(existsSync(path)).toBe(true);
  });

  it("convention doc covers all 6 stages with template blocks", () => {
    const body = readFileSync(
      join(PLUGIN_ROOT, "docs", "conventions", "audit-request-by-stage.md"),
      "utf8",
    );
    for (const stage of STAGES) {
      expect(body.toLowerCase()).toContain(stage.toLowerCase());
    }
  });

  it("convention doc names the 6 ask-fields", () => {
    const body = readFileSync(
      join(PLUGIN_ROOT, "docs", "conventions", "audit-request-by-stage.md"),
      "utf8",
    );
    const askFields = [
      "Stage",
      "Mode mix",
      "Lenses",
      "Specific questions",
      "Out-of-scope",
      "Disposition gate",
    ];
    for (const field of askFields) {
      expect(body).toContain(field);
    }
  });

  it("convention doc references the 2-pool selection model and the framework memory", () => {
    const body = readFileSync(
      join(PLUGIN_ROOT, "docs", "conventions", "audit-request-by-stage.md"),
      "utf8",
    );
    expect(body).toContain("Pool A");
    expect(body).toContain("Pool B");
    expect(body).toContain("feedback-audit-upstream-vs-downstream-posture.md");
    expect(body).toContain("agents/audit/registry.md");
  });

  it("SKILL.md Step 0 imports the convention doc as per-stage template source", () => {
    const skill = readFileSync(
      join(PLUGIN_ROOT, "skills", "audit", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("docs/conventions/audit-request-by-stage.md");
  });

  it("INDEX.md catalogs the convention doc under ## Conventions", () => {
    const index = readFileSync(join(PLUGIN_ROOT, "INDEX.md"), "utf8");
    expect(index).toContain("docs/conventions/audit-request-by-stage.md");
    expect(index).toContain("L:508 audit-request convention doc");
  });

  it("bundled memory adds the implementation-note pointer line (KS REFRAME-1 option c — body preserved)", () => {
    const memory = readFileSync(
      join(
        PLUGIN_ROOT,
        "memories",
        "feedback-audit-request-framing-by-stage.md",
      ),
      "utf8",
    );
    expect(memory).toContain("docs/conventions/audit-request-by-stage.md");
    expect(memory).toContain("Implementation note");
    expect(memory).toContain("Pre-plan audit request");
    expect(memory).toContain("Plan v1 cross-audit request");
    expect(memory).toContain("Lane D STRICT GATE request");
    expect(memory).toContain("Post-merge retrospective request");
  });

  it("framework memories have well-formed updated: frontmatter (anonymization regression check)", () => {
    const frameworkMemories = [
      "feedback-audit-upstream-vs-downstream-posture.md",
      "feedback-audit-findings-prefix-distinguishes-mode.md",
      "feedback-audit-request-framing-by-stage.md",
    ];
    const ISO_DATE = /^updated: \d{4}-\d{2}-\d{2}$/m;
    for (const mem of frameworkMemories) {
      const body = readFileSync(join(PLUGIN_ROOT, "memories", mem), "utf8");
      expect(body).toMatch(ISO_DATE);
    }
  });
});
