// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Identity-context helper for Phase 2 hooks.
 *
 * Lifted to a shared module per Phase 2 plan §Slice 5 sub-step 1 + ARCH-W0-8
 * (helper extraction when a second caller appears — Slice 7 TeammateIdle
 * reuses this surface; per `feedback-partial-v2-anticipation-primitives.md`).
 *
 * Returns the per-channel claim context for a given session: the session's
 * own identity + role + the peer roster (each peer's identity, role, and
 * heartbeat mtime). Both Slice 5 (identity-injector) and Slice 7
 * (teammate-idle-reminder) consume this surface; Slice 5 reads identity
 * + role for its operator-context emission, Slice 7 reads heartbeat
 * mtime for idle detection.
 *
 * Design decisions:
 *
 * - **Sync API.** Underlying primitives (`listChannels`, `readMetadata`,
 *   `heartbeatMtime`) are all sync; lifting them to async would cascade
 *   unnecessarily. The lock-acquisition cost is bounded (one read per
 *   channel; metadata.json is JSON-parseable in O(1) for typical sizes).
 *
 * - **Skip-on-error.** Per Phase 2 plan §Slice 5 sub-step 4 + RE-W0-7
 *   (corrupt-metadata error path), `readMetadata` failures are caught +
 *   skipped per channel; never throws upward. Failure is breadcrumb'd via
 *   `appendPresenceFailure` with `source: "channels-identity"` (the shared
 *   channel-identity category) for forensics. Filter by `kind` to
 *   disambiguate from sibling hooks that share the same source category.
 *
 * - **Empty-result early return.** Sessions with no identity claims on
 *   any channel return `[]`. Consumers (hooks) detect this and emit
 *   nothing — no operator interruption.
 *
 * - **Non-archived only.** Archived channels are excluded; consumers
 *   only care about live coordination contexts.
 */

import { appendPresenceFailure } from "../shared/presence-failure-log.ts";
import {
  heartbeatMtime,
  listChannels,
  readMetadata,
  type ChannelRole,
  type IdentityClaim,
} from "./index.ts";
import type { NatoIdentity } from "./identity.ts";
import { isValidIdentity } from "./identity.ts";

/** Per-peer slice for the context payload. */
export type IdentityPeer = {
  readonly identity: NatoIdentity;
  readonly role: ChannelRole;
  readonly session_id: string;
  /** Heartbeat mtime in ms since epoch; `null` if peer hasn't heartbeat'd. */
  readonly heartbeat_mtime_ms: number | null;
};

/** Per-channel context: this session's claim + the peer roster. */
export type IdentityContext = {
  readonly channelId: string;
  readonly self: {
    readonly identity: NatoIdentity;
    readonly role: ChannelRole;
    readonly joined_at: string;
  };
  readonly peers: readonly IdentityPeer[];
};

// Reuses the existing "channels-identity" PresenceFailureSource — semantically
// adjacent (both surface identity-related read failures); keeps the type tight.
const SOURCE = "channels-identity" as const;

/**
 * Resolve the identity context across all live channels for a session.
 *
 * Returns an entry per channel where `sessionId` has a claim in
 * `metadata.identities`. Channels with no claim (or a corrupt metadata
 * file) are silently skipped — consumers see only the channels they're
 * actually a participant in.
 */
export function getIdentityContextForSession(
  sessionId: string,
): readonly IdentityContext[] {
  if (!sessionId) return [];

  let summaries;
  try {
    summaries = listChannels();
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: SOURCE,
      kind: "registry-contention",
      sessionId,
      artifactPath: null,
      detail: `listChannels failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return [];
  }

  const contexts: IdentityContext[] = [];
  for (const summary of summaries) {
    if (summary.archived) continue;
    const ctx = buildContextForChannel(summary.id, sessionId);
    if (ctx !== null) contexts.push(ctx);
  }
  return sortIdentityContextsByChannelId(contexts);
}

/**
 * Deterministic channel ordering for the identity-context list: code-unit
 * (locale-independent) ascending by `channelId`.
 *
 * Why this exists — `listChannels()` returns channels in `readdirSync` order,
 * which is filesystem-dependent: sorted on APFS/macOS, ext4 hash-order on Linux.
 * Any ORDER-DEPENDENT consumer of {@link getIdentityContextForSession} is then
 * nondeterministic across platforms. The lived instance: `peer-message-deliverer`
 * applies a 50-message emission cap by decrementing a shared `remaining` across
 * channels in iteration order, so WHICH channel wins the budget was
 * readdir-order-dependent — green on macOS, flaky on Linux CI (the "aggregate
 * 50-cap shared across channels" flake; 2026-06-11). Sorting here makes the
 * channel order — and therefore the cap distribution + the operator-facing block
 * order — reproducible on every platform. `channelId`-asc is the minimal
 * deterministic key; a recency-first ordering is a deferred UX enhancement (it
 * would reintroduce a timing input needing its own tiebreak — determinism is the
 * requirement, recency is a nice-to-have).
 *
 * Pure + non-mutating (returns a new array) so it is directly unit-testable;
 * the other two consumers ({@link isPeerCoordinatedWithSelf}, teammate-idle) are
 * order-insensitive, so a stable order is harmless-to-beneficial for them.
 */
export function sortIdentityContextsByChannelId(
  contexts: readonly IdentityContext[],
): IdentityContext[] {
  return [...contexts].sort((a, b) =>
    a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0,
  );
}

function buildContextForChannel(
  channelId: string,
  sessionId: string,
): IdentityContext | null {
  let metadata;
  try {
    metadata = readMetadata(channelId);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: SOURCE,
      kind: "registry-contention",
      sessionId,
      artifactPath: channelId,
      detail: `readMetadata failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }

  const identities = metadata.identities ?? {};
  const entries = Object.entries(identities);

  let selfEntry: { letter: NatoIdentity; claim: IdentityClaim } | null = null;
  const peers: IdentityPeer[] = [];

  for (const [letter, claim] of entries) {
    if (!isValidIdentity(letter)) continue;
    if (claim.session_id === sessionId) {
      selfEntry = { letter, claim };
      continue;
    }
    peers.push({
      identity: letter,
      role: claim.role,
      session_id: claim.session_id,
      heartbeat_mtime_ms: heartbeatMtime(channelId, claim.session_id),
    });
  }

  if (selfEntry === null) return null;

  return {
    channelId,
    self: {
      identity: selfEntry.letter,
      role: selfEntry.claim.role,
      joined_at: selfEntry.claim.joined_at,
    },
    peers,
  };
}

/**
 * Check whether a peer session is channel-coordinated with self.
 *
 * "Coordinated" = both `selfSessionId` and `peerSessionId` are participants
 * (via `metadata.identities[*].session_id`) in at least one non-archived
 * channel where self has a claim. Used by hooks (e.g., `session-collision-gate`)
 * to distinguish deliberate channel-coordinated peers from unexpected
 * concurrent sessions before deciding to BLOCK vs WARN.
 *
 * READ-ONLY: zero fs writes, zero lock acquisitions. Safe to call from any
 * hook lock context. Inherits the skip-on-error contract of
 * `getIdentityContextForSession`: corrupt channel metadata produces a
 * breadcrumb (kind: "registry-contention") and is treated as "not coordinated."
 *
 * **Race tolerance — symmetric (channel-JOIN / channel-LEAVE):** if the peer
 * joins a channel between two fires of the caller, the first fire sees
 * `coordinated=false` and the second sees `coordinated=true`. Symmetric on
 * leave. Worst-case is one extra BLOCK/WARN cycle before the second hook
 * fire sees the updated state — acceptable per `feedback-bounded-reaudit-on-critical-fix-delta.md`
 * "skip-on-error + next-fire-converges" pattern.
 *
 * **Pairwise scope:** returns `coordinated=true` if ANY shared channel exists
 * between self + peer. Coordination is NOT scoped to a specific work-thread.
 * If work-thread isolation matters (Alpha+Bravo on channel A AND Alpha+Charlie
 * on channel B; Charlie editing a shared artifact would coordinate via Alpha's
 * identity-context), pass an explicit `channelIds` filter param in a future
 * extension. The current shape covers today's lived evidence — defer scoping
 * until a real cross-channel ambiguity surfaces.
 *
 * Returns `{ coordinated, channelIds }`. `channelIds` is the set of channels
 * where the coordination relationship was found — surfacable by callers
 * (e.g., session-collision-gate annotates per-peer with channel id).
 */
export function isPeerCoordinatedWithSelf(
  selfSessionId: string,
  peerSessionId: string,
): { readonly coordinated: boolean; readonly channelIds: readonly string[] } {
  if (!selfSessionId || !peerSessionId) {
    return { coordinated: false, channelIds: [] };
  }
  // Defense-in-depth: getIdentityContextForSession is documented as
  // skip-on-error, but a future refactor could break that contract. Wrap to
  // guarantee callers never see an exception.
  let contexts: readonly IdentityContext[];
  try {
    contexts = getIdentityContextForSession(selfSessionId);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: SOURCE,
      kind: "registry-contention",
      sessionId: selfSessionId,
      artifactPath: null,
      detail: `isPeerCoordinatedWithSelf: getIdentityContextForSession threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { coordinated: false, channelIds: [] };
  }

  const channelIds: string[] = [];
  for (const ctx of contexts) {
    for (const peer of ctx.peers) {
      if (peer.session_id === peerSessionId) {
        channelIds.push(ctx.channelId);
        break; // one match per channel suffices; move to next channel
      }
    }
  }
  return { coordinated: channelIds.length > 0, channelIds };
}
