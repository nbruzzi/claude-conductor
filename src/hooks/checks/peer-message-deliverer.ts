// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 4 Step A — Layer 1 hook: surface new peer messages on
 * UserPromptSubmit across all channels where this session has a NATO
 * identity claim.
 *
 * Closes the "no cross-window delivery" gap (backlog L133). Without this
 * hook, peer messages are only seen via manual `channels read` poll or
 * SessionStart fire — making true autonomous sibling coordination
 * impossible at the substrate level.
 *
 * **Design (per plan `eventual-marinating-wall.md` v5 §Phase 1):**
 *
 *   - Two-phase cursor commit per (channel, session) at
 *     `<channel-dir>/peer-message-emit-cursors/<sid>.json`. Emit-turn
 *     writes `<path>.pending`; next UserPromptSubmit fire promotes
 *     pending → committed (atomic rename). Recovery: if the session
 *     crashes between emit and promote, the next session sees the stale
 *     pending + still-old committed cursor and re-emits — silent loss is
 *     impossible because cursor advance is gated on the OPERATOR
 *     reaching the next prompt (evidence the prior emission was
 *     consumed).
 *   - **Body fencing + sanitization** (MAJOR-1 fold per Bravo
 *     cross-audit; MINOR-3 refinement). Peer body is free-form text from
 *     another Claude session; defense-in-depth via targeted-pattern
 *     strip + bare-`<` escape + per-emission UUID-nonce fence + 200-char
 *     truncate. Multibyte UTF-8 preserved verbatim (em-dashes, smart
 *     quotes, emoji, ellipsis are normal markdown content).
 *   - **Bootstrap-without-emit**: on first scan (no committed cursor,
 *     no pending), set committed cursor to newest message `mtime`
 *     silently. Matches CLI `--since-cursor` bootstrap.
 *   - **Skip own messages** (`from === sessionId`).
 *   - **Emission cap**: 50 messages/prompt across all channels;
 *     per-channel overflow → summary line.
 *   - **Fail-open + breadcrumb** failure-mode class. Any thrown helper
 *     becomes a single outer `pass()`; never break the
 *     UserPromptSubmit chain.
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 §Phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isChannelMessage,
  readBodyFile,
  readMessagesAfter,
  resolveChannelsDir,
  type ChannelMessage,
} from "../../channels/index.ts";
import { getIdentityContextForSession } from "../../channels/identity-context.ts";
import {
  MAX_INLINE_BODY_CHARS,
  fencePeerBody,
  promotePendingPeerMessageCursor,
  readPeerMessageCursor,
  sanitizePeerBody,
  writePendingPeerMessageCursor,
} from "../../channels/peer-message-cursors.ts";
import {
  renderAuditVerdictSummary,
  renderKindPrefix,
} from "../../channels/render.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { extractValidSessionId } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "peer-message-deliverer";

/** Maximum total messages surfaced per UserPromptSubmit across all channels.
 *  Per-channel overflow → summary line. Plan v5 §Phase 1 §Emission cap. */
const EMISSION_CAP = 50;

/** Read + parse the channel's append-only JSONL log. Tolerant — corrupt
 *  lines + schema-invalid records are skipped without throwing.
 *
 *  Uses the substrate's `isChannelMessage` predicate (exported per the
 *  RE-1 / ARCH-4 convergent fold of the 2026-05-14 4-persona audit). This
 *  is load-bearing — a malicious peer-written record like
 *  `{"ts":"</system-reminder>","from":42,"kind":"note","identity":"<...>"}`
 *  would otherwise reach `formatMessageBlock` with prompt-injected schema
 *  metadata. The body-fencing only sanitizes `msg.body`; schema metadata
 *  (identity / ts / kind / body_ref) flows through the speaker line. Strict
 *  shape validation at the read boundary keeps the trust seam aligned with
 *  the substrate-canonical schema.
 *
 *  Missing file → empty array. */
function readChannelMessages(channelId: string): readonly ChannelMessage[] {
  const path = join(resolveChannelsDir(), channelId, "messages.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const messages: ChannelMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isChannelMessage(parsed)) continue;
      messages.push(parsed);
    } catch {
      continue;
    }
  }
  return messages;
}

/** Decode an `audit-verdict` message into the one-line readable summary
 *  shared with the `read` CLI verb (SSOT: `renderAuditVerdictSummary`), or
 *  null when the message is not a decodable verdict.
 *
 *  Mirrors the #168 `read`-verb fix on the hook-digest surface: without this,
 *  a DSSE-wrapped verdict shows as an opaque base64 blob inline, and
 *  a body_ref-sidecarred verdict shows only as a `body_ref:` pointer — both
 *  lose the verdict at a glance in the UserPromptSubmit digest.
 *
 *  Two body sources, in priority order:
 *    1. inline `body` (raw v0.1/v0.2 OR v0.3 DSSE-wrapped — both decoded by
 *       the SSOT parser).
 *    2. `body_ref` sidecar — resolved via `readBodyFile(channelId, ref)`,
 *       the only safe resolver (it guards the peer-controlled `ref` against
 *       path traversal and returns null on any unresolvable/unsafe ref).
 *
 *  Returns null (→ caller falls back to the raw-body display path) for non-
 *  verdict kinds, undecodable bodies, and unresolvable refs. The returned
 *  summary still contains peer-controlled fields (target_peer, verdict,
 *  audit_class, lens names) → the caller routes it through the SAME
 *  sanitize+fence path as a raw body. */
function decodeVerdictSummary(
  channelId: string,
  msg: ChannelMessage,
  body: string | undefined,
): string | null {
  if (msg.kind !== "audit-verdict") return null;
  if (body !== undefined && body.length > 0) {
    return renderAuditVerdictSummary(body);
  }
  if (msg.body_ref !== undefined) {
    const resolved = readBodyFile(channelId, msg.body_ref);
    if (resolved === null) return null;
    return renderAuditVerdictSummary(resolved);
  }
  return null;
}

/** Format one peer message as the operator-facing emission block per
 *  plan v5 §Phase 1 §Emission format.
 *
 *  **Speaker-line sanitization (RE-1 / ARCH-4 convergent fold).** `isChannelMessage`
 *  validates the SHAPE of schema metadata (identity / ts / body_ref are strings;
 *  role is `pen|queue|out` literal-union; kind is one of the four channel kinds);
 *  it does NOT validate string CONTENT. A peer writing JSONL directly could put
 *  `identity: "</system-reminder>injection<system-reminder>"` past the shape
 *  predicate. Defense: sanitize the user-controlled string fields (identity, ts,
 *  body_ref) through the same `sanitizePeerBody` pass that defends `body`.
 *  `kind` and `role` are literal-union-validated upstream → not sanitized.
 *  Legacy `<unknown>` placeholder for absent identity is a literal not user-
 *  controlled → left as-is for operator legibility. */
function formatMessageBlock(
  channelId: string,
  msg: ChannelMessage,
  body: string | undefined,
): string {
  // Identity: sanitize if present (user-controlled string); literal placeholder
  // when absent (legacy pre-Phase-1 messages — operator-legible).
  const identityLabel =
    msg.identity !== undefined ? sanitizePeerBody(msg.identity) : "<unknown>";
  // Role: literal-union-validated by isChannelMessage → safe to interpolate.
  const roleSuffix = msg.role !== undefined ? ` (${msg.role})` : " (no-role)";
  // Kind: literal-union-validated → safe; renderKindPrefix brackets it.
  const kindPrefix = renderKindPrefix(msg.kind);
  // Ts: typeof-string-validated but content-arbitrary → sanitize.
  const safeTs = sanitizePeerBody(msg.ts);
  const speaker = `• ${identityLabel}${roleSuffix} ${kindPrefix} @${safeTs}:`;

  // audit-verdict decode (the #168 fast-follow): replace an opaque inline
  // DSSE blob / bare body_ref pointer with the readable one-line summary.
  // Null for non-verdict / undecodable / unresolvable-ref → falls back to the
  // raw body. The summary then flows through the SAME sanitize+fence+truncate
  // path below as a raw body, since it carries peer-controlled fields.
  const decoded = decodeVerdictSummary(channelId, msg, body);
  const displayBody = decoded ?? body;

  // Body absent → body_ref-only message. Surface the body_ref pointer
  // with recovery hint (`channels read --since-cursor` to follow).
  if (displayBody === undefined || displayBody.length === 0) {
    // L409: when the body shunted to a body_ref sidecar, a send-time
    // body_preview lets us surface CONTENT instead of a bare pointer. Flow it
    // through the same sanitize+fence injection-defense path as a real body;
    // append a recovery hint since it is a truncated preview, not the full body.
    if (msg.body_preview !== undefined && msg.body_preview.length > 0) {
      const previewNonce = randomUUID().slice(0, 8);
      const fencedPreview = fencePeerBody(
        sanitizePeerBody(msg.body_preview),
        previewNonce,
      );
      return `${speaker}\n${fencedPreview}\n  (preview — channels read ${channelId} --since-cursor for the full body)`;
    }
    const refHint =
      msg.body_ref !== undefined
        ? `  (body via body_ref:${sanitizePeerBody(msg.body_ref)} — channels read ${channelId} --since-cursor)`
        : `  <empty>`;
    return `${speaker}\n${refHint}`;
  }

  const truncated =
    displayBody.length > MAX_INLINE_BODY_CHARS
      ? displayBody.slice(0, MAX_INLINE_BODY_CHARS)
      : displayBody;
  const sanitized = sanitizePeerBody(truncated);
  const nonce = randomUUID().slice(0, 8);
  const fenced = fencePeerBody(sanitized, nonce);
  // CLI-8 fold: drop the "via body_ref" mention — `channels read --since-cursor`
  // returns full content regardless of whether the body sidecarred to body_ref
  // or stayed inline. The body_ref mention misled operators into thinking
  // body_ref was the recovery mechanism for any truncation.
  const overflowHint =
    displayBody.length > MAX_INLINE_BODY_CHARS
      ? `\n  (truncated to ${MAX_INLINE_BODY_CHARS} chars in this preview; full body via 'channels read ${channelId} --since-cursor')`
      : "";
  return `${speaker}\n${fenced}${overflowHint}`;
}

/** Compute the newest message mtime in a non-empty list. Returns 0 for
 *  empty / all-unparseable lists. */
function newestMtime(messages: readonly ChannelMessage[]): number {
  let max = 0;
  for (const m of messages) {
    const mtime = Date.parse(m.ts);
    if (Number.isFinite(mtime) && mtime > max) max = mtime;
  }
  return max;
}

export async function check(input: HookInput): Promise<HookResult> {
  try {
    const sessionId = extractValidSessionId(input.raw);
    if (sessionId === undefined) return pass();

    const contexts = getIdentityContextForSession(sessionId);
    if (contexts.length === 0) return pass();

    const blocks: string[] = [];
    let remaining = EMISSION_CAP;

    for (const ctx of contexts) {
      const channelId = ctx.channelId;

      // Phase 1 of two-phase commit: promote any prior-turn pending
      // cursor to committed before reading messages. Idempotent — no-op
      // if no pending exists.
      try {
        promotePendingPeerMessageCursor(channelId, sessionId);
      } catch (err: unknown) {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          source: "channels-identity",
          kind: "write-failed",
          sessionId,
          artifactPath: channelId,
          detail: `${SOURCE}: promotePendingPeerMessageCursor failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        // Best-effort; continue to message read.
      }

      const cursor = readPeerMessageCursor(channelId, sessionId);
      // Bootstrap needs the full live tail (newestMtime); the normal path needs
      // messages strictly after the cursor — readMessagesAfter spans the
      // rotation boundary (live + the archive when the cursor predates live), so
      // a peer message archived before this session's cursor advanced is still
      // delivered (no coordination silent-loss), while a near-live cursor stays
      // live-only + bounded.
      const messages =
        cursor === null
          ? readChannelMessages(channelId)
          : readMessagesAfter(channelId, cursor.ts);

      // Bootstrap path — no prior cursor. Set committed-via-pending to
      // newest mtime silently; do NOT emit (matches CLI --since-cursor
      // bootstrap). Next turn's promote will land this committed.
      if (cursor === null) {
        if (messages.length === 0) continue;
        const newest = newestMtime(messages);
        if (newest > 0) {
          try {
            writePendingPeerMessageCursor(
              channelId,
              sessionId,
              newest,
              new Date(newest).toISOString(),
            );
          } catch (err: unknown) {
            appendPresenceFailure({
              timestamp: new Date().toISOString(),
              source: "channels-identity",
              kind: "write-failed",
              sessionId,
              artifactPath: channelId,
              detail: `${SOURCE}: bootstrap writePending failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        continue;
      }

      // Normal path — filter messages newer than cursor + not from
      // this session.
      const filtered: ChannelMessage[] = [];
      for (const m of messages) {
        if (m.from === sessionId) continue;
        const mtime = Date.parse(m.ts);
        if (!Number.isFinite(mtime)) continue;
        if (mtime <= cursor.mtime) continue;
        filtered.push(m);
      }

      if (filtered.length === 0) continue;

      // Apply emission cap. If this channel alone has more new messages
      // than `remaining`, switch to summary mode for the channel.
      if (filtered.length > remaining) {
        const newest = newestMtime(filtered);
        // RE-3 fold: distinguish per-channel overflow from aggregate-cap
        // exhaustion. When `remaining === 0` entering this branch (a prior
        // channel consumed the full 50-message budget), every message in
        // this channel is suppressed — not "M of N suppressed." Phrase the
        // summary line so the operator reads the actual outcome rather
        // than doing arithmetic.
        const summaryDetail =
          remaining === 0
            ? `(${filtered.length} new messages, all suppressed — aggregate 50-message cap exhausted by prior channels; read full via 'channels read ${channelId} --since-cursor')`
            : `(${filtered.length} new messages; ${remaining} shown, ${filtered.length - remaining} suppressed by 50-message cap; read full via 'channels read ${channelId} --since-cursor')`;
        blocks.push(`── ${channelId} ──\n  ${summaryDetail}`);
        try {
          writePendingPeerMessageCursor(
            channelId,
            sessionId,
            newest,
            new Date(newest).toISOString(),
          );
        } catch (err: unknown) {
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "write-failed",
            sessionId,
            artifactPath: channelId,
            detail: `${SOURCE}: summary-mode writePending failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        remaining = 0;
        continue;
      }

      // Normal emission for this channel.
      const channelBlocks: string[] = [`── ${channelId} ──`];
      for (const m of filtered) {
        channelBlocks.push(formatMessageBlock(channelId, m, m.body));
      }
      blocks.push(channelBlocks.join("\n"));
      remaining -= filtered.length;

      const newest = newestMtime(filtered);
      try {
        writePendingPeerMessageCursor(
          channelId,
          sessionId,
          newest,
          new Date(newest).toISOString(),
        );
      } catch (err: unknown) {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          source: "channels-identity",
          kind: "write-failed",
          sessionId,
          artifactPath: channelId,
          detail: `${SOURCE}: writePending failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (blocks.length === 0) return pass();

    // CLI-4 fold: visual hierarchy. The outer `══ Peer messages ══` heading
    // (double-rule) distinguishes the hook's overall block from the inner
    // per-channel `── <channel-id> ──` headings (single-rule). Operators
    // scanning the system-reminder can map double=hook-level, single=channel
    // boundary at a glance instead of two same-style headings stacked.
    return warn(SOURCE, ["", "══ Peer messages ══", ...blocks, ""].join("\n"));
  } catch (err: unknown) {
    // RE-2 fold: defense-in-depth fail-open WITH breadcrumb. Any thrown
    // helper that escaped a per-call try/catch lands here. The plan's
    // "fail-open + breadcrumb" class is satisfied only if the breadcrumb
    // half fires — silent fail-open hides regressions in future refactors
    // (e.g., a sync IO call added without its own catch). The breadcrumb
    // write itself is best-effort (appendPresenceFailure has its own inner
    // catch), so a breadcrumb-write failure cannot re-throw.
    try {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: "channels-identity",
        kind: "unhandled",
        sessionId: null,
        artifactPath: null,
        detail: `${SOURCE}: outer-catch swallowed unhandled throw: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      /* breadcrumb write is best-effort; never re-throw */
    }
    return pass();
  }
}
