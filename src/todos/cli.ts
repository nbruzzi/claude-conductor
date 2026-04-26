#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for the todos module, invoked by handoff slash commands.
 *
 * Usage:
 *   bun run src/todos/cli.ts path <handoff-id>
 *   bun run src/todos/cli.ts exists <handoff-id>           [exits 0 if present]
 *   bun run src/todos/cli.ts read <handoff-id>             [prints JSON]
 *   bun run src/todos/cli.ts read-active <handoff-id>      [one item per line]
 *   bun run src/todos/cli.ts write <handoff-id>            [JSON TodoFile on stdin]
 *   bun run src/todos/cli.ts count-active <handoff-id>     [prints integer]
 */

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

function requireArg(argv: string[], i: number, name: string): string {
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

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "path": {
      const id = requireArg(rest, 0, "handoff-id");
      process.stdout.write(`${todoPath(id)}\n`);
      return;
    }
    case "exists": {
      const id = requireArg(rest, 0, "handoff-id");
      if (!exists(id)) process.exit(1);
      return;
    }
    case "read": {
      const id = requireArg(rest, 0, "handoff-id");
      if (!exists(id)) die(`todo file not found for handoff ${id}`, 2);
      printJson(read(id));
      return;
    }
    case "read-active": {
      const id = requireArg(rest, 0, "handoff-id");
      if (!exists(id)) die(`todo file not found for handoff ${id}`, 2);
      const file = read(id);
      for (const item of file.active) {
        process.stdout.write(`${item}\n`);
      }
      return;
    }
    case "write": {
      const id = requireArg(rest, 0, "handoff-id");
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
      const id = requireArg(rest, 0, "handoff-id");
      if (!exists(id)) die(`todo file not found for handoff ${id}`, 2);
      process.stdout.write(`${countActive(read(id))}\n`);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(
        [
          "todos CLI — see src/todos/cli.ts header for full usage.",
          "",
          "Subcommands: path | exists | read | read-active | write | count-active",
        ].join("\n") + "\n",
      );
      return;
    }
    default:
      die(`unknown subcommand: ${cmd}`);
  }
}

await main();
