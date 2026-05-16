// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SessionStart check — archive stale channels and prune the archive.
 *
 * Runs at chain index 0 (before dotfiles-catchup) so that archived channels
 * don't surface as live in downstream checks. Emits a brief when archives
 * are purged so the user can see what was cleaned up.
 *
 * Staleness rules (per plan):
 *   - last message timestamp > 72h ago, OR
 *   - newest heartbeat > 24h ago (all participants offline), OR
 *   - no messages + created_at > 24h ago (abandoned empty channel)
 *
 * Archive retention: 30 days. Archive cap: 100 entries (oldest-first eviction).
 *
 * Fail-open on any IO error — must never break the SessionStart chain.
 */

import {
  archiveChannel,
  listChannels,
  newestHeartbeatMtime,
  pruneArchive,
} from "../../channels/index.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "channel-gc";

const STALE_LAST_MESSAGE_MS = 72 * 60 * 60 * 1000;
const STALE_HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const EMPTY_ABANDONED_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_DAYS = 30;
const ARCHIVE_MAX_ENTRIES = 100;

export async function check(_input: HookInput): Promise<HookResult> {
  try {
    const archived = sweepStale();
    const purged = pruneArchive({
      retentionDays: ARCHIVE_RETENTION_DAYS,
      maxEntries: ARCHIVE_MAX_ENTRIES,
    });
    if (archived.length === 0 && purged.length === 0) return pass();

    const lines: string[] = ["", `── Channel GC ──`];
    if (archived.length > 0) {
      lines.push(`  archived ${archived.length} stale channel(s):`);
      for (const id of archived) lines.push(`    - ${id}`);
    }
    if (purged.length > 0) {
      lines.push(
        `  purged ${purged.length} archive entr${purged.length === 1 ? "y" : "ies"}`,
      );
    }
    lines.push("");
    return warn(SOURCE, lines.join("\n"));
  } catch {
    return pass();
  }
}

function sweepStale(): string[] {
  const now = getWallClockNow();
  const archived: string[] = [];
  let channels: ReturnType<typeof listChannels>;
  try {
    channels = listChannels();
  } catch {
    return archived;
  }
  for (const ch of channels) {
    try {
      if (ch.archived) continue;
      if (isStale(ch, now)) {
        archiveChannel(ch.id);
        archived.push(ch.id);
      }
    } catch {
      /* skip malformed entries */
    }
  }
  return archived;
}

type ChannelSummary = ReturnType<typeof listChannels>[number];

function isStale(ch: ChannelSummary, now: number): boolean {
  if (ch.metadata.closed_at) {
    const closedMs = Date.parse(ch.metadata.closed_at);
    if (Number.isFinite(closedMs) && now - closedMs > EMPTY_ABANDONED_MS)
      return true;
  }
  if (ch.lastMessageTs) {
    const lastMs = Date.parse(ch.lastMessageTs);
    if (Number.isFinite(lastMs) && now - lastMs > STALE_LAST_MESSAGE_MS)
      return true;
  } else {
    const createdMs = Date.parse(ch.metadata.created_at);
    if (Number.isFinite(createdMs) && now - createdMs > EMPTY_ABANDONED_MS) {
      return true;
    }
  }
  const hb = newestHeartbeatMtime(ch.id);
  if (hb !== null && now - hb > STALE_HEARTBEAT_MS) return true;
  return false;
}
