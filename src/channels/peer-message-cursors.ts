// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 4 Step A — Layer 1 substrate helpers for the `peer-message-deliverer`
 * hook.
 *
 * Two responsibilities:
 *
 *   1. **Per-(channel, session) cursor management** with two-phase commit
 *      semantics. The hook writes a `<sid>.json.pending` cursor on emit;
 *      the next UserPromptSubmit fire promotes it to the committed
 *      `<sid>.json` (atomic rename). If the session crashes between emit
 *      and promote, the next session sees the stale pending + still-old
 *      committed cursor and re-emits the affected messages — silent
 *      message-loss is impossible because cursor advance is gated on the
 *      OPERATOR reaching the next prompt (evidence the prior emission was
 *      consumed).
 *
 *   2. **Body sanitization + nonce-fence wrapping** before the hook
 *      surfaces peer message bodies as system-reminders. Peer body is
 *      free-form text from another Claude session; without defense, body
 *      containing platform-control markup would corrupt the receiving
 *      Claude's prompt structure. Defense is in depth:
 *
 *        - Targeted-pattern strip (system-reminder tags, function-call
 *          traces, antml:* namespace tags, the fence marker itself, bare
 *          `</` close-tag sequence) — replaces each with the literal
 *          string `[redacted-platform-marker]`.
 *        - Bare `<` escape — any remaining `<` chars after the targeted
 *          strip become `&lt;`. The receiver's surface is markdown-rendered;
 *          a bare `<` is structurally meaningful, so this catches whatever
 *          the targeted strip missed.
 *        - **NO high-byte strip** — em-dashes, smart quotes, emoji,
 *          ellipsis are all multibyte UTF-8 and routinely appear in
 *          legitimate markdown prose. Stripping defends nothing additional
 *          (Claude's tokenizer reads UTF-8 fine) and corrupts legit
 *          content. (Per Bravo MINOR-3 fold, plan v3 → v4.)
 *        - Per-emission UUID-nonce fence: `[peer-body-<8hex>] ... [/peer-body-<8hex>]`.
 *          The fence marker itself is in the targeted-strip pattern set so
 *          the nonce can never collide with body content.
 *        - 200-char inline truncate; longer bodies → body_ref note pointing
 *          to the externalized body file.
 *
 * Cursor schema:
 *
 * ```
 *   <channels-dir>/<channel-id>/peer-message-emit-cursors/<sid>.json
 *     { mtime: number, ts: string }
 * ```
 *
 * Sibling-shape to `LastSeenCursor` (`src/channels/index.ts`). Distinct
 * cursor dir avoids racing the CLI's `read --since-cursor` reader; same
 * `{mtime, ts}` shape keeps semantics consistent.
 *
 * Pending cursor lives at the same path with `.pending` suffix. Atomic
 * tmp+rename for both write and promote. Last-writer-wins on concurrent
 * promote (correctness-preserving: both attempts advance to the same or
 * newer position).
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v4.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  isValidArtifactId,
  isValidSessionId,
} from "../active-sessions/index.ts";
import { resolveChannelsDir } from "./index.ts";

/** Subdir name (NEW noun-form per Step G convention; no legacy here — this
 *  is a fresh substrate introduced in Phase 4 Step A). */
const PEER_MESSAGE_EMIT_SUBDIR = "peer-message-emit-cursors";

/** Maximum body length surfaced inline in the hook emission. Body longer
 *  than this is rendered as a body_ref note instead. */
export const MAX_INLINE_BODY_CHARS = 200;

/** Per-(channel, session) cursor tracking the last peer message this
 *  session's hook surfaced to the operator. Sibling-shape to
 *  `LastSeenCursor`. */
export type PeerMessageCursor = {
  readonly mtime: number;
  readonly ts: string;
};

// ─── Path resolution ─────────────────────────────────────────────

function peerMessageEmitDir(channelId: string): string {
  return join(resolveChannelsDir(), channelId, PEER_MESSAGE_EMIT_SUBDIR);
}

function peerMessageEmitCursorPath(
  channelId: string,
  sessionId: string,
): string {
  return join(peerMessageEmitDir(channelId), `${sessionId}.json`);
}

function pendingPeerMessageEmitCursorPath(
  channelId: string,
  sessionId: string,
): string {
  return `${peerMessageEmitCursorPath(channelId, sessionId)}.pending`;
}

/** Path to the per-channel `peer-message-emit-cursors/` subdirectory.
 *  Exported so the GC reaper can scan + prune stale cursors (sibling-shape
 *  to `resolveLastSeenDir`). */
export function resolvePeerMessageEmitDir(channelId: string): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolvePeerMessageEmitDir: invalid channelId "${channelId}"`,
    );
  }
  return peerMessageEmitDir(channelId);
}

/** Path to a specific session's peer-message-emit cursor file. Exported
 *  for the GC reaper's per-cursor unlink path + the `show-message-cursor`
 *  / `forget-message-cursor` CLI verbs. */
export function resolvePeerMessageEmitCursorPath(
  channelId: string,
  sessionId: string,
): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolvePeerMessageEmitCursorPath: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] resolvePeerMessageEmitCursorPath: invalid sessionId "${sessionId}"`,
    );
  }
  return peerMessageEmitCursorPath(channelId, sessionId);
}

/** Path to a specific session's PENDING peer-message-emit cursor file
 *  (the two-phase commit staging file). */
export function resolvePendingPeerMessageEmitCursorPath(
  channelId: string,
  sessionId: string,
): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolvePendingPeerMessageEmitCursorPath: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] resolvePendingPeerMessageEmitCursorPath: invalid sessionId "${sessionId}"`,
    );
  }
  return pendingPeerMessageEmitCursorPath(channelId, sessionId);
}

// ─── Cursor read ─────────────────────────────────────────────────

function readCursorAt(path: string): PeerMessageCursor | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as PeerMessageCursor;
  if (!Number.isFinite(c.mtime)) return null;
  if (typeof c.ts !== "string") return null;
  return { mtime: c.mtime, ts: c.ts };
}

/** Read the committed per-session peer-message cursor for `channelId`.
 *  Returns null on absent, ENOENT, parse error, invalid shape, or
 *  non-finite mtime. */
export function readPeerMessageCursor(
  channelId: string,
  sessionId: string,
): PeerMessageCursor | null {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readPeerMessageCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] readPeerMessageCursor: invalid sessionId "${sessionId}"`,
    );
  }
  return readCursorAt(peerMessageEmitCursorPath(channelId, sessionId));
}

/** Read the PENDING per-session peer-message cursor (two-phase commit
 *  staging file). Returns null on absent / parse error / invalid shape. */
export function readPendingPeerMessageCursor(
  channelId: string,
  sessionId: string,
): PeerMessageCursor | null {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readPendingPeerMessageCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] readPendingPeerMessageCursor: invalid sessionId "${sessionId}"`,
    );
  }
  return readCursorAt(pendingPeerMessageEmitCursorPath(channelId, sessionId));
}

// ─── Cursor write (pending) + promote ─────────────────────────────

/** Write the PENDING peer-message cursor for (channelId, sessionId). Atomic
 *  via tmp+rename — concurrent writers race on the rename, one wins, file
 *  is always valid. Sibling-pattern (RE-NEW-1) from teammate-idle-reminder:
 *  tmp suffix includes pid + random tail so concurrent same-pid invocations
 *  don't collide before rename. */
export function writePendingPeerMessageCursor(
  channelId: string,
  sessionId: string,
  mtime: number,
  ts: string,
): void {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] writePendingPeerMessageCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] writePendingPeerMessageCursor: invalid sessionId "${sessionId}"`,
    );
  }
  if (!Number.isFinite(mtime)) {
    throw new Error(
      `[channels] writePendingPeerMessageCursor: mtime must be finite, got ${mtime}`,
    );
  }
  const dir = peerMessageEmitDir(channelId);
  mkdirSync(dir, { recursive: true });
  const finalPath = pendingPeerMessageEmitCursorPath(channelId, sessionId);
  const tmpSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = `${finalPath}.${tmpSuffix}.tmp`;
  const cursor: PeerMessageCursor = { mtime, ts };
  writeFileSync(tmpPath, `${JSON.stringify(cursor)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* tmp already gone; ignore */
    }
    throw err;
  }
}

/** Promote the PENDING cursor to COMMITTED via atomic rename. Returns
 *  `true` if a pending file existed and was promoted; `false` if no
 *  pending was present. Idempotent — repeated calls after pending is
 *  consumed return `false`.
 *
 *  Atomicity: POSIX `rename` is atomic; observers either see the prior
 *  committed cursor (if promote hasn't fired) or the new one (if it has).
 *  Concurrent promotes from same-session race; both write the same
 *  content; last-writer-wins is correctness-preserving (both promote to
 *  the same or newer position).
 */
export function promotePendingPeerMessageCursor(
  channelId: string,
  sessionId: string,
): boolean {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] promotePendingPeerMessageCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] promotePendingPeerMessageCursor: invalid sessionId "${sessionId}"`,
    );
  }
  const pendingPath = pendingPeerMessageEmitCursorPath(channelId, sessionId);
  const committedPath = peerMessageEmitCursorPath(channelId, sessionId);
  if (!existsSync(pendingPath)) return false;
  try {
    renameSync(pendingPath, committedPath);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT after our existsSync check = race with a concurrent promote;
    // treat as already-promoted (still correctness-preserving).
    if (code === "ENOENT") return false;
    throw err;
  }
}

/** Discriminated result for `clearPeerMessageCursor` — sibling-shape to
 *  `ClearLastSeenCursorResult`. */
export type ClearPeerMessageCursorResult =
  | { readonly kind: "cleared" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "error";
      readonly code: "EACCES" | "EBUSY" | "OTHER";
      readonly detail: string;
    };

/** Clear BOTH the committed and pending cursors for (channelId, sessionId).
 *  Idempotent — returns `{kind: "absent"}` if neither file existed. Returns
 *  `{kind: "cleared"}` if either was successfully unlinked. Returns
 *  `{kind: "error"}` (with code + detail) on EACCES/EBUSY/other errors
 *  that aren't ENOENT.
 *
 *  Sibling-shape to `clearLastSeenCursor`. Powers the
 *  `channels forget-message-cursor <channel-id>` CLI verb. */
export function clearPeerMessageCursor(
  channelId: string,
  sessionId: string,
): ClearPeerMessageCursorResult {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] clearPeerMessageCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] clearPeerMessageCursor: invalid sessionId "${sessionId}"`,
    );
  }
  let anyCleared = false;
  let firstError: { code: string; detail: string } | null = null;
  for (const path of [
    peerMessageEmitCursorPath(channelId, sessionId),
    pendingPeerMessageEmitCursorPath(channelId, sessionId),
  ]) {
    try {
      unlinkSync(path);
      anyCleared = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") continue;
      const detail = err instanceof Error ? err.message : String(err);
      if (firstError === null) {
        firstError = {
          code: code === "EACCES" || code === "EBUSY" ? code : "OTHER",
          detail,
        };
      }
    }
  }
  if (anyCleared) return { kind: "cleared" };
  if (firstError !== null) {
    return {
      kind: "error",
      code: firstError.code as "EACCES" | "EBUSY" | "OTHER",
      detail: firstError.detail,
    };
  }
  return { kind: "absent" };
}

// ─── Body sanitization + nonce-fence ──────────────────────────────

/**
 * Platform-control markup patterns that get stripped from peer body
 * before fence-wrap. Each occurrence is replaced with the literal string
 * `[redacted-platform-marker]`.
 *
 * Per MAJOR-1 fold (plan v3) + MINOR-3 refinement (plan v4):
 *
 *   - system-reminder tags (open + close)
 *   - function-call traces (open + close)
 *   - antml:* namespace tags (open + close)
 *   - the fence marker itself (so a malicious body can't collide with
 *     the nonce-fence)
 *   - bare `</` close-tag sequence (catches anything else the targeted
 *     patterns missed)
 *
 * Targeted-strip is pass (a) of sanitization. Pass (b) escapes any
 * remaining bare `<` chars via `&lt;`-replacement.
 */
const PLATFORM_CONTROL_PATTERNS: readonly RegExp[] = [
  /<\/?system-reminder>/gi,
  /<\/?function_calls>/gi,
  /<\/?antml:[a-z_][a-z0-9_-]*\s*\/?>/gi,
  /\[\/?peer-body-[0-9a-f]{1,16}\]/gi,
  /<\//g,
];

/** Sanitize a peer message body for safe inclusion as a system-reminder.
 *
 *  Two-pass defense (per plan v4 §Phase 1 §Body-fencing):
 *
 *    (a) Strip platform-control patterns (see PLATFORM_CONTROL_PATTERNS).
 *    (b) Escape any remaining bare `<` chars via `&lt;`.
 *
 *  Does NOT strip high-byte content — em-dashes, smart quotes, emoji,
 *  ellipsis, and other multibyte UTF-8 characters routinely appear in
 *  legitimate markdown prose and are preserved verbatim. (Per Bravo
 *  MINOR-3 fold.) */
export function sanitizePeerBody(raw: string): string {
  let s = raw;
  for (const pat of PLATFORM_CONTROL_PATTERNS) {
    s = s.replace(pat, "[redacted-platform-marker]");
  }
  s = s.replace(/</g, "&lt;");
  return s;
}

/** Wrap a sanitized peer body in a per-emission UUID-nonce fence:
 *  `[peer-body-<nonce>]\n<sanitized>\n[/peer-body-<nonce>]`.
 *
 *  Nonce uniqueness defends against attacker collision: even if the body
 *  contained the literal fence marker (it can't — pass (a) of sanitize
 *  strips the fence pattern), a fresh nonce per emission means the
 *  receiver can match the opening/closing pair unambiguously. */
export function fencePeerBody(sanitized: string, nonce: string): string {
  return `[peer-body-${nonce}]\n${sanitized}\n[/peer-body-${nonce}]`;
}
