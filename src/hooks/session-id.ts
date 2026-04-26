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

export function extractSessionId(
  raw: Record<string, unknown>,
): string | undefined {
  const v = raw["session_id"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
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
