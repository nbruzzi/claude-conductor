#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for the todos module, invoked by handoff slash commands.
 *
 * Phase 1 Slice 8.5 (CLI-DX consistency closure): brought to parity with
 * channels/cli.ts — `parseFlags` integration, per-verb `--help`,
 * `runTodosCli` programmatic export + `import.meta.main` guard per atomic-
 * wiring discipline (`feedback-atomic-wiring-discipline.md`).
 *
 * Usage:
 *   claude-conductor todos <verb> [args...] [--help]
 *
 * Verbs (run with `--help` for per-verb usage):
 *   path           — print on-disk todo file path for handoff-id
 *   exists         — exit 0 if todo file exists; non-zero otherwise
 *   read           — print TodoFile JSON
 *   read-active    — print one active item per line
 *   write          — read TodoFile JSON from stdin and write to disk
 *   count-active   — print integer count of active items
 */

import { parseFlags } from "../cli/flags.ts";
import {
  countActive,
  exists,
  read,
  todoPath,
  write,
  type TodoFile,
} from "./index.ts";

function die(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function requireArg(argv: readonly string[], i: number, name: string): string {
  const v = argv[i];
  if (!v) die(`missing argument: ${name}`);
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function printJson(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

function validateTodoFile(v: unknown): TodoFile {
  if (typeof v !== "object" || v === null)
    die("invalid TodoFile: expected object");
  const o = v as Record<string, unknown>;
  const handoffId = o["handoffId"];
  const active = o["active"];
  const done = o["done"];
  if (typeof handoffId !== "string")
    die("invalid TodoFile: handoffId must be string");
  if (!Array.isArray(active) || !active.every((x) => typeof x === "string")) {
    die("invalid TodoFile: active must be string[]");
  }
  if (!Array.isArray(done) || !done.every((x) => typeof x === "string")) {
    die("invalid TodoFile: done must be string[]");
  }
  const out: TodoFile = {
    handoffId,
    active: active as string[],
    done: done as string[],
  };
  const generatedBy = o["generatedBy"];
  if (typeof generatedBy === "string") out.generatedBy = generatedBy;
  return out;
}

const VERB_HELP: Record<string, string> = {
  path: "Usage: claude-conductor todos path <handoff-id>\n  Print the canonical on-disk path for the handoff's todo file.",
  exists:
    "Usage: claude-conductor todos exists <handoff-id>\n  Exit 0 if the todo file exists; non-zero otherwise. Useful as a guard.",
  read: "Usage: claude-conductor todos read <handoff-id>\n  Print the TodoFile JSON. Exits 2 if the file does not exist.",
  "read-active":
    "Usage: claude-conductor todos read-active <handoff-id>\n  Print one active item per line. Exits 2 if the file does not exist.",
  write:
    "Usage: claude-conductor todos write <handoff-id>\n  Read TodoFile JSON from stdin and write to disk. The payload's `handoffId` must match the argv handoff-id.",
  "count-active":
    "Usage: claude-conductor todos count-active <handoff-id>\n  Print integer count of active items. Exits 2 if the file does not exist.",
};

const TOP_LEVEL_HELP =
  [
    "Usage: claude-conductor todos <verb> [args...] [--help]",
    "",
    "Verbs:",
    "  path           — print on-disk todo file path for handoff-id",
    "  exists         — exit 0 if todo file exists; non-zero otherwise",
    "  read           — print TodoFile JSON",
    "  read-active    — print one active item per line",
    "  write          — read TodoFile JSON from stdin and write to disk",
    "  count-active   — print integer count of active items",
    "",
    "Run 'claude-conductor todos <verb> --help' for per-verb details.",
  ].join("\n") + "\n";

/**
 * Programmatic entry point for the todos CLI. Mirrors `runChannelsCli` per
 * atomic-wiring discipline: importing this module is a no-op (no top-level
 * side effects); subprocess invocation via the bash binary or
 * `bun run src/todos/cli.ts` triggers `import.meta.main` and runs.
 */
export async function runTodosCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const cmd = argv[0];

  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(TOP_LEVEL_HELP);
    return;
  }

  // Parse flags out of the verb's args; --help anywhere triggers verb help.
  const verbArgs = argv.slice(1);
  const { positional, flags } = parseFlags(verbArgs, {
    help: true,
    json: false,
    quiet: false,
  });

  if (flags.help) {
    const help = VERB_HELP[cmd];
    if (help !== undefined) {
      process.stdout.write(`${help}\n`);
      return;
    }
    process.stdout.write(TOP_LEVEL_HELP);
    return;
  }

  switch (cmd) {
    case "path": {
      const id = requireArg(positional, 0, "handoff-id");
      process.stdout.write(`${todoPath(id)}\n`);
      return;
    }
    case "exists": {
      const id = requireArg(positional, 0, "handoff-id");
      if (!exists(id)) process.exit(1);
      return;
    }
    case "read": {
      const id = requireArg(positional, 0, "handoff-id");
      if (!exists(id)) die(`todo file not found for handoff ${id}`, 2);
      printJson(read(id));
      return;
    }
    case "read-active": {
      const id = requireArg(positional, 0, "handoff-id");
      if (!exists(id)) die(`todo file not found for handoff ${id}`, 2);
      const file = read(id);
      for (const item of file.active) {
        process.stdout.write(`${item}\n`);
      }
      return;
    }
    case "write": {
      const id = requireArg(positional, 0, "handoff-id");
      const raw = (await readStdin()).trim();
      if (raw.length === 0)
        die("empty stdin — write requires a TodoFile JSON on stdin");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        die(`invalid JSON on stdin: ${msg}`);
      }
      const file = validateTodoFile(parsed);
      if (file.handoffId !== id) {
        die(
          `handoffId mismatch: argv "${id}" vs payload "${file.handoffId}" — refusing to write`,
        );
      }
      write(id, file);
      process.stdout.write(`${todoPath(id)}\n`);
      return;
    }
    case "count-active": {
      const id = requireArg(positional, 0, "handoff-id");
      if (!exists(id)) die(`todo file not found for handoff ${id}`, 2);
      process.stdout.write(`${countActive(read(id))}\n`);
      return;
    }
    default:
      die(`unknown subcommand: ${cmd}`);
  }
}

if (import.meta.main) {
  await runTodosCli();
}
