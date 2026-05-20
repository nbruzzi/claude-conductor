// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Reciprocation graph builder (Tier 2 Verb 3) — pure logic layer.
 *
 * Consumes `kind=audit-verdict` messages from a channel within a time
 * window; derives directional auditor → target edges + per-peer audit
 * debt + canonical pairwise reciprocation balance.
 *
 * Substrate-precedes-consumer: relies on the Slice 2 `audit-verdict`
 * schema (`src/channels/audit-verdict.ts`). The parser is the trim
 * authority for `target_peer` (F3 in slice 2); this module trusts
 * parser output as already-trimmed (F1 carry-over per plan §9).
 *
 * Plan: `~/.claude/plans/slice-T2V3-reciprocation-cli-2026-05-20.md` v0.1.
 */

import { parseAuditVerdictBody } from "../channels/audit-verdict.ts";
import type { AuditClass, AuditVerdict } from "../channels/audit-types.ts";
import type { ChannelMessage, ChannelMetadata } from "../channels/index.ts";

/**
 * A single audit edge — one auditor-to-target verdict in the window.
 * Auditor identity is resolved at message-time (per plan D2):
 * `message.identity` if present, else metadata identity-map fallback.
 */
export type AuditEdge = {
  ts: string;
  auditor_identity: string;
  auditor_session: string;
  target_peer: string;
  target_pr: { repo: string; number: number };
  verdict: AuditVerdict;
  audit_class: AuditClass;
};

/**
 * Canonical pairwise balance — pair-key sorted alphabetically per D6
 * to dedupe `(A,B)` + `(B,A)` double-counting. `net` is signed relative
 * to `pair[0]`: positive net = pair[0] gives more than pair[1].
 */
export type ReciprocationBalance = {
  pair: readonly [string, string];
  a_to_b: number;
  b_to_a: number;
  net: number;
};

/**
 * Top-level graph output. `per_peer_audit_debt` sign convention (D5):
 * positive = net-debt (received > given). Matches the hand-tally
 * ledger reading from cycle-handoff bodies.
 */
export type ReciprocationGraph = {
  channel_id: string;
  window: { start_ms: number; end_ms: number };
  edges: readonly AuditEdge[];
  per_peer_audit_debt: Readonly<Record<string, number>>;
  balances: readonly ReciprocationBalance[];
};

type BuildArgs = {
  messages: readonly ChannelMessage[];
  metadata: ChannelMetadata;
  bodies_by_ref: ReadonlyMap<string, string>;
  channel_id: string;
  window: { start_ms: number; end_ms: number };
};

function resolveAuditorIdentity(
  message: ChannelMessage,
  metadata: ChannelMetadata,
): string | null {
  if (message.identity !== undefined && message.identity.length > 0) {
    return message.identity;
  }
  const identities = metadata.identities;
  if (identities === undefined) return null;
  for (const [letter, claim] of Object.entries(identities)) {
    if (claim.session_id === message.from) return letter;
  }
  return null;
}

function resolveMessageBody(
  message: ChannelMessage,
  bodies_by_ref: ReadonlyMap<string, string>,
): string | null {
  if (message.body !== undefined) return message.body;
  if (message.body_ref !== undefined) {
    const fromMap = bodies_by_ref.get(message.body_ref);
    if (fromMap !== undefined) return fromMap;
  }
  return null;
}

function canonicalPairKey(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}

export function buildReciprocationGraph(args: BuildArgs): ReciprocationGraph {
  const { messages, metadata, bodies_by_ref, channel_id, window } = args;
  const { start_ms, end_ms } = window;
  const edges: AuditEdge[] = [];

  for (const m of messages) {
    if (m.kind !== "audit-verdict") continue;
    const ts_ms = Date.parse(m.ts);
    if (!Number.isFinite(ts_ms)) continue;
    if (ts_ms < start_ms || ts_ms > end_ms) continue;
    const bodyRaw = resolveMessageBody(m, bodies_by_ref);
    if (bodyRaw === null) continue;
    const body = parseAuditVerdictBody(bodyRaw);
    if (body === null) continue;
    const auditor = resolveAuditorIdentity(m, metadata);
    if (auditor === null) continue;
    edges.push({
      ts: m.ts,
      auditor_identity: auditor,
      auditor_session: m.from,
      target_peer: body.target_peer,
      target_pr: { repo: body.target_pr.repo, number: body.target_pr.number },
      verdict: body.verdict,
      audit_class: body.audit_class,
    });
  }

  edges.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const given = new Map<string, number>();
  const received = new Map<string, number>();
  for (const e of edges) {
    given.set(e.auditor_identity, (given.get(e.auditor_identity) ?? 0) + 1);
    received.set(e.target_peer, (received.get(e.target_peer) ?? 0) + 1);
  }
  const debt: Record<string, number> = {};
  const allIdentities = new Set<string>([...given.keys(), ...received.keys()]);
  for (const id of allIdentities) {
    debt[id] = (received.get(id) ?? 0) - (given.get(id) ?? 0);
  }

  const pairCounts = new Map<string, { a_to_b: number; b_to_a: number }>();
  const pairKeys = new Map<string, readonly [string, string]>();
  for (const e of edges) {
    const pair = canonicalPairKey(e.auditor_identity, e.target_peer);
    if (pair[0] === pair[1]) continue;
    const key = `${pair[0]}|${pair[1]}`;
    const counts = pairCounts.get(key) ?? { a_to_b: 0, b_to_a: 0 };
    if (e.auditor_identity === pair[0]) {
      counts.a_to_b += 1;
    } else {
      counts.b_to_a += 1;
    }
    pairCounts.set(key, counts);
    pairKeys.set(key, pair);
  }
  const balances: ReciprocationBalance[] = [];
  for (const [key, counts] of pairCounts) {
    const pair = pairKeys.get(key);
    if (pair === undefined) continue;
    balances.push({
      pair,
      a_to_b: counts.a_to_b,
      b_to_a: counts.b_to_a,
      net: counts.a_to_b - counts.b_to_a,
    });
  }
  balances.sort((a, b) =>
    a.pair[0] < b.pair[0]
      ? -1
      : a.pair[0] > b.pair[0]
        ? 1
        : a.pair[1] < b.pair[1]
          ? -1
          : a.pair[1] > b.pair[1]
            ? 1
            : 0,
  );

  return {
    channel_id,
    window: { start_ms, end_ms },
    edges,
    per_peer_audit_debt: debt,
    balances,
  };
}
