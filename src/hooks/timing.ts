// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Per-check timing telemetry emitter.
 *
 * Appends one JSONL row to ~/.claude/hook-timing.jsonl per check execution.
 * Rolling append-only log; rotation/windowing is out of scope for Phase 0 —
 * consumer tools are expected to read and filter by ts.
 *
 * Fail-open: any IO error → silent no-op. This is observability data, never
 * a blocking concern in the hook pipeline.
 *
 * Schema:
 *   ts          ISO-8601 timestamp of record emission
 *   session_id  from HookInput.raw.session_id when present; omitted otherwise
 *   event       hook event name (pre-tool-use, post-tool-use, stop, ...)
 *   check_name  CheckDecl.name (e.g., "destructive-cmd", "pending-threads-briefing")
 *   tool_name   HookInput.toolName when present; omitted otherwise
 *   ms          elapsed milliseconds (2 decimal places)
 *   exit_code   check result exitCode; undefined/omitted when the check crashed
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidSessionId } from "../active-sessions/index.ts";
import { extractSessionId } from "./session-id.ts";

function logPath(): string {
  return (
    process.env["HOOK_TIMING_LOG_PATH"] ??
    join(homedir(), ".claude", "hook-timing.jsonl")
  );
}

export type TimingRecord = {
  ts: string;
  session_id?: string;
  event: string;
  check_name: string;
  tool_name?: string;
  ms: number;
  exit_code?: number;
};

export function recordCheckTiming(
  rawInput: Record<string, unknown>,
  event: string,
  checkName: string,
  toolName: string | undefined,
  ms: number,
  exitCode: number | undefined,
): void {
  try {
    const record: TimingRecord = {
      ts: new Date().toISOString(),
      event,
      check_name: checkName,
      ms: Math.round(ms * 100) / 100,
    };
    // Defense-in-depth: session-id is written verbatim into a JSONL log line.
    // Gate via isValidSessionId to reject path-traversal AND log-injection
    // (newlines/CR would corrupt the JSONL parser on read). Sub-step 0.10 RE-2.
    const sessionId = extractSessionId(rawInput);
    if (sessionId && isValidSessionId(sessionId)) record.session_id = sessionId;
    if (toolName) record.tool_name = toolName;
    if (exitCode !== undefined) record.exit_code = exitCode;

    appendFileSync(logPath(), `${JSON.stringify(record)}\n`, "utf-8");
  } catch {
    // Fail-open: telemetry must never break the hook pipeline.
  }
}
