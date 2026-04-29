// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 7 hook — surface idle peers on UserPromptSubmit so operators
 * discover stuck/crashed siblings without manual `peers` queries.
 *
 * Phase 1 shipped a no-op stub to satisfy `assertWiringComplete` across the
 * cross-edge. Phase 2 (this implementation) consumes the substrate Slice 5
 * left behind (`getIdentityContextForSession` in `channels/identity-context`)
 * + Slice 7's own substrate extension (`readHeartbeatBody` reading the
 * peer-clock body that Slice 7's `touchHeartbeat` writes alongside mtime).
 *
 * For each channel where this session has a NATO-identity claim, the hook:
 *   1. Iterates peers in the channel's metadata.identities.
 *   2. Skips peers whose `heartbeat_mtime_ms` is fresh (≤ idle threshold).
 *   3. For each idle-by-mtime peer, reads `readHeartbeatBody` (the peer's
 *      `Date.now()` written into the body at the same write instant the
 *      kernel set mtime). If `|mtime - body_ts| > 5 min` → clock-skew
 *      detected → suppress the reminder + log `kind: "clock-skew"`
 *      breadcrumb. Body=null (legacy peer / corrupt) skips skew check.
 *   4. Honors a per-(channel, observer-session) rate-limit cursor stored
 *      at `<channel-dir>/idle-emit/<sid>.json`. Each peer letter has an
 *      independent ISO-timestamp; emission is suppressed for 30 minutes
 *      after the last emission.
 *   5. Emits one `[teammate-idle]` system-reminder block per still-eligible
 *      idle peer with the canonical `close-peer --force` recovery hint.
 *
 * Failure-mode class: **fail-open + breadcrumb**. Outer try/catch ensures
 * a thrown helper never breaks the UserPromptSubmit chain. IO failures on
 * cursor read/write are breadcrumb'd via `appendPresenceFailure` (kind
 * `write-failed`), and the hook continues.
 *
 * Plan: ~/.claude/plans/stateful-munching-volcano.md REV 2 §B.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { isValidSessionId } from "../../active-sessions/index.ts";
import {
  getIdentityContextForSession,
  type IdentityContext,
  type IdentityPeer,
} from "../../channels/identity-context.ts";
import { readHeartbeatBody, resolveChannelsDir } from "../../channels/index.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { extractSessionId } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "teammate-idle-reminder";
const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const RATE_LIMIT_MS = 30 * 60 * 1000;
const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;
const CURSOR_DIR_NAME = "idle-emit";
const ENV_VAR_IDLE_THRESHOLD = "CLAUDE_CONDUCTOR_IDLE_THRESHOLD_MS";

/** Per-(channel, observer-session) rate-limit cursor. Key = peer letter, value = ISO timestamp of last emission. */
type EmitCursor = Record<string, string>;

function cursorPath(channelId: string, sessionId: string): string {
  return join(
    resolveChannelsDir(),
    channelId,
    CURSOR_DIR_NAME,
    `${sessionId}.json`,
  );
}

/**
 * Strict cursor shape validator. Rejects non-objects, arrays, non-string
 * values, and unparseable timestamp strings. Per audit TS-4 — the rate-limit
 * gate reads `cursor[peer.identity]` then `Date.parse(it)`; a bogus value
 * silently disables rate-limit for that peer (every prompt floods).
 */
function isValidCursor(parsed: unknown): parsed is EmitCursor {
  if (typeof parsed !== "object" || parsed === null) return false;
  if (Array.isArray(parsed)) return false;
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
    if (!Number.isFinite(Date.parse(v))) return false;
  }
  return true;
}

function readCursor(channelId: string, sessionId: string): EmitCursor {
  const path = cursorPath(channelId, sessionId);
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor parse failed (treating as empty)`,
    });
    return {};
  }
  if (!isValidCursor(parsed)) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor shape invalid (treating as empty)`,
    });
    return {};
  }
  return parsed;
}

/**
 * Atomic write via tmp + rename. POSIX rename is atomic on the same
 * filesystem, so observers either see the previous full cursor or the new
 * full cursor — never a partial JSON. Tmp suffix includes pid + a random
 * id so concurrent same-pid invocations don't collide on the tmp path
 * before rename (RE-NEW-1 verification finding).
 */
function writeCursor(
  channelId: string,
  sessionId: string,
  cursor: EmitCursor,
): void {
  const path = cursorPath(channelId, sessionId);
  const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(cursor)}\n`, "utf-8");
    renameSync(tmp, path);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Resolve the idle-threshold from env, falling back to the 5-minute
 * default. Defense-in-depth syntactic guard rejects scientific notation,
 * decimals, and signed values before `Number()` would silently accept
 * them; operator intent for a ms threshold is always plain digits.
 */
function readIdleThresholdMs(): number {
  const raw = process.env[ENV_VAR_IDLE_THRESHOLD];
  if (raw === undefined) return DEFAULT_IDLE_THRESHOLD_MS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_IDLE_THRESHOLD_MS;
  if (!/^\d+$/.test(trimmed)) return DEFAULT_IDLE_THRESHOLD_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return DEFAULT_IDLE_THRESHOLD_MS;
  if (!Number.isInteger(n)) return DEFAULT_IDLE_THRESHOLD_MS;
  if (n <= 0) return DEFAULT_IDLE_THRESHOLD_MS;
  return n;
}

function formatRelativeTime(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** Format a per-peer idle reminder block per parent plan REV 2.1 §Hook message templates. */
function formatPeerBlock(
  channelId: string,
  peer: IdentityPeer,
  idleMs: number,
): string {
  const rel = formatRelativeTime(idleMs);
  return [
    `[teammate-idle] Peer ${peer.identity} on channel ${channelId} is idle (last heartbeat ${rel} ago, role=${peer.role}).`,
    `Recovery options:`,
    `  claude-conductor channels close-peer ${channelId} --peer ${peer.identity}`,
    `  claude-conductor channels close-peer ${channelId} --peer ${peer.identity} --force  (override staleness gate)`,
  ].join("\n");
}

export async function check(input: HookInput): Promise<HookResult> {
  try {
    const sessionId = extractSessionId(input.raw);
    if (sessionId === undefined || !isValidSessionId(sessionId)) return pass();

    const contexts: readonly IdentityContext[] =
      getIdentityContextForSession(sessionId);
    if (contexts.length === 0) return pass();

    const idleThreshold = readIdleThresholdMs();
    const now = Date.now();
    const blocks: string[] = [];

    for (const ctx of contexts) {
      const cursor: EmitCursor = { ...readCursor(ctx.channelId, sessionId) };
      let cursorMutated = false;

      for (const peer of ctx.peers) {
        // Idle gate (mtime-based, primary signal).
        if (peer.heartbeat_mtime_ms === null) continue;
        const idleMs = now - peer.heartbeat_mtime_ms;
        if (idleMs <= idleThreshold) continue;

        // Clock-skew gate. Compare body-ts against mtime (REV 2 RE-1 fix —
        // both are set at the SAME write instant by the peer; a divergence
        // means the peer's user-space clock and filesystem mtime-stamp clock
        // disagree, so neither timestamp can be fully trusted).
        const bodyTs = readHeartbeatBody(ctx.channelId, peer.session_id);
        if (
          bodyTs !== null &&
          Math.abs(peer.heartbeat_mtime_ms - bodyTs) > CLOCK_SKEW_THRESHOLD_MS
        ) {
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "clock-skew",
            sessionId,
            artifactPath: ctx.channelId,
            detail: `${SOURCE}: peer ${peer.identity} body_ts=${bodyTs} mtime=${peer.heartbeat_mtime_ms} delta=${Math.abs(peer.heartbeat_mtime_ms - bodyTs)}ms`,
          });
          continue;
        }

        // Rate-limit gate (per-peer per RATE_LIMIT_MS).
        const lastEmit =
          peer.identity in cursor ? cursor[peer.identity] : undefined;
        if (lastEmit !== undefined) {
          const lastMs = Date.parse(lastEmit);
          if (Number.isFinite(lastMs) && now - lastMs < RATE_LIMIT_MS) continue;
        }

        blocks.push(formatPeerBlock(ctx.channelId, peer, idleMs));
        cursor[peer.identity] = new Date(now).toISOString();
        cursorMutated = true;
      }

      if (cursorMutated) writeCursor(ctx.channelId, sessionId, cursor);
    }

    if (blocks.length === 0) return pass();
    return warn(SOURCE, ["", "── Teammate idle ──", ...blocks, ""].join("\n"));
  } catch {
    // Defense in depth — any unexpected throw becomes pass(). The hook is
    // advisory; never break the UserPromptSubmit chain on an internal fault.
    return pass();
  }
}
