// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Pattern-trace detector (Tier 3-D D1) — pure logic layer.
 *
 * Aggregates timestamped propagation events for a code-symbol across
 * git commits, PR bodies, and channel JSONL into a `PropagationGraph`:
 * introducing event + absorbing events + distinct-peer count + latency
 * metrics (both raw + cross-author) + auto-memory-write trigger.
 *
 * Pure functions; no fs / no spawn. Caller (cli.ts) is responsible for
 * gathering RawEvents from sources; this module classifies + aggregates.
 *
 * Substrate-precedes-consumer: V2 kind=memory-proposal schema is the
 * downstream emission channel when threshold fires (per plan D7).
 *
 * Plan: slice-T3D-pattern-trace-2026-05-20.md v0.1.
 */

export type PropagationSourceKind = "git" | "pr" | "channel";

export type RawEvent = {
  source_kind: PropagationSourceKind;
  source_ref: string;
  ts: string;
  author: string;
};

export type PropagationEvent = {
  symbol: string;
  kind: "introducing" | "absorbing";
  source_kind: PropagationSourceKind;
  source_ref: string;
  ts: string;
  author: string;
};

export type PropagationGraph = {
  symbol: string;
  introducing_event: PropagationEvent | null;
  absorbing_events: readonly PropagationEvent[];
  distinct_peers: readonly string[];
  distinct_peers_count: number;
  latency_to_first_absorption_ms: number | null;
  latency_to_cross_author_absorption_ms: number | null;
  memory_suggest_triggered: boolean;
  memory_suggest_reason: string | null;
};

/**
 * Build a deterministic PropagationGraph from raw events. Sorts events
 * chronologically; first by ts becomes introducing, rest are absorbing.
 *
 * Threshold logic (D5): when `distinct_peers_count >= threshold`, the
 * memory-write suggestion fires. Distinct peers counted across both
 * introducing + absorbing authors.
 *
 * Latency metrics (D4):
 *  - raw: introducing.ts → first absorbing.ts (regardless of author)
 *  - cross-author: introducing.ts → first absorbing.ts where author ≠ introducing-author
 *
 * Deterministic sort (F1 fold): events by ts ASC, ties broken by
 * source_ref ASC; peers alphabetical.
 */
export function aggregateGraph(
  events: readonly RawEvent[],
  symbol: string,
  threshold: number,
): PropagationGraph {
  if (events.length === 0) {
    return {
      symbol,
      introducing_event: null,
      absorbing_events: [],
      distinct_peers: [],
      distinct_peers_count: 0,
      latency_to_first_absorption_ms: null,
      latency_to_cross_author_absorption_ms: null,
      memory_suggest_triggered: false,
      memory_suggest_reason: null,
    };
  }

  const sorted = [...events].sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    if (a.source_ref < b.source_ref) return -1;
    if (a.source_ref > b.source_ref) return 1;
    return 0;
  });

  const first = sorted[0];
  if (first === undefined) {
    return {
      symbol,
      introducing_event: null,
      absorbing_events: [],
      distinct_peers: [],
      distinct_peers_count: 0,
      latency_to_first_absorption_ms: null,
      latency_to_cross_author_absorption_ms: null,
      memory_suggest_triggered: false,
      memory_suggest_reason: null,
    };
  }
  const introducing_event: PropagationEvent = {
    symbol,
    kind: "introducing",
    source_kind: first.source_kind,
    source_ref: first.source_ref,
    ts: first.ts,
    author: first.author,
  };
  const absorbing_events: PropagationEvent[] = sorted.slice(1).map((e) => ({
    symbol,
    kind: "absorbing",
    source_kind: e.source_kind,
    source_ref: e.source_ref,
    ts: e.ts,
    author: e.author,
  }));

  const peerSet = new Set<string>([first.author]);
  for (const e of absorbing_events) {
    peerSet.add(e.author);
  }
  const distinct_peers = Array.from(peerSet).sort();

  const introducingTsMs = Date.parse(introducing_event.ts);
  const firstAbsorbing = absorbing_events[0];
  const latency_to_first_absorption_ms =
    firstAbsorbing === undefined
      ? null
      : Date.parse(firstAbsorbing.ts) - introducingTsMs;

  const firstCrossAuthor = absorbing_events.find(
    (e) => e.author !== introducing_event.author,
  );
  const latency_to_cross_author_absorption_ms =
    firstCrossAuthor === undefined
      ? null
      : Date.parse(firstCrossAuthor.ts) - introducingTsMs;

  const memory_suggest_triggered = distinct_peers.length >= threshold;
  const memory_suggest_reason = memory_suggest_triggered
    ? `${distinct_peers.length} distinct peer${distinct_peers.length === 1 ? "" : "s"} (threshold ${threshold}); pattern shows cross-author absorption signaling adoption`
    : null;

  return {
    symbol,
    introducing_event,
    absorbing_events,
    distinct_peers,
    distinct_peers_count: distinct_peers.length,
    latency_to_first_absorption_ms,
    latency_to_cross_author_absorption_ms,
    memory_suggest_triggered,
    memory_suggest_reason,
  };
}

/**
 * Build a kind=memory-proposal payload from a triggered PropagationGraph
 * (D7 — emit suggestion, NOT auto-file). Returns null when threshold not
 * met.
 *
 * Body fields conform to V2 MemoryProposalBody schema
 * (src/channels/memory-proposal.ts).
 */
export function buildMemoryProposalPayload(graph: PropagationGraph): {
  kind_version: 1;
  candidate_name: string;
  memory_type: "feedback";
  description: string;
  reason: string;
  proposed_body: string;
  amends_existing: null;
} | null {
  if (!graph.memory_suggest_triggered) return null;
  const introducing = graph.introducing_event;
  if (introducing === null) return null;

  const candidate_name = `feedback-pattern-propagation-${graph.symbol.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  const description = `Pattern ${graph.symbol} propagated across ${graph.distinct_peers_count} distinct peers — eligible for memorialization`;
  const reason = [
    `Introduced ${introducing.ts} by ${introducing.author} (${introducing.source_kind}: ${introducing.source_ref}).`,
    `Absorbed by ${graph.absorbing_events.length} subsequent event(s) across peers: ${graph.distinct_peers.join(", ")}.`,
    graph.latency_to_cross_author_absorption_ms !== null
      ? `Cross-author latency: ${Math.round(graph.latency_to_cross_author_absorption_ms / 60000)} min.`
      : "No cross-author absorption observed.",
    "Auto-suggested by pattern-trace per propagation-threshold trigger.",
  ].join(" ");

  return {
    kind_version: 1,
    candidate_name,
    memory_type: "feedback",
    description,
    reason,
    proposed_body: `Pattern ${graph.symbol} surfaced across ${graph.distinct_peers_count} peers. Document the discipline this pattern encodes + how/when to apply.`,
    amends_existing: null,
  };
}
