// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Pure-logic tests for buildReciprocationGraph (Tier 2 Verb 3).
 *
 * Coverage per plan §7:
 *   - empty messages → empty graph
 *   - single edge Alpha→Bravo SHIP-CLEAN
 *   - symmetric A→B + B→A → net 0
 *   - asymmetric 3 A→B + 1 B→A → net 2
 *   - verdict-mix (SHIP-CLEAN / SHIP-WITH-FOLDS / NEEDS-REWORK) all equal
 *   - window-filter excludes out-of-window
 *   - identity-rotation (post-time identity resolves from message.identity)
 *   - non-audit-verdict messages ignored
 *
 * Plan: ~/.claude/plans/slice-T2V3-reciprocation-cli-2026-05-20.md v0.1.
 */

import { describe, expect, it } from "bun:test";

import { buildReciprocationGraph } from "../../src/reciprocation/graph.ts";
import type { ChannelMessage } from "../../src/channels/index.ts";
import {
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";
import { generateKeypair } from "../../src/channels/key-surface.ts";

function makeVerdictBody(opts: {
  target_peer: string;
  pr_number: number;
  repo?: string;
  verdict?: "SHIP-CLEAN" | "SHIP-WITH-FOLDS" | "NEEDS-REWORK";
  audit_class?: "inside-pair";
  cross_edge_consumers_verified?: readonly string[];
}): string {
  return JSON.stringify({
    kind_version: 1,
    target_pr: {
      repo: opts.repo ?? "claude-conductor",
      number: opts.pr_number,
    },
    target_peer: opts.target_peer,
    lens_set_applied: ["RE"],
    audit_class: opts.audit_class ?? "inside-pair",
    audit_axes: ["surface"],
    verdict: opts.verdict ?? "SHIP-CLEAN",
    counts: { blocker: 0, fold: 0, nit: 0 },
    three_option_ask: {
      a_ratify: "ratify and ship",
      b_fold_if_applicable: null,
      c_reframe_if_applicable: null,
    },
    findings: [],
    ...(opts.cross_edge_consumers_verified !== undefined
      ? { cross_edge_consumers_verified: opts.cross_edge_consumers_verified }
      : {}),
  });
}

function makeVerdict(opts: {
  ts: string;
  from: string;
  identity: string;
  target_peer: string;
  pr_number: number;
  repo?: string;
  verdict?: "SHIP-CLEAN" | "SHIP-WITH-FOLDS" | "NEEDS-REWORK";
  cross_edge_consumers_verified?: readonly string[];
}): ChannelMessage {
  return {
    ts: opts.ts,
    from: opts.from,
    kind: "audit-verdict",
    identity: opts.identity,
    body: makeVerdictBody({
      target_peer: opts.target_peer,
      pr_number: opts.pr_number,
      ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
      ...(opts.verdict !== undefined ? { verdict: opts.verdict } : {}),
      ...(opts.cross_edge_consumers_verified !== undefined
        ? { cross_edge_consumers_verified: opts.cross_edge_consumers_verified }
        : {}),
    }),
  };
}

const FULL_WINDOW = {
  start_ms: Date.parse("2026-05-20T00:00:00.000Z"),
  end_ms: Date.parse("2026-05-21T00:00:00.000Z"),
};

describe("buildReciprocationGraph", () => {
  it("empty messages → empty graph", () => {
    const g = buildReciprocationGraph({
      messages: [],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.edges).toEqual([]);
    expect(g.balances).toEqual([]);
    expect(g.per_peer_audit_debt).toEqual({});
  });

  it("single edge Alpha→Bravo SHIP-CLEAN", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.auditor_identity).toBe("Alpha");
    expect(g.edges[0]?.target_peer).toBe("Bravo");
    expect(g.balances).toHaveLength(1);
    expect(g.balances[0]?.pair).toEqual(["Alpha", "Bravo"]);
    expect(g.balances[0]?.a_to_b).toBe(1);
    expect(g.balances[0]?.b_to_a).toBe(0);
    expect(g.balances[0]?.net).toBe(1);
    expect(g.per_peer_audit_debt).toEqual({ Alpha: -1, Bravo: 1 });
  });

  it("symmetric A→B + B→A → net 0", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
        }),
        makeVerdict({
          ts: "2026-05-20T02:00:00.000Z",
          from: "bravo-sid",
          identity: "Bravo",
          target_peer: "Alpha",
          pr_number: 101,
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.balances).toHaveLength(1);
    expect(g.balances[0]?.net).toBe(0);
    expect(g.per_peer_audit_debt).toEqual({ Alpha: 0, Bravo: 0 });
  });

  it("asymmetric 3 A→B + 1 B→A → net 2 (Alpha gives more)", () => {
    const msgs: ChannelMessage[] = [];
    for (let i = 0; i < 3; i++) {
      msgs.push(
        makeVerdict({
          ts: `2026-05-20T0${i + 1}:00:00.000Z`,
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 200 + i,
        }),
      );
    }
    msgs.push(
      makeVerdict({
        ts: "2026-05-20T10:00:00.000Z",
        from: "bravo-sid",
        identity: "Bravo",
        target_peer: "Alpha",
        pr_number: 300,
      }),
    );
    const g = buildReciprocationGraph({
      messages: msgs,
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.edges).toHaveLength(4);
    expect(g.balances[0]?.net).toBe(2);
    expect(g.per_peer_audit_debt["Bravo"]).toBe(2);
    expect(g.per_peer_audit_debt["Alpha"]).toBe(-2);
  });

  it("verdict-mix counts equally (no quality weighting in V3)", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
          verdict: "SHIP-CLEAN",
        }),
        makeVerdict({
          ts: "2026-05-20T02:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 101,
          verdict: "SHIP-WITH-FOLDS",
        }),
        makeVerdict({
          ts: "2026-05-20T03:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 102,
          verdict: "NEEDS-REWORK",
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.edges).toHaveLength(3);
    expect(g.balances[0]?.net).toBe(3);
  });

  it("window-filter excludes out-of-window verdicts", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-19T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
        }),
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 101,
        }),
        makeVerdict({
          ts: "2026-05-22T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 102,
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.target_pr.number).toBe(101);
  });

  it("identity-rotation: message.identity (post-time) is preserved on the edge", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "bravo-sid",
          identity: "Charlie",
          target_peer: "Delta",
          pr_number: 100,
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.edges[0]?.auditor_identity).toBe("Charlie");
  });

  it("non-audit-verdict messages ignored", () => {
    const g = buildReciprocationGraph({
      messages: [
        {
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          kind: "note",
          identity: "Alpha",
          body: "hello world",
        },
        makeVerdict({
          ts: "2026-05-20T02:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
        }),
        {
          ts: "2026-05-20T03:00:00.000Z",
          from: "bravo-sid",
          kind: "status",
          identity: "Bravo",
          body: "standing by",
        },
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.edges).toHaveLength(1);
  });
});

describe("cross_edge_coverage_by_peer", () => {
  it("substrate-class verdict with non-empty consumers → with_consumers=1, total=1", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
          cross_edge_consumers_verified: ["dotfiles-shim", "dashboard-adapter"],
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.cross_edge_coverage_by_peer).toEqual({
      Alpha: { with_consumers: 1, total_substrate_class: 1 },
    });
  });

  it("substrate-class verdict with empty consumers[] → counted in denominator only", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
          cross_edge_consumers_verified: [],
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.cross_edge_coverage_by_peer).toEqual({
      Alpha: { with_consumers: 0, total_substrate_class: 1 },
    });
  });

  it("substrate-class verdict without consumers field (undefined) → excluded from coverage", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.cross_edge_coverage_by_peer).toEqual({});
    expect(g.edges).toHaveLength(1);
  });

  it("non-substrate-class repo with consumers → excluded from coverage", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Bravo",
          pr_number: 100,
          repo: "claude-conductor-dashboard",
          cross_edge_consumers_verified: ["some-consumer"],
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.cross_edge_coverage_by_peer).toEqual({});
    expect(g.edges).toHaveLength(1);
  });

  it("mixed per-peer aggregation: Alpha 1/2 (one with, one empty, one undefined-excluded); Bravo 2/2", () => {
    const g = buildReciprocationGraph({
      messages: [
        makeVerdict({
          ts: "2026-05-20T01:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Charlie",
          pr_number: 100,
          cross_edge_consumers_verified: ["dotfiles-shim"],
        }),
        makeVerdict({
          ts: "2026-05-20T02:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Charlie",
          pr_number: 101,
          cross_edge_consumers_verified: [],
        }),
        makeVerdict({
          ts: "2026-05-20T03:00:00.000Z",
          from: "alpha-sid",
          identity: "Alpha",
          target_peer: "Charlie",
          pr_number: 102,
        }),
        makeVerdict({
          ts: "2026-05-20T04:00:00.000Z",
          from: "bravo-sid",
          identity: "Bravo",
          target_peer: "Charlie",
          pr_number: 103,
          cross_edge_consumers_verified: ["dashboard-adapter"],
        }),
        makeVerdict({
          ts: "2026-05-20T05:00:00.000Z",
          from: "bravo-sid",
          identity: "Bravo",
          target_peer: "Charlie",
          pr_number: 104,
          cross_edge_consumers_verified: ["dotfiles-shim", "dashboard-adapter"],
        }),
      ],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    expect(g.cross_edge_coverage_by_peer).toEqual({
      Alpha: { with_consumers: 1, total_substrate_class: 2 },
      Bravo: { with_consumers: 2, total_substrate_class: 2 },
    });
    expect(g.edges).toHaveLength(5);
  });
});

describe("buildReciprocationGraph — v0.3 DSSE-wrapped (signed) verdicts", () => {
  it("counts a signed (wrapped) verdict as an edge (regression: was 0 when wrapped-blind)", async () => {
    const kp = await generateKeypair();
    const rawBody = makeVerdictBody({ target_peer: "Bravo", pr_number: 100 });
    const wrappedBody = await wrapAuditVerdictBody(
      JSON.parse(rawBody) as AuditVerdictBody,
      kp.privateKey,
      "Alpha",
    );
    const msg: ChannelMessage = {
      ts: "2026-05-20T01:00:00.000Z",
      from: "alpha-sid",
      kind: "audit-verdict",
      identity: "Alpha",
      body: wrappedBody,
    };
    const g = buildReciprocationGraph({
      messages: [msg],
      bodies_by_ref: new Map(),
      channel_id: "ch",
      window: FULL_WINDOW,
    });
    // Pre-fix: graph.ts used parseAuditVerdictBody (raw-only) → a wrapped body
    // → null → 0 edges (the exact local full-suite failure post-bootstrap).
    // Now graph dispatches via parseAuditVerdictBodyAnyVersion → edge counted.
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.auditor_identity).toBe("Alpha");
    expect(g.edges[0]?.target_peer).toBe("Bravo");
  });
});
