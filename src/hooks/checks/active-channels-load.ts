// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SessionStart check — surface any live channel this session should know about.
 *
 * Runs after `memory-scope-filter` and before `pending-threads-briefing`, so
 * memory context is already scoped before we annotate channel state on top.
 *
 * Emits one brief block listing, per non-archived channel:
 *   - •  self        — we're already a participant; peer liveness shown
 *   - →  pending-join — a peer has created/joined but we haven't joined yet
 *   - ·  observer    — channel exists but does not involve us (read-only ctx)
 *
 * Side effect: touches the heartbeat marker for any channel we're in, so
 * peers see this session as live immediately on session start.
 *
 * Fail-open on any IO error — must never break the SessionStart chain.
 */

import {
  heartbeatMtime,
  listChannels,
  newestHeartbeatMtime,
  touchHeartbeat,
} from "../../channels/index.ts";
import { isValidSessionId } from "../../active-sessions/index.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { extractSessionId } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "active-channels-load";

const LIVE_WINDOW_MS = 30 * 60 * 1000;
const ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

type Liveness = "live" | "online" | "stale" | "unknown";

function liveness(ageMs: number | null): Liveness {
  if (ageMs === null) return "unknown";
  if (ageMs < LIVE_WINDOW_MS) return "live";
  if (ageMs < ONLINE_WINDOW_MS) return "online";
  return "stale";
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "no heartbeat";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

export async function check(input: HookInput): Promise<HookResult> {
  try {
    // Defense-in-depth: session-id flows into heartbeatPath via touchHeartbeat
    // below. Gate via isValidSessionId before any path-join. Sub-step 0.10 RE-2.
    const sessionId = extractSessionId(input.raw);
    if (!sessionId || !isValidSessionId(sessionId)) return pass();

    let channels: ReturnType<typeof listChannels>;
    try {
      channels = listChannels();
    } catch {
      return pass();
    }
    if (channels.length === 0) return pass();

    const now = getWallClockNow();
    const selfLines: string[] = [];
    const pendingLines: string[] = [];
    const observerLines: string[] = [];

    for (const ch of channels) {
      try {
        if (ch.archived) continue;
        if (ch.metadata.closed_at) continue;
        const isSelf = ch.metadata.participants.includes(sessionId);
        if (isSelf) {
          try {
            touchHeartbeat(ch.id, sessionId);
          } catch {
            /* non-fatal */
          }
          selfLines.push(
            formatSelfLine(ch.id, ch.metadata.participants, sessionId, now),
          );
          continue;
        }
        const peerActivity = newestHeartbeatMtime(ch.id);
        if (peerActivity !== null && now - peerActivity < ONLINE_WINDOW_MS) {
          pendingLines.push(
            formatPendingLine(ch.id, ch.metadata.participants, now),
          );
          continue;
        }
        observerLines.push(
          formatObserverLine(ch.id, ch.metadata.participants.length),
        );
      } catch {
        /* skip malformed — never abort the chain */
      }
    }

    if (
      selfLines.length === 0 &&
      pendingLines.length === 0 &&
      observerLines.length === 0
    ) {
      return pass();
    }

    const out: string[] = ["", `── Active channels ──`];
    for (const line of selfLines) out.push(`  • ${line}`);
    for (const line of pendingLines) out.push(`  → ${line}`);
    for (const line of observerLines) out.push(`  · ${line}`);
    out.push("");
    return warn(SOURCE, out.join("\n"));
  } catch {
    return pass();
  }
}

function formatSelfLine(
  id: string,
  participants: readonly string[],
  self: string,
  now: number,
): string {
  const peers = participants.filter((p) => p !== self);
  if (peers.length === 0) return `${id} — waiting for peer`;
  const statuses = peers.map((p) => {
    const m = heartbeatMtime(id, p);
    const age = m === null ? null : now - m;
    return `${liveness(age)} (${formatAge(age)})`;
  });
  return `${id} — peer ${statuses.join(", ")}`;
}

function formatPendingLine(
  id: string,
  participants: readonly string[],
  now: number,
): string {
  const newest = newestHeartbeatMtime(id);
  const age = newest === null ? null : now - newest;
  const peerCount = participants.length;
  return `${id} — ${peerCount} peer(s) active ${formatAge(age)}; join with: /channel join ${id}`;
}

function formatObserverLine(id: string, participantCount: number): string {
  return `${id} — ${participantCount} participant(s), no recent activity`;
}
