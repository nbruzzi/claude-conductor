// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 7 hook — surface idle peers on UserPromptSubmit so operators
 * discover stuck/crashed siblings without manual `peers` queries.
 *
 * Phase 1 shipped a no-op stub to satisfy `assertWiringComplete` across the
 * cross-edge. Phase 2 (this implementation) consumes the substrate Slice 5
 * left behind (`getIdentityContextForSession` in `channels/identity-context`)
 * + Slice 7's own substrate extension (`readHeartbeatBody` reading the
 * peer-clock body that Slice 7's `touchHeartbeat` writes alongside mtime).
 *
 * For each channel where this session has a NATO-identity claim, the hook:
 *   1. Iterates peers in the channel's metadata.identities.
 *   2. Skips peers whose `heartbeat_mtime_ms` is fresh (≤ idle threshold).
 *   3. For each idle-by-mtime peer, reads `readHeartbeatBody` (the peer's
 *      `Date.now()` written into the body at the same write instant the
 *      kernel set mtime). If `|mtime - body_ts| > 5 min` → clock-skew
 *      detected → suppress the reminder + log `kind: "clock-skew"`
 *      breadcrumb. Body=null (legacy peer / corrupt) skips skew check.
 *   4. Honors a per-(channel, observer-session) rate-limit cursor stored
 *      at `<channel-dir>/idle-emit-cursors/<sid>.json` (Step G renamed from
 *      `idle-emit/`; LEGACY dual-read fallback ≥30d). Each peer letter has
 *      an independent ISO-timestamp; emission is suppressed for 30 minutes
 *      after the last emission.
 *   5. Compaction grace gate (K4-b §C): if the peer's most-recent STATUS
 *      message body starts with COMPACTION_SENTINEL_PREFIX and is within
 *      COMPACTION_GRACE_MS of now, the peer is mid-/compact (working, not
 *      crashed) → suppress. Addresses sub-class (i) compaction only; does NOT
 *      suppress (ii) reserve-hold/dead-peer true-idle — see backlog.
 *   6. Emits one `[teammate-idle]` system-reminder block per still-eligible
 *      idle peer with the canonical `close-peer --force` recovery hint.
 *
 * Failure-mode class: **fail-open + breadcrumb**. Outer try/catch ensures
 * a thrown helper never breaks the UserPromptSubmit chain. IO failures on
 * cursor read/write are breadcrumb'd via `appendPresenceFailure` (kind
 * `write-failed`), and the hook continues.
 *
 * Plan: ~/.claude/plans/stateful-munching-volcano.md REV 2 §B.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  getIdentityContextForSession,
  type IdentityContext,
  type IdentityPeer,
} from "../../channels/identity-context.ts";
import {
  COMPACTION_SENTINEL_PREFIX,
  readHeartbeatBody,
  resolveChannelsDir,
} from "../../channels/index.ts";
import {
  getMostRecentPeerKind,
  getMostRecentPeerMessageWithBody,
} from "../../channels/peer-recent-message.ts";
import { isSessionLiveByPrefix } from "../../active-sessions/index.ts";
import {
  buildHarnessStatusIndex,
  isActiveHarnessStatus,
} from "../../cohort-sight/index.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { extractValidSessionId } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "teammate-idle-reminder";
const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const RATE_LIMIT_MS = 30 * 60 * 1000;
const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Sibling-coord-gate-awareness plan v2 Lane C — suppress the idle reminder
 * when a peer's most-recent channel message is a deliberate-standby kind.
 * Stale heartbeat is by-design (not by-crash) for these peers.
 *
 * Per RE-5 fold: only canonical `CHANNEL_KINDS` members that semantically
 * indicate "I am pausing, not crashed" — verified against
 * `src/channels/index.ts` CHANNEL_KINDS (`note` / `question` / `handoff` /
 * `status` / `ack` / `roger` / `over` / `standby` / `out` / `digest`).
 *
 *   - `standby` — explicit "I am standing by"
 *   - `roger`   — explicit "received, holding"
 *   - `out`     — explicit "leaving channel"
 *   - `digest`  — Phase 4 Layer 4 summary post; indicates work-cycle close
 *
 * Excluded:
 *   - `over` — transient hand-off-the-mic, not a state-end
 *   - `done` — not a canonical CHANNEL_KIND (v1 plan included it in error)
 */
const STANDBY_KINDS: ReadonlySet<string> = new Set([
  "standby",
  "roger",
  "out",
  "digest",
]);
// Step G (ARCH-W2-4) renamed `idle-emit/` to `idle-emit-cursors/` (noun-form
// standardization). LEGACY name retained for 30-day dual-read transition per
// `feedback-live-substrate-sequencing.md`; readers fall back to LEGACY,
// writers use NEW only. Removal commit deferred to follow-up cycle.
const CURSOR_DIR_NAME = "idle-emit-cursors";
const LEGACY_CURSOR_DIR_NAME = "idle-emit";
const ENV_VAR_IDLE_THRESHOLD = "CLAUDE_CONDUCTOR_IDLE_THRESHOLD_MS";
const DEFAULT_COMPACTION_GRACE_MS = 15 * 60 * 1000;
const ENV_VAR_COMPACTION_GRACE = "CLAUDE_CONDUCTOR_COMPACTION_GRACE_MS";

/** Per-(channel, observer-session) rate-limit cursor. Key = peer letter, value = ISO timestamp of last emission. */
type EmitCursor = Record<string, string>;

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

/**
 * Strict cursor shape validator. Rejects non-objects, arrays, non-string
 * values, and unparseable timestamp strings. Per audit TS-4 — the rate-limit
 * gate reads `cursor[peer.identity]` then `Date.parse(it)`; a bogus value
 * silently disables rate-limit for that peer (every prompt floods).
 */
function isValidCursor(parsed: unknown): parsed is EmitCursor {
  if (typeof parsed !== "object" || parsed === null) return false;
  if (Array.isArray(parsed)) return false;
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
    if (!Number.isFinite(Date.parse(v))) return false;
  }
  return true;
}

function readCursor(channelId: string, sessionId: string): EmitCursor {
  // Step G dual-read: try NEW `idle-emit-cursors/` first, fall back to LEGACY
  // `idle-emit/` for pre-rename peers. First-existing path wins; absent both
  // = empty cursor.
  const newPath = cursorPath(channelId, sessionId);
  const legacyPath = legacyCursorPath(channelId, sessionId);
  const path = existsSync(newPath)
    ? newPath
    : existsSync(legacyPath)
      ? legacyPath
      : null;
  if (path === null) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor parse failed (treating as empty)`,
    });
    return {};
  }
  if (!isValidCursor(parsed)) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor shape invalid (treating as empty)`,
    });
    return {};
  }
  return parsed;
}

/**
 * Atomic write via tmp + rename. POSIX rename is atomic on the same
 * filesystem, so observers either see the previous full cursor or the new
 * full cursor — never a partial JSON. Tmp suffix includes pid + a random
 * id so concurrent same-pid invocations don't collide on the tmp path
 * before rename (RE-NEW-1 verification finding).
 */
function writeCursor(
  channelId: string,
  sessionId: string,
  cursor: EmitCursor,
): void {
  const path = cursorPath(channelId, sessionId);
  const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(cursor)}\n`, "utf-8");
    renameSync(tmp, path);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId,
      artifactPath: path,
      detail: `${SOURCE}: cursor write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Resolve the idle-threshold from env, falling back to the 5-minute
 * default. Defense-in-depth syntactic guard rejects scientific notation,
 * decimals, and signed values before `Number()` would silently accept
 * them; operator intent for a ms threshold is always plain digits.
 */
function readIdleThresholdMs(): number {
  const raw = process.env[ENV_VAR_IDLE_THRESHOLD];
  if (raw === undefined) return DEFAULT_IDLE_THRESHOLD_MS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_IDLE_THRESHOLD_MS;
  if (!/^\d+$/.test(trimmed)) return DEFAULT_IDLE_THRESHOLD_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return DEFAULT_IDLE_THRESHOLD_MS;
  if (!Number.isInteger(n)) return DEFAULT_IDLE_THRESHOLD_MS;
  if (n <= 0) return DEFAULT_IDLE_THRESHOLD_MS;
  return n;
}

/**
 * Resolve the compaction grace window from env, falling back to the 15-minute
 * default. Same syntactic guard as readIdleThresholdMs.
 */
function readCompactionGraceMs(): number {
  const raw = process.env[ENV_VAR_COMPACTION_GRACE];
  if (raw === undefined) return DEFAULT_COMPACTION_GRACE_MS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_COMPACTION_GRACE_MS;
  if (!/^\d+$/.test(trimmed)) return DEFAULT_COMPACTION_GRACE_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return DEFAULT_COMPACTION_GRACE_MS;
  if (!Number.isInteger(n)) return DEFAULT_COMPACTION_GRACE_MS;
  if (n <= 0) return DEFAULT_COMPACTION_GRACE_MS;
  return n;
}

function formatRelativeTime(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** Format a per-peer idle reminder block per parent plan REV 2.1 §Hook message templates. */
function formatPeerBlock(
  channelId: string,
  peer: IdentityPeer,
  idleMs: number,
): string {
  const rel = formatRelativeTime(idleMs);
  return [
    `[teammate-idle] Peer ${peer.identity} on channel ${channelId} is idle (last heartbeat ${rel} ago, role=${peer.role}).`,
    `Recovery options:`,
    `  claude-conductor channels close-peer ${channelId} --peer ${peer.identity}`,
    `  claude-conductor channels close-peer ${channelId} --peer ${peer.identity} --force  (override staleness gate)`,
  ].join("\n");
}

export async function check(input: HookInput): Promise<HookResult> {
  try {
    const sessionId = extractValidSessionId(input.raw);
    if (sessionId === undefined) return pass();

    const contexts: readonly IdentityContext[] =
      getIdentityContextForSession(sessionId);
    if (contexts.length === 0) return pass();

    const idleThreshold = readIdleThresholdMs();
    const compactionGraceMs = readCompactionGraceMs();
    const now = getWallClockNow();
    // INDEX-ONCE (Alpha Lane-A lens Q3): build the harness sessions/<pid>.json
    // status map a single time per check, then do O(1) per-peer lookups below
    // (vs N scandirs). ADVISORY-OBSERVE-ONLY; fail-soft to an empty map.
    const harnessIndex = buildHarnessStatusIndex();
    const blocks: string[] = [];

    for (const ctx of contexts) {
      const cursor: EmitCursor = { ...readCursor(ctx.channelId, sessionId) };
      let cursorMutated = false;

      for (const peer of ctx.peers) {
        // Idle gate (mtime-based, primary signal).
        if (peer.heartbeat_mtime_ms === null) continue;
        const idleMs = now - peer.heartbeat_mtime_ms;
        if (idleMs <= idleThreshold) continue;

        // Harness-status PRIMARY suppress (Lane A). The mtime-idle test above is
        // only the CANDIDATE filter (channel-quiet); the harness
        // `sessions/<pid>.json` status is the most DIRECT "is this peer actually
        // working?" signal, so it is consulted FIRST — before the heavier
        // active-sessions mirror below. If the peer's harness status is ACTIVE
        // (busy/shell/waiting) AND its pid is alive, it is WORKING, not idle ->
        // suppress. THE CRUX (CG1): trust the ACTIVE status REGARDLESS of the
        // pidfile `updatedAt` ageMs — updatedAt FREEZES multi-minute during active
        // work (a /compact is indistinguishable from a long busy turn), so the
        // staleness guard is `isOsPidAlive` (the `pidAlive` field), NEVER ageMs.
        // The obvious ageMs-staleness gate would RE-INTRODUCE the false-idle bug.
        // CG3: additive-for-idle — only QUIETS a would-be idle warn, never promotes
        // a peer to idle. CG6: ADVISORY-OBSERVE-ONLY — never gates a reaper
        // (cohort-sight is off the LGC allowlist). Same-host only (Q4): a peer with
        // no local pidfile degrades to the mtime path (cross-host is CG7-deferred).
        const harness = harnessIndex.get(peer.session_id);
        if (
          harness &&
          isActiveHarnessStatus(harness.status) &&
          harness.pidAlive
        ) {
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "harness-active-suppressed",
            sessionId,
            artifactPath: ctx.channelId,
            detail: `${SOURCE}: peer ${peer.identity} suppressed (channel-idle ${formatRelativeTime(idleMs)} but harness status=${harness.status} pid=${harness.pid} alive)`,
          });
          continue;
        }

        // Alive-anywhere consult (A1 Slice 2; the contract-with-qualifier). The
        // idle gate above is CHANNEL-store-only (heartbeat_mtime_ms). teammate-idle
        // gates on "is this peer doing ANY work?" — an alive-anywhere question — so
        // it must OR-in every store that proves that liveness: a peer that is
        // tool-active (active-sessions heartbeat fresh) but channel-quiet (no recent
        // send) is WORKING, not idle. This is the MIRROR of the L1049 reaper /
        // reconcile-boot fixes (those read active-sessions-ONLY and OR-in channel;
        // this reads channel-ONLY and ORs-in active-sessions). Fail-soft: the helper
        // returns false on any IO error (never throws). EXACT-prefix match (full
        // peer.session_id) — no 8-hex-prefix collision risk. Non-mutating gate, so
        // a single decision point (no apply-time recheck). Breadcrumb mirrors the
        // standby / clock-skew gates so a mis-suppression stays observable.
        if (isSessionLiveByPrefix(peer.session_id, now)) {
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "active-sessions-live-suppressed",
            sessionId,
            artifactPath: ctx.channelId,
            detail: `${SOURCE}: peer ${peer.identity} suppressed (channel-idle ${formatRelativeTime(idleMs)} but active-sessions-live)`,
          });
          continue;
        }

        // Compaction grace gate (K4-b §C). The harness reports a NON-active status
        // during /compact (F4: confirmed by elimination), so neither Lane-A nor the
        // active-sessions consult above can see a compacting peer as alive. The channel
        // PreCompact sentinel IS that signal: if the peer's most-recent message body is
        // the compaction sentinel AND it is within the grace window, the peer is
        // mid-compaction (working, not crashed) -> suppress. Additive-for-suppress-only
        // (CG3): only quiets a would-be warn, never promotes a peer to idle.
        // Addresses sub-class (i) compaction only; does NOT suppress (ii) reserve-hold/
        // dead-peer true-idle — see backlog.
        // kindFilter="status" is REQUIRED (the accessor takes 3 args; the sentinel is
        // kind=status, compaction-notify.ts:172). Semantics: this returns the most-recent
        // STATUS post. A newer NON-prefix status self-corrects (peer resurfaced -> not
        // suppressed). A newer non-status NOTE after the sentinel would have touched the
        // heartbeat mtime, so the peer wouldn't reach this idle gate at all — benign.
        const recentMsg = getMostRecentPeerMessageWithBody(
          ctx.channelId,
          peer.session_id,
          "status",
        );
        if (
          recentMsg !== null &&
          recentMsg.body !== undefined &&
          recentMsg.body.startsWith(COMPACTION_SENTINEL_PREFIX) &&
          Number.isFinite(Date.parse(recentMsg.ts)) &&
          now - Date.parse(recentMsg.ts) <= compactionGraceMs
        ) {
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "compaction-grace-suppressed",
            sessionId,
            artifactPath: ctx.channelId,
            detail: `${SOURCE}: peer ${peer.identity} suppressed (channel-idle ${formatRelativeTime(idleMs)} but mid-/compact sentinel ts=${recentMsg.ts} within ${compactionGraceMs}ms grace)`,
          });
          continue;
        }

        // Clock-skew gate. Compare body-ts against mtime (REV 2 RE-1 fix —
        // both are set at the SAME write instant by the peer; a divergence
        // means the peer's user-space clock and filesystem mtime-stamp clock
        // disagree, so neither timestamp can be fully trusted).
        const bodyTs = readHeartbeatBody(ctx.channelId, peer.session_id);
        if (
          bodyTs !== null &&
          Math.abs(peer.heartbeat_mtime_ms - bodyTs) > CLOCK_SKEW_THRESHOLD_MS
        ) {
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "clock-skew",
            sessionId,
            artifactPath: ctx.channelId,
            detail: `${SOURCE}: peer ${peer.identity} body_ts=${bodyTs} mtime=${peer.heartbeat_mtime_ms} delta=${Math.abs(peer.heartbeat_mtime_ms - bodyTs)}ms`,
          });
          continue;
        }

        // Standby-state gate — sibling-coord-gate-awareness plan v2 Lane C.
        // If the peer's most-recent channel message is a deliberate-standby
        // kind (`standby` / `roger` / `out` / `digest`), the stale heartbeat
        // is by-design, not by-crash. Suppress the reminder + emit a
        // forensic breadcrumb so a mis-suppressed cycle (peer genuinely
        // crashed AFTER posting a standby kind) is observable in the
        // presence-failure log (FIND-6 fold).
        const recentKind = getMostRecentPeerKind(
          ctx.channelId,
          peer.session_id,
        );
        if (recentKind !== null && STANDBY_KINDS.has(recentKind.kind)) {
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "standby-suppressed",
            sessionId,
            artifactPath: ctx.channelId,
            detail: `${SOURCE}: peer ${peer.identity} suppressed (recent kind=${recentKind.kind} ts=${recentKind.ts})`,
          });
          continue;
        }

        // Rate-limit gate (per-peer per RATE_LIMIT_MS).
        const lastEmit =
          peer.identity in cursor ? cursor[peer.identity] : undefined;
        if (lastEmit !== undefined) {
          const lastMs = Date.parse(lastEmit);
          if (Number.isFinite(lastMs) && now - lastMs < RATE_LIMIT_MS) continue;
        }

        blocks.push(formatPeerBlock(ctx.channelId, peer, idleMs));
        cursor[peer.identity] = new Date(now).toISOString();
        cursorMutated = true;
      }

      if (cursorMutated) writeCursor(ctx.channelId, sessionId, cursor);
    }

    if (blocks.length === 0) return pass();
    return warn(SOURCE, ["", "── Teammate idle ──", ...blocks, ""].join("\n"));
  } catch {
    // Defense in depth — any unexpected throw becomes pass(). The hook is
    // advisory; never break the UserPromptSubmit chain on an internal fault.
    return pass();
  }
}
