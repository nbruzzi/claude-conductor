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

import { parseAuditVerdictBodyAnyVersion } from "../channels/audit-verdict.ts";
import type { AuditClass, AuditVerdict } from "../channels/audit-types.ts";
import type { ChannelMessage } from "../channels/index.ts";
import { isSubstrateClassPR } from "../channels/substrate-class.ts";

/**
 * A single audit edge — one auditor-to-target verdict in the window.
 * Auditor identity = message.identity (NATO letter stamped at post-time
 * per Phase 1 ChannelMessage schema). Messages without identity are
 * skipped — mirrors `audits/queue.ts` skip-pattern + assumes Slice 2
 * audit-verdict messages are identity-stamped at send-time.
 */
export type AuditEdge = {
  ts: string;
  auditor_identity: string;
  auditor_session: string;
  target_peer: string;
  target_pr: { repo: string; number: number };
  verdict: AuditVerdict;
  audit_class: AuditClass;
  /**
   * Cross-edge consumer-edges the auditor verified, when the audit-
   * verdict body provided them. Absent (`undefined`) for verdicts that
   * pre-date the field OR for non-substrate-class PRs where the field
   * is optional. Empty-array means "auditor explicitly listed none" —
   * distinct from absent. Per
   * `feedback-audit-cohort-missed-cross-edge-shim-consumer`.
   */
  cross_edge_consumers_verified?: readonly string[];
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
  /**
   * Per-peer cross-edge-consumer coverage aggregate. Each entry counts
   * audit-verdicts the peer AUTHORED that included non-empty
   * `cross_edge_consumers_verified`. Surfacing primitive for the
   * audit-cohort-blind-spot signal: a peer whose verdicts uniformly
   * omit the field (count == 0 while audit-edges > 0) is the
   * substrate-side-focused-lens-set pattern caught at cycle 2026-05-25
   * PR #119 (per `feedback-audit-cohort-missed-cross-edge-shim-consumer`).
   * Pre-PR-#120 verdicts (no field) are excluded from numerator AND
   * denominator — only verdicts that COULD have included the field
   * count.
   */
  cross_edge_coverage_by_peer: Readonly<
    Record<string, { with_consumers: number; total_substrate_class: number }>
  >;
};

type BuildArgs = {
  messages: readonly ChannelMessage[];
  bodies_by_ref: ReadonlyMap<string, string>;
  channel_id: string;
  window: { start_ms: number; end_ms: number };
};

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
  const { messages, bodies_by_ref, channel_id, window } = args;
  const { start_ms, end_ms } = window;
  const edges: AuditEdge[] = [];

  for (const m of messages) {
    if (m.kind !== "audit-verdict") continue;
    if (m.identity === undefined || m.identity.length === 0) continue;
    const ts_ms = Date.parse(m.ts);
    if (!Number.isFinite(ts_ms)) continue;
    if (ts_ms < start_ms || ts_ms > end_ms) continue;
    const bodyRaw = resolveMessageBody(m, bodies_by_ref);
    if (bodyRaw === null) continue;
    const body = parseAuditVerdictBodyAnyVersion(bodyRaw);
    if (body === null) continue;
    // b2: the reciprocation graph is PR-only for now; plan-target verdicts are
    // deferred to the full-migration fast-follow (Golf's b2 map) — skip them
    // (not dropped from the channel, only from the auto-reciprocation graph).
    if (body.target.kind !== "pr") continue;
    edges.push({
      ts: m.ts,
      auditor_identity: m.identity,
      auditor_session: m.from,
      target_peer: body.target_peer,
      target_pr: { repo: body.target.repo, number: body.target.number },
      verdict: body.verdict,
      audit_class: body.audit_class,
      ...(body.cross_edge_consumers_verified !== undefined
        ? { cross_edge_consumers_verified: body.cross_edge_consumers_verified }
        : {}),
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

  // Cross-edge coverage aggregate per auditor identity. Denominator counts
  // substrate-class verdicts where the auditor's body included the field
  // (present + array — including empty); numerator counts those with non-
  // empty array. Verdicts whose body pre-dates the field (undefined) are
  // excluded from BOTH; only schema-aware substrate-class verdicts count.
  const coverage: Record<
    string,
    { with_consumers: number; total_substrate_class: number }
  > = {};
  for (const e of edges) {
    if (!isSubstrateClassPR(e.target_pr)) continue;
    if (e.cross_edge_consumers_verified === undefined) continue;
    const entry = coverage[e.auditor_identity] ?? {
      with_consumers: 0,
      total_substrate_class: 0,
    };
    entry.total_substrate_class += 1;
    if (e.cross_edge_consumers_verified.length > 0) entry.with_consumers += 1;
    coverage[e.auditor_identity] = entry;
  }

  return {
    channel_id,
    window: { start_ms, end_ms },
    edges,
    per_peer_audit_debt: debt,
    balances,
    cross_edge_coverage_by_peer: coverage,
  };
}
