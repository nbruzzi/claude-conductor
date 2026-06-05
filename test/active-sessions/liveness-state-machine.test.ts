// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * C1 S4-slim — the formalized liveness STATE MACHINE table (RFC #200 §3.5).
 *
 * This file pins the `LIVENESS_TRANSITIONS` table: the formalized lifecycle, each
 * edge carrying an explicit signal. The CLASSIFICATION of the observable states
 * (live / likely-dead / stale) is NOT re-implemented here — it is S1's
 * `classifySessionLiveness` (mtime OR-compose) gated by S2's pid protect, pinned
 * at the integration level in liveness-contract.test.ts. This is a pure-data
 * test of the table, so it needs no heartbeat sandbox.
 *
 * S4-slim (Alpha cohort call, 2026-06-05): formalize the SHIPPED + lifecycle
 * states only — `live -> likely-dead -> stale -> gc'd(--apply) -> reclaimed`,
 * `paused` orthogonal. The 2-sweep states (suspected-dead / confirmed-dead) are
 * OMITTED (they need the CAPPED S3a generation marker). `idle` is kept a NAMED
 * state but is the DEFERRED observe rung (harness `status`, OBSERVE-NOT-INFER) —
 * documented, NOT classified by the substrate this slice.
 */

import { describe, expect, it } from "bun:test";
import {
  LIVENESS_TRANSITIONS,
  type LivenessState,
  type LivenessTransitionKind,
} from "../../src/active-sessions/session-liveness.ts";

const states = (): Set<string> =>
  new Set<string>(LIVENESS_TRANSITIONS.flatMap((t) => [t.from, t.to]));
const hasEdge = (from: LivenessState, to: LivenessState): boolean =>
  LIVENESS_TRANSITIONS.some((t) => t.from === from && t.to === to);
const touchesIdle = (t: { from: LivenessState; to: LivenessState }): boolean =>
  t.from === "idle" || t.to === "idle";
const CLASSIFIABLE_KINDS: readonly LivenessTransitionKind[] = [
  "decay",
  "refresh",
];

describe("LIVENESS_TRANSITIONS — formalized lifecycle (RFC §3.5 S4-slim)", () => {
  it("OMITS the capped 2-sweep states (suspected-dead / confirmed-dead)", () => {
    expect(states().has("suspected-dead")).toBe(false);
    expect(states().has("confirmed-dead")).toBe(false);
  });

  it("covers exactly the S4-slim state set", () => {
    expect(states()).toEqual(
      new Set(["live", "idle", "likely-dead", "stale", "gc'd", "reclaimed"]),
    );
  });

  it("encodes the SHIPPED forward decay path live -> likely-dead -> stale (no idle on the classifiable path)", () => {
    expect(hasEdge("live", "likely-dead")).toBe(true);
    expect(hasEdge("likely-dead", "stale")).toBe(true);
  });

  it("the ONLY state-deleting (operator) edge is stale -> gc'd", () => {
    const operatorEdges = LIVENESS_TRANSITIONS.filter(
      (t) => t.kind === "operator",
    );
    expect(operatorEdges).toHaveLength(1);
    expect(operatorEdges[0]?.from).toBe("stale");
    expect(operatorEdges[0]?.to).toBe("gc'd");
  });

  it("gc'd is reachable ONLY from stale and ONLY via an operator edge (NEVER-auto-kill)", () => {
    const intoGcd = LIVENESS_TRANSITIONS.filter((t) => t.to === "gc'd");
    expect(intoGcd.length).toBeGreaterThan(0);
    expect(intoGcd.every((t) => t.from === "stale")).toBe(true);
    expect(intoGcd.every((t) => t.kind === "operator")).toBe(true);
  });

  it("gc'd -> reclaimed -> live closes the lifecycle", () => {
    expect(hasEdge("gc'd", "reclaimed")).toBe(true);
    expect(hasEdge("reclaimed", "live")).toBe(true);
  });

  it("recovery (refresh) edges exist — liveness is non-monotonic, a silent peer can return", () => {
    const refresh = LIVENESS_TRANSITIONS.filter((t) => t.kind === "refresh");
    expect(refresh.length).toBeGreaterThan(0);
    // A stale (but not yet gc'd) peer must be recoverable to live — the gc'd
    // state is a substrate transition, not a death certificate.
    expect(refresh.some((t) => t.from === "stale" && t.to === "live")).toBe(
      true,
    );
  });

  it("every transition carries an explicit, non-empty signal", () => {
    expect(
      LIVENESS_TRANSITIONS.every(
        (t) => typeof t.signal === "string" && t.signal.length > 0,
      ),
    ).toBe(true);
  });

  // ── idle = the DEFERRED observe rung (OBSERVE-NOT-INFER) ──

  it("idle is present, but ONLY on observe-kind edges (never hand-rolled / inferred)", () => {
    expect(states().has("idle")).toBe(true);
    const idleEdges = LIVENESS_TRANSITIONS.filter(touchesIdle);
    expect(idleEdges.length).toBeGreaterThan(0);
    expect(idleEdges.every((t) => t.kind === "observe")).toBe(true);
  });

  it("the classifiable (decay/refresh) edges NEVER touch idle — it is off the mtime-classified path", () => {
    const classifiable = LIVENESS_TRANSITIONS.filter((t) =>
      CLASSIFIABLE_KINDS.includes(t.kind),
    );
    expect(classifiable.every((t) => !touchesIdle(t))).toBe(true);
  });

  it("observe (idle) edges are marked DEFERRED and reference the harness OBSERVE-NOT-INFER rung", () => {
    const observe = LIVENESS_TRANSITIONS.filter((t) => t.kind === "observe");
    expect(observe.length).toBeGreaterThan(0);
    expect(observe.every((t) => touchesIdle(t))).toBe(true);
    expect(
      observe.every(
        (t) =>
          t.signal.includes("DEFERRED") &&
          t.signal.includes("OBSERVE-NOT-INFER"),
      ),
    ).toBe(true);
  });

  it("the transition set is CLOSED — exactly the sanctioned edges, no spurious additions", () => {
    // A self-closing table: a bogus edge fails membership; a missing/extra edge
    // fails the length. Without this, a spurious non-gc'd edge passes silently.
    const sanctioned = new Set([
      "live|likely-dead|decay",
      "likely-dead|stale|decay",
      "likely-dead|live|refresh",
      "stale|live|refresh",
      "stale|gc'd|operator",
      "gc'd|reclaimed|lifecycle",
      "reclaimed|live|lifecycle",
      "live|idle|observe",
      "idle|live|observe",
    ]);
    expect(LIVENESS_TRANSITIONS).toHaveLength(sanctioned.size);
    for (const t of LIVENESS_TRANSITIONS) {
      expect(sanctioned.has(`${t.from}|${t.to}|${t.kind}`)).toBe(true);
    }
  });
});
