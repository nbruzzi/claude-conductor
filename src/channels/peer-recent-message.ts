// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tail-read the most-recent message from a peer on a channel.
 *
 * Used by `teammate-idle-reminder` (and future consumers) to detect deliberate
 * peer-standby state: if the peer's most-recent post is a state-end kind
 * (`standby` / `roger` / `out` / `digest`), the stale-heartbeat reminder is
 * suppressed for that peer.
 *
 * READ-ONLY: zero fs writes, zero lock acquisitions. Safe to call from any
 * hook lock context. All failure modes (ENOENT, EACCES, malformed JSONL,
 * non-canonical kinds, truncated trailing line) return `null` + emit
 * `appendPresenceFailure` breadcrumb. Mirrors the skip-on-error contract of
 * `identity-context.ts`.
 *
 * **Race tolerance (symmetric channel-JOIN / channel-LEAVE):** if the peer
 * joins/leaves a channel between two fires of the caller, the helper's
 * snapshot may lag by one fire. Worst-case is one extra reminder cycle before
 * the next hook fire sees the updated state — acceptable per the
 * "skip-on-error + next-fire-converges" pattern documented in
 * `feedback-bounded-reaudit-on-critical-fix-delta.md`.
 *
 * Bound: scans up to MAX_TAIL_BYTES (256 KB) backward from EOF, parsing up
 * to MAX_TAIL_LINES (500) most-recent lines. Bounds chosen against observed
 * data: today's typical channel (`2026-05-15_08-07`) is ~42 KB / 31 lines
 * with max-line ~3 KB; a 100-line channel with similar density approaches
 * 256 KB. Bound covers the common case + comfortable headroom for
 * Phase 4 Layer 4 `digest` posts (which can be larger). Channels exceeding
 * the bound where the standby post is older than the bound DO regress to
 * the pre-fix behavior — accepted trade-off; cycle activity beats bound on
 * any healthy channel.
 *
 * Algorithm (per plan v2 §"L146 fix" RE-3 fold spec):
 *   1. Stat the file → ENOENT returns null cleanly.
 *   2. Read up to MAX_TAIL_BYTES from EOF.
 *   3. Split on `\n`.
 *   4. If the read started mid-line (size > MAX_TAIL_BYTES), DROP the first
 *      partial line.
 *   5. If the final byte is NOT `\n`, DROP the trailing line (potentially a
 *      writer's mid-append; not safe to parse).
 *   6. Bottom-up: try JSON.parse + isChannelMessage + from === peerSessionId.
 *      First match wins. Parse-fail / validate-fail / non-match all skip.
 *   7. Hit MAX_TAIL_LINES bottom-up without a match → return null. Don't
 *      scan deeper backward.
 *
 * Filed: 2026-05-15 (plan SHA `c0c01622ab08` plan v2 Lane A.2; channel
 * `2026-05-15_08-07` Alpha + Bravo coordination).
 */

import { closeSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { appendPresenceFailure } from "../shared/presence-failure-log.ts";
import {
  isChannelMessage,
  resolveChannelsDir,
  type ChannelMessage,
} from "./index.ts";

/** Max bytes scanned backward from EOF. 256 KB covers observed channels. */
export const MAX_TAIL_BYTES = 256 * 1024;

/** Max lines parsed from the tail buffer. Bounds CPU + memory worst-case. */
export const MAX_TAIL_LINES = 500;

const SOURCE = "channels-identity" as const;

/**
 * Read the most-recent message from `peerSessionId` on `channelId`.
 *
 * Returns `{ kind, ts } | null`. `null` is the safe-default for every failure
 * mode (ENOENT, EACCES, malformed JSONL, no match within bound). Callers
 * MUST treat `null` as "no recent message known" — not as "peer is crashed."
 *
 * @param channelId - per-channel id (e.g., `"2026-05-15_08-07"`).
 * @param peerSessionId - the session id whose post to look up.
 */
export function getMostRecentPeerKind(
  channelId: string,
  peerSessionId: string,
): { readonly kind: string; readonly ts: string } | null {
  return tailScanForPeer(channelId, peerSessionId, null);
}

/**
 * Read the most-recent message from `peerSessionId` on `channelId` whose
 * `kind` matches `kindFilter`. Sibling to `getMostRecentPeerKind` —
 * differs only in that messages of OTHER kinds are skipped during the
 * scan. L152 closure: the `live-delta-reminder` UserPromptSubmit hook
 * (Bravo's dotfiles consumer lane) calls this with `kindFilter:
 * "live-delta"` to find the most-recent live-delta from the joining
 * sibling (NOT the most-recent message of any kind).
 *
 * Why a sibling and not an optional parameter on `getMostRecentPeerKind`:
 * the kind-filtered variant is a distinct caller-intent. Adding a
 * defaulted optional parameter would mean every existing call site
 * implicitly opts into the new behavior shape; a sibling function
 * keeps the two callers explicit about which semantic they want
 * (per `feedback-partial-v2-anticipation-primitives.md` — extend the
 * existing primitive cleanly, don't overload it).
 *
 * Returns `{ kind, ts } | null` with the same safe-default semantics as
 * `getMostRecentPeerKind`. The returned `kind` will always equal
 * `kindFilter` on success — exposed redundantly to keep the return
 * shape uniform with the sibling.
 *
 * @param channelId - per-channel id.
 * @param peerSessionId - the session id whose post to look up.
 * @param kindFilter - the canonical CHANNEL_KIND literal to match (e.g.,
 *   `"live-delta"`, `"digest"`, `"standby"`). Empty string is treated
 *   as "no match possible" → returns null. Non-canonical kinds may
 *   appear in the tail (validator rejects them) but the filter compares
 *   against the message's stored kind regardless.
 */
export function getMostRecentPeerMessageOfKind(
  channelId: string,
  peerSessionId: string,
  kindFilter: string,
): { readonly kind: string; readonly ts: string } | null {
  if (!kindFilter) return null;
  return tailScanForPeer(channelId, peerSessionId, kindFilter);
}

/**
 * Shared tail-scan core. Walks the channel's messages.jsonl backwards
 * within the MAX_TAIL_BYTES + MAX_TAIL_LINES bound, returning the
 * latest line whose `from` matches `peerSessionId` and whose `kind`
 * matches `kindFilter` (or any kind when `kindFilter === null`).
 *
 * Private helper — public callers must use `getMostRecentPeerKind` or
 * `getMostRecentPeerMessageOfKind` so caller-intent stays explicit at
 * use sites.
 */
function tailScanForPeer(
  channelId: string,
  peerSessionId: string,
  kindFilter: string | null,
): { readonly kind: string; readonly ts: string } | null {
  if (!channelId || !peerSessionId) return null;

  const messagesPath = join(resolveChannelsDir(), channelId, "messages.jsonl");

  let size: number;
  try {
    size = statSync(messagesPath).size;
  } catch (err: unknown) {
    const code =
      err instanceof Error && "code" in err
        ? String((err as { code: unknown }).code ?? "")
        : "";
    // ENOENT is the common "no messages yet on this channel" path — silent + null.
    // Other errors (EACCES on the file or parent dir) are unexpected; breadcrumb.
    if (code !== "ENOENT") {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: SOURCE,
        kind: "write-failed",
        sessionId: peerSessionId,
        artifactPath: messagesPath,
        detail: `getMostRecentPeerKind: stat failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return null;
  }

  // Read the tail bytes. Hybrid: if file is small (≤ MAX_TAIL_BYTES) use
  // readFileSync (simpler, no FD lifecycle). Otherwise open + seek + read.
  let buffer: Buffer;
  let startedMidLine: boolean;
  try {
    if (size <= MAX_TAIL_BYTES) {
      buffer = readFileSync(messagesPath);
      startedMidLine = false;
    } else {
      const fd = openSync(messagesPath, "r");
      try {
        buffer = Buffer.alloc(MAX_TAIL_BYTES);
        const position = size - MAX_TAIL_BYTES;
        readSync(fd, buffer, 0, MAX_TAIL_BYTES, position);
        startedMidLine = true;
      } finally {
        closeSync(fd);
      }
    }
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: SOURCE,
      kind: "write-failed",
      sessionId: peerSessionId,
      artifactPath: messagesPath,
      detail: `getMostRecentPeerKind: tail read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }

  // Detect whether the buffer's final byte is `\n`. A final byte that is
  // NOT `\n` means the last "line" is potentially a mid-append from a
  // concurrent writer and unsafe to parse (per RE-3 fold).
  const trailingNewline =
    buffer.length > 0 && buffer[buffer.length - 1] === 0x0a;

  const lines = buffer.toString("utf-8").split("\n");

  // Drop the empty string after the final `\n` if present (standard split artifact).
  if (trailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Drop trailing line lacking `\n` (potentially truncated write).
  if (!trailingNewline && lines.length > 0) {
    lines.pop();
  }

  // Drop partial first line if we started mid-buffer (seek-and-read path).
  if (startedMidLine && lines.length > 0) {
    lines.shift();
  }

  // Bottom-up scan, bounded by MAX_TAIL_LINES.
  const scanCount = Math.min(lines.length, MAX_TAIL_LINES);
  for (let i = lines.length - 1; i >= lines.length - scanCount; i--) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip malformed JSON; don't breadcrumb per-line (volume noise).
      continue;
    }

    if (!isChannelMessage(parsed)) continue;
    const msg = parsed as ChannelMessage;
    if (msg.from !== peerSessionId) continue;
    if (kindFilter !== null && msg.kind !== kindFilter) continue;

    return { kind: msg.kind, ts: msg.ts };
  }

  return null;
}
