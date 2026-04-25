// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatMemoriesIndex,
  loadMemories,
  NAMESPACE_PREFIX,
  type MemoryEntry,
} from "../../src/memory-loader";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

describe("loadMemories — fixture parsing", () => {
  const result = loadMemories(FIXTURES_DIR);

  test("parses 2 valid fixtures", () => {
    expect(result.entries).toHaveLength(2);
  });

  test("entries are sorted alphabetically by filename", () => {
    expect(result.entries.map((e) => e.filename)).toEqual([
      "feedback-valid-no-origin.md",
      "feedback-valid-stable.md",
    ]);
  });

  test("typoed-key fixture produces a missing-field error for the canonical key (typo-as-missing)", () => {
    const err = result.errors.find(
      (e) => e.filename === "feedback-typoed-key.md",
    );
    expect(err).toBeDefined();
    expect(err?.reason).toContain("cadence");
    expect(err?.reason).toContain("missing");
  });

  test("valid entry includes parsed frontmatter and body", () => {
    const stable = result.entries.find(
      (e) => e.filename === "feedback-valid-stable.md",
    );
    expect(stable).toBeDefined();
    if (!stable) return;
    expect(stable.frontmatter.name).toBe("Test stable memory");
    expect(stable.frontmatter.cadence).toBe("stable");
    expect(stable.frontmatter.scope).toBe("global");
    expect(stable.frontmatter.origin).toBe("extracted");
    expect(stable.body).toContain("body of a stable test memory");
  });

  test("origin is omitted from entry when not present in frontmatter", () => {
    const noOrigin = result.entries.find(
      (e) => e.filename === "feedback-valid-no-origin.md",
    );
    expect(noOrigin).toBeDefined();
    if (!noOrigin) return;
    expect(noOrigin.frontmatter.origin).toBeUndefined();
  });

  test("invalid-cadence fixture lands in errors with explanatory reason", () => {
    const err = result.errors.find(
      (e) => e.filename === "feedback-invalid-cadence.md",
    );
    expect(err).toBeDefined();
    expect(err?.reason).toContain("cadence");
    expect(err?.reason).toContain("durable");
  });

  test("missing-name fixture lands in errors", () => {
    const err = result.errors.find(
      (e) => e.filename === "feedback-missing-name.md",
    );
    expect(err).toBeDefined();
    expect(err?.reason).toContain("name");
  });

  test("no-frontmatter fixture lands in errors", () => {
    const err = result.errors.find(
      (e) => e.filename === "feedback-no-frontmatter.md",
    );
    expect(err).toBeDefined();
    expect(err?.reason).toContain("frontmatter");
  });

  test("INDEX.md is filtered out", () => {
    const indexEntry = result.entries.find((e) => e.filename === "INDEX.md");
    const indexErr = result.errors.find((e) => e.filename === "INDEX.md");
    expect(indexEntry).toBeUndefined();
    expect(indexErr).toBeUndefined();
  });

  test("underscore-prefixed file is filtered out", () => {
    const internal = result.entries.find(
      (e) => e.filename === "_internal-not-a-memory.md",
    );
    const internalErr = result.errors.find(
      (e) => e.filename === "_internal-not-a-memory.md",
    );
    expect(internal).toBeUndefined();
    expect(internalErr).toBeUndefined();
  });
});

describe("loadMemories — directory handling", () => {
  test("returns empty result when directory does not exist", () => {
    const result = loadMemories("/nonexistent/path/that/should/not/exist");
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("returns empty result when directory is empty", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "memory-loader-test-"));
    try {
      const result = loadMemories(tmpDir);
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("formatMemoriesIndex — INDEX.md section rendering", () => {
  test("renders empty placeholder when no entries", () => {
    const output = formatMemoriesIndex([]);
    expect(output).toContain("## Bundled Memories");
    expect(output).toContain("No memories bundled yet");
  });

  test("renders entries with namespace prefix and link", () => {
    const result = loadMemories(FIXTURES_DIR);
    const output = formatMemoriesIndex(result.entries);
    expect(output).toContain("## Bundled Memories");
    expect(output).toContain(`${NAMESPACE_PREFIX} [Test stable memory]`);
    expect(output).toContain("memories/feedback-valid-stable.md");
  });

  test("uses singular vs plural correctly", () => {
    const oneEntry: readonly MemoryEntry[] = [
      {
        filename: "x.md",
        path: "/x.md",
        frontmatter: {
          name: "X",
          description: "desc",
          type: "feedback",
          cadence: "stable",
          scope: "global",
          updated: "2026-04-25",
        },
        body: "",
      },
    ];
    const single = formatMemoriesIndex(oneEntry);
    expect(single).toContain("1 discipline memory ship");
  });
});
