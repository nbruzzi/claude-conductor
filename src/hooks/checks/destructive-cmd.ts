// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Block or warn on destructive / production-affecting commands.
 * Exit 2 = hard-block (truly destructive). Exit 0 = warn or pass.
 */

import type { HookInput, HookResult } from "../types.ts";
import { block, pass, warn } from "../types.ts";

const SOURCE = "destructive-cmd";

const BLOCK_PATTERNS: RegExp[] = [
  /rm -r[f ]/i,
  /rm -fr/i,
  /rm --recursive/i,
  /git reset --hard/i,
  /git push[^-]*--force(\s|$)/i,
  /git clean -[fd]/i,
  /git restore\b(?!\s+--staged)/i,
  /git checkout --\s/i,
  /DROP TABLE/i,
  /DROP DATABASE/i,
  /TRUNCATE/i,
];

const WARN_PATTERNS: RegExp[] = [
  /git branch -D/i,
  /git push.*--force-with-lease/i,
  /git push.*--force-if-includes/i,
  /DELETE FROM/i,
  /vercel --prod/i,
  /vercel deploy --prod/i,
  /vercel promote/i,
];

export async function check(input: HookInput): Promise<HookResult> {
  const cmd = input.command;
  if (!cmd) return pass();

  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(cmd)) {
      return block(
        SOURCE,
        "BLOCKED: destructive command detected. Get explicit user approval first.",
        `matched BLOCK pattern: ${pattern.source}`,
      );
    }
  }

  for (const pattern of WARN_PATTERNS) {
    if (pattern.test(cmd)) {
      return warn(
        SOURCE,
        "CAUTION: potentially destructive or production-affecting command.",
        `matched WARN pattern: ${pattern.source}`,
      );
    }
  }

  return pass();
}
