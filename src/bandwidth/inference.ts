// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Bandwidth inference pure logic (Tier 1 Slice 3 Layer 3 — coord-
 * primitive consuming Slices 1+2 schemas + Layer 2 queue primitive).
 *
 * Two coupled exports:
 *
 *   - **`inferBandwidthState(inputs)`** — strict pure decision tree over
 *     `BandwidthInputs` returning a `BandwidthState`. Trivial to test;
 *     no channel access required.
 *   - **`inferBandwidth(args)`** — composer that derives the
 *     `BandwidthInputs` from channel state (messages, bodies, identity,
 *     heartbeat, now) then dispatches to `inferBandwidthState`. Returns
 *     `{ state, inputs }` so callers can surface BOTH the decision AND
 *     the artifact-evidence behind it.
 *
 * **Threshold constants** live at this module (per plan Q2 disposition
 * — co-located with the decision logic, not in audit-types.ts SSOT).
 * Future per-environment override is a Tier 2 concern; trivially
 * refactorable via `import * as I` rebinding at call site if a consumer
 * needs different thresholds.
 *
 * **Decision order matters.** The tree is evaluated top-down (STALE
 * dominates everything; queue-overflow precedes density-derived
 * SATURATED; ACTIVE precedes IDLE-AVAILABLE). T2.16/T2.17 cover the
 * order at edges.
 *
 * Plan: ~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md v0.1.
 */

import { queryPendingAuditAsks } from "../audits/queue.ts";
import { parseAuditVerdictBody } from "../channels/audit-verdict.ts";
import {
  type BandwidthInputs,
  type BandwidthState,
} from "../channels/audit-types.ts";
import { type ChannelMessage } from "../channels/index.ts";

/**
 * Message-density (kind-agnostic) HIGH threshold — messages from the
 * identity in the trailing 30min window. At or above triggers
 * SATURATED-if-no-recent-audits-delivered (busy authoring without
 * reciprocating).
 *
 * Calibrated to cycle-2026-05-19 cadence: Bravo authored 9 audits +
 * ~30 status posts in 6 hours = ~6.5 msgs/30min when active.
 */
export const BANDWIDTH_DENSITY_HIGH = 6;

/**
 * Message-density LOW threshold — at or above this engages ACTIVE;
 * below means IDLE-AVAILABLE. Calibrated at 4 msgs/hour minimum to
 * separate "genuinely idle" from "lightly engaged."
 */
export const BANDWIDTH_DENSITY_LOW = 2;

/**
 * Open audit-asks targeting the identity. At or above this count, the
 * peer is SATURATED on queue-overflow — NEW asks should route elsewhere.
 */
export const BANDWIDTH_OPEN_ASKS_OVERFLOW = 3;

/**
 * Heartbeat staleness threshold — past this age, the identity reads
 * as STALE regardless of other inputs. Matches the channel-tier
 * `online`-vs-`stale` boundary used by `channels peers`.
 */
export const BANDWIDTH_STALE_AGE_MS = 30 * 60 * 1000;

/**
 * Density input window — 30 minutes preceding `now_ms`. Messages with
 * `ts` strictly older are excluded.
 */
export const BANDWIDTH_DENSITY_WINDOW_MS = 30 * 60 * 1000;

/**
 * Audits-delivered window — 90 minutes preceding `now_ms`. Verdicts
 * with `ts` strictly older are excluded.
 */
export const BANDWIDTH_AUDITS_WINDOW_MS = 90 * 60 * 1000;

/**
 * Strict pure decision tree mapping `BandwidthInputs` → `BandwidthState`.
 *
 * Order (top-down):
 *
 *   1. `STALE`           — `heartbeat_age_ms` is `null` OR exceeds
 *                          `BANDWIDTH_STALE_AGE_MS`. Heartbeat-loss
 *                          dominates regardless of other inputs.
 *   2. `SATURATED`       — `open_audit_asks >= BANDWIDTH_OPEN_ASKS_OVERFLOW`.
 *                          Queue-overflow signal (route NEW asks elsewhere).
 *   3. `SATURATED`       — `msg_density_30min >= BANDWIDTH_DENSITY_HIGH`
 *                          AND `audits_delivered_90min === 0`. Busy-
 *                          authoring without reciprocating.
 *   4. `ACTIVE`          — `msg_density_30min >= BANDWIDTH_DENSITY_LOW`.
 *                          Engaged; messages flowing.
 *   5. `IDLE-AVAILABLE`  — otherwise (heartbeat fresh, low density, no
 *                          open-ask overflow). Available for routing.
 *
 * Pure function — no I/O, no clock access, no global state.
 */
export function inferBandwidthState(inputs: BandwidthInputs): BandwidthState {
  if (
    inputs.heartbeat_age_ms === null ||
    inputs.heartbeat_age_ms > BANDWIDTH_STALE_AGE_MS
  ) {
    return "STALE";
  }
  if (inputs.open_audit_asks >= BANDWIDTH_OPEN_ASKS_OVERFLOW) {
    return "SATURATED";
  }
  if (
    inputs.msg_density_30min >= BANDWIDTH_DENSITY_HIGH &&
    inputs.audits_delivered_90min === 0
  ) {
    return "SATURATED";
  }
  if (inputs.msg_density_30min >= BANDWIDTH_DENSITY_LOW) {
    return "ACTIVE";
  }
  return "IDLE-AVAILABLE";
}

/**
 * Inputs to `inferBandwidth` composer. Pure-args; CLI layer reads I/O
 * and passes through.
 */
export type InferBandwidthArgs = {
  /** All messages on the channel, oldest-first. */
  messages: readonly ChannelMessage[];
  /** Body store for `body_ref`-stored messages. */
  bodies_by_ref: ReadonlyMap<string, string>;
  /** NATO identity being inferred-on (e.g., `"Bravo"`). */
  target_identity: string;
  /** Heartbeat age in milliseconds. `null` when identity has no
   *  heartbeat sentinel on the channel. Caller (CLI layer) computes
   *  via `now_ms - heartbeatMtime(channel, sid)`. */
  heartbeat_age_ms: number | null;
  /** Clock now (epoch ms). Caller passes `Date.now()`. */
  now_ms: number;
};

/**
 * Composer that derives `BandwidthInputs` from channel state then
 * dispatches to `inferBandwidthState`. Returns BOTH the state AND the
 * inputs so callers can surface artifact-evidence.
 *
 * Derivation:
 *
 *   - `msg_density_30min`     — count of messages with
 *                                `identity === target_identity` AND
 *                                `ts_ms >= now_ms - BANDWIDTH_DENSITY_WINDOW_MS`.
 *                                Kind-agnostic (any message, including
 *                                status / note / audit-ask / audit-verdict).
 *   - `audits_delivered_90min` — count of messages with
 *                                `kind === "audit-verdict"` AND
 *                                `identity === target_identity` AND
 *                                `ts_ms >= now_ms - BANDWIDTH_AUDITS_WINDOW_MS`
 *                                AND body parses successfully.
 *   - `heartbeat_age_ms`      — pass-through from args.
 *   - `open_audit_asks`       — `queryPendingAuditAsks` length (Layer 2
 *                                pure logic; identity-rotation-resilient).
 */
export function inferBandwidth(args: InferBandwidthArgs): {
  state: BandwidthState;
  inputs: BandwidthInputs;
} {
  const { messages, bodies_by_ref, target_identity, heartbeat_age_ms, now_ms } =
    args;

  const densityCutoff = now_ms - BANDWIDTH_DENSITY_WINDOW_MS;
  const auditsCutoff = now_ms - BANDWIDTH_AUDITS_WINDOW_MS;

  let msgDensity = 0;
  let auditsDelivered = 0;

  for (const m of messages) {
    if (m.identity !== target_identity) continue;
    const ts_ms = Date.parse(m.ts);
    if (!Number.isFinite(ts_ms)) continue;

    if (ts_ms >= densityCutoff) {
      msgDensity += 1;
    }

    if (m.kind === "audit-verdict" && ts_ms >= auditsCutoff) {
      const raw =
        m.body !== undefined
          ? m.body
          : m.body_ref !== undefined
            ? (bodies_by_ref.get(m.body_ref) ?? null)
            : null;
      if (raw === null) continue;
      if (parseAuditVerdictBody(raw) === null) continue;
      auditsDelivered += 1;
    }
  }

  const pending = queryPendingAuditAsks({
    messages,
    bodies_by_ref,
    target_identity,
    now_ms,
  });

  const inputs: BandwidthInputs = {
    msg_density_30min: msgDensity,
    audits_delivered_90min: auditsDelivered,
    heartbeat_age_ms,
    open_audit_asks: pending.length,
  };

  return { state: inferBandwidthState(inputs), inputs };
}
