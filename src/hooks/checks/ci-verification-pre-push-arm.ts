// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER 4 — PreToolUse Bash sentinel writer for CI verification cycle.
 *
 * On detection of a real-shape `git push` Bash command at PreToolUse, write a
 * sentinel JSON file at `~/.claude/.flags/ci-verification-armed-<session>-<ts>.json`
 * carrying { push_ts, command_preview, branchHint?, sessionId, claimed: false,
 * evidenced: false }. Establishes plugin-owned ground truth for "did push happen
 * in this session" — independent of Anthropic transcript schema (per RE finding
 * #1 schema-drift critical, surfaced in the TIER 2/3 plan audit).
 *
 * Runs at PreToolUse — BEFORE the push executes. Sentinel write never blocks the
 * push (canBlock=false, returns pass() always; failure modes fail-OPEN with a
 * one-time stderr breadcrumb).
 *
 * TIER 2 (Stop) reads these sentinels for push detection and writes back
 * claimed/evidenced flags during transcript scan. TIER 4 only writes; TIER 2
 * owns mutation + cleanup discipline (Stop-pass GC, SessionEnd reaper, >24h
 * mtime-GC at next SessionStart).
 *
 * Kill switch: `~/.claude/.flags/ci-verification-pre-push-arm-disabled-<sessionId>`
 *   - touch  ~/.claude/.flags/ci-verification-pre-push-arm-disabled-<sessionId>  (per-session)
 *   - delete to re-enable
 * Global emergency: `~/.claude/.flags/ci-verification-pre-push-arm-disabled`
 *   - touch  ~/.claude/.flags/ci-verification-pre-push-arm-disabled              (across-all-sessions)
 *   - delete to re-enable
 *
 * HOME-per-call pattern (per test-gate.ts:23-26): module-level HOME defeats test
 * isolation — kill-switch + sentinel paths are resolved per call.
 *
 * Detection regex constants are VERBATIM copies from compound-bash-detector
 * for chain-op split + quoted-region strip. Phase-v lift candidate to
 * plugin/bash-parser.ts (per ARCH-8 / B-PR-2 dispositions in the plan audit).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HookInput, HookResult } from "../types.ts";
import { pass } from "../types.ts";
import { extractSessionId } from "../session-id.ts";

const SOURCE = "ci-verification-pre-push-arm";

// LIFTED-FROM: ~/.claude-dotfiles/src/hooks/checks/compound-bash-detector.ts:65-69
// Phase-v lift candidate: consolidate verbatim regex constants in plugin/bash-parser.ts
// per plan decisions ARCH-8 + B-PR-2.
const SINGLE_QUOTED = /'[^']*'/g;
const DOUBLE_QUOTED = /"(?:\\.|[^"\\])*"/g;
const ANSI_C_QUOTED = /\$'(?:\\.|[^'\\])*'/g;
const COMMENT_LINE = /(^|\s)#[^\n]*/g;

const CHAIN_SPLIT = /\s*(?:;|&&|\|\|)\s*/u;
const GIT_PUSH_PATTERN =
  /(^|\s)git(?:\s+(?:-c\s+\S+|--?[A-Za-z0-9-]+(?:=\S*)?))*\s+push(\s|$)/u;
const DRY_RUN_PATTERN = /(^|\s)(?:--dry-run|-n)(\s|$)/u;
const BRANCH_HINT =
  /\bgit\s+push(?:\s+(?:--?\S+|-c\s+\S+))*\s+(\S+)(?:\s+(\S+))?/u;

const errorReported = new Set<string>();

function homeFlagsDir(): string {
  return join(process.env["HOME"] ?? "", ".claude", ".flags");
}

function killSwitchPaths(sessionId: string): {
  session: string;
  global: string;
} {
  const dir = homeFlagsDir();
  return {
    session: join(dir, `${SOURCE}-disabled-${sessionId}`),
    global: join(dir, `${SOURCE}-disabled`),
  };
}

function sentinelPath(sessionId: string, pushTs: string): string {
  // Filesystem-safe timestamp (replace `:` and `.` for cross-platform safety).
  const safeTs = pushTs.replace(/[:.]/gu, "-");
  return join(
    homeFlagsDir(),
    `ci-verification-armed-${sessionId}-${safeTs}.json`,
  );
}

function stripQuoted(s: string): string {
  return s
    .replace(SINGLE_QUOTED, "")
    .replace(DOUBLE_QUOTED, "")
    .replace(ANSI_C_QUOTED, "")
    .replace(COMMENT_LINE, "");
}

function isRealPushSegment(segment: string): boolean {
  if (!GIT_PUSH_PATTERN.test(segment)) return false;
  if (DRY_RUN_PATTERN.test(segment)) return false;
  return true;
}

function extractBranchHint(segment: string): string | undefined {
  const m = BRANCH_HINT.exec(segment);
  if (!m) return undefined;
  // Two-positional `git push <remote> <branch>` → m[2] is the branch.
  // One-positional `git push <branch>` (no explicit remote) → m[1] is the branch.
  return m[2] ?? m[1];
}

function reportOnce(key: string, msg: string): void {
  if (errorReported.has(key)) return;
  errorReported.add(key);
  console.error(`[${SOURCE}] ${msg}`);
}

export async function check(input: HookInput): Promise<HookResult> {
  if (input.toolName !== "Bash") return pass();
  const command = input.command;
  if (command === undefined || command === "") return pass();

  const sessionId = extractSessionId(input.raw);
  if (sessionId === undefined) {
    // Without a session id we cannot scope the sentinel — silently pass.
    // No breadcrumb because sessionless invocations are normal in test/probe contexts.
    return pass();
  }

  // Kill switch (session-scoped first, then global emergency).
  const ks = killSwitchPaths(sessionId);
  try {
    if (existsSync(ks.session) || existsSync(ks.global)) return pass();
  } catch (err) {
    reportOnce(
      "kill-switch-stat",
      `kill-switch stat failed: ${(err as Error).message}`,
    );
    return pass();
  }

  // Detect: chain-op-split → strip quoted → look for a real-push segment.
  const stripped = stripQuoted(command);
  const segments = stripped.split(CHAIN_SPLIT);
  const pushSegment = segments.find(isRealPushSegment);
  if (pushSegment === undefined) return pass();

  // Build sentinel payload.
  const pushTs = new Date().toISOString();
  const branchHint = extractBranchHint(pushSegment);
  const sentinelData: {
    push_ts: string;
    command_preview: string;
    sessionId: string;
    claimed: boolean;
    evidenced: boolean;
    branchHint?: string;
  } = {
    push_ts: pushTs,
    command_preview:
      command.length > 200 ? `${command.substring(0, 200)}…` : command,
    sessionId,
    claimed: false,
    evidenced: false,
    ...(branchHint !== undefined ? { branchHint } : {}),
  };

  // Write sentinel; fail-OPEN on any I/O error.
  try {
    mkdirSync(homeFlagsDir(), { recursive: true });
    writeFileSync(
      sentinelPath(sessionId, pushTs),
      JSON.stringify(sentinelData),
    );
  } catch (err) {
    reportOnce(
      "sentinel-write",
      `sentinel write failed: ${(err as Error).message}`,
    );
  }

  return pass();
}

// Test-only exports for fixture-driven unit tests.
export const INTERNAL = {
  killSwitchPaths,
  sentinelPath,
  stripQuoted,
  isRealPushSegment,
  extractBranchHint,
  homeFlagsDir,
  GIT_PUSH_PATTERN,
  DRY_RUN_PATTERN,
};
