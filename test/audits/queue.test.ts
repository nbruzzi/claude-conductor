// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `queryPendingAuditAsks` pure logic (Slice 3 Layer 2 of
 * Tier 1 schemas+coord substrate).
 *
 * Coverage matches plan §Test plan Phase 2 (queue subset):
 *
 *   T2.1  happy path — single ask, no verdict, returns 1 pending
 *   T2.2  identity-rotation resilience (Charlie pre+post sid rotation)
 *   T2.3  multi-ask sort: tier-DESC secondary at same waited_minutes
 *   T2.4  wait sort primary: same tier ordered by waited_minutes DESC
 *   T2.5  matching verdict removes ask
 *   T2.5x verdict-from-different-PR doesn't close (surface flag)
 *   T2.6  non-matching verdict (different PR) keeps ask pending
 *   T2.7  verdict-before-ask doesn't match (timing)
 *   T2.8  empty channel → 0 pending
 *   T2.9  body parser null on shape mismatch → skipped, not crashed
 *
 * Plan: ~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md v0.1
 * LOCKED post-Delta cross-pair-shadow RATIFY-AS-STATED.
 */

import { describe, expect, it } from "bun:test";

import { queryPendingAuditAsks } from "../../src/audits/queue.ts";
import { type ChannelMessage } from "../../src/channels/index.ts";

/**
 * Synthetic ask-body factory — defaults to a 3-lens-convergence ask
 * targeting Charlie from Delta on conductor PR #99.
 */
function askBody(opts?: {
  repo?: string;
  number?: number;
  target_peer?: string;
  tier?: "light-touch" | "1-lens-substantive" | "3-lens-convergence";
  audit_class?: "inside-pair" | "outside-pair" | "cross-pair-shadow";
  lenses?: readonly ("RE" | "Architecture" | "TA" | "Security" | "Contract")[];
}): string {
  return JSON.stringify({
    kind_version: 1,
    target_pr: {
      repo: opts?.repo ?? "claude-conductor",
      number: opts?.number ?? 99,
    },
    target_peer: opts?.target_peer ?? "Charlie",
    tier: opts?.tier ?? "3-lens-convergence",
    lens_set_requested: opts?.lenses ?? ["RE", "Architecture", "TA"],
    audit_class: opts?.audit_class ?? "inside-pair",
  });
}

/**
 * Synthetic verdict-body factory — defaults to SHIP-CLEAN with zero
 * findings on conductor PR #99 addressed to Delta.
 */
function verdictBody(opts?: {
  repo?: string;
  number?: number;
  target_peer?: string;
  verdict?: "SHIP-CLEAN" | "SHIP-WITH-FOLDS" | "NEEDS-REWORK";
}): string {
  return JSON.stringify({
    kind_version: 1,
    target_pr: {
      repo: opts?.repo ?? "claude-conductor",
      number: opts?.number ?? 99,
    },
    target_peer: opts?.target_peer ?? "Delta",
    lens_set_applied: ["RE", "Architecture", "TA"],
    audit_class: "inside-pair",
    audit_axes: ["surface", "depth"],
    verdict: opts?.verdict ?? "SHIP-CLEAN",
    counts: { blocker: 0, fold: 0, nit: 0 },
    three_option_ask: {
      a_ratify: "PR cleared",
      b_fold_if_applicable: null,
      c_reframe_if_applicable: null,
    },
    findings: [],
  });
}

/**
 * Build a ChannelMessage with inline body. Sender + identity bind the
 * "who sent" axis; body is the structured payload.
 */
function inlineMsg(opts: {
  ts: string;
  from: string;
  identity: string;
  kind: ChannelMessage["kind"];
  body: string;
}): ChannelMessage {
  return {
    ts: opts.ts,
    from: opts.from,
    identity: opts.identity,
    kind: opts.kind,
    body: opts.body,
  };
}

const NOW_MS = Date.parse("2026-05-20T01:00:00Z");

describe("queryPendingAuditAsks — T2.1 happy path", () => {
  it("returns the single pending ask when no verdict exists", () => {
    const messages: ChannelMessage[] = [
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "delta-sid",
        identity: "Delta",
        kind: "audit-ask",
        body: askBody({ target_peer: "Charlie", number: 100 }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Charlie",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(100);
    expect(out[0]?.from_identity).toBe("Delta");
    expect(out[0]?.waited_minutes).toBe(30);
  });
});

describe("queryPendingAuditAsks — T2.2 identity-rotation resilience", () => {
  it("matches verdict on identity NAME, surviving session-id rotation", () => {
    const messages: ChannelMessage[] = [
      // Ask sent by Charlie's pre-respawn sid c813f872
      inlineMsg({
        ts: "2026-05-19T22:00:00Z",
        from: "c813f872-prior",
        identity: "Charlie",
        kind: "audit-ask",
        body: askBody({ target_peer: "Delta", number: 100 }),
      }),
      // Verdict from Delta's post-respawn sid 17e0ced4 — same identity name
      inlineMsg({
        ts: "2026-05-20T00:32:00Z",
        from: "17e0ced4-current",
        identity: "Delta",
        kind: "audit-verdict",
        body: verdictBody({ number: 100, target_peer: "Charlie" }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Delta",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(0); // verdict closes the ask
  });
});

describe("queryPendingAuditAsks — T2.3 sort secondary tier DESC", () => {
  it("orders 3-lens-convergence ahead of 1-lens-substantive at same waited_minutes", () => {
    // Both asks at SAME ts so waited_minutes is identical; tier breaks tie.
    const messages: ChannelMessage[] = [
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({
          target_peer: "Charlie",
          number: 200,
          tier: "1-lens-substantive",
        }),
      }),
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({
          target_peer: "Charlie",
          number: 201,
          tier: "3-lens-convergence",
        }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Charlie",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.tier).toBe("3-lens-convergence");
    expect(out[1]?.tier).toBe("1-lens-substantive");
  });
});

describe("queryPendingAuditAsks — T2.4 sort primary waited_minutes DESC", () => {
  it("orders three asks at SAME tier by waited_minutes DESC", () => {
    const messages: ChannelMessage[] = [
      // youngest
      inlineMsg({
        ts: "2026-05-20T00:55:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Charlie", number: 300 }),
      }),
      // middle
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Charlie", number: 301 }),
      }),
      // oldest
      inlineMsg({
        ts: "2026-05-19T23:00:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Charlie", number: 302 }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Charlie",
      now_ms: NOW_MS,
    });
    expect(out.map((p) => p.pr_number)).toEqual([302, 301, 300]);
  });
});

describe("queryPendingAuditAsks — T2.5 matching verdict removes ask", () => {
  it("returns 0 pending when a matching verdict closes the ask", () => {
    const messages: ChannelMessage[] = [
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Bravo", number: 99 }),
      }),
      inlineMsg({
        ts: "2026-05-20T00:45:00Z",
        from: "bravo-sid",
        identity: "Bravo",
        kind: "audit-verdict",
        body: verdictBody({ number: 99, target_peer: "Alpha" }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(0);
  });
});

describe("queryPendingAuditAsks — T2.5x verdict-from-different-PR doesn't close", () => {
  it("one ask each for PR 99 and PR 100; verdict only on PR 99 → PR 100 still pending", () => {
    const messages: ChannelMessage[] = [
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Bravo", number: 99 }),
      }),
      inlineMsg({
        ts: "2026-05-20T00:31:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Bravo", number: 100 }),
      }),
      inlineMsg({
        ts: "2026-05-20T00:45:00Z",
        from: "bravo-sid",
        identity: "Bravo",
        kind: "audit-verdict",
        body: verdictBody({ number: 99, target_peer: "Alpha" }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(100);
  });
});

describe("queryPendingAuditAsks — T2.6 non-matching verdict keeps ask pending", () => {
  it("ask for PR 100 + verdict for PR 99 (different) → 1 pending", () => {
    const messages: ChannelMessage[] = [
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Bravo", number: 100 }),
      }),
      inlineMsg({
        ts: "2026-05-20T00:45:00Z",
        from: "bravo-sid",
        identity: "Bravo",
        kind: "audit-verdict",
        body: verdictBody({ number: 99, target_peer: "Alpha" }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(100);
  });
});

describe("queryPendingAuditAsks — T2.7 verdict-before-ask doesn't match", () => {
  it("verdict.ts < ask.ts → ask remains pending (re-ask after prior verdict)", () => {
    const messages: ChannelMessage[] = [
      inlineMsg({
        ts: "2026-05-19T20:00:00Z",
        from: "bravo-sid",
        identity: "Bravo",
        kind: "audit-verdict",
        body: verdictBody({ number: 100, target_peer: "Alpha" }),
      }),
      // Re-ask after the original verdict
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Bravo", number: 100 }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(1);
  });
});

describe("queryPendingAuditAsks — T2.8 empty channel", () => {
  it("returns 0 pending on empty messages", () => {
    const out = queryPendingAuditAsks({
      messages: [],
      bodies_by_ref: new Map(),
      target_identity: "Charlie",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(0);
  });
});

describe("queryPendingAuditAsks — T2.9 body parser null on shape mismatch", () => {
  it("skips malformed audit-ask without crashing", () => {
    const messages: ChannelMessage[] = [
      // Valid ask
      inlineMsg({
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody({ target_peer: "Charlie", number: 100 }),
      }),
      // Malformed (not JSON)
      inlineMsg({
        ts: "2026-05-20T00:31:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: "this is not json",
      }),
      // Malformed (missing fields)
      inlineMsg({
        ts: "2026-05-20T00:32:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body: JSON.stringify({ kind_version: 1, target_pr: {} }),
      }),
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Charlie",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(100);
  });

  it("resolves body via bodies_by_ref when body inline is absent", () => {
    const ref = "ref-12345";
    const messages: ChannelMessage[] = [
      {
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        identity: "Alpha",
        kind: "audit-ask",
        body_ref: ref,
      },
    ];
    const bodies = new Map([
      [ref, askBody({ target_peer: "Charlie", number: 250 })],
    ]);
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: bodies,
      target_identity: "Charlie",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.pr_number).toBe(250);
  });

  it("skips audit-ask without identity stamp (legacy)", () => {
    const messages: ChannelMessage[] = [
      {
        ts: "2026-05-20T00:30:00Z",
        from: "alpha-sid",
        kind: "audit-ask",
        body: askBody({ target_peer: "Charlie", number: 100 }),
        // no identity
      },
    ];
    const out = queryPendingAuditAsks({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Charlie",
      now_ms: NOW_MS,
    });
    expect(out).toHaveLength(0);
  });
});
