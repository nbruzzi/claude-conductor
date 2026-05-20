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
  /**
   * NULL semantic (Bravo N4 + Charlie N1 from 3-lens audit):
   * `introducing_event === null` means the symbol's TRUE first appearance
   * predates the scanned window. Operator passed events that begin
   * mid-propagation; absorbing_events list the in-window references.
   * Distinguish from "symbol doesn't exist" — in that case, the entire
   * graph is empty (no introducing + no absorbing + empty peers).
   */
  introducing_event: PropagationEvent | null;
  absorbing_events: readonly PropagationEvent[];
  /**
   * Sorted ALPHABETICAL ASCENDING per F1 deterministic-sort fold
   * (Charlie N2 invariant). Consumer should NOT re-sort.
   */
  distinct_peers: readonly string[];
  distinct_peers_count: number;
  latency_to_first_absorption_ms: number | null;
  latency_to_cross_author_absorption_ms: number | null;
  memory_suggest_triggered: boolean;
  /**
   * When `memory_suggest_triggered === true`, this field follows the
   * template (Charlie N3 specification):
   *   "threshold N=<K> met: distinct_peers=[<A>,<B>,...]; absorbing_events=<count>"
   * Machine-parseable. Null when threshold not met.
   */
  memory_suggest_reason: string | null;
};

export type AggregateOptions = {
  /**
   * When provided, events with ts < window.start_ms OR ts > window.end_ms
   * are excluded from the absorbing list. If the chronologically-first
   * event in the full input falls BEFORE window.start_ms, `introducing_event`
   * is set to null (the introducing happened pre-window) per Charlie N1
   * window-boundary semantic. The CLI scope-introducing strict mode is
   * implemented at this boundary.
   *
   * When window is undefined (default), legacy behavior: first event in
   * input chronologically = introducing.
   */
  window?: { start_ms: number; end_ms: number };
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
 *
 * Window-boundary semantic (Charlie N1 fold): when `options.window` is
 * provided AND the chronologically-first event predates window.start_ms,
 * `introducing_event` is null + all in-window events are absorbing.
 * This catches the substrate-self-validation case where a symbol
 * pre-existed but is referenced within a query window.
 */
export function aggregateGraph(
  events: readonly RawEvent[],
  symbol: string,
  threshold: number,
  options: AggregateOptions = {},
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

  // Charlie N1 fold: window-boundary semantic. When window provided AND
  // the chronologically-first event predates window.start_ms, introducing
  // happened pre-window — set introducing_event=null + filter in-window
  // events as absorbing only.
  const window = options.window;
  const firstTsMs = Date.parse(first.ts);
  const introducingIsPreWindow =
    window !== undefined && firstTsMs < window.start_ms;

  const inWindowEvents = window
    ? sorted.filter((e) => {
        const ms = Date.parse(e.ts);
        return ms >= window.start_ms && ms <= window.end_ms;
      })
    : sorted;

  const introducing_event: PropagationEvent | null = introducingIsPreWindow
    ? null
    : (() => {
        const head = inWindowEvents[0];
        if (head === undefined) return null;
        return {
          symbol,
          kind: "introducing",
          source_kind: head.source_kind,
          source_ref: head.source_ref,
          ts: head.ts,
          author: head.author,
        };
      })();

  const absorbingRawSource =
    introducing_event === null ? inWindowEvents : inWindowEvents.slice(1);
  const absorbing_events: PropagationEvent[] = absorbingRawSource.map((e) => ({
    symbol,
    kind: "absorbing",
    source_kind: e.source_kind,
    source_ref: e.source_ref,
    ts: e.ts,
    author: e.author,
  }));

  const peerSet = new Set<string>();
  if (introducing_event !== null) peerSet.add(introducing_event.author);
  for (const e of absorbing_events) {
    peerSet.add(e.author);
  }
  const distinct_peers = Array.from(peerSet).sort();

  const introducingTsMs =
    introducing_event === null ? null : Date.parse(introducing_event.ts);
  const firstAbsorbing = absorbing_events[0];
  const latency_to_first_absorption_ms =
    firstAbsorbing === undefined || introducingTsMs === null
      ? null
      : Date.parse(firstAbsorbing.ts) - introducingTsMs;

  const firstCrossAuthor =
    introducing_event === null
      ? undefined
      : absorbing_events.find((e) => e.author !== introducing_event.author);
  const latency_to_cross_author_absorption_ms =
    firstCrossAuthor === undefined || introducingTsMs === null
      ? null
      : Date.parse(firstCrossAuthor.ts) - introducingTsMs;

  const memory_suggest_triggered = distinct_peers.length >= threshold;
  // Charlie N3 templated format: machine-parseable for consumer extraction.
  const memory_suggest_reason = memory_suggest_triggered
    ? `threshold N=${threshold} met: distinct_peers=[${distinct_peers.join(",")}]; absorbing_events=${absorbing_events.length}`
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
