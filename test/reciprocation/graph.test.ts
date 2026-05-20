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

function makeVerdictBody(opts: {
  target_peer: string;
  pr_number: number;
  verdict?: "SHIP-CLEAN" | "SHIP-WITH-FOLDS" | "NEEDS-REWORK";
  audit_class?: "inside-pair";
}): string {
  return JSON.stringify({
    kind_version: 1,
    target_pr: { repo: "claude-conductor", number: opts.pr_number },
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
  });
}

function makeVerdict(opts: {
  ts: string;
  from: string;
  identity: string;
  target_peer: string;
  pr_number: number;
  verdict?: "SHIP-CLEAN" | "SHIP-WITH-FOLDS" | "NEEDS-REWORK";
}): ChannelMessage {
  return {
    ts: opts.ts,
    from: opts.from,
    kind: "audit-verdict",
    identity: opts.identity,
    body: makeVerdictBody({
      target_peer: opts.target_peer,
      pr_number: opts.pr_number,
      ...(opts.verdict !== undefined ? { verdict: opts.verdict } : {}),
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
