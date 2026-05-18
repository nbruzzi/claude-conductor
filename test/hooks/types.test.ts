// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Compile-time exhaustiveness anchor for `KnownToolName`.
 *
 * Plan: ~/.claude/plans/mirrored-stitching-orchid.md (slice 6 / B1 / TS-N3).
 *
 * The switch below covers every member of `KNOWN_TOOL_NAMES`. If a future
 * contributor adds a new tool to the runtime array without adding a `case`
 * arm here, the `default` branch hands a non-`never` value to `assertNever`
 * and TypeScript fails to compile (CI typecheck gate fires).
 *
 * Lives in `test/` so plain `bun test` discovers it, but the load-bearing
 * mechanism is `bun run typecheck` (tsc --noEmit) which compiles every
 * `*.test.ts` per `tsconfig.json` `include`. The runtime assertion is a
 * bonus belt-on-suspenders: each name in `KNOWN_TOOL_NAMES` is fed through
 * the switch and must reach a non-default branch.
 */

import { describe, expect, it } from "bun:test";

import {
  assertNever,
  KNOWN_TOOL_NAMES,
  type KnownToolName,
} from "../../src/hooks/types.ts";

function describeKnownTool(tool: KnownToolName): string {
  switch (tool) {
    case "Bash":
      return "shell";
    case "BashOutput":
      return "shell";
    case "Edit":
      return "edit";
    case "ExitPlanMode":
      return "control";
    case "Glob":
      return "read";
    case "Grep":
      return "read";
    case "KillShell":
      return "shell";
    case "MultiEdit":
      return "edit";
    case "NotebookEdit":
      return "edit";
    case "NotebookRead":
      return "read";
    case "Read":
      return "read";
    case "SlashCommand":
      return "control";
    case "Task":
      return "control";
    case "TodoWrite":
      return "edit";
    case "WebFetch":
      return "read";
    case "WebSearch":
      return "read";
    case "Write":
      return "edit";
    default:
      return assertNever(tool);
  }
}

describe("KnownToolName exhaustiveness anchor", () => {
  it("describeKnownTool returns a non-default branch for every member of KNOWN_TOOL_NAMES", () => {
    for (const name of KNOWN_TOOL_NAMES) {
      expect(describeKnownTool(name)).not.toBe("");
    }
  });
});
