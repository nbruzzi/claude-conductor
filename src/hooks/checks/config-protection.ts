// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Config protection — block edits to lint/format/typecheck config files.
 *
 * Catches the failure mode where Claude weakens lint rules or disables
 * type checking to make code pass instead of fixing the actual issue.
 * Requires explicit user approval for any config edit.
 *
 * Approval mechanism: a single-use, TTL-bounded marker file at
 * $HOME/.claude/config-protection-approvals/<hash>.json bypasses the block
 * for one Edit/Write to the matching path. Markers are written via the
 * `/approve-config-edit` slash command (which invokes
 * `src/hooks/checks/config-protection-cli.ts`) and consumed on first use.
 *
 * Fail-closed contract: every error path inside `consumeApproval` returns
 * `false` (no approval honored). The outer try/catch wraps EVERYTHING so a
 * malformed approvals dir (corrupt umask, EACCES, EIO) cannot crash the
 * hook into bypassing the block.
 */

import { readFileSync, renameSync, unlinkSync } from "node:fs";
import type { HookInput, HookResult } from "../types.ts";
import { pass, block } from "../types.ts";
import {
  canonicalizePath,
  markerPath,
  type ApprovalMarker,
} from "./config-protection-store.ts";

const SOURCE = "config-protection";

/** Config file patterns — basename matches. */
const PROTECTED_BASENAMES = new Set([
  "tsconfig.json",
  "biome.json",
  "biome.jsonc",
  ".editorconfig",
]);

/** Config file patterns — prefix/suffix matches. */
const PROTECTED_PATTERNS: Array<(basename: string) => boolean> = [
  // ESLint: eslint.config.*, .eslintrc*
  (b) => b.startsWith("eslint.config.") || b.startsWith(".eslintrc"),
  // Prettier: prettier.config.*, .prettierrc*
  (b) => b.startsWith("prettier.config.") || b.startsWith(".prettierrc"),
  // TypeScript: tsconfig.*.json
  (b) => b.startsWith("tsconfig.") && b.endsWith(".json"),
];

function isProtectedConfig(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? "";
  if (PROTECTED_BASENAMES.has(basename)) return true;
  return PROTECTED_PATTERNS.some((fn) => fn(basename));
}

/**
 * Look for a non-expired approval marker for `absolutePath`. If one exists,
 * atomically claim it (rename-then-read), validate, and return true. The
 * rename ensures only one of N concurrent invocations wins the marker; the
 * loser sees ENOENT and returns false.
 *
 * Fail-closed: ANY error returns false. The outer try/catch wraps every
 * filesystem and parse step so EACCES on the approvals dir, missing HOME,
 * unreadable marker, etc. all default to "no approval honored."
 */
function consumeApproval(absolutePath: string): boolean {
  try {
    const canonical = canonicalizePath(absolutePath);
    const target = markerPath(canonical);
    // TOCTOU-safe claim: rename to a per-invocation suffix. The first writer
    // wins; subsequent renamers get ENOENT and treat it as no approval.
    // This also doubles as the "consumed" mark — even if we crash post-rename,
    // the next invocation cannot find the marker.
    const claimed = `${target}.consumed-${process.pid}-${Date.now()}`;
    try {
      renameSync(target, claimed);
    } catch {
      // ENOENT (no marker, or another invocation won) → no approval.
      // EACCES / EIO / etc. → no approval (fail-closed).
      return false;
    }
    let marker: ApprovalMarker;
    try {
      marker = JSON.parse(readFileSync(claimed, "utf8")) as ApprovalMarker;
    } catch {
      // Corrupt JSON or unreadable → consume + fail-closed. (The rename
      // already moved it out of the active set so re-edits won't re-trigger.)
      tryUnlink(claimed);
      return false;
    }
    // Defensive: collision check. The hash is 16 hex chars (~10^19 space) so
    // SHA-256 collision is astronomically unlikely, but verify the marker
    // claims our path before honoring it. Compare canonical-to-canonical so
    // tamper-resistance survives ".." or symlink shenanigans on either side.
    if (canonicalizePath(marker.path) !== canonical) {
      // Path mismatch — DO NOT consume. Restore the marker so the legitimate
      // owner (whoever's path actually hashes here) can still claim it.
      try {
        renameSync(claimed, target);
      } catch {
        // If restore fails, leave the .consumed-N file for inspection.
      }
      return false;
    }
    const expiresAt = Date.parse(marker.expires_at);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      // Expired — clean up and fail-closed.
      tryUnlink(claimed);
      return false;
    }
    // Valid + non-expired → approval honored. Marker is already moved out of
    // the active set; finalize cleanup.
    tryUnlink(claimed);
    return true;
  } catch {
    // Any uncaught error (canonicalizePath throwing, markerPath throwing,
    // process.pid / Date.now() — none should throw, but defense in depth):
    // fail-closed.
    return false;
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore — already gone or unwritable
  }
}

export async function check(input: HookInput): Promise<HookResult> {
  const file = input.filePath;
  if (!file) return pass();

  if (!isProtectedConfig(file)) return pass();

  if (consumeApproval(file)) {
    return pass();
  }

  const basename = file.split("/").pop() ?? file;
  const matchType = PROTECTED_BASENAMES.has(basename)
    ? "exact basename"
    : "pattern";
  return block(
    SOURCE,
    `BLOCKED: editing config file \`${basename}\`. If you're adding/tightening rules, get user approval. If you're weakening rules to make code pass — fix the code instead. To approve a single edit, run: bun run src/hooks/checks/config-protection-cli.ts approve "${file}" --reason "..."`,
    `matched ${matchType}: ${basename}`,
  );
}

/** Exported for testing. */
export { consumeApproval, isProtectedConfig };
