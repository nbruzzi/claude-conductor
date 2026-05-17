// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Canonical session identity helpers.
 *
 * Claude Code's hook input carries `session_id` on the top-level raw payload.
 * Use these helpers instead of inferring session identity from session-file
 * mtimes (mtimes alias across concurrent sessions) or from `process.ppid`
 * (unstable across subprocess-spawned hook invocations).
 */

import { isValidSessionId } from "../active-sessions/index.ts";
import type { HookInput } from "./types.ts";

/**
 * Extract the raw `session_id` field without validating it.
 *
 * Returns the string verbatim if present + non-empty; otherwise undefined.
 * Does NOT enforce `isValidSessionId` — a value like `"../etc/passwd"` would
 * pass this check unchanged and could escape any path constructed from it.
 *
 * @deprecated for end-consumers — prefer `extractValidSessionId` which
 *   composes this extraction with `isValidSessionId` so the path-traversal
 *   class is rejected at the API boundary instead of relying on every caller
 *   remembering to gate downstream. The raw form survives for tests that
 *   exercise extraction logic independently of validation (see
 *   test/hooks/session-id.test.ts).
 */
export function extractSessionId(
  raw: Record<string, unknown>,
): string | undefined {
  const v = raw["session_id"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Extract + validate the `session_id` field — safe-by-default.
 *
 * Wraps `extractSessionId` with `isValidSessionId`. Returns the validated
 * string on success, or `undefined` when the field is missing, non-string,
 * empty, or fails the strict-id regex.
 *
 * Observability: emits a stderr breadcrumb on the "extracted-but-rejected"
 * path so silent validation drops are visible. The bare missing-field case
 * stays silent (normal for sessionless tool calls). Mirrors
 * `resolveSessionIdOrNull`'s `logRejected` convention; the raw id is never
 * logged — only its length — to avoid leaking ids into aggregators.
 *
 * Use this from any new consumer; the raw `extractSessionId` exists only for
 * test infrastructure that asserts extraction-only behavior.
 */
export function extractValidSessionId(
  raw: Record<string, unknown>,
): string | undefined {
  const extracted = extractSessionId(raw);
  if (extracted === undefined) return undefined;
  if (isValidSessionId(extracted)) return extracted;
  logRejected("raw.session_id", extracted);
  return undefined;
}

/**
 * Resolve a validated session id from hook input, with env override.
 *
 * Resolution order:
 *   1. `CLAUDE_SESSION_ID` environment variable (tests, manual runs)
 *   2. `session_id` field on hook input payload
 *
 * Both paths are validated via `isValidSessionId` — a non-conforming id
 * returns null so callers can fail-open.
 *
 * Observability: when a session id is PROVIDED but rejected by validation,
 * we emit a stderr line so silent drops are visible to operators. Missing
 * session ids are normal (test harnesses, sessionless tool calls) and stay
 * silent. The raw id is not logged — only its length — to avoid leaking
 * ids into log aggregators.
 */
export function resolveSessionIdOrNull(input: HookInput): string | null {
  const envOverride = process.env["CLAUDE_SESSION_ID"];
  if (envOverride && envOverride.length > 0) {
    if (isValidSessionId(envOverride)) return envOverride;
    logRejected("CLAUDE_SESSION_ID env", envOverride);
    return null;
  }
  const raw = extractSessionId(input.raw) ?? null;
  if (raw === null) return null;
  if (isValidSessionId(raw)) return raw;
  logRejected("hook input session_id", raw);
  return null;
}

function logRejected(source: string, id: string): void {
  console.error(
    `[session-id] ${source} rejected by isValidSessionId (len=${id.length})`,
  );
}
