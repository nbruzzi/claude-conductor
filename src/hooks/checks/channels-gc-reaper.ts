// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 4 hook — sweep orphan channel-identity sentinels with
 * own-sentinel-before-unlink discipline.
 *
 * Plan: ~/.claude/plans/prismatic-orbiting-mesh.md REV 2.2 §Slice 4 +
 * implementation plan ~/.claude/plans/lovely-dreaming-willow.md REV 1.2.
 *
 * **What is an orphan sentinel:** a per-letter sentinel file under
 * `<channel-dir>/identities/<letter>` that exists with NO matching
 * `metadata.identities[<letter>]` entry. Genesis path: claimIdentity won
 * the linkSync atomically but commitIdentityClaim crashed/never-ran before
 * writing metadata, OR a closeStalePeerIdentity removed the metadata entry
 * but the sentinel-unlink subsequently failed (EACCES/EBUSY persistence
 * per Slice 3 RE-W2-4).
 *
 * **Race against in-flight claimIdentity:** claimIdentity does
 * `linkSync(tmp, sentinel)` BEFORE entering withMetadataLock to write
 * metadata. Between linkSync and commit, the state looks identical to an
 * orphan (sentinel exists, no metadata entry). The reaper must NOT unlink
 * a sentinel whose claimIdentity is mid-flight. Three layered guards:
 *
 *   1. **mtime gate (90 s = 3 × LOCK_STALE_MS):** any in-flight commit
 *      completes within LOCK_STALE_MS of acquiring the metadata lock; 3×
 *      headroom covers retry budget + commit + safety margin.
 *   2. **Sweep-phase invariant re-check:** sentinel content unchanged from
 *      mark + metadata.json mtime unchanged from mark + metadata.identities
 *      still has no entry → no commit happened in the quiesce window.
 *   3. **`.reaper-acked` suppression marker:** prevents repeated
 *      system-reminders for stuck orphans (EACCES/EBUSY); 7-day TTL.
 *
 * Note (per `feedback-atomic-wiring-discipline.md` ARCH-3): mark-phase
 * sentinel scan inside withMetadataLock is for atomicity vs metadata
 * writes only — concurrent claimIdentity.linkSync is NOT serialized by
 * this lock. The mtime gate + sweep-phase invariants are the correctness
 * guard, not the lock.
 *
 * Failure-mode class (per CLI-W0-6): **fail-loud + breadcrumb** for true
 * orphan-unlink failures (operator-actionable); **fail-open + breadcrumb**
 * for transient skip conditions (lock contention, metadata corrupt).
 * SessionStart chain is never broken by this hook.
 *
 * Import-path policy (per ARCH-W0-4): direct primitives from
 * `claude-conductor/channels` + `claude-conductor/channels/identity` —
 * NOT runChannelsCli (this hook reads + mutates substrate state, doesn't
 * emit structured CLI JSON).
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  COORDINATION_CHANNEL_ID,
  LOCK_STALE_MS,
  listChannels,
  resolveArchiveDir,
  resolveChannelsDir,
  resolveLastSeenDir,
  resolveLatestSymlinkPath,
  resolveLegacyLastSeenDir,
  withMetadataLock,
  readMetadata,
  rotateChannelMessages,
  isChannelRotationAutoEnabled,
  type ChannelSummary,
  type IdentityClaim,
  type UnreachableChannelSummary,
} from "../../channels/index.ts";
import { reclaimStaleIdentities } from "../../channels/reclaim.ts";
import { validateIdentityClaim } from "../../channels/claim.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { isValidSessionId } from "../../active-sessions/index.ts";
import {
  identitiesDir,
  identitySentinelPath,
  isValidIdentity,
  unlinkIdentitySentinelOrLogOrphan,
  type NatoIdentity,
  type UnlinkResult,
} from "../../channels/identity.ts";
import {
  appendPresenceFailure,
  redactHome,
} from "../../shared/presence-failure-log.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "channels-gc-reaper";

/** 5-min rate gate per channel (cursor mtime). */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Phase 2 Slice 8: TTL for last-seen cursors. Cursor file mtime > 7 days
 *  AND owning sid not in metadata.identities → prune. */
const LAST_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Mtime gate for orphan candidates: 3 × LOCK_STALE_MS = 90 s. Ensures
 *  any in-flight claimIdentity has fully committed before reaper acts.
 *  Imported as runtime constant so future tuning of LOCK_STALE_MS
 *  automatically tightens this gate. */
const ORPHAN_MTIME_GATE_MS = 3 * LOCK_STALE_MS;

/** 7-day TTL on `.reaper-acked` suppression markers. Stale marker → re-emit
 *  system-reminder + refresh marker mtime. */
const ACKED_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Stale-identity reclaim window for the eternal coordination channel: 24h —
 *  the ONLINE-window / dead edge (a heartbeat older than this is no longer
 *  even "online"; the same 24h boundary channel-gc archives a non-exempt
 *  channel at). Conservative by design: it clears the heartbeat-lag-during-
 *  long-tool-runs band (observed 5-9 min on the 2026-06-01 live cohort, where
 *  the teammate-idle hook false-positived) by >150x, so heads-down-building
 *  sessions are never reclaimed — only truly dead/crashed sessions (clean
 *  exits self-release their letter). NOT the 60s close-peer
 *  STALE_THRESHOLD_MS, which is an operator-gated manual escape hatch and
 *  false-positives on Monitor-wake-delayed sessions. */
const COORDINATION_RECLAIM_STALE_MS = 24 * 60 * 60 * 1000;

/** Subdirectory holding the per-channel rate-gate cursor file.
 *  Step G (ARCH-W2-4) renamed from `gc-reap/` to `reap-cursors/` (noun-form
 *  standardization). LEGACY name retained for 30-day dual-read transition
 *  per `feedback-live-substrate-sequencing.md`; readers fall back to LEGACY,
 *  writers use NEW only. Removal commit deferred to follow-up cycle. */
const CURSOR_SUBDIR = "reap-cursors";
const LEGACY_CURSOR_SUBDIR = "gc-reap";
const CURSOR_FILENAME = "cursor";

/** Per-process suppression set for cursor-write failures (RE-2 closure):
 *  channelId → first cursor-write failure already surfaced. */
const cursorWriteFailureSurfaced = new Set<string>();

/** Per-process suppression set for `.reaper-acked` marker-write failures
 *  (RE-9 closure): `${channelId}/${letter}` → already surfaced. */
const ackedMarkerFailureSurfaced = new Set<string>();

/** Mark-phase capture of an orphan sentinel candidate. */
type OrphanCandidate = {
  readonly letter: NatoIdentity;
  readonly sentinelPath: string;
  readonly sentinelMtimeMs: number;
  readonly sentinelContent: string;
  readonly markedClaim: IdentityClaim;
  readonly metadataMtimeMs: number;
};

/** Mark-phase capture of a metadata orphan candidate (entry exists, no
 *  sentinel). Recorded for breadcrumb only — reaper does NOT eagerly
 *  recreate sentinels (claimIdentity's reconcile-on-rejoin handles it).
 *  Permanent metadata-orphan handling is deferred — see
 *  wiki/backlog.md `permanent-metadata-orphan-reap`. */
type ReconcileCandidate = {
  readonly letter: string;
  readonly claim: IdentityClaim;
};

type MarkResult = {
  readonly orphans: readonly OrphanCandidate[];
  readonly reconciles: readonly ReconcileCandidate[];
};

export async function check(_input: HookInput): Promise<HookResult> {
  try {
    const lines = await reapAllChannels();
    if (lines.length === 0) return pass();
    return warn(
      SOURCE,
      ["", "── Channel GC reaper ──", ...lines, ""].join("\n"),
    );
  } catch {
    return pass();
  }
}

async function reapAllChannels(): Promise<string[]> {
  const summaryLines: string[] = [];

  // RE-W2-1 closure (Phase 3 Step C): opt into the `includeUnreachable: true`
  // variant so channels whose `metadata.json` is unreadable surface as
  // `UnreachableChannelSummary` entries instead of being silently skipped.
  // Reaper cannot safely GC orphan sentinels in an unreachable channel
  // (no valid metadata anchor to distinguish orphan from live), so the
  // disposition is a breadcrumb-only: append a presence-failure entry +
  // surface a summary line so the operator notices. The actual orphan
  // sentinels remain in place; recovery is an explicit operator action
  // (fix metadata.json or close-peer the channel).
  let channels: Array<ChannelSummary | UnreachableChannelSummary>;
  try {
    channels = listChannels({ includeUnreachable: true });
  } catch {
    return summaryLines;
  }

  for (const ch of channels) {
    if ("kind" in ch) {
      // `kind` is declared only on UnreachableChannelSummary (literal
      // `"unreachable"`), so the in-operator alone is sufficient to
      // narrow. Avoiding a redundant `ch.kind === "unreachable"` keeps
      // TS narrowing on the negative branch unambiguous → `ch.archived`
      // below is reachable as `ChannelSummary`.
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: "channels-identity",
        kind: "registry-contention",
        sessionId: null,
        artifactPath: ch.id,
        detail: `gc-reaper: unreachable channel — cannot read metadata.json; orphan sentinels (if any) cannot be safely GC'd. reason=${ch.reason}`,
      });
      // RE-3 v2.6 fold (Step C cross-audit): redact $HOME paths in the
      // operator-facing summary line. `appendPresenceFailure` already
      // redacts via `redactEvent`; the stdout breadcrumb path was missing
      // the same discipline, so paths could leak into transcripts +
      // SessionStart briefings + peer channel messages.
      summaryLines.push(
        `  UNREACHABLE channel=${ch.id} reason=${redactHome(ch.reason)} — orphan sentinels (if any) not GC'd; fix metadata.json or close-peer.`,
      );
      continue;
    }

    if (ch.archived) continue;

    try {
      const reaperLines = await reapChannel(ch.id);
      summaryLines.push(...reaperLines);
    } catch (err: unknown) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: "channels-identity",
        kind: "unhandled",
        sessionId: null,
        artifactPath: ch.id,
        detail: `gc-reaper unexpected error on channel: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // L143 — sweep stale LATEST symlink. Defensive: archiveChannel +
  // closeChannel both clear LATEST if it pointed at them, but this catches
  // cases where the channel dir was deleted directly (rmSync) without going
  // through archiveChannel, OR a race left LATEST pointing at .archive/.
  // Append the action as a summary line if a sweep fired so the operator
  // sees the cleanup at session-start.
  const sweepLine = sweepLatestSymlinkStaleness();
  if (sweepLine !== null) summaryLines.push(sweepLine);

  // Eternal coordination channel: reclaim NATO letters held by dead/crashed
  // sessions. REQUIRED counterpart of channel-gc's archival-exemption for
  // COORDINATION_CHANNEL_ID — that exemption removed the per-cycle archival
  // that used to recycle the 26-letter pool, so without this the pool would
  // exhaust under real come-and-go cadence (claimIdentity → NatoExhaustedError).
  // Not rate-gated: the scan is cheap (listClaims + per-claim heartbeat read)
  // and each closeStalePeerIdentity is idempotent + lock-serialized, so a
  // concurrent session's pass is safe. Fail-open + breadcrumb: never break the
  // SessionStart chain on a reclaim error.
  try {
    const reclaim = await reclaimStaleIdentities({
      channelId: COORDINATION_CHANNEL_ID,
      staleThresholdMs: COORDINATION_RECLAIM_STALE_MS,
    });
    for (const letter of reclaim.reclaimed) {
      summaryLines.push(
        `  reclaimed stale identity channel=${COORDINATION_CHANNEL_ID} letter=${letter}`,
      );
    }
    for (const letter of reclaim.stuck) {
      summaryLines.push(
        `  STUCK stale identity channel=${COORDINATION_CHANNEL_ID} letter=${letter} (sentinel unlink failed; orphan-reaper retries)`,
      );
    }
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "unhandled",
      sessionId: null,
      artifactPath: COORDINATION_CHANNEL_ID,
      detail: `gc-reaper stale-identity reclaim failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return summaryLines;
}

/**
 * Detect + clean a stale `~/.claude/channels/LATEST` symlink. Returns a
 * one-line summary string when the symlink was removed (for inclusion in
 * the reaper's warn output); returns `null` when the symlink is absent,
 * still valid, or unreadable (in which case we leave it alone).
 *
 * Stale conditions:
 *   - Target path does not exist (the channel dir was deleted out from
 *     under us — direct rmSync, ENOENT-after-archive race, etc.).
 *   - Target path resolves under `<channelsDir>/.archive/` (LATEST should
 *     never point at an archived channel; archiveChannel's preemptive
 *     clear catches the dominant path; this is the belt-and-suspenders).
 *
 * Fail-open: any unexpected error during the sweep is breadcrumbed via
 * `appendPresenceFailure` and the sweep returns `null`. The reaper never
 * blocks session-start on a discoverability-primitive cleanup.
 */
function sweepLatestSymlinkStaleness(): string | null {
  const symlinkPath = resolveLatestSymlinkPath();
  let target: string;
  try {
    const stat = lstatSync(symlinkPath);
    if (!stat.isSymbolicLink()) return null;
    target = readlinkSync(symlinkPath);
  } catch {
    // ENOENT / EACCES / ELOOP — nothing to sweep.
    return null;
  }
  // Stale if target dir is missing OR resides under the archive subtree.
  const archivePrefix = resolveArchiveDir();
  const targetExists = existsSync(target);
  const targetIsArchived = target.startsWith(`${archivePrefix}/`);
  if (targetExists && !targetIsArchived) return null;
  try {
    unlinkSync(symlinkPath);
    const reason = !targetExists ? "target missing" : "target archived";
    return `  swept stale LATEST symlink (${reason}): was → ${target}`;
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId: null,
      artifactPath: symlinkPath,
      detail: `gc-reaper: failed to sweep stale LATEST symlink: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
}

async function reapChannel(channelId: string): Promise<string[]> {
  const lines: string[] = [];

  if (!shouldReap(channelId)) return lines;

  sweepStaleTmpFiles(channelId);

  // messages.jsonl rotation — opt-in via the `.rotation-enabled` flag (default
  // OFF: a `tail -f` Monitor follows by descriptor and would go silent after
  // the rename; enable only once cohort Monitors follow by name with `tail -F`).
  // Bounded + zero-loss (atomic rename); a failure is breadcrumbed and never
  // breaks the SessionStart chain.
  if (isChannelRotationAutoEnabled()) {
    try {
      const rotated = await rotateChannelMessages(channelId);
      if (rotated.kind === "rotated") {
        lines.push(
          `  rotated messages channel=${channelId} -> messages.${rotated.seq}.archive.jsonl (${rotated.archivedBytes} bytes archived)`,
        );
      }
    } catch (err: unknown) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: "channels-identity",
        kind: "unhandled",
        sessionId: null,
        artifactPath: channelId,
        detail: `gc-reaper messages rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  let markResult: MarkResult;
  try {
    markResult = await markPhase(channelId);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "lock-timeout",
      sessionId: null,
      artifactPath: channelId,
      detail: `gc-reaper mark-phase lock-acquire or read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return lines;
  }

  for (const reconcile of markResult.reconciles) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "registry-contention",
      sessionId: reconcile.claim.session_id,
      artifactPath: identitySentinelPath(
        channelId,
        reconcile.letter as NatoIdentity,
      ),
      detail: `metadata-orphan-pending-rejoin: channel=${channelId} letter=${reconcile.letter}`,
    });
  }

  if (markResult.orphans.length === 0) {
    touchReapCursor(channelId);
    return lines;
  }

  let sweepLines: string[];
  try {
    sweepLines = await sweepPhase(channelId, markResult.orphans);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "lock-timeout",
      sessionId: null,
      artifactPath: channelId,
      detail: `gc-reaper sweep-phase lock-acquire failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return lines;
  }

  lines.push(...sweepLines);

  // Phase 2 Slice 8: prune stale last-seen cursors AFTER sweepPhase
  // releases its lock (RE-3 + RE-6 closures — separate withMetadataLock
  // block; re-reads metadata.identities inside the lock).
  try {
    await pruneStaleLastSeenCursors(channelId);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "lock-timeout",
      sessionId: null,
      artifactPath: channelId,
      detail: `gc-reaper last-seen prune lock-acquire failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  touchReapCursor(channelId);
  return lines;
}

/** Returns true if the cursor mtime is older than REAP_INTERVAL_MS (or
 *  doesn't exist — first pass on this channel).
 *  Step G dual-read (v2.14 fold of ARCH-2): take MAX(newMtime, legacyMtime)
 *  so the rate-gate respects whichever peer-version touched the cursor
 *  most recently. First-existing-wins would defeat the gate during the
 *  30-day transition (e.g., stale NEW cursor + fresh LEGACY cursor would
 *  bypass the 5-min interval). */
function shouldReap(channelId: string): boolean {
  let newestMtime: number | null = null;
  for (const cursor of [
    reapCursorPath(channelId),
    legacyReapCursorPath(channelId),
  ]) {
    if (!existsSync(cursor)) continue;
    try {
      const m = statSync(cursor).mtimeMs;
      if (newestMtime === null || m > newestMtime) newestMtime = m;
    } catch {
      continue;
    }
  }
  if (newestMtime === null) return true;
  return getWallClockNow() - newestMtime >= REAP_INTERVAL_MS;
}

/** Touch the rate-gate cursor. On EROFS/ENOSPC/EACCES, surface ONE
 *  system-reminder per channel per process via in-memory backoff (RE-2). */
function touchReapCursor(channelId: string): void {
  const path = reapCursorPath(channelId);
  try {
    mkdirSync(reapCursorDir(channelId), { recursive: true });
    writeFileSync(path, "", "utf-8");
  } catch (err: unknown) {
    if (cursorWriteFailureSurfaced.has(channelId)) return;
    cursorWriteFailureSurfaced.add(channelId);
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId: null,
      artifactPath: path,
      detail: `gc-reaper cursor write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function reapCursorDir(channelId: string): string {
  return join(resolveChannelsDir(), channelId, CURSOR_SUBDIR);
}

function reapCursorPath(channelId: string): string {
  return join(reapCursorDir(channelId), CURSOR_FILENAME);
}

/** Step G dual-read: LEGACY `gc-reap/cursor` path for pre-rename peers. */
function legacyReapCursorPath(channelId: string): string {
  return join(
    resolveChannelsDir(),
    channelId,
    LEGACY_CURSOR_SUBDIR,
    CURSOR_FILENAME,
  );
}

/** Sweep stale `.tmp.*` and `.reap-tmp.*` files older than LOCK_STALE_MS
 *  from identitiesDir. Recovers reaper + claimIdentity tmp leaks from
 *  prior crashed processes (RE-10 closure). Both producers use a
 *  `<prefix>.<pid>.<ts>.<rand>` shape; LOCK_STALE_MS is also
 *  claimIdentity's max in-flight tmp lifetime so this sweep cannot
 *  collide with a live claim. */
function sweepStaleTmpFiles(channelId: string): void {
  const dir = identitiesDir(channelId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = getWallClockNow() - LOCK_STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(".tmp.") && !name.startsWith(".reap-tmp.")) continue;
    const tmpPath = join(dir, name);
    try {
      if (statSync(tmpPath).mtimeMs < cutoff) {
        unlinkSync(tmpPath);
      }
    } catch {
      /* race-cleared or perms — skip silently */
    }
  }
}

async function markPhase(channelId: string): Promise<MarkResult> {
  return await withMetadataLock(channelId, () => {
    const orphans: OrphanCandidate[] = [];
    const reconciles: ReconcileCandidate[] = [];

    let metaIdentities: Record<string, IdentityClaim> = {};
    let metadataMtimeMs = 0;
    try {
      const meta = readMetadata(channelId);
      metaIdentities = meta.identities ?? {};
      metadataMtimeMs = statSync(metadataJsonPath(channelId)).mtimeMs;
    } catch {
      return { orphans, reconciles };
    }

    let sentinelEntries: string[];
    try {
      sentinelEntries = readdirSync(identitiesDir(channelId));
    } catch {
      sentinelEntries = [];
    }

    const sentinelLetters = new Set<string>();
    const now = getWallClockNow();
    for (const entry of sentinelEntries) {
      if (!isValidIdentity(entry)) continue;
      sentinelLetters.add(entry);

      if (metaIdentities[entry] !== undefined) continue;

      const sentinelPath = identitySentinelPath(channelId, entry);
      let sentinelMtimeMs: number;
      let sentinelContent: string;
      try {
        sentinelMtimeMs = statSync(sentinelPath).mtimeMs;
        if (now - sentinelMtimeMs < ORPHAN_MTIME_GATE_MS) continue;
        if (now - metadataMtimeMs < ORPHAN_MTIME_GATE_MS) continue;
        sentinelContent = readFileSync(sentinelPath, "utf-8");
      } catch {
        continue;
      }

      const markedClaim = validateIdentityClaim(sentinelContent);
      if (markedClaim === null) continue;

      orphans.push({
        letter: entry,
        sentinelPath,
        sentinelMtimeMs,
        sentinelContent,
        markedClaim,
        metadataMtimeMs,
      });
    }

    for (const [letter, claim] of Object.entries(metaIdentities)) {
      if (sentinelLetters.has(letter)) continue;
      reconciles.push({ letter, claim });
    }

    return { orphans, reconciles };
  });
}

async function sweepPhase(
  channelId: string,
  candidates: readonly OrphanCandidate[],
): Promise<string[]> {
  return await withMetadataLock(channelId, () => {
    const lines: string[] = [];

    let metaIdentities: Record<string, IdentityClaim> = {};
    let currentMetadataMtimeMs = 0;
    try {
      const meta = readMetadata(channelId);
      metaIdentities = meta.identities ?? {};
      currentMetadataMtimeMs = statSync(metadataJsonPath(channelId)).mtimeMs;
    } catch {
      return lines;
    }

    for (const candidate of candidates) {
      if (metaIdentities[candidate.letter] !== undefined) continue;
      if (currentMetadataMtimeMs > candidate.metadataMtimeMs) continue;

      let currentSentinelMtimeMs: number;
      let currentContent: string;
      try {
        currentSentinelMtimeMs = statSync(candidate.sentinelPath).mtimeMs;
        if (currentSentinelMtimeMs > candidate.sentinelMtimeMs) continue;
        currentContent = readFileSync(candidate.sentinelPath, "utf-8");
      } catch {
        continue;
      }

      if (currentContent !== candidate.sentinelContent) continue;

      if (isAckedMarkerFresh(candidate.sentinelPath)) continue;

      // Wave 2 RE-W2-3 closure: pass suppressLog so the primitive does
      // not duplicate the appendPresenceFailure that handleUnlinkFailure
      // emits below — `gc-reaper stuck orphan` is the more informative
      // breadcrumb for operator triage of reaper-driven failures.
      const result = unlinkIdentitySentinelOrLogOrphan(
        channelId,
        candidate.letter,
        candidate.markedClaim,
        { suppressLog: true },
      );

      if (result.ok) {
        lines.push(`  reaped channel=${channelId} letter=${candidate.letter}`);
        runRaceDetectionBreadcrumb(channelId, candidate.letter);
        continue;
      }

      handleUnlinkFailure(channelId, candidate, result, lines);
    }

    return lines;
  });
}

function metadataJsonPath(channelId: string): string {
  return join(resolveChannelsDir(), channelId, "metadata.json");
}

function ackedMarkerPath(sentinelPath: string): string {
  return `${sentinelPath}.reaper-acked`;
}

function isAckedMarkerFresh(sentinelPath: string): boolean {
  const path = ackedMarkerPath(sentinelPath);
  if (!existsSync(path)) return false;
  try {
    const age = getWallClockNow() - statSync(path).mtimeMs;
    return age < ACKED_MARKER_TTL_MS;
  } catch {
    return false;
  }
}

function writeAckedMarker(sentinelPath: string): boolean {
  const path = ackedMarkerPath(sentinelPath);
  try {
    writeFileSync(path, "", "utf-8");
    const now = getWallClockNow() / 1000;
    utimesSync(path, now, now);
    return true;
  } catch {
    return false;
  }
}

function handleUnlinkFailure(
  channelId: string,
  candidate: OrphanCandidate,
  result: Exclude<UnlinkResult, { ok: true }>,
  lines: string[],
): void {
  if (result.code === "ENOENT") return;

  const markerKey = `${channelId}/${candidate.letter}`;
  const markerWritten = writeAckedMarker(candidate.sentinelPath);

  if (!markerWritten && ackedMarkerFailureSurfaced.has(markerKey)) return;
  if (!markerWritten) {
    ackedMarkerFailureSurfaced.add(markerKey);
  }

  const recoveryHint = `bun run src/channels/cli.ts close-peer ${channelId} --peer ${candidate.letter} --force`;
  lines.push(
    `  STUCK orphan channel=${channelId} letter=${candidate.letter} (${result.code}). Recovery: ${recoveryHint}`,
  );

  appendPresenceFailure({
    timestamp: new Date().toISOString(),
    source: "channels-identity",
    kind: "write-failed",
    sessionId: candidate.markedClaim.session_id,
    artifactPath: candidate.sentinelPath,
    detail: `gc-reaper stuck orphan: code=${result.code} markerWritten=${markerWritten} detail=${result.detail}`,
  });
}

function runRaceDetectionBreadcrumb(
  channelId: string,
  letter: NatoIdentity,
): void {
  const sentinelPath = identitySentinelPath(channelId, letter);
  const reaperTmpPath = join(
    identitiesDir(channelId),
    `.reap-tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
  );

  try {
    writeFileSync(reaperTmpPath, '{"reaper":true}', {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    return;
  }

  try {
    try {
      linkSync(reaperTmpPath, sentinelPath);
      try {
        unlinkSync(sentinelPath);
      } catch {
        /* race-cleared by another process — fine */
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          source: "channels-identity",
          kind: "registry-contention",
          sessionId: null,
          artifactPath: sentinelPath,
          detail: `gc-reaper race-detection: claimIdentity reused channel=${channelId} letter=${letter} after sweep-phase unlink`,
        });
      }
    }
  } finally {
    try {
      unlinkSync(reaperTmpPath);
    } catch {
      /* tmp-file already moved or absent — ignore */
    }
  }
}

/**
 * Phase 2 Slice 8: prune stale last-seen cursors. Runs in its OWN
 * `withMetadataLock` block (RE-3 + RE-6 closures — separate from
 * `sweepPhase`'s lock; re-reads `metadata.identities` inside the lock).
 *
 * For each `<channel-dir>/last-seen-cursors/<sid>.json` AND each
 * `<channel-dir>/last-seen/<sid>.json` (Step G dual-read: pruner
 * enumerates BOTH dirs during the ≥30d transition window — see
 * `legacyLastSeenDir` / `legacyLastSeenCursorPath` below; writer code
 * post-Step-G emits to the NEW dir only):
 *   1. Validate filename has the `<uuid>.json` shape (skip non-UUID
 *      debris like `.tmp` partial-write leftovers).
 *   2. Check the owning `sid` is NOT in any `metadata.identities[*].session_id`
 *      (re-read inside the lock for fresh post-sweep snapshot).
 *   3. Check cursor file mtime > 7 days old.
 *   4. If BOTH true: `unlinkSync(cursorPath)`. EACCES/EBUSY → breadcrumb.
 *
 * Race-safe vs concurrent `read --since-cursor` — TTL window is 7 days;
 * any session active in that window will have their sid in
 * `metadata.identities` (kept fresh by claimIdentity + heartbeat). False
 * positives only when a session is BOTH absent from metadata AND silent
 * for 7 days, which by definition means re-read-from-start is acceptable.
 */
async function pruneStaleLastSeenCursors(channelId: string): Promise<void> {
  await withMetadataLock(channelId, () => {
    let metaIdentities: Record<string, IdentityClaim> = {};
    try {
      const meta = readMetadata(channelId);
      metaIdentities = meta.identities ?? {};
    } catch {
      return; // skip channel if metadata unreadable
    }
    const liveSids = new Set<string>();
    for (const claim of Object.values(metaIdentities)) {
      liveSids.add(claim.session_id);
    }
    // Step G dual-read: prune stale entries from BOTH new
    // `last-seen-cursors/` and legacy `last-seen/` dirs. Each cursor file is
    // considered independently; one session may have left a cursor in either
    // dir depending on which side of the rename their writer code ran on.
    const now = getWallClockNow();
    for (const dir of [
      resolveLastSeenDir(channelId),
      resolveLegacyLastSeenDir(channelId),
    ]) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // ENOENT — this dir doesn't exist yet (e.g., new dir before any session writes)
      }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const sid = name.slice(0, -".json".length);
        if (!isValidSessionId(sid)) continue; // skip .tmp partial-write debris
        if (liveSids.has(sid)) continue; // session is current participant
        const cursorPath = join(dir, name);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(cursorPath).mtimeMs;
        } catch {
          continue; // race-cleared
        }
        if (now - mtimeMs < LAST_SEEN_TTL_MS) continue;
        try {
          unlinkSync(cursorPath);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ENOENT") continue;
          appendPresenceFailure({
            timestamp: new Date().toISOString(),
            source: "channels-identity",
            kind: "write-failed",
            sessionId: sid,
            artifactPath: cursorPath,
            detail: `gc-reaper last-seen prune unlink failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  });
}
