// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared types for the Claude Code hook dispatcher.
 */

/** Available hook profiles, from least to most strict. */
export type HookProfile = "minimal" | "standard" | "strict";

/** Dispatcher-injected state — typed, never from stdin. */
export type DispatchContext = {
  verbose: boolean;
  isolateCheck?: string;
  preserveChecks?: string[];
  profileDisabled?: string[];
  profile?: HookProfile;
};

/** Default dispatch context (no flags active). */
export const DEFAULT_DISPATCH: DispatchContext = { verbose: false };

/** Parsed hook input from Claude Code's stdin JSON. */
export type HookInput = {
  /** The tool being invoked (e.g., "Bash", "Edit", "Write"). */
  toolName: string | undefined;
  /** File path from tool_input.file_path. */
  filePath: string | undefined;
  /** Command string from tool_input.command. */
  command: string | undefined;
  /** Working directory. */
  cwd: string | undefined;
  /** Path to session transcript JSONL — present on Stop/SubagentStop hook inputs. */
  transcriptPath: string | undefined;
  /** Full parsed JSON for checks that need non-standard fields. */
  raw: Record<string, unknown>;
  /** Dispatcher-injected state (flags, profile, isolation). Never from stdin. */
  dispatch: DispatchContext;
};

/**
 * Result returned by a check function.
 *
 * Convention: Handlers that aggregate multiple checks (post-tool-use, stop,
 * session-start) label each check's output internally and return source: ""
 * so the dispatcher doesn't double-label. Single-check results use a
 * non-empty source so the dispatcher labels them.
 */
export type HookResult = {
  /** 0 = allow, 2 = hard-block. */
  exitCode: number;
  /** Output shown to Claude/user. Dispatcher prepends [source] label. */
  stdout: string;
  /** Label identifying which check produced this result. */
  source: string;
  /** What specifically triggered this result (shown in --verbose). */
  detail?: string;
};

/** Hook event types that the dispatcher routes. Runtime array is the source
 * of truth; the type derives from it so add/remove only happens in one place. */
export const HOOK_EVENTS = [
  "pre-tool-use",
  "post-tool-use",
  "stop",
  "session-start",
  "user-prompt-submit",
] as const satisfies readonly string[];

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Handler function signature. */
export type HookHandler = (input: HookInput) => Promise<HookResult>;

/** Check function signature — same as handler but semantically a single check. */
export type CheckFn = (input: HookInput) => Promise<HookResult>;

/** Create a passing result (exit 0, no output). */
export function pass(): HookResult {
  return { exitCode: 0, stdout: "", source: "" };
}

/** Create a warning result (exit 0, with message). */
export function warn(
  source: string,
  message: string,
  detail?: string,
): HookResult {
  return {
    exitCode: 0,
    stdout: message,
    source,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** Create a blocking result (exit 2, with message). */
export function block(
  source: string,
  message: string,
  detail?: string,
): HookResult {
  return {
    exitCode: 2,
    stdout: message,
    source,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Determine if a named check should be skipped.
 *
 * Composes two independent skip reasons:
 * 1. Profile filtering — the active profile doesn't include this check.
 * 2. Check isolation — --check=NAME targets a different check (with blocking
 *    checks preserved via preserveChecks for security).
 *
 * Profile filtering is checked first and takes precedence: a check disabled by
 * the profile is skipped even if --check targets it directly.
 */
export function shouldSkip(input: HookInput, checkName: string): boolean {
  if (isDisabledByProfile(input, checkName)) return true;
  if (isExcludedByIsolation(input, checkName)) return true;
  return false;
}

/** Check is not in the active profile. */
function isDisabledByProfile(input: HookInput, checkName: string): boolean {
  const disabled = input.dispatch.profileDisabled;
  if (!disabled || disabled.length === 0) return false;
  if (!disabled.includes(checkName)) return false;
  verboseLog(input, `  [${checkName}] disabled by profile — skipping`);
  return true;
}

/** --check=NAME isolation: skip unless this check is the target or is preserved. */
function isExcludedByIsolation(input: HookInput, checkName: string): boolean {
  const isolate = input.dispatch.isolateCheck;
  if (!isolate) return false;

  if (isolate === checkName) {
    verboseLog(input, `  [${checkName}] targeted — running`);
    return false;
  }

  const preserved = input.dispatch.preserveChecks;
  if (preserved && preserved.includes(checkName)) {
    verboseLog(input, `  [${checkName}] preserved (blocking) — running`);
    return false;
  }

  verboseLog(input, `  [${checkName}] isolated — skipping`);
  return true;
}

/** Log to stderr when --verbose is active. */
export function verboseLog(input: HookInput, message: string): void {
  if (input.dispatch.verbose) {
    console.error(message);
  }
}

/** Label a check result with its source prefix. */
export function labelResult(result: HookResult): string {
  return result.source ? `[${result.source}] ${result.stdout}` : result.stdout;
}

/**
 * Exhaustiveness helper. Place in the `default:` branch of a switch over a
 * discriminated union — compilation fails when a new variant is added without
 * a corresponding case arm.
 */
export function assertNever(v: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(v)}`);
}
