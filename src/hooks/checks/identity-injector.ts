// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 5 hook — surface NATO-identity context on SessionStart for
 * channels where this session has a claim.
 *
 * For each claimed channel, emit one block telling the agent:
 *   - which NATO letter is theirs
 *   - their current role (pen / queue / out)
 *   - the active peer roster
 *   - canonical CLI form for the four common coordination verbs
 *
 * Plan: ~/.claude/plans/prismatic-orbiting-mesh.md REV 2.1 §Slice 5.
 *
 * Emission cadence (CLI-W0-2 fix): persist a per-session cursor at
 * `<channel-dir>/identity-emit/<sid>.json`; emit ONLY when the current
 * (identity, role, peer-letter-set) tuple differs from the cursor (or no
 * cursor exists). Avoids spamming SessionStart with the same context every
 * `/resume`.
 *
 * Failure-mode class (CLI-W0-6): **fail-open + breadcrumb**. Read failures
 * (corrupt metadata, IO error) are caught + breadcrumb'd via
 * `appendPresenceFailure` (source="channels-identity") + skipped per-channel.
 * SessionStart chain is never broken.
 *
 * Import-path policy (ARCH-W0-4): direct primitives from
 * `claude-conductor/channels/identity-context` (the Slice 5 helper) — no
 * `runChannelsCli` invocation since this hook reads state, doesn't emit
 * structured CLI JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isValidSessionId } from "../../active-sessions/index.ts";
import { resolveChannelsDir, type ChannelRole } from "../../channels/index.ts";
import {
  getIdentityContextForSession,
  type IdentityContext,
} from "../../channels/identity-context.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { extractSessionId } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "identity-injector";
// Step G (ARCH-W2-4) renamed `identity-emit/` to `identity-emit-cursors/`
// (noun-form standardization). LEGACY name retained for 30-day dual-read
// transition per `feedback-live-substrate-sequencing.md`; readers fall back
// to LEGACY, writers use NEW only. Removal commit deferred to follow-up cycle.
const CURSOR_DIR_NAME = "identity-emit-cursors";
const LEGACY_CURSOR_DIR_NAME = "identity-emit";

/** Per-session emission cursor — last (identity, role, peer-set) we surfaced. */
type EmitCursor = {
  readonly identity: string;
  readonly role: ChannelRole;
  readonly peer_letters: readonly string[];
  readonly emitted_at: string;
};

function cursorPath(channelId: string, sessionId: string): string {
  return join(
    resolveChannelsDir(),
    channelId,
    CURSOR_DIR_NAME,
    `${sessionId}.json`,
  );
}

function legacyCursorPath(channelId: string, sessionId: string): string {
  return join(
    resolveChannelsDir(),
    channelId,
    LEGACY_CURSOR_DIR_NAME,
    `${sessionId}.json`,
  );
}

function readCursor(channelId: string, sessionId: string): EmitCursor | null {
  // Step G dual-read: try NEW `identity-emit-cursors/` first, fall back to
  // LEGACY `identity-emit/` for pre-rename peers.
  for (const path of [
    cursorPath(channelId, sessionId),
    legacyCursorPath(channelId, sessionId),
  ]) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      const cursor = parsed as EmitCursor;
      if (typeof cursor.identity !== "string") continue;
      if (typeof cursor.role !== "string") continue;
      if (!Array.isArray(cursor.peer_letters)) continue;
      return cursor;
    } catch {
      continue;
    }
  }
  return null;
}

function writeCursor(
  channelId: string,
  sessionId: string,
  cursor: EmitCursor,
): void {
  const path = cursorPath(channelId, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cursor)}\n`, "utf-8");
}

function shouldEmit(
  current: IdentityContext,
  cursor: EmitCursor | null,
): boolean {
  if (cursor === null) return true;
  if (cursor.identity !== current.self.identity) return true;
  if (cursor.role !== current.self.role) return true;
  const currentPeers = [...current.peers.map((p) => p.identity)].sort();
  const cursorPeers = [...cursor.peer_letters].sort();
  if (currentPeers.length !== cursorPeers.length) return true;
  for (let i = 0; i < currentPeers.length; i++) {
    if (currentPeers[i] !== cursorPeers[i]) return true;
  }
  return false;
}

function formatRelativeTime(
  isoString: string,
  now: number = Date.now(),
): string {
  const ms = now - new Date(isoString).getTime();
  if (Number.isNaN(ms)) return "earlier";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatPeerSummary(peers: IdentityContext["peers"]): string {
  if (peers.length === 0) return "no peers";
  return peers.map((p) => `${p.identity} (${p.role})`).join(", ");
}

function formatChannelBlock(ctx: IdentityContext, now: number): string {
  return [
    `You are ${ctx.self.identity} on channel ${ctx.channelId} (role=${ctx.self.role}, joined ${formatRelativeTime(ctx.self.joined_at, now)}).`,
    `Active peers: ${formatPeerSummary(ctx.peers)}.`,
    `Coordinate via:`,
    `  claude-conductor channels whoami ${ctx.channelId}`,
    `  claude-conductor channels peers ${ctx.channelId}`,
    `  claude-conductor channels set-role ${ctx.channelId} --role <pen|queue|out>`,
    `  claude-conductor channels send ${ctx.channelId} <kind>`,
  ].join("\n");
}

export async function check(input: HookInput): Promise<HookResult> {
  try {
    const sessionId = extractSessionId(input.raw);
    if (!sessionId || !isValidSessionId(sessionId)) return pass();

    const contexts = getIdentityContextForSession(sessionId);
    if (contexts.length === 0) return pass();

    const now = Date.now();
    const blocks: string[] = [];

    for (const ctx of contexts) {
      const cursor = readCursor(ctx.channelId, sessionId);
      if (!shouldEmit(ctx, cursor)) continue;

      blocks.push(formatChannelBlock(ctx, now));

      try {
        writeCursor(ctx.channelId, sessionId, {
          identity: ctx.self.identity,
          role: ctx.self.role,
          peer_letters: ctx.peers.map((p) => p.identity),
          emitted_at: new Date().toISOString(),
        });
      } catch (err: unknown) {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          source: "channels-identity",
          kind: "write-failed",
          sessionId,
          artifactPath: cursorPath(ctx.channelId, sessionId),
          detail: `identity-injector cursor write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (blocks.length === 0) return pass();

    return warn(
      SOURCE,
      ["", "── Identity context ──", ...blocks, ""].join("\n"),
    );
  } catch {
    return pass();
  }
}
