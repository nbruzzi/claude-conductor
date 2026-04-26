// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * handoff-symlink-write-guard — block Edit/Write on symlinked paths inside
 * ~/.claude/handoffs/.
 *
 * Scope:
 *   Enforces a /handoff skill invariant: aggregate-pointer symlinks under
 *   ~/.claude/handoffs/ (LATEST.md and similar) must only be updated via
 *   `rm -f && ln -sf` through the Bash tool. Edit/Write follows symlinks
 *   and silently overwrites the target handoff, clobbering the previous
 *   session's work. This check blocks before that happens.
 *
 * Trigger — blocks only when ALL hold:
 *   1. toolName ∈ { "Edit", "Write" }
 *   2. filePath resolves inside ~/.claude/handoffs/
 *   3. lstat(filePath) reports a symbolic link
 *
 * Kill switches (either disables this check):
 *   - ~/.claude/handoff-guards-off              — umbrella flag
 *   - ~/.claude/handoff-symlink-write-guard-off — per-check flag
 *   When active, the check emits a warn() naming the active flag so the
 *   user sees an audit trail on every invocation.
 *
 * Known limitations:
 *   - TOCTOU: a small race exists between lstat() here and the actual
 *     Write performed by Claude Code. In that window a peer session could
 *     replace a regular file with a symlink, defeating this check. This
 *     is defense-in-depth — the /handoff skill's Step 6 Bash recipe is
 *     the primary defense.
 *   - Ancestor symlinks: isInside() canonicalizes both the handoffs dir
 *     and the target's parent directory via realpath() to handle legitimate
 *     ancestor symlinks (e.g. /tmp → /private/tmp on macOS). If the
 *     target's parent directory does not yet exist, the check falls back
 *     to textual resolve() and may under-match when an ancestor symlink
 *     would have otherwise normalized to inside the handoffs dir.
 *
 * See /handoff skill Step 6 for the canonical Bash recipe.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn, block } from "../types.ts";

const SOURCE = "handoff-symlink-write-guard";

function resolveHome(): string {
  return process.env["HANDOFF_SYMLINK_GUARD_HOME"] ?? homedir();
}

function handoffsDir(): string {
  return join(resolveHome(), ".claude", "handoffs");
}

function perCheckKillSwitchPath(): string {
  return join(resolveHome(), ".claude", "handoff-symlink-write-guard-off");
}

function umbrellaKillSwitchPath(): string {
  return join(resolveHome(), ".claude", "handoff-guards-off");
}

/** Return the active kill-switch flag path, or undefined when none is set. */
function activeKillSwitch(): string | undefined {
  if (existsSync(umbrellaKillSwitchPath())) return umbrellaKillSwitchPath();
  if (existsSync(perCheckKillSwitchPath())) return perCheckKillSwitchPath();
  return undefined;
}

/**
 * True when `target` resolves inside `parent`. Canonicalizes both via
 * realpath to handle legitimate ancestor symlinks (e.g. /tmp → /private/tmp
 * on macOS). The final segment of `target` is preserved (not followed) so
 * the caller can still detect a symlink at that position via lstat.
 */
function isInside(parent: string, target: string): boolean {
  let parentCanonical: string;
  try {
    parentCanonical = realpathSync(parent);
  } catch {
    parentCanonical = resolve(parent);
  }

  const targetResolved = resolve(target);
  let targetCanonical: string;
  try {
    const parentDir = realpathSync(dirname(targetResolved));
    targetCanonical = join(parentDir, basename(targetResolved));
  } catch {
    targetCanonical = targetResolved;
  }

  const rel = relative(parentCanonical, targetCanonical);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export async function check(input: HookInput): Promise<HookResult> {
  const tool = input.toolName;
  if (tool !== "Edit" && tool !== "Write") return pass();

  const file = input.filePath;
  if (!file) return pass();

  const switchPath = activeKillSwitch();
  if (switchPath) {
    return warn(
      SOURCE,
      `disabled by kill switch: ${switchPath}`,
      `kind=kill-switch-active;path=${switchPath}`,
    );
  }

  const dir = handoffsDir();
  if (!isInside(dir, file)) return pass();

  let stat;
  try {
    stat = lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return pass();
    return warn(
      SOURCE,
      `could not lstat \`${file}\`: ${code ?? "unknown"}`,
      `kind=lstat-error;code=${code ?? "unknown"};path=${file}`,
    );
  }
  if (!stat.isSymbolicLink()) return pass();

  let linkTarget: string | undefined;
  try {
    linkTarget = readlinkSync(file);
  } catch {
    linkTarget = undefined;
  }

  const linkTargetResolved = linkTarget
    ? resolve(dirname(file), linkTarget)
    : undefined;
  const targetExists = linkTargetResolved
    ? existsSync(linkTargetResolved)
    : false;

  const contextLine = linkTarget
    ? targetExists
      ? `currently targets \`${linkTarget}\``
      : `current target missing: \`${linkTarget}\``
    : `(cannot read link target)`;

  return block(
    SOURCE,
    [
      `BLOCKED: Edit/Write on symlinked path under ~/.claude/handoffs/: \`${file}\``,
      `(${contextLine})`,
      `Edit/Write follows the symlink and silently overwrites the target handoff.`,
      `Use the Bash tool instead:`,
      `  rm -f ${file} && ln -sf /path/to/HANDOFF_YYYY-MM-DD_HH-MM.md ${file}`,
      `See /handoff skill Step 6 for the canonical recipe.`,
    ].join("\n"),
    `kind=symlinked-handoff-write;broken=${!targetExists};path=${file}`,
  );
}

export const INTERNAL = {
  SOURCE,
  handoffsDir,
  perCheckKillSwitchPath,
  umbrellaKillSwitchPath,
  activeKillSwitch,
  isInside,
};
