// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Warn when editing sensitive files (.env, settings.json, CI configs, Dockerfiles).
 */

import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "sensitive-files";

export async function check(input: HookInput): Promise<HookResult> {
  const file = input.filePath;
  if (!file) return pass();

  const basename = file.split("/").pop() ?? "";

  // Environment / secrets files
  if (/^\.env(\..+)?$/.test(basename) || basename.endsWith(".env")) {
    return warn(
      SOURCE,
      "CAUTION: editing environment/secrets file.",
      `matched env pattern: ${basename}`,
    );
  }

  // Claude Code settings
  if (basename === "settings.json" && file.includes(".claude/settings.json")) {
    return warn(
      SOURCE,
      "CAUTION: editing Claude Code settings.",
      "matched: .claude/settings.json",
    );
  }

  // CI/CD pipeline configs
  if (
    /\.(yml|yaml)$/.test(basename) &&
    /\.(github|gitlab|circleci)\//.test(file)
  ) {
    return warn(
      SOURCE,
      "CAUTION: editing CI/CD pipeline config.",
      `matched CI config: ${basename}`,
    );
  }

  // Container configs
  if (
    basename === "Dockerfile" ||
    /^docker-compose.*\.(yml|yaml)$/.test(basename)
  ) {
    return warn(
      SOURCE,
      "CAUTION: editing container config.",
      `matched container config: ${basename}`,
    );
  }

  return pass();
}
