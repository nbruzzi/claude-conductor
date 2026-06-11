// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Audit-queue pure logic (Tier 1 Slice 3 Layer 2 — coord-primitive
 * consuming Slices 1+2 schemas).
 *
 * **`queryPendingAuditAsks`** — given a channel's messages + body store
 * + a target NATO identity + a clock, returns the audit-asks targeting
 * that identity which have NO matching `kind=audit-verdict` reply.
 *
 * **Identity-rotation resilience** is the key reliability invariant
 * (A2 in plan v0.1). Matching uses the `identity` field on the
 * `ChannelMessage` wrapper (auto-stamped at send time), NOT the session-
 * id `from`. Charlie's pre-respawn `c813f872` asks + post-respawn
 * `cc901eaf` asks all bind to identity name `"Charlie"`; same for
 * Delta's `c939b611` → `17e0ced4` verdict authorship. This survives
 * NATO takeover-with-CAS cleanly per cycle-2026-05-19 evidence.
 *
 * **Pure-function discipline** (A3): no I/O, no clock side-effects, no
 * global. All inputs are explicit args. The CLI layer
 * (`src/audits/cli.ts`) is the I/O wrapper that reads the channel +
 * gathers bodies + calls now-ms.
 *
 * Plan: `~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md` v0.1.
 */

import { parseAuditAskBody } from "../channels/audit-ask.ts";
import { parseAuditVerdictBodyAnyVersion } from "../channels/audit-verdict.ts";
import {
  sameTarget,
  type AuditAskTier,
  type AuditClass,
  type AuditTarget,
  type LensClass,
} from "../channels/audit-types.ts";
import { type ChannelMessage } from "../channels/index.ts";

/**
 * One pending audit-ask row in the queue output.
 */
export type PendingAsk = {
  /** The audit target (PR or plan). Canonical field post-b2 generalization. */
  target: AuditTarget;
  /** Repo of the PR under audit. Only meaningful for PR targets; "" for plan. */
  pr_repo: string;
  /** PR number. Only meaningful for PR targets; 0 for plan. */
  pr_number: number;
  /** ISO-8601 timestamp the ask was posted to channel (wrapper `ts`). */
  ask_ts: string;
  /** Waited time in whole minutes (floored), `now_ms - parseISO(ts)`. */
  waited_minutes: number;
  /** Audit class the asker requested. */
  audit_class: AuditClass;
  /** Audit tier the asker stamped (default-inferred OR override). */
  tier: AuditAskTier;
  /** Lens-set the asker requested. */
  lens_set_requested: readonly LensClass[];
  /** NATO identity of the asker (from wrapper `identity` field). */
  from_identity: string;
};

/**
 * Inputs to `queryPendingAuditAsks`. Pure-args; no I/O closure.
 */
export type QueryPendingAuditAsksArgs = {
  /** All messages on the channel, oldest-first (as `readMessages` returns). */
  messages: readonly ChannelMessage[];
  /** Body store for `body_ref`-stored messages. Wrapper-inline `body`
   *  is preferred when present; only `body_ref`-only messages need
   *  the lookup. Caller-prepopulated by reading `bodies/<ref>.txt`. */
  bodies_by_ref: ReadonlyMap<string, string>;
  /** The NATO identity being queried (e.g., `"Charlie"`, `"Delta"`). */
  target_identity: string;
  /** Clock now (epoch ms). Caller passes `Date.now()`. */
  now_ms: number;
};

/**
 * Resolve a message body to its string content. Wrapper inline `body`
 * wins; falls back to `bodies_by_ref` lookup on `body_ref`. Returns
 * `null` when neither path resolves.
 */
function resolveBody(
  msg: ChannelMessage,
  bodies_by_ref: ReadonlyMap<string, string>,
): string | null {
  if (msg.body !== undefined) return msg.body;
  if (msg.body_ref !== undefined) {
    return bodies_by_ref.get(msg.body_ref) ?? null;
  }
  return null;
}

/**
 * Tier-rank for sort: higher rank = higher queue priority (tested at
 * boundary edges in T2.3). Slice 3 secondary sort key.
 */
function rankTier(tier: AuditAskTier): number {
  switch (tier) {
    case "3-lens-convergence":
      return 2;
    case "1-lens-substantive":
      return 1;
    case "light-touch":
      return 0;
  }
}

/**
 * Query the channel for `kind=audit-ask` messages targeting the given
 * identity that lack a matching `kind=audit-verdict` reply.
 *
 * **Matching predicate** (verdict closes ask): a verdict V closes ask A
 * iff ALL hold:
 *
 *   1. `V.kind === "audit-verdict"` AND parses as a valid verdict body
 *   2. `V.identity === A.body.target_peer` — verdict author is the
 *      identity originally asked to audit
 *   3. `sameTarget(V.body.target, A.body.target)` — same PR or plan ref
 *   4. `V.ts >= A.ts` — verdict posted at or after the ask
 *
 * **Sort:** primary `waited_minutes` DESC (oldest waiting first);
 * secondary `tier` rank DESC (3-lens-convergence > 1-lens-substantive >
 * light-touch). Tertiary: channel JSONL append order (intrinsic via
 * stable sort on Array.prototype.sort with deterministic comparator).
 *
 * **Body resolution:** wrapper-inline `body` preferred; `body_ref`
 * resolved via `bodies_by_ref` map. Messages with body neither inline
 * nor in the map are skipped (parser-null path equivalent).
 *
 * **Identity-rotation resilience:** matches on identity NAME (wrapper
 * `identity` field), NOT session-id `from`. NATO takeover via
 * `--as <Identity> --force` preserves the binding.
 */
export function queryPendingAuditAsks(
  args: QueryPendingAuditAsksArgs,
): readonly PendingAsk[] {
  const { messages, bodies_by_ref, target_identity, now_ms } = args;

  type ParsedAsk = {
    msg: ChannelMessage;
    ts_ms: number;
    body: NonNullable<ReturnType<typeof parseAuditAskBody>>;
  };

  type ParsedVerdict = {
    identity: string;
    ts_ms: number;
    body: NonNullable<ReturnType<typeof parseAuditVerdictBodyAnyVersion>>;
  };

  const asks: ParsedAsk[] = [];
  const verdicts: ParsedVerdict[] = [];

  for (const m of messages) {
    if (m.kind === "audit-ask") {
      const raw = resolveBody(m, bodies_by_ref);
      if (raw === null) continue;
      const body = parseAuditAskBody(raw);
      if (body === null) continue;
      if (body.target_peer !== target_identity) continue;
      const ts_ms = Date.parse(m.ts);
      if (!Number.isFinite(ts_ms)) continue;
      asks.push({ msg: m, ts_ms, body });
    } else if (m.kind === "audit-verdict") {
      const raw = resolveBody(m, bodies_by_ref);
      if (raw === null) continue;
      const body = parseAuditVerdictBodyAnyVersion(raw);
      if (body === null) continue;
      const identity = m.identity;
      if (identity === undefined || identity.length === 0) continue;
      const ts_ms = Date.parse(m.ts);
      if (!Number.isFinite(ts_ms)) continue;
      verdicts.push({ identity, ts_ms, body });
    }
  }

  const pending: PendingAsk[] = [];

  for (const ask of asks) {
    const askTarget = ask.body.target;
    const matched = verdicts.some(
      (v) =>
        v.identity === ask.body.target_peer &&
        sameTarget(askTarget, v.body.target) &&
        v.ts_ms >= ask.ts_ms,
    );
    if (matched) continue;

    const fromIdentity = ask.msg.identity ?? "";
    if (fromIdentity.length === 0) continue; // skip legacy asks without identity stamp

    pending.push({
      target: askTarget,
      pr_repo: askTarget.kind === "pr" ? askTarget.repo : "",
      pr_number: askTarget.kind === "pr" ? askTarget.number : 0,
      ask_ts: ask.msg.ts,
      waited_minutes: Math.max(0, Math.floor((now_ms - ask.ts_ms) / 60_000)),
      audit_class: ask.body.audit_class,
      tier: ask.body.tier,
      lens_set_requested: ask.body.lens_set_requested,
      from_identity: fromIdentity,
    });
  }

  pending.sort((a, b) => {
    if (a.waited_minutes !== b.waited_minutes) {
      return b.waited_minutes - a.waited_minutes;
    }
    return rankTier(b.tier) - rankTier(a.tier);
  });

  return pending;
}
