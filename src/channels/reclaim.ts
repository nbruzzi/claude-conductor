// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * NATO-letter reclaim-on-staleness reaper primitive.
 *
 * The eternal coordination channel (`COORDINATION_CHANNEL_ID`) is exempt from
 * whole-channel archival (`channel-gc.ts:sweepStale`). That exemption removes
 * the per-cycle archival that used to implicitly recycle the 26-letter NATO
 * identity pool — so dead/crashed sessions' claims would otherwise accumulate
 * forever and eventually exhaust the pool (`claimIdentity` throws
 * `NatoExhaustedError` once all 26 sentinels are live). This reaper is the
 * REQUIRED counterpart of the exemption: neither ships without the other.
 *
 * It reclaims the letters held by DEAD sessions: for each sentinel-backed
 * claim, it asks {@link closeStalePeerIdentity} to release the claim ONLY if
 * its heartbeat is stale beyond `staleThresholdMs` (`force: false` — fresh
 * claims are left untouched), then unlinks the sentinel to free the pool slot.
 * The two-call shape (metadata removal + sentinel unlink) mirrors the
 * `close-peer` / `release-self` CLI verbs exactly.
 *
 * Targets ONLY dead sessions. Clean exits self-release their letter; a live
 * session whose channel heartbeat merely lags during a long tool run
 * (observed 5-9 min on the 2026-06-01 live cohort, where the teammate-idle
 * hook false-positived) stays far inside the threshold the hook wiring
 * applies (24h — the ONLINE-window / dead edge). NO key-revoke: NATO-letter
 * keys are per-letter + persistent and the identity path is unsigned, so
 * reclaiming a dead session's letter never touches its key (key-revoke stays
 * the separate compromise/retirement protocol — D-INT-3).
 *
 * Design: plans-durable/channel-coordination-fixed-eternal-design-2026-05-31.md
 */

import { closeStalePeerIdentity } from "./index.ts";
import {
  listClaims,
  unlinkIdentitySentinelOrLogOrphan,
  type NatoIdentity,
} from "./identity.ts";

/** Outcome of a {@link reclaimStaleIdentities} pass over one channel. */
export type ReclaimResult = {
  /** Letters whose stale claim was released (metadata entry removed) AND
   *  whose sentinel was unlinked — the pool slot is now free. */
  reclaimed: NatoIdentity[];
  /** Letters whose holder heartbeat was fresher than the threshold; the
   *  `force: false` staleness gate left them untouched. */
  skippedActive: NatoIdentity[];
  /** Letters whose metadata entry was removed but whose sentinel unlink
   *  failed with a non-ENOENT code (EACCES/EBUSY/OTHER). The sentinel
   *  persists as an orphan, reclaimable by the orphan-sentinel pass in
   *  `channels-gc-reaper.ts` on a later run. Surfaced for operator
   *  visibility; the pool slot is NOT yet freed for these. */
  stuck: NatoIdentity[];
};

/**
 * Reclaim NATO identity letters held by sessions whose channel heartbeat is
 * stale beyond `staleThresholdMs`. Pure primitive (policy-free): the caller
 * supplies the staleness window. Iterates the sentinel scan
 * ({@link listClaims}) because the 26 sentinel files ARE the pool slots that
 * `claimIdentity` walks.
 *
 * Best-effort per claim: a still-active / not-held / raced claim is skipped so
 * one entry cannot block reclaim of the rest (matches the GC reapers' posture).
 * An invalid `channelId` still throws at the {@link closeStalePeerIdentity}
 * boundary guard (defense-in-depth); a missing identities dir yields an empty
 * result (no claims to scan).
 */
export async function reclaimStaleIdentities(args: {
  channelId: string;
  staleThresholdMs: number;
}): Promise<ReclaimResult> {
  const { channelId, staleThresholdMs } = args;
  const reclaimed: NatoIdentity[] = [];
  const skippedActive: NatoIdentity[] = [];
  const stuck: NatoIdentity[] = [];

  for (const { identity } of listClaims(channelId)) {
    const result = await closeStalePeerIdentity({
      channelId,
      identity,
      staleThresholdMs,
      force: false,
    });
    if (result.kind === "released") {
      const unlink = unlinkIdentitySentinelOrLogOrphan(
        channelId,
        identity,
        result.releasedClaim,
      );
      // ok, or already-gone (ENOENT, race-cleared): the pool slot is free.
      // A true orphan (EACCES/EBUSY/OTHER) leaves the sentinel on disk for
      // the orphan-sentinel reaper to retry — surface it as `stuck`.
      if (unlink.ok || unlink.code === "ENOENT") {
        reclaimed.push(identity);
      } else {
        stuck.push(identity);
      }
    } else if (result.kind === "still-active") {
      // Heartbeat fresher than the staleness window — a live session.
      skippedActive.push(identity);
    }
    // "not-held": sentinel exists but no metadata entry (orphan); the
    // orphan-sentinel reaper owns that case. "session-mismatch": cannot
    // occur — we pass no casSessionId. Both: skip.
  }

  return { reclaimed, skippedActive, stuck };
}
