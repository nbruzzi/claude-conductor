// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Per-handoff durable todo surface.
 *
 * One file per handoff chain: `~/.claude/todos/<handoff-id>.md`. Format is
 * octogent-style markdown checkboxes under sections. `/handoff` writes the
 * file at session-end; `/handoff-resume` rehydrates TaskList from `## Active`
 * at session-start. The file is the single source of truth across sessions;
 * the TaskList is the single source of truth within a session.
 *
 * See ~/.claude/plans/ancient-waddling-tulip.md for the full carry-forward
 * contract.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { todosDir } from "../shared/paths.ts";

export type TodoFile = {
  handoffId: string;
  generatedBy?: string;
  active: string[];
  done: string[];
};

/** Root directory for all per-handoff todo state. Delegates to the
 *  centralized resolver in `src/shared/paths.ts` (honors
 *  `CLAUDE_CONDUCTOR_TODOS_DIR` then `CLAUDE_CONDUCTOR_ROOT/todos` then
 *  `~/.claude/todos` per Decision N — shared canonical with dotfiles, not
 *  under `conductor/`). */
export function resolveTodosDir(): string {
  return todosDir();
}

export function todoPath(handoffId: string): string {
  return join(resolveTodosDir(), `${handoffId}.md`);
}

export function exists(handoffId: string): boolean {
  return existsSync(todoPath(handoffId));
}

const HANDOFF_ID_COMMENT = /<!--\s*handoff-id:\s*(.+?)\s*-->/u;
const GENERATED_BY_COMMENT = /<!--\s*generated-by:\s*(.+?)\s*-->/u;
const ACTIVE_CHECKBOX = /^-\s+\[\s\]\s+(.+)$/u;
const DONE_CHECKBOX = /^-\s+\[x\]\s+(.+)$/iu;

type SectionKey = "active" | "done" | null;

/** Parse a todo-file markdown blob. Never throws; returns best-effort. */
export function parse(md: string): TodoFile {
  const lines = md.split("\n");
  const handoffMatch = md.match(HANDOFF_ID_COMMENT);
  const generatedMatch = md.match(GENERATED_BY_COMMENT);

  const out: TodoFile = {
    handoffId: handoffMatch?.[1] ?? "",
    active: [],
    done: [],
  };
  if (generatedMatch?.[1]) out.generatedBy = generatedMatch[1];

  let section: SectionKey = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim().toLowerCase();
      if (heading === "active") section = "active";
      else if (heading.startsWith("done")) section = "done";
      else section = null;
      continue;
    }
    if (section === null) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const activeMatch = trimmed.match(ACTIVE_CHECKBOX);
    const doneMatch = trimmed.match(DONE_CHECKBOX);
    if (activeMatch?.[1]) {
      if (section === "active") out.active.push(activeMatch[1].trim());
      else out.done.push(activeMatch[1].trim());
    } else if (doneMatch?.[1]) {
      if (section === "done") out.done.push(doneMatch[1].trim());
      else out.active.push(doneMatch[1].trim());
    }
  }
  return out;
}

/** Serialize a TodoFile to the canonical markdown shape. */
export function serialize(file: TodoFile): string {
  const lines: string[] = [
    "# Todo",
    "",
    `<!-- handoff-id: ${file.handoffId} -->`,
  ];
  if (file.generatedBy) {
    lines.push(`<!-- generated-by: ${file.generatedBy} -->`);
  }
  lines.push("", "## Active", "");
  if (file.active.length === 0) {
    lines.push("<!-- none -->");
  } else {
    for (const item of file.active) lines.push(`- [ ] ${item}`);
  }
  lines.push("", "## Done (since last handoff)", "");
  if (file.done.length === 0) {
    lines.push("<!-- none -->");
  } else {
    for (const item of file.done) lines.push(`- [x] ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Read and parse a todo file. Throws on missing file or read failure. */
export function read(handoffId: string): TodoFile {
  const text = readFileSync(todoPath(handoffId), "utf-8");
  return parse(text);
}

/** Write a todo file atomically via temp+rename. Throws on IO failure. */
export function write(handoffId: string, file: TodoFile): void {
  mkdirSync(resolveTodosDir(), { recursive: true });
  const dest = todoPath(handoffId);
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, serialize(file), "utf-8");
  renameSync(tmp, dest);
}

/** Count active items — convenience for reconciliation after rehydration. */
export function countActive(file: TodoFile): number {
  return file.active.length;
}
