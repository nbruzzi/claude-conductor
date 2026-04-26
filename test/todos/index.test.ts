// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import {
  countActive,
  exists,
  parse,
  read,
  resolveTodosDir,
  serialize,
  todoPath,
  write,
  type TodoFile,
} from "../../src/todos/index.ts";

const SANDBOX = `/tmp/test-todos-${process.pid}`;

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["TODOS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["TODOS_DIR"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

describe("todos", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  describe("resolveTodosDir + todoPath", () => {
    it("honours TODOS_DIR override", () => {
      expect(resolveTodosDir()).toBe(SANDBOX);
      expect(todoPath("handoff-x")).toBe(`${SANDBOX}/handoff-x.md`);
    });
  });

  describe("parse", () => {
    it("pulls handoff-id from the frontmatter comment", () => {
      const md = `# Todo\n\n<!-- handoff-id: h-1 -->\n\n## Active\n\n- [ ] thing\n`;
      const file = parse(md);
      expect(file.handoffId).toBe("h-1");
      expect(file.active).toEqual(["thing"]);
    });

    it("pulls generatedBy when present", () => {
      const md = `# Todo\n\n<!-- handoff-id: h-g -->\n<!-- generated-by: /handoff -->\n\n## Active\n- [ ] a\n`;
      const file = parse(md);
      expect(file.generatedBy).toBe("/handoff");
    });

    it("section heading is authoritative over checkbox state", () => {
      // If a [x] appears under ## Active, it still counts as active — section
      // is the source of truth. Same for [ ] under ## Done. This keeps the
      // round-trip stable even if users hand-edit boxes without moving items.
      const md = `# Todo\n\n<!-- handoff-id: h-2 -->\n\n## Active\n- [x] still-active\n\n## Done (since last handoff)\n- [ ] still-done\n`;
      const file = parse(md);
      expect(file.active).toEqual(["still-active"]);
      expect(file.done).toEqual(["still-done"]);
    });

    it("ignores items outside known sections", () => {
      const md = `# Todo\n\n<!-- handoff-id: h-3 -->\n\n## Untracked\n- [ ] ignored\n\n## Active\n- [ ] kept\n`;
      const file = parse(md);
      expect(file.active).toEqual(["kept"]);
    });

    it("handles missing handoff-id comment gracefully", () => {
      const md = `# Todo\n\n## Active\n- [ ] x\n`;
      const file = parse(md);
      expect(file.handoffId).toBe("");
      expect(file.active).toEqual(["x"]);
    });
  });

  describe("serialize", () => {
    it("emits canonical structure", () => {
      const file: TodoFile = {
        handoffId: "h-s",
        generatedBy: "/handoff @ 2026-04-19T10:00Z",
        active: ["one", "two"],
        done: ["zero"],
      };
      const md = serialize(file);
      expect(md).toContain("<!-- handoff-id: h-s -->");
      expect(md).toContain(
        "<!-- generated-by: /handoff @ 2026-04-19T10:00Z -->",
      );
      expect(md).toContain("- [ ] one");
      expect(md).toContain("- [ ] two");
      expect(md).toContain("- [x] zero");
    });

    it("emits <!-- none --> placeholders when a section is empty", () => {
      const md = serialize({ handoffId: "h-e", active: [], done: [] });
      expect(md.match(/<!-- none -->/gu)?.length).toBe(2);
    });

    it("round-trips through parse", () => {
      const original: TodoFile = {
        handoffId: "h-r",
        active: ["alpha", "beta with spaces"],
        done: ["gamma"],
      };
      const reparsed = parse(serialize(original));
      expect(reparsed.handoffId).toBe(original.handoffId);
      expect(reparsed.active).toEqual(original.active);
      expect(reparsed.done).toEqual(original.done);
    });
  });

  describe("read + write", () => {
    it("writes atomically and reads back", () => {
      const file: TodoFile = { handoffId: "h-rw", active: ["a"], done: [] };
      write("h-rw", file);
      expect(exists("h-rw")).toBe(true);
      const readBack = read("h-rw");
      expect(readBack.handoffId).toBe("h-rw");
      expect(readBack.active).toEqual(["a"]);
    });

    it("overwrites on re-write", () => {
      write("h-ow", { handoffId: "h-ow", active: ["first"], done: [] });
      write("h-ow", { handoffId: "h-ow", active: ["second"], done: ["first"] });
      const readBack = read("h-ow");
      expect(readBack.active).toEqual(["second"]);
      expect(readBack.done).toEqual(["first"]);
    });

    it("temp file is cleaned up after successful write", () => {
      write("h-tmp", { handoffId: "h-tmp", active: [], done: [] });
      const tmp = `${todoPath("h-tmp")}.tmp.${process.pid}`;
      expect(existsSync(tmp)).toBe(false);
    });

    it("read throws when file missing", () => {
      expect(() => read("never-written")).toThrow();
    });
  });

  describe("countActive", () => {
    it("returns the length of active", () => {
      expect(countActive({ handoffId: "h", active: [], done: [] })).toBe(0);
      expect(
        countActive({ handoffId: "h", active: ["a", "b", "c"], done: ["d"] }),
      ).toBe(3);
    });
  });

  describe("exists", () => {
    it("reflects filesystem state", () => {
      expect(exists("nope")).toBe(false);
      writeFileSync(
        todoPath("yep"),
        "# Todo\n<!-- handoff-id: yep -->\n\n## Active\n\n## Done\n",
      );
      expect(exists("yep")).toBe(true);
    });
  });
});
