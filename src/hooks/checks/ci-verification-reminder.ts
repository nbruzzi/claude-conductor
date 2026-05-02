// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER 3 — PostToolUse Bash post-push system-reminder emitter.
 *
 * Fires after every successful `git push` Bash invocation. Emits a literal
 * `<system-reminder>`-shaped warn() instructing the agent to run
 * `gh pr checks --watch` or `gh run watch --exit-status` and include run id +
 * "success" conclusion in any subsequent shipped/merged/landed claim — per
 * ~/CLAUDE.md "After Every Push — CI verification is mandatory".
 *
 * Pairs with TIER 4 (PreToolUse sentinel writer), TIER 2 (Stop verification
 * gate), and TIER-3a (SessionStart auth advisor) per
 * ~/.claude/plans/typed-sleeping-snowglobe.md.
 *
 * Severity: warn-only (canBlock=false). Reminder is informational — the agent
 * decides when to verify (some pushes are intentional non-claims, e.g.
 * publishing branches, intermediate checkpoints). The blocking enforcement is
 * TIER 2 at Stop.
 *
 * Detection: chain-op-split → strip quoted regions → for each segment, test
 *   GIT_PUSH_PATTERN AND not DRY_RUN_PATTERN AND tool_response.exit_code === 0
 * (exit_code reading per session-telemetry-tracker.ts:184-193).
 * ANY matching segment + exit-0 → warn.
 *
 * Kill switches:
 *   - Session-scoped: ~/.claude/.flags/ci-verification-reminder-disabled-<sessionId>
 *   - Global emergency: ~/.claude/.flags/ci-verification-reminder-disabled
 *
 * HOME-per-call (per test-gate.ts:23-26): module-level HOME defeats test
 * isolation; kill-switch path is resolved per check invocation.
 *
 * Detection regex constants are VERBATIM copies from compound-bash-detector
 * for chain-op split + quoted-region strip. Phase-v lift candidate to
 * plugin/bash-parser.ts (per ARCH-8 / B-PR-2 dispositions in the plan audit).
 *
 * Known limitations (documented; will not block merge):
 *   - Multi-remote / tag pushes match same as PR pushes — `git push origin
 *     tag v1.0` and `git push fork main` both trigger the reminder. Accept
 *     noise post-launch; tune via filter on tracked-upstream-with-CI if it
 *     becomes a real issue.
 *   - Pipe-separated commands (`git push | tee`, `git push 2>&1 | grep ...`)
 *     match the push segment and emit the reminder; intent there is usually
 *     output capture, not delivery, but the reminder is still informative.
 *     Accept noise; covered by test fixture for piped pushes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";
import { extractSessionId } from "../session-id.ts";

const SOURCE = "ci-verification-reminder";

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

const REMINDER_TEXT = [
  "── CI Verification Reminder (after git push) ──",
  "",
  "git push completed (exit 0). Per ~/CLAUDE.md After Every Push: VERIFY CI before any 'shipped' / 'merged' / 'landed' / 'deployed' / 'done' claim.",
  "",
  "Run one of:",
  "  gh pr checks <pr> --watch                 # for open PRs",
  "  gh run watch <run-id> --exit-status        # for branch/main pushes",
  "",
  "Then include the run id + 'success' conclusion in your shipped-claim recap.",
].join("\n");

const errorReported = new Set<string>();

function homeFlagsDir(): string {
  return join(process.env["HOME"] ?? "", ".claude", ".flags");
}

function killSwitchPaths(sessionId: string | undefined): {
  session: string | undefined;
  global: string;
} {
  const dir = homeFlagsDir();
  return {
    session:
      sessionId === undefined
        ? undefined
        : join(dir, `${SOURCE}-disabled-${sessionId}`),
    global: join(dir, `${SOURCE}-disabled`),
  };
}

function reportOnce(key: string, msg: string): void {
  if (errorReported.has(key)) return;
  errorReported.add(key);
  console.error(`[${SOURCE}] ${msg}`);
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

function extractExitCode(raw: Record<string, unknown>): number | undefined {
  // Per session-telemetry-tracker.ts:184-193 — accepts either {exit_code: number}
  // or {success: boolean} shapes from tool_response.
  const resp = raw["tool_response"];
  if (typeof resp !== "object" || resp === null) return undefined;
  const rec = resp as Record<string, unknown>;
  const direct = rec["exit_code"];
  if (typeof direct === "number") return direct;
  const success = rec["success"];
  if (typeof success === "boolean") return success ? 0 : 1;
  return undefined;
}

function reminderMessage(sessionId: string | undefined): string {
  const flag =
    sessionId === undefined
      ? "ci-verification-reminder-disabled"
      : `ci-verification-reminder-disabled-${sessionId}`;
  return `${REMINDER_TEXT}\n\nDisable: touch ~/.claude/.flags/${flag}`;
}

export async function check(input: HookInput): Promise<HookResult> {
  if (input.toolName !== "Bash") return pass();
  const command = input.command;
  if (command === undefined || command === "") return pass();

  // Only fire on successful pushes — failed pushes aren't deliveries.
  const exitCode = extractExitCode(input.raw);
  if (exitCode !== 0) return pass();

  const sessionId = extractSessionId(input.raw);

  // Kill switch (session-scoped first if available, then global).
  const ks = killSwitchPaths(sessionId);
  try {
    if (ks.session !== undefined && existsSync(ks.session)) return pass();
    if (existsSync(ks.global)) return pass();
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

  return warn(
    SOURCE,
    reminderMessage(sessionId),
    "git push completed; CI verification reminder emitted",
  );
}

// Test-only exports.
export const INTERNAL = {
  killSwitchPaths,
  homeFlagsDir,
  stripQuoted,
  isRealPushSegment,
  extractExitCode,
  reminderMessage,
  GIT_PUSH_PATTERN,
  DRY_RUN_PATTERN,
};
