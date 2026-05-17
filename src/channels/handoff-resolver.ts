// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L141 — handoff resolution for `/handoff-resume parallel` Step 4a.
 *
 * Given a handoff file path, returns a `ChannelResolutionResult`
 * discriminating four outcomes:
 *
 *   - `derived-active` — derived channel (from `HANDOFF_<id>.md`
 *     filename) has live peers; happy path; Step 4a joins it.
 *   - `derived-empty-no-body-refs` — derived channel has no live
 *     peers AND handoff body names no alternative channels;
 *     Step 4a creates/joins as today (no surface).
 *   - `mismatch-body-has-live-alternative` — the L141 case:
 *     derived has zero live peers AND body names ≥1 channel with
 *     live peers. Step 4a surfaces the mismatch to the user
 *     (non-magical per Nick's "surface branch/merge strategy
 *     decisions before acting" principle). User chooses to switch
 *     or proceed with derived.
 *   - `derive-failed` — handoff file missing, name shape invalid,
 *     body unreadable, etc. `reason` discriminates root cause.
 *
 * Caller: `src/channels/cli.ts:resolve-handoff` verb, invoked by
 * the `/handoff-resume parallel` skill at Step 4a. Output is
 * `JSON.stringify`'d to stdout; skill bash branches on `.kind`.
 *
 * Live-peer threshold: `LIVE_WINDOW_MS` (30 min, matching cli.ts
 * `peers` verb taxonomy). Peers within this window count as live;
 * stale peers do not. Online (30 min - 24 h) peers are NOT counted
 * — the L141 use case asks "is anyone actively coordinating?"
 * which the live window expresses correctly.
 *
 * Pure on filesystem reads (handoff body, channel metadata,
 * heartbeat mtimes). No channel mutations.
 */

import { existsSync } from "node:fs";

import { getWallClockNow } from "../shared/clock.ts";
import {
  channelIdFromHandoff,
  heartbeatMtime,
  readMetadata,
  resolveChannelsDir,
} from "./index.ts";
import { parseHandoffBodyForChannelsFromFile } from "./handoff-body-parser.ts";

const LIVE_WINDOW_MS = 30 * 60 * 1000;
const ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CandidateChannel = {
  id: string;
  peers: number;
};

/**
 * L:142 picker channel-liveness summary — used by `/handoff-resume` Step 1a
 * picker to enrich each candidate row with the channel's activity state.
 *
 * Distinguishes 5 kinds (richer than `resolveActiveChannelForHandoff`'s
 * 4-kind union which is tuned for Step 4a's join decision):
 *
 *   - `live` — ≥1 peer heartbeat within 30 min
 *   - `online` — 0 live peers, ≥1 online peer (heartbeat within 24 h)
 *   - `stale` — channel exists but no recent peer activity
 *   - `missing` — derived channel id has no on-disk channel dir
 *   - `derive-failed` — handoff filename doesn't match `HANDOFF_<id>.md` shape
 *
 * Distinct from `countLivePeersForChannel` (private) which collapses
 * stale/missing → 0. Picker needs to distinguish those for the operator's
 * pick decision (a missing channel is a fresh-cycle handoff; a stale
 * channel is a wound-down one).
 *
 * Excludes a caller-supplied `selfSessionId` from the peer counts when
 * present, so the picker doesn't tell the operator "1 live peer" when
 * the only live heartbeat is their own. `null` selfSessionId disables
 * the filter (e.g., on degraded handoff path with no session context).
 */
export type ChannelSummaryForHandoff =
  | {
      kind: "live";
      channelId: string;
      livePeerCount: number;
      onlinePeerCount: number;
    }
  | {
      kind: "online";
      channelId: string;
      livePeerCount: 0;
      onlinePeerCount: number;
    }
  | {
      kind: "stale";
      channelId: string;
      livePeerCount: 0;
      onlinePeerCount: 0;
    }
  | {
      kind: "missing";
      channelId: string;
    }
  | {
      kind: "derive-failed";
      detail: string;
    };

export function summarizeChannelForHandoff(
  handoffPath: string,
  selfSessionId: string | null = null,
): ChannelSummaryForHandoff {
  let channelId: string;
  try {
    channelId = channelIdFromHandoff(handoffPath);
  } catch (err) {
    return {
      kind: "derive-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const channelDir = `${resolveChannelsDir()}/${channelId}`;
  if (!existsSync(channelDir)) {
    return { kind: "missing", channelId };
  }

  let participants: readonly string[];
  try {
    const meta = readMetadata(channelId);
    participants = meta.participants;
  } catch {
    return { kind: "stale", channelId, livePeerCount: 0, onlinePeerCount: 0 };
  }

  const now = getWallClockNow();
  let live = 0;
  let online = 0;
  for (const sessionId of participants) {
    if (selfSessionId !== null && sessionId === selfSessionId) continue;
    const mtime = heartbeatMtime(channelId, sessionId);
    if (mtime === null) continue;
    const age = now - mtime;
    if (age < LIVE_WINDOW_MS) {
      live += 1;
    } else if (age < ONLINE_WINDOW_MS) {
      online += 1;
    }
  }

  if (live > 0) {
    return {
      kind: "live",
      channelId,
      livePeerCount: live,
      onlinePeerCount: online,
    };
  }
  if (online > 0) {
    return {
      kind: "online",
      channelId,
      livePeerCount: 0,
      onlinePeerCount: online,
    };
  }
  return { kind: "stale", channelId, livePeerCount: 0, onlinePeerCount: 0 };
}

export type ChannelResolutionResult =
  | {
      kind: "derived-active";
      channelId: string;
      peerCount: number;
    }
  | {
      kind: "derived-empty-no-body-refs";
      channelId: string;
    }
  | {
      kind: "mismatch-body-has-live-alternative";
      derivedChannelId: string;
      candidateChannels: CandidateChannel[];
    }
  | {
      kind: "derive-failed";
      reason: "file-not-found" | "handoff-name-shape" | "io-error";
      detail: string;
    };

/**
 * Counts peers on a channel whose heartbeat is fresh enough to be
 * considered live (within `LIVE_WINDOW_MS`).
 *
 * Returns 0 if the channel does not exist, has no metadata, has no
 * participants, or all participant heartbeats are stale/missing.
 * Never throws on missing-channel — returning 0 is the natural
 * "no live coordination here" signal for the resolver.
 */
function countLivePeersForChannel(channelId: string): number {
  const channelDir = `${resolveChannelsDir()}/${channelId}`;
  if (!existsSync(channelDir)) return 0;

  let participants: readonly string[];
  try {
    const meta = readMetadata(channelId);
    participants = meta.participants;
  } catch {
    return 0;
  }

  const now = getWallClockNow();
  let live = 0;
  for (const sessionId of participants) {
    const mtime = heartbeatMtime(channelId, sessionId);
    if (mtime === null) continue;
    if (now - mtime < LIVE_WINDOW_MS) live += 1;
  }
  return live;
}

export function resolveActiveChannelForHandoff(
  handoffPath: string,
): ChannelResolutionResult {
  if (!existsSync(handoffPath)) {
    return {
      kind: "derive-failed",
      reason: "file-not-found",
      detail: `handoff file does not exist: ${handoffPath}`,
    };
  }

  let derivedChannelId: string;
  try {
    derivedChannelId = channelIdFromHandoff(handoffPath);
  } catch (err) {
    return {
      kind: "derive-failed",
      reason: "handoff-name-shape",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const derivedPeerCount = countLivePeersForChannel(derivedChannelId);

  if (derivedPeerCount > 0) {
    return {
      kind: "derived-active",
      channelId: derivedChannelId,
      peerCount: derivedPeerCount,
    };
  }

  // Derived empty. Scan handoff body for alternative channels.
  let candidateIds: string[];
  try {
    candidateIds = parseHandoffBodyForChannelsFromFile(handoffPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      kind: "derive-failed",
      reason: e.code === "ENOENT" ? "file-not-found" : "io-error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Exclude the derived id from candidate alternatives (don't list self).
  const alternatives = candidateIds.filter((id) => id !== derivedChannelId);

  const candidateChannels: CandidateChannel[] = [];
  for (const id of alternatives) {
    const peers = countLivePeersForChannel(id);
    if (peers > 0) {
      candidateChannels.push({ id, peers });
    }
  }

  if (candidateChannels.length > 0) {
    return {
      kind: "mismatch-body-has-live-alternative",
      derivedChannelId,
      candidateChannels,
    };
  }

  return {
    kind: "derived-empty-no-body-refs",
    channelId: derivedChannelId,
  };
}
