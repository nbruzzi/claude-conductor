// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `inferBandwidthState` + `inferBandwidth` pure logic (Slice
 * 3 Layer 3 of Tier 1 schemas+coord substrate).
 *
 * Coverage matches plan §Test plan Phase 2 (inference subset):
 *
 *   T2.10  STALE: heartbeat_age_ms = null
 *   T2.11  STALE: heartbeat_age_ms > BANDWIDTH_STALE_AGE_MS
 *   T2.12  SATURATED (overflow): open_audit_asks = 3
 *   T2.13  SATURATED (busy-authoring): density HIGH + 0 audits delivered
 *   T2.14  ACTIVE: density LOW (boundary) + 1 audit delivered
 *   T2.15  IDLE-AVAILABLE: density 0 + heartbeat fresh
 *   T2.16  STALE precedes SATURATED (decision order)
 *   T2.17  SATURATED precedes ACTIVE (decision order)
 *   T2.18  threshold-boundary tests (±1 around each constant)
 *
 * Plus composer tests for `inferBandwidth`:
 *
 *   C1  derives msg_density_30min from in-window messages
 *   C2  derives audits_delivered_90min from in-window valid verdicts
 *   C3  derives open_audit_asks via queryPendingAuditAsks integration
 *   C4  excludes out-of-window messages
 *   C5  resolves body_ref for verdict count
 *
 * Plan: ~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md v0.1.
 */

import { describe, expect, it } from "bun:test";

import {
  BANDWIDTH_AUDITS_WINDOW_MS,
  BANDWIDTH_DENSITY_HIGH,
  BANDWIDTH_DENSITY_LOW,
  BANDWIDTH_DENSITY_WINDOW_MS,
  BANDWIDTH_OPEN_ASKS_OVERFLOW,
  BANDWIDTH_STALE_AGE_MS,
  inferBandwidth,
  inferBandwidthState,
} from "../../src/bandwidth/inference.ts";
import { type BandwidthInputs } from "../../src/channels/audit-types.ts";
import { type ChannelMessage } from "../../src/channels/index.ts";

const NOW_MS = Date.parse("2026-05-20T01:00:00Z");

function baseInputs(overrides: Partial<BandwidthInputs> = {}): BandwidthInputs {
  return {
    msg_density_30min: 0,
    audits_delivered_90min: 0,
    heartbeat_age_ms: 1000,
    open_audit_asks: 0,
    ...overrides,
  };
}

describe("inferBandwidthState — T2.10 STALE on heartbeat null", () => {
  it("returns STALE when heartbeat_age_ms is null", () => {
    expect(inferBandwidthState(baseInputs({ heartbeat_age_ms: null }))).toBe(
      "STALE",
    );
  });
});

describe("inferBandwidthState — T2.11 STALE on heartbeat aged out", () => {
  it("returns STALE when heartbeat_age_ms > BANDWIDTH_STALE_AGE_MS", () => {
    expect(
      inferBandwidthState(
        baseInputs({ heartbeat_age_ms: BANDWIDTH_STALE_AGE_MS + 1 }),
      ),
    ).toBe("STALE");
  });
});

describe("inferBandwidthState — T2.12 SATURATED on queue-overflow", () => {
  it("returns SATURATED when open_audit_asks reaches BANDWIDTH_OPEN_ASKS_OVERFLOW", () => {
    expect(
      inferBandwidthState(
        baseInputs({ open_audit_asks: BANDWIDTH_OPEN_ASKS_OVERFLOW }),
      ),
    ).toBe("SATURATED");
  });
});

describe("inferBandwidthState — T2.13 SATURATED on busy-authoring", () => {
  it("returns SATURATED when density HIGH + 0 audits delivered", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_HIGH,
          audits_delivered_90min: 0,
        }),
      ),
    ).toBe("SATURATED");
  });

  it("does NOT return SATURATED when density HIGH but audits>0", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_HIGH,
          audits_delivered_90min: 1,
        }),
      ),
    ).toBe("ACTIVE");
  });
});

describe("inferBandwidthState — T2.14 ACTIVE at density-LOW boundary", () => {
  it("returns ACTIVE at exact LOW threshold + 1 audit delivered", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_LOW,
          audits_delivered_90min: 1,
        }),
      ),
    ).toBe("ACTIVE");
  });
});

describe("inferBandwidthState — T2.15 IDLE-AVAILABLE at zero density", () => {
  it("returns IDLE-AVAILABLE with heartbeat fresh + zero density + no open asks", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: 0,
          audits_delivered_90min: 0,
          heartbeat_age_ms: 0,
          open_audit_asks: 0,
        }),
      ),
    ).toBe("IDLE-AVAILABLE");
  });
});

describe("inferBandwidthState — T2.16 STALE precedes SATURATED", () => {
  it("returns STALE when heartbeat stale AND 3 open asks (STALE wins)", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          heartbeat_age_ms: BANDWIDTH_STALE_AGE_MS + 100,
          open_audit_asks: BANDWIDTH_OPEN_ASKS_OVERFLOW,
        }),
      ),
    ).toBe("STALE");
  });

  it("returns STALE when heartbeat null AND HIGH density (STALE wins)", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          heartbeat_age_ms: null,
          msg_density_30min: BANDWIDTH_DENSITY_HIGH * 2,
          audits_delivered_90min: 0,
        }),
      ),
    ).toBe("STALE");
  });
});

describe("inferBandwidthState — T2.17 SATURATED precedes ACTIVE", () => {
  it("returns SATURATED on 3 open asks + LOW density (overflow wins)", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_LOW,
          open_audit_asks: BANDWIDTH_OPEN_ASKS_OVERFLOW,
        }),
      ),
    ).toBe("SATURATED");
  });
});

describe("inferBandwidthState — T2.18 ±1 threshold boundaries", () => {
  it("heartbeat at exactly STALE_AGE_MS does NOT go STALE (uses >, not >=)", () => {
    expect(
      inferBandwidthState(
        baseInputs({ heartbeat_age_ms: BANDWIDTH_STALE_AGE_MS }),
      ),
    ).not.toBe("STALE");
  });

  it("heartbeat at STALE_AGE_MS + 1 goes STALE", () => {
    expect(
      inferBandwidthState(
        baseInputs({ heartbeat_age_ms: BANDWIDTH_STALE_AGE_MS + 1 }),
      ),
    ).toBe("STALE");
  });

  it("open_audit_asks just below overflow does NOT trigger SATURATED-overflow", () => {
    expect(
      inferBandwidthState(
        baseInputs({ open_audit_asks: BANDWIDTH_OPEN_ASKS_OVERFLOW - 1 }),
      ),
    ).not.toBe("SATURATED");
  });

  it("open_audit_asks at OVERFLOW triggers SATURATED-overflow", () => {
    expect(
      inferBandwidthState(
        baseInputs({ open_audit_asks: BANDWIDTH_OPEN_ASKS_OVERFLOW }),
      ),
    ).toBe("SATURATED");
  });

  it("density just below HIGH + 0 audits returns ACTIVE (not SATURATED-busy)", () => {
    // Delta nit-A absorption: explicit positive assertion `.toBe("ACTIVE")`
    // rather than `.not.toBe("SATURATED")`. Captures the FULL decision-tree
    // outcome at the SATURATED-busy boundary edge — heartbeat fresh +
    // density at HIGH-1=5 (≥ LOW=2) + audits 0 + no open-ask overflow →
    // falls through SATURATED gates to ACTIVE. Sibling sharper-assertion
    // pattern with the rest of T2.18.
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_HIGH - 1,
          audits_delivered_90min: 0,
        }),
      ),
    ).toBe("ACTIVE");
  });

  it("density at HIGH + 0 audits triggers SATURATED-busy", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_HIGH,
          audits_delivered_90min: 0,
        }),
      ),
    ).toBe("SATURATED");
  });

  it("density just below LOW returns IDLE-AVAILABLE", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_LOW - 1,
          audits_delivered_90min: 0,
        }),
      ),
    ).toBe("IDLE-AVAILABLE");
  });

  it("density at LOW (with audits>0 to avoid busy-saturated) returns ACTIVE", () => {
    expect(
      inferBandwidthState(
        baseInputs({
          msg_density_30min: BANDWIDTH_DENSITY_LOW,
          audits_delivered_90min: 1,
        }),
      ),
    ).toBe("ACTIVE");
  });
});

/* -------------------------- composer (inferBandwidth) -------------------------- */

function msg(opts: {
  ts: string;
  identity: string;
  kind: ChannelMessage["kind"];
  body?: string;
  body_ref?: string;
}): ChannelMessage {
  const base: ChannelMessage = {
    ts: opts.ts,
    from: `${opts.identity.toLowerCase()}-sid`,
    identity: opts.identity,
    kind: opts.kind,
  };
  if (opts.body !== undefined) {
    return { ...base, body: opts.body };
  }
  if (opts.body_ref !== undefined) {
    return { ...base, body_ref: opts.body_ref };
  }
  return base;
}

function validVerdictBody(repo = "claude-conductor", number = 99): string {
  return JSON.stringify({
    kind_version: 1,
    target_pr: { repo, number },
    target_peer: "Alpha",
    lens_set_applied: ["RE"],
    audit_class: "inside-pair",
    audit_axes: ["surface"],
    verdict: "SHIP-CLEAN",
    counts: { blocker: 0, fold: 0, nit: 0 },
    three_option_ask: {
      a_ratify: "ok",
      b_fold_if_applicable: null,
      c_reframe_if_applicable: null,
    },
    findings: [],
  });
}

describe("inferBandwidth — C1 derives msg_density_30min", () => {
  it("counts in-window messages from target identity, kind-agnostic", () => {
    const messages: ChannelMessage[] = [
      msg({ ts: "2026-05-20T00:45:00Z", identity: "Bravo", kind: "status" }),
      msg({ ts: "2026-05-20T00:50:00Z", identity: "Bravo", kind: "note" }),
      msg({ ts: "2026-05-20T00:55:00Z", identity: "Bravo", kind: "status" }),
      // out of window (older than 30min before NOW_MS)
      msg({ ts: "2026-05-20T00:20:00Z", identity: "Bravo", kind: "status" }),
      // other identity
      msg({ ts: "2026-05-20T00:55:00Z", identity: "Alpha", kind: "status" }),
    ];
    const result = inferBandwidth({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      heartbeat_age_ms: 5000,
      now_ms: NOW_MS,
    });
    expect(result.inputs.msg_density_30min).toBe(3);
  });
});

describe("inferBandwidth — C2 derives audits_delivered_90min", () => {
  it("counts in-window valid audit-verdict messages from identity", () => {
    const messages: ChannelMessage[] = [
      msg({
        ts: "2026-05-20T00:30:00Z",
        identity: "Bravo",
        kind: "audit-verdict",
        body: validVerdictBody("claude-conductor", 200),
      }),
      msg({
        ts: "2026-05-20T00:45:00Z",
        identity: "Bravo",
        kind: "audit-verdict",
        body: validVerdictBody("claude-conductor", 201),
      }),
      // malformed body — skipped
      msg({
        ts: "2026-05-20T00:50:00Z",
        identity: "Bravo",
        kind: "audit-verdict",
        body: "not json",
      }),
      // out of window (>90min old)
      msg({
        ts: "2026-05-19T22:00:00Z",
        identity: "Bravo",
        kind: "audit-verdict",
        body: validVerdictBody("claude-conductor", 99),
      }),
    ];
    const result = inferBandwidth({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      heartbeat_age_ms: 5000,
      now_ms: NOW_MS,
    });
    expect(result.inputs.audits_delivered_90min).toBe(2);
  });
});

describe("inferBandwidth — C3 derives open_audit_asks via queue", () => {
  it("integrates with queryPendingAuditAsks for open-asks count", () => {
    const askBody = JSON.stringify({
      kind_version: 1,
      target_pr: { repo: "claude-conductor", number: 500 },
      target_peer: "Bravo",
      tier: "1-lens-substantive",
      lens_set_requested: ["RE"],
      audit_class: "inside-pair",
    });
    const messages: ChannelMessage[] = [
      msg({
        ts: "2026-05-20T00:30:00Z",
        identity: "Alpha",
        kind: "audit-ask",
        body: askBody,
      }),
    ];
    const result = inferBandwidth({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      heartbeat_age_ms: 5000,
      now_ms: NOW_MS,
    });
    expect(result.inputs.open_audit_asks).toBe(1);
  });
});

describe("inferBandwidth — C4 window boundary exclusion", () => {
  it("excludes density messages strictly older than densityCutoff", () => {
    const olderThanCutoff = new Date(
      NOW_MS - BANDWIDTH_DENSITY_WINDOW_MS - 1,
    ).toISOString();
    const messages: ChannelMessage[] = [
      msg({ ts: olderThanCutoff, identity: "Bravo", kind: "status" }),
    ];
    const result = inferBandwidth({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      heartbeat_age_ms: 5000,
      now_ms: NOW_MS,
    });
    expect(result.inputs.msg_density_30min).toBe(0);
  });

  it("excludes audit-verdict strictly older than auditsCutoff", () => {
    const olderThanCutoff = new Date(
      NOW_MS - BANDWIDTH_AUDITS_WINDOW_MS - 1,
    ).toISOString();
    const messages: ChannelMessage[] = [
      msg({
        ts: olderThanCutoff,
        identity: "Bravo",
        kind: "audit-verdict",
        body: validVerdictBody(),
      }),
    ];
    const result = inferBandwidth({
      messages,
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      heartbeat_age_ms: 5000,
      now_ms: NOW_MS,
    });
    expect(result.inputs.audits_delivered_90min).toBe(0);
  });
});

describe("inferBandwidth — C5 resolves body_ref for verdict count", () => {
  it("counts verdict whose body lives in bodies_by_ref map", () => {
    const ref = "verdict-ref-1";
    const messages: ChannelMessage[] = [
      msg({
        ts: "2026-05-20T00:30:00Z",
        identity: "Bravo",
        kind: "audit-verdict",
        body_ref: ref,
      }),
    ];
    const bodies = new Map([[ref, validVerdictBody()]]);
    const result = inferBandwidth({
      messages,
      bodies_by_ref: bodies,
      target_identity: "Bravo",
      heartbeat_age_ms: 5000,
      now_ms: NOW_MS,
    });
    expect(result.inputs.audits_delivered_90min).toBe(1);
  });
});

describe("inferBandwidth — composer returns state + inputs", () => {
  it("returns IDLE-AVAILABLE state when no activity + fresh heartbeat", () => {
    const result = inferBandwidth({
      messages: [],
      bodies_by_ref: new Map(),
      target_identity: "Bravo",
      heartbeat_age_ms: 0,
      now_ms: NOW_MS,
    });
    expect(result.state).toBe("IDLE-AVAILABLE");
    expect(result.inputs).toEqual({
      msg_density_30min: 0,
      audits_delivered_90min: 0,
      heartbeat_age_ms: 0,
      open_audit_asks: 0,
    });
  });
});
