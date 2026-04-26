// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Warn when ~/.claude/handoffs/LATEST.md is broken — either a regular
 * file instead of a symlink, or a symlink whose target is missing.
 *
 * The /handoff and /handoff-resume skills depend on LATEST pointing at
 * a valid handoff file. Rot is silent until the next /handoff-resume,
 * which then degrades from "pick up instantly" to "figure it out." This
 * check surfaces the rot at session end so it gets fixed before it
 * bites.
 *
 * Detection-only. Never auto-fixes.
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, dirname, resolve } from "node:path";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "handoff-latest-guard";
const LATEST_NAME = "LATEST.md";

function resolveHome(): string {
  return process.env["HANDOFF_LATEST_GUARD_HOME"] ?? homedir();
}

function handoffsDir(): string {
  return join(resolveHome(), ".claude", "handoffs");
}

function killSwitchPath(): string {
  return join(resolveHome(), ".claude", "handoff-latest-guard-off");
}

export async function check(_input: HookInput): Promise<HookResult> {
  if (existsSync(killSwitchPath())) return pass();

  const dir = handoffsDir();
  if (!existsSync(dir)) return pass();

  const latest = join(dir, LATEST_NAME);

  let stat;
  try {
    stat = lstatSync(latest);
  } catch {
    return pass();
  }

  if (!stat.isSymbolicLink()) {
    return warn(
      SOURCE,
      [
        `${latest} is a regular file — expected a symlink to the newest handoff.`,
        `Re-point it: \`cd ${dir} && ln -sf $(ls -t HANDOFF_*.md | head -1) LATEST.md\``,
      ].join("\n"),
      "kind=not-symlink",
    );
  }

  const target = readlinkSync(latest);
  const resolved = isAbsolute(target)
    ? target
    : resolve(dirname(latest), target);
  if (existsSync(resolved)) return pass();

  return warn(
    SOURCE,
    [
      `${latest} points to a missing target: ${target}`,
      `The handoff file was deleted or renamed. Re-link or run /handoff to create a fresh one.`,
    ].join("\n"),
    `kind=broken-symlink;target=${target}`,
  );
}

export const INTERNAL = {
  SOURCE,
  LATEST_NAME,
  handoffsDir,
  killSwitchPath,
};
