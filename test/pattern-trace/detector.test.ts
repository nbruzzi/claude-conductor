// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for pattern-trace detector D1 (Tier 3-D).
 *
 * Coverage per plan §8 D1 test plan:
 *   - empty inputs → empty graph
 *   - single introducing event → graph has introducing + empty absorbing + memory-suggest false
 *   - introducing + 1 absorbing (same author) → graph fires NEITHER cross-author NOR threshold
 *   - introducing + 2 absorbing (3 distinct peers) → threshold fires; memory_suggest_triggered=true
 *   - latency calc: introducing@T1 + absorbing@T2 → first-absorption-latency = T2-T1
 *   - cross-author latency: introducing by Alpha + absorbing by Alpha + Bravo → cross-author = Bravo-event - introducing
 *   - deterministic sort: events by ts ASC, ties broken by source_ref
 *   - peers list dedupe + alphabetical
 *
 * Plus buildMemoryProposalPayload V2-schema-conformance tests.
 *
 * Plan: slice-T3D-pattern-trace-2026-05-20.md v0.1.
 */

import { describe, expect, it } from "bun:test";

import {
  aggregateGraph,
  buildMemoryProposalPayload,
  type RawEvent,
} from "../../src/pattern-trace/detector.ts";

const ALPHA_INTRODUCING: RawEvent = {
  source_kind: "git",
  source_ref: "abc12345",
  ts: "2026-05-20T10:00:00.000Z",
  author: "Alpha",
};

describe("aggregateGraph", () => {
  it("empty inputs → empty graph", () => {
    const g = aggregateGraph([], "X", 3);
    expect(g.introducing_event).toBeNull();
    expect(g.absorbing_events).toEqual([]);
    expect(g.distinct_peers_count).toBe(0);
    expect(g.memory_suggest_triggered).toBe(false);
  });

  it("single event → introducing only, no absorbing, no threshold fire", () => {
    const g = aggregateGraph([ALPHA_INTRODUCING], "X", 3);
    expect(g.introducing_event?.author).toBe("Alpha");
    expect(g.absorbing_events).toEqual([]);
    expect(g.latency_to_first_absorption_ms).toBeNull();
    expect(g.latency_to_cross_author_absorption_ms).toBeNull();
    expect(g.memory_suggest_triggered).toBe(false);
  });

  it("introducing + 1 absorbing (same author) → no cross-author + no threshold@3", () => {
    const events: RawEvent[] = [
      ALPHA_INTRODUCING,
      {
        source_kind: "git",
        source_ref: "def67890",
        ts: "2026-05-20T11:00:00.000Z",
        author: "Alpha",
      },
    ];
    const g = aggregateGraph(events, "X", 3);
    expect(g.absorbing_events).toHaveLength(1);
    expect(g.distinct_peers_count).toBe(1);
    expect(g.latency_to_first_absorption_ms).toBe(3600000);
    expect(g.latency_to_cross_author_absorption_ms).toBeNull();
    expect(g.memory_suggest_triggered).toBe(false);
  });

  it("introducing + 2 cross-author absorbing → threshold fires at K=3", () => {
    const events: RawEvent[] = [
      ALPHA_INTRODUCING,
      {
        source_kind: "git",
        source_ref: "bravo-sha",
        ts: "2026-05-20T11:00:00.000Z",
        author: "Bravo",
      },
      {
        source_kind: "channel",
        source_ref: "channel/x:y",
        ts: "2026-05-20T12:00:00.000Z",
        author: "Charlie",
      },
    ];
    const g = aggregateGraph(events, "X", 3);
    expect(g.distinct_peers_count).toBe(3);
    expect(g.distinct_peers).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(g.memory_suggest_triggered).toBe(true);
    expect(g.memory_suggest_reason).toContain("3 distinct peers");
  });

  it("cross-author latency skips same-author absorbing", () => {
    const events: RawEvent[] = [
      ALPHA_INTRODUCING,
      {
        source_kind: "git",
        source_ref: "alpha-abs",
        ts: "2026-05-20T10:30:00.000Z",
        author: "Alpha",
      },
      {
        source_kind: "git",
        source_ref: "bravo-abs",
        ts: "2026-05-20T11:00:00.000Z",
        author: "Bravo",
      },
    ];
    const g = aggregateGraph(events, "X", 3);
    expect(g.latency_to_first_absorption_ms).toBe(1800000);
    expect(g.latency_to_cross_author_absorption_ms).toBe(3600000);
  });

  it("deterministic sort by ts ASC, ties broken by source_ref", () => {
    const sameTs = "2026-05-20T10:00:00.000Z";
    const events: RawEvent[] = [
      {
        source_kind: "git",
        source_ref: "zzz",
        ts: sameTs,
        author: "Alpha",
      },
      {
        source_kind: "git",
        source_ref: "aaa",
        ts: sameTs,
        author: "Bravo",
      },
    ];
    const g = aggregateGraph(events, "X", 3);
    expect(g.introducing_event?.source_ref).toBe("aaa");
    expect(g.absorbing_events[0]?.source_ref).toBe("zzz");
  });

  it("peers deduped + alphabetical", () => {
    const events: RawEvent[] = [
      {
        source_kind: "git",
        source_ref: "c1",
        ts: "2026-05-20T10:00:00.000Z",
        author: "Delta",
      },
      {
        source_kind: "git",
        source_ref: "c2",
        ts: "2026-05-20T11:00:00.000Z",
        author: "Alpha",
      },
      {
        source_kind: "git",
        source_ref: "c3",
        ts: "2026-05-20T12:00:00.000Z",
        author: "Alpha",
      },
    ];
    const g = aggregateGraph(events, "X", 3);
    expect(g.distinct_peers).toEqual(["Alpha", "Delta"]);
    expect(g.distinct_peers_count).toBe(2);
  });

  it("operator-tunable threshold (K=2) fires earlier", () => {
    const events: RawEvent[] = [
      ALPHA_INTRODUCING,
      {
        source_kind: "git",
        source_ref: "bravo-sha",
        ts: "2026-05-20T11:00:00.000Z",
        author: "Bravo",
      },
    ];
    const g = aggregateGraph(events, "X", 2);
    expect(g.distinct_peers_count).toBe(2);
    expect(g.memory_suggest_triggered).toBe(true);
  });
});

describe("buildMemoryProposalPayload", () => {
  it("returns null when threshold not met", () => {
    const g = aggregateGraph([ALPHA_INTRODUCING], "X", 3);
    expect(buildMemoryProposalPayload(g)).toBeNull();
  });

  it("returns V2-schema-conforming payload when threshold met", () => {
    const events: RawEvent[] = [
      ALPHA_INTRODUCING,
      {
        source_kind: "git",
        source_ref: "bravo-sha",
        ts: "2026-05-20T11:00:00.000Z",
        author: "Bravo",
      },
      {
        source_kind: "git",
        source_ref: "charlie-sha",
        ts: "2026-05-20T12:00:00.000Z",
        author: "Charlie",
      },
    ];
    const g = aggregateGraph(events, "FuzzyPattern", 3);
    const payload = buildMemoryProposalPayload(g);
    expect(payload).not.toBeNull();
    expect(payload?.kind_version).toBe(1);
    expect(payload?.candidate_name).toContain("fuzzypattern");
    expect(payload?.memory_type).toBe("feedback");
    expect(payload?.amends_existing).toBeNull();
    expect(payload?.reason).toContain("Alpha");
    expect(payload?.reason).toContain("Cross-author latency");
  });
});
