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
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_LINE_BYTES = 4096;
const TRUNCATION_MARKER = "...[truncated]";

/**
 * Single-slot rotation threshold for the shared presence-failure log. Mirrors
 * the `SYNC_LOG_MAX_BYTES` (1 MiB) convention from
 * `~/claude-conductor/src/hooks/checks/sync-common.ts:21-69`. The current log
 * baseline is ~28 KB/day across 5 known event kinds; Phase 1 telemetry from
 * the worktree-provisioner race-fix slice will add ~5-15 events per
 * SessionStart, plus high-frequency reap events from `tryReapHeartbeat`. At
 * 1 MiB the file can hold months of routine activity AND survives a
 * multi-week failure-loop without growing unbounded. SessionStart's
 * `readPresenceFailures` reads the whole file — keeping it bounded preserves
 * sub-100ms briefing reads. Operators who want deeper history should ship
 * the `.1` archive to durable storage between sessions.
 */
const PRESENCE_LOG_MAX_BYTES = 1_048_576;

export type PresenceFailureSource =
  | "session-collision-gate"
  | "session-presence-register"
  | "session-presence-unregister"
  | "active-sessions-registry"
  | "channels-identity"
  | "dispatcher"
  | "session-reconcile-boot";

export type PresenceFailureKind =
  | "lock-timeout"
  | "write-failed"
  | "registry-contention"
  | "operator-reset"
  | "unhandled"
  | "clock-skew"
  | "kill-switch"
  // Phase 3 Slice 2 — substrate-level extensions (per Bravo C1: lands in
  // Commit 2 alongside active-sessions extensions so Commit 3's resolver
  // tests T3 (deprecation breadcrumb) and T7 (sentinel-corrupt) can fire).
  | "deprecation"
  | "sentinel-corrupt"
  // Phase 3 Slice 2 — worktree lifecycle (consumed by provisioner / gc /
  // cleanup hooks landing in Commit 4).
  | "worktree-provision-failed"
  | "worktree-gc-reaped"
  | "worktree-gc-liveness-fallback-fired"
  | "worktree-cleanup-failed"
  | "worktree-cleanup-incomplete"
  // Phase 3 Slice 2 follow-up — provisioner observability (provisionWorktree
  // returned ok but post-create state is incomplete: stat-errno, realpath
  // mismatch with canonical, or sentinel-readback null). Mirrors the
  // `<lifecycle-stage>-incomplete` naming established by `worktree-cleanup-
  // incomplete`. Consumed by the provisioner hook only.
  | "worktree-provision-incomplete"
  // P0 substrate canary (backlog L:892, 2026-05-17) — node_modules
  // symlink-clone failed during provisioner post-creation. Surfaced when
  // `linkCanonicalNodeModules` returns `kind: "error"` (operator-collision
  // at <worktree>/node_modules, wrong-target stale symlink, or symlinkSync
  // throw). Consumed by the provisioner hook only.
  | "worktree-deps-link-failed"
  // P2 — `claimIdentityNamed` audit-trail failure. Per plan
  // giggly-bouncing-spark.md §3 (RE-3 closure): when a takeover succeeds
  // (metadata committed, sentinel renamed) but the post-lock `appendMessage`
  // audit-trail line fails, write this breadcrumb so the forensic gap is
  // observable to operators via the session-active registry rather than
  // silent. Source: `channels-identity`.
  | "takeover-audit-failed"
  // sibling-coord-gate-awareness plan v2 Lane C FIND-6 (Bravo) — forensic
  // signal when `teammate-idle-reminder` suppresses a reminder because the
  // peer's most-recent message on the channel is a standby-state kind
  // (`standby` / `roger` / `out` / `digest` per RE-5 fold). The breadcrumb
  // is the only forensic record if standby-suppression mis-engages (e.g.,
  // peer genuinely crashed AFTER posting a standby kind); without it,
  // operators have no way to distinguish "reminder correctly suppressed"
  // from "reminder mistakenly suppressed." Source: `channels-identity`.
  | "standby-suppressed"
  // Slice 7 A2 — worktree-provisioner race-fix Phase 1 telemetry (plan
  // v1.4 = v1.3's 6 instrumentation points + new Point 7 for
  // `resetArtifactRegistry` rmSync-bypass). Consumed exclusively by
  // `active-sessions/index.ts`. Per plan v1.3 §Phase 2 trigger criteria,
  // pattern of these firings discriminates Branch A (merge-broke) vs
  // B (opportunistic-reap LIKELY) vs C (provisioner-incomplete) vs
  // D (telemetry-blind-spot). 14-day data-collection ceiling.
  | "sentinel-dotfilesroot-set"
  | "sentinel-dotfilesroot-cleared"
  | "session-unregistered"
  | "heartbeat-no-dotfilesroot-on-existing"
  | "heartbeat-reaped"
  | "heartbeat-removed"
  | "artifact-reset";

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
 *
 * Single-slot rotation: before appending, stat the current log; if it's at
 * or over `PRESENCE_LOG_MAX_BYTES`, rename to `<path>.1` (overwriting any
 * prior `.1`) and let the append create a fresh file. This keeps the file
 * bounded at roughly `maxBytes + one entry` peak. Rotation errors other
 * than ENOENT (log doesn't exist yet) are non-fatal: stderr'd and the
 * append still runs. The append itself remains best-effort under the outer
 * catch — log-write failures must never mask the original failure path.
 *
 * Mirrors `appendLogWithRotation` in `sync-common.ts:47-74`. Implemented
 * inline rather than imported to avoid a `shared/` → `hooks/checks/` layer
 * inversion. When a third consumer of the rotation pattern appears, lift
 * the helper to `shared/log-rotation.ts` per
 * `feedback-partial-v2-anticipation-primitives.md`.
 *
 * Race window (per RE-2 audit fold): the `statSync → renameSync` composition
 * is NOT atomic. Two concurrent appenders crossing the threshold within the
 * same instant can both observe `size >= MAX_BYTES` and both call
 * `renameSync`. POSIX `rename(2)` is atomic per-call, but the second rename
 * clobbers the first writer's `.log.1` archive. Realistic likelihood is low
 * (per-line writes via O_APPEND are atomic ≤ PIPE_BUF; only the rotation
 * boundary races). Acceptable per single-slot retention contract — operators
 * who need durable history ship the archive between sessions. Sibling concern
 * to `sync-common.ts:53-57` which has the identical race documented or not.
 */
export function appendPresenceFailure(event: PresenceFailureEvent): void {
  const line = serializeWithinCap(redactEvent(event));
  const path = failureLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      const st = statSync(path);
      if (st.size >= PRESENCE_LOG_MAX_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch (err: unknown) {
      const code =
        err instanceof Error && "code" in err
          ? String((err as { code: unknown }).code ?? "")
          : "";
      // ENOENT = log doesn't exist yet, first append will create it. All good.
      // Other errors (EACCES on stat, rename target on a different device,
      // etc.) shouldn't block the append — log through to stderr and keep
      // going. Mirrors the sync-common.ts non-fatal-rotation contract.
      if (code !== "ENOENT") {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[presence-failure-log] log rotation check failed (${path}): ${msg}`,
        );
      }
    }
    appendFileSync(path, line, "utf-8");
  } catch (err: unknown) {
    // Outer catch: preserves best-effort contract (caller is on a failure path
    // and cannot do anything useful with a second failure). RE-3 audit fold:
    // surface the failure to stderr so silent data loss (e.g., disk-full
    // ENOSPC AFTER a successful rotation rename) is observable to operators.
    // Stderr-only — never throws back to the caller.
    const code =
      err instanceof Error && "code" in err
        ? String((err as { code: unknown }).code ?? "")
        : "";
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[presence-failure-log] append failed (${path}, errno=${code || "unknown"}): ${msg}`,
    );
  }
}

/**
 * Read the most recent N events from the log. Returns oldest→newest
 * within the tail window. Malformed lines are skipped silently — a
 * single bad write must not blind the reader to good events around it.
 *
 * Used by the SessionStart briefing (Slice 4) to surface fail-soft
 * history at the start of a new session.
 *
 * Reads BOTH `<path>.1` (rotated archive, oldest) AND `<path>` (current,
 * newest) and concatenates oldest→newest before tailing. Per RE-1 audit
 * fold: rotation must not silently invalidate the operator-promise that
 * kill-switch + structural-failure events are visible at next session-
 * start. With single-slot rotation each file is bounded at 1 MiB, so
 * reading both is cheap (worst case ~2 MiB total). Lines outside the
 * tail-window are filtered after concatenation, so the limit semantic is
 * preserved across the rotation boundary.
 */
export function readPresenceFailures(
  limit: number = 20,
): PresenceFailureEvent[] {
  const path = failureLogPath();
  const archivePath = `${path}.1`;
  const lines: string[] = [];
  // Order: archive (older) first, current (newer) second — preserves
  // chronological oldest→newest contract on the concatenated stream.
  for (const readPath of [archivePath, path]) {
    if (!existsSync(readPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(readPath, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.length > 0) lines.push(line);
    }
  }
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
    s === "channels-identity" ||
    s === "dispatcher" ||
    s === "session-reconcile-boot"
  );
}

function isPresenceFailureKind(k: string): k is PresenceFailureKind {
  return (
    k === "lock-timeout" ||
    k === "write-failed" ||
    k === "registry-contention" ||
    k === "operator-reset" ||
    k === "unhandled" ||
    k === "clock-skew" ||
    k === "kill-switch" ||
    // Phase 3 Slice 2 — substrate-level extensions (Bravo C1).
    k === "deprecation" ||
    k === "sentinel-corrupt" ||
    // Phase 3 Slice 2 — worktree lifecycle.
    k === "worktree-provision-failed" ||
    k === "worktree-gc-reaped" ||
    k === "worktree-gc-liveness-fallback-fired" ||
    k === "worktree-cleanup-failed" ||
    k === "worktree-cleanup-incomplete" ||
    k === "worktree-provision-incomplete" ||
    // P0 substrate canary (backlog L:892, 2026-05-17) — node_modules
    // symlink-clone failed during provisioner post-creation.
    k === "worktree-deps-link-failed" ||
    k === "takeover-audit-failed" ||
    // sibling-coord-gate-awareness Lane C FIND-6 (Bravo).
    k === "standby-suppressed" ||
    // Slice 7 A2 — worktree-provisioner race-fix Phase 1 telemetry (plan v1.4).
    k === "sentinel-dotfilesroot-set" ||
    k === "sentinel-dotfilesroot-cleared" ||
    k === "session-unregistered" ||
    k === "heartbeat-no-dotfilesroot-on-existing" ||
    k === "heartbeat-reaped" ||
    k === "heartbeat-removed" ||
    k === "artifact-reset"
  );
}

export const INTERNAL = {
  MAX_LINE_BYTES,
  PRESENCE_LOG_MAX_BYTES,
  TRUNCATION_MARKER,
  serializeWithinCap,
  parseEvent,
  redactEvent,
};
