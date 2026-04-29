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
 *   `appendPresenceFailure` with `source: "channels-identity-context"` for
 *   forensics.
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
  return contexts;
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
