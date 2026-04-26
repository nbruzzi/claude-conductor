// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Remind to use bun instead of npm (per CLAUDE.md).
 */

import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "prefer-bun";

const NPM_PATTERN =
  /(^|\s|&&|\|\||;)npm (install|i|ci|run|exec|init|create|test|start|build|publish)/;

export async function check(input: HookInput): Promise<HookResult> {
  const cmd = input.command;
  if (!cmd) return pass();

  const match = NPM_PATTERN.exec(cmd);
  if (match) {
    return warn(
      SOURCE,
      "REMINDER: use bun, not npm (per CLAUDE.md).",
      `matched: ${match[0].trim()}`,
    );
  }

  return pass();
}
