// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared presence-failure log — single write path for cross-session
 * coordination failures.
 *
 * Before this module, `session-collision-gate` kept a private
 * `.presence-gate-failures.log` while `session-presence-register` and
 * `session-presence-unregister` only emitted to stderr. That asymmetry
 * hid fail-soft paths: a lock timeout in register could silently skip
 * our heartbeat write, and the peer-side collision gate would then miss
 * the collision entirely — a double fail-soft cascade.
 *
 * This module centralizes the append path. Every presence-related
 * fail-soft writes here, so SessionStart briefing (Slice 4) has a
 * single authoritative source.
 *
 * Atomicity: each event serializes to a single JSONL line ≤ 4096 bytes
 * (POSIX PIPE_BUF on macOS/Linux for regular files opened O_APPEND). A
 * single `write(2)` of ≤ PIPE_BUF bytes is atomic — concurrent writers
 * from different sessions cannot interleave. `appendFileSync` uses the
 * `a` flag which maps to O_APPEND, preserving this guarantee.
 *
 * Lines that would exceed the cap are truncated on `detail` with a
 * sentinel marker. Other fields are short and bounded; only `detail`
 * (error message / stack) can realistically grow.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";

const MAX_LINE_BYTES = 4096;
const TRUNCATION_MARKER = "...[truncated]";

export type PresenceFailureSource =
  | "session-collision-gate"
  | "session-presence-register"
  | "session-presence-unregister"
  | "active-sessions-registry"
  | "channels-identity";

export type PresenceFailureKind =
  | "lock-timeout"
  | "write-failed"
  | "registry-contention"
  | "operator-reset"
  | "unhandled";

export type PresenceFailureEvent = {
  timestamp: string;
  sessionId: string | null;
  source: PresenceFailureSource;
  kind: PresenceFailureKind;
  artifactPath: string | null;
  detail: string;
};

function home(): string {
  return process.env["HOME"] ?? "";
}

export function failureLogPath(): string {
  return join(home(), ".claude", "logs", ".presence-gate-failures.log");
}

/**
 * Replace the current `$HOME` with `~` in a log string. The shared log
 * travels across sessions, may be shipped off-host in a bundle, and is
 * surfaced in the SessionStart briefing (Slice 4). Any text that embeds
 * an absolute path leaks the operator's username and any project-name
 * directory structure under $HOME. This redaction runs at the log write
 * boundary so every caller is protected by default — the P2 backlog item
 * for global homedir redaction now lives here.
 *
 * Two forms of $HOME are redacted: the literal env var AND its realpath,
 * because macOS `/var` → `/private/var` (and similar symlink-prefixed
 * filesystems) means `realpathSync(path)` returns a different string
 * than `HOME` itself. Callers routinely emit realpath-resolved paths
 * (e.g. `artifactPath`) so redaction must cover both. Longer form is
 * replaced first so prefix-overlap can't produce a partial match like
 * `/private~/sub`.
 *
 * Only paths derived from the current $HOME are redacted. Paths outside
 * $HOME are passed through unchanged — they came from elsewhere and
 * their exposure is not caused by our log writes.
 */
export function redactHome(s: string): string {
  const h = home();
  if (h.length === 0) return s;
  let real = h;
  try {
    real = realpathSync(h);
  } catch {
    /* HOME may not exist on disk — fall back to raw value */
  }
  const forms =
    real !== h ? [real, h].sort((a, b) => b.length - a.length) : [h];
  let out = s;
  for (const form of forms) out = out.split(form).join("~");
  return out;
}

function redactEvent(event: PresenceFailureEvent): PresenceFailureEvent {
  return {
    ...event,
    artifactPath:
      event.artifactPath !== null ? redactHome(event.artifactPath) : null,
    detail: redactHome(event.detail),
  };
}

/**
 * Append one presence-failure event. Best-effort — swallows write errors
 * since the caller is already on a failure path and cannot do anything
 * useful with a second failure. Prefer logging *something* over nothing.
 *
 * Path-shaped fields (`artifactPath`, `detail`) are passed through
 * `redactHome` before serialization. Callers that want the raw value
 * should skip the log and use their own channel — this function is the
 * one authoritative write path for the shared log and intentionally
 * does the redaction itself rather than trusting each caller.
 */
export function appendPresenceFailure(event: PresenceFailureEvent): void {
  const line = serializeWithinCap(redactEvent(event));
  try {
    appendFileSync(failureLogPath(), line, "utf-8");
  } catch {
    /* nothing more we can do — caller is already on a failure path */
  }
}

/**
 * Read the most recent N events from the log. Returns oldest→newest
 * within the tail window. Malformed lines are skipped silently — a
 * single bad write must not blind the reader to good events around it.
 *
 * Used by the SessionStart briefing (Slice 4) to surface fail-soft
 * history at the start of a new session.
 */
export function readPresenceFailures(
  limit: number = 20,
): PresenceFailureEvent[] {
  const path = failureLogPath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(-limit);
  const events: PresenceFailureEvent[] = [];
  for (const line of tail) {
    const parsed = parseEvent(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

function serializeWithinCap(event: PresenceFailureEvent): string {
  const serialize = (ev: PresenceFailureEvent): string =>
    `${JSON.stringify(ev)}\n`;
  let line = serialize(event);
  if (Buffer.byteLength(line, "utf-8") <= MAX_LINE_BYTES) return line;

  // Only `detail` can reasonably grow. Truncate it until the full line fits.
  const overhead = Buffer.byteLength(
    serialize({ ...event, detail: "" }),
    "utf-8",
  );
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
  const detailBudget = MAX_LINE_BYTES - overhead - markerBytes;
  const detailSlice =
    detailBudget > 0
      ? Buffer.from(event.detail, "utf-8")
          .subarray(0, detailBudget)
          .toString("utf-8")
      : "";
  line = serialize({ ...event, detail: `${detailSlice}${TRUNCATION_MARKER}` });
  // Final safety clamp — if multibyte boundaries or other oversized fields
  // still push us over, hard-truncate by bytes. Loses JSON validity on the
  // last line, but the reader's parser tolerates malformed lines.
  if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
    return Buffer.from(line, "utf-8")
      .subarray(0, MAX_LINE_BYTES)
      .toString("utf-8");
  }
  return line;
}

function parseEvent(line: string): PresenceFailureEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const timestamp = typeof o["timestamp"] === "string" ? o["timestamp"] : null;
  const sessionId =
    typeof o["sessionId"] === "string"
      ? o["sessionId"]
      : o["sessionId"] === null
        ? null
        : undefined;
  const source = typeof o["source"] === "string" ? o["source"] : null;
  const kind = typeof o["kind"] === "string" ? o["kind"] : null;
  const artifactPath =
    typeof o["artifactPath"] === "string"
      ? o["artifactPath"]
      : o["artifactPath"] === null
        ? null
        : undefined;
  const detail = typeof o["detail"] === "string" ? o["detail"] : null;

  if (timestamp === null || source === null || kind === null || detail === null)
    return null;
  if (sessionId === undefined || artifactPath === undefined) return null;
  if (!isPresenceFailureSource(source) || !isPresenceFailureKind(kind))
    return null;

  return { timestamp, sessionId, source, kind, artifactPath, detail };
}

function isPresenceFailureSource(s: string): s is PresenceFailureSource {
  return (
    s === "session-collision-gate" ||
    s === "session-presence-register" ||
    s === "session-presence-unregister" ||
    s === "active-sessions-registry" ||
    s === "channels-identity"
  );
}

function isPresenceFailureKind(k: string): k is PresenceFailureKind {
  return (
    k === "lock-timeout" ||
    k === "write-failed" ||
    k === "registry-contention" ||
    k === "operator-reset" ||
    k === "unhandled"
  );
}

export const INTERNAL = {
  MAX_LINE_BYTES,
  TRUNCATION_MARKER,
  serializeWithinCap,
  parseEvent,
  redactEvent,
};
