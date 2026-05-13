// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Lifecycle-bound inter-session channels.
 *
 * A channel is a local filesystem inbox shared between two sessions that are
 * coordinating through a `/handoff-resume parallel` workflow. Storage lives
 * under ~/.claude/channels/<channel-id>/ with an append-only JSONL message
 * log, a metadata.json participants file, and heartbeat marker files.
 *
 * Design invariants (see ~/.claude/plans/ancient-waddling-tulip.md):
 *   - Append-only — messages are never mutated or deleted.
 *   - Atomic append for small messages (≤ SMALL_MESSAGE_MAX_BYTES) via
 *     O_APPEND. Oversized bodies are written to bodies/<uuid>.txt first
 *     (temp+rename) and a pointer message is appended.
 *   - Metadata mutations are serialized with an O_EXCL lockfile and
 *     written temp+rename. Stale locks (>30s) are stolen with jittered retry.
 *   - Tolerant reader — a corrupt JSONL line never throws upward; it's
 *     skipped with a single warning per channel per session.
 *   - Session identity is NEVER inferred from mtime; it comes from the
 *     hook-input session_id (or CLAUDE_SESSION_ID for tests).
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  isValidArtifactId,
  isValidSessionId,
} from "../active-sessions/index.ts";
import { getWallClockNow } from "../shared/clock.ts";
import { extractSessionId } from "../hooks/session-id.ts";
import { channelsDir } from "../shared/paths.ts";

/** Conservative atomic-append threshold. POSIX guarantees PIPE_BUF (512 on
 *  macOS); Linux regular-file O_APPEND is typically safe up to 4096. We
 *  use 3KB as a safe middle ground — anything larger redirects the body
 *  to a sidecar file and only a pointer message is appended. */
const SMALL_MESSAGE_MAX_BYTES = 3 * 1024;

/** Lock-stale-steal threshold — `acquireLock` reclaims a lockfile whose
 *  mtime exceeds this age, on the assumption the holder crashed. Exported
 *  per Phase 2 Slice 4 — the channels-gc-reaper computes its mtime gate
 *  as `3 * LOCK_STALE_MS` so future tuning of this constant automatically
 *  tightens the reaper's race-safety margin (per `feedback-atomic-wiring-discipline.md`
 *  + plan `lovely-dreaming-willow.md` §Race correctness). */
export const LOCK_STALE_MS = 30 * 1000;
const LOCK_MAX_ATTEMPTS = 5;
const LOCK_BASE_DELAY_MS = 50;

export type ChannelLifecycle = "parallel";

/**
 * Single source of truth for the set of channel message kinds. The
 * `ChannelKind` union derives from this tuple via
 * `(typeof CHANNEL_KINDS)[number]`, and runtime validators import
 * `CHANNEL_KINDS` so the type-level and runtime acceptance stay in
 * lockstep (no 3-sync-point drift bait when extending the set).
 *
 * Sibling pattern: `BUNDLED_CHECKS_BY_EVENT` `as const` at
 * `src/hooks/bundled-check-names.ts:58-72`. Extension order is the
 * declaration order shown here — Phase 1 kinds first; future kinds
 * (e.g., Phase 4 Step A Layer 3 walkie-talkie primitives, Layer 4
 * `digest`) append after.
 */
export const CHANNEL_KINDS = [
  // Phase 1 kinds (informational + protocol carriers)
  "note",
  "question",
  "handoff",
  "status",
  // Phase 4 Step A Layer 3 — walkie-talkie protocol primitives
  // (see `docs/conventions/message-kinds-and-verification.md`):
  //   - `ack`      — receipt confirmation; presence-of-message is the signal
  //   - `roger`    — receipt + commitment; sender will act on what was read
  //   - `over`     — sender hint: "I posted, expecting reply"
  //   - `standby`  — sender hint: "heard you, working, hold the channel"
  //   - `out`      — peer terminates this channel (additive; `claim --force` resets)
  "ack",
  "roger",
  "over",
  "standby",
  "out",
] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Role posture per parent plan §266-271. `pen` = actively writing;
 *  `queue` = ready to take pen; `out` = observing only (sends blocked). */
export type ChannelRole = "pen" | "queue" | "out";

export type ChannelMessage = {
  ts: string;
  from: string;
  kind: ChannelKind;
  body?: string;
  body_ref?: string;
  /** NATO identity letter (e.g., "Alpha", "Bravo") — Phase 1 structured
   *  field. Absent on legacy messages; renders as `<unknown>` per the
   *  display matrix at parent plan §311-321 row 5. */
  identity?: string;
  /** Role at write time. Absent on legacy messages. */
  role?: ChannelRole;
  /** Forward-compat marker. Phase 1 messages omit this; future schema
   *  evolutions may set explicit version values. */
  version?: 1;
};

/** Per-identity claim record stored under metadata.identities[<letter>]. */
export type IdentityClaim = {
  session_id: string;
  role: ChannelRole;
  joined_at: string;
  /**
   * ISO timestamp set when this identity posted `kind="out"` on the
   * channel.
   *
   * **Sole writer this arc (plan v5):** the CLI send-verb in
   * `src/channels/cli.ts` when `kind === "out"`. The send-role-gate
   * carve-out from the Layer 3 commit lets the `out` kind through,
   * and `makeSendOutMutator(sessionId)` (this module) is passed as the
   * `appendMessage` `extraMetadataMutator` to atomically set BOTH
   * `role = "out"` AND `out_posted_at = ts` on the sender's claim
   * under a single `withMetadataLock`.
   *
   * **No Stop-hook auto-writer.** A v4 draft extended
   * `session-presence-unregister` to auto-post `out` at session-end,
   * but Stop fires per-turn (not session-end) — see
   * `src/hooks/checks/bundled-registrations.ts:71-78` for the
   * dotfiles-worktree-cleanup precedent removed for the same bug
   * shape. SessionStart-driven reaper deferred to Phase 4 Step B.
   *
   * Read by `explicitlyOutPeers` (`src/channels/explicitly-out-peers.ts`)
   * for the "terminal until takeover" predicate per RE-7 fold. Reset
   * via the existing identity-takeover path (`claim --force` clears the
   * claim entirely, which drops `out_posted_at`).
   */
  out_posted_at?: string;
};

export type ChannelMetadata = {
  created_at: string;
  lifecycle: ChannelLifecycle;
  handoff_id: string;
  participants: string[];
  closed_at?: string;
  /** NATO identity claims keyed by letter (e.g., "Alpha", "Bravo"). Absent
   *  on legacy channels; populated lazily on first `claimIdentity` call. */
  identities?: Record<string, IdentityClaim>;
};

export type ChannelSummary = {
  id: string;
  metadata: ChannelMetadata;
  lastMessageTs: string | null;
  archived: boolean;
};

/** Sentinel for channels whose `metadata.json` cannot be read or parsed.
 *  Surfaced ONLY by `listChannels({ includeUnreachable: true })`. The default
 *  zero-arg / `{ includeArchived }`-only signatures continue to silently skip
 *  such channels (legacy semantics — list must not throw).
 *
 *  Discriminator: callers narrow via `"kind" in entry && entry.kind === "unreachable"`.
 *  `ChannelSummary` deliberately has no `kind` field — adding one would change
 *  `JSON.stringify(listChannels())` output and break the `channels list --json`
 *  contract (Step C exit-criterion). The discriminator lives only on the
 *  unreachable arm, and only flows into return types when opted into.
 *
 *  Use case: `channels-gc-reaper` consumes the new variant to walk channels
 *  whose orphan sentinels would otherwise be unreachable (RE-W2-1 closure;
 *  see `decisions/phase-2.md` Decision A RE-1 + Decision C). */
export type UnreachableChannelSummary = {
  kind: "unreachable";
  id: string;
  /** Human-readable diagnostic; not stable for programmatic matching. */
  reason: string;
};

/** Root directory for all channel state. Delegates to the centralized
 *  resolver in `src/shared/paths.ts` which honors `CLAUDE_CONDUCTOR_CHANNELS_DIR`
 *  (per-component env), `CLAUDE_CONDUCTOR_ROOT` (root prefix), and falls back
 *  to `~/.claude/channels` (per Decision N: shared canonical with dotfiles,
 *  not under `conductor/`). */
export function resolveChannelsDir(): string {
  return channelsDir();
}

/** Archive subdirectory. Never synced. */
export function resolveArchiveDir(): string {
  return join(resolveChannelsDir(), ".archive");
}

/**
 * Canonicalize a handoff path to a channel ID.
 *
 *   HANDOFF_2026-04-19_11-30.md     → 2026-04-19_11-30
 *   /any/prefix/HANDOFF_2026-04-19_11-30  → 2026-04-19_11-30
 *   LATEST.md / any non-HANDOFF name      → throws
 */
export function channelIdFromHandoff(handoffPath: string): string {
  const name = basename(handoffPath).replace(/\.md$/u, "");
  if (!name.startsWith("HANDOFF_")) {
    throw new Error(
      `[channels] cannot derive channel id from "${handoffPath}" — handoff filenames must start with "HANDOFF_"`,
    );
  }
  const id = name.slice("HANDOFF_".length);
  if (id.length === 0) {
    throw new Error(
      `[channels] empty channel id derived from "${handoffPath}"`,
    );
  }
  return id;
}

/**
 * Canonical session-id resolver for channels-internal callers. Prefers
 * `CLAUDE_SESSION_ID` (tests) then the hook input's raw session_id. Throws
 * loudly if neither is available — never guesses.
 *
 * **Cross-edge env-var contract (ARCH-1, plan vivid-seeking-crayon §1):**
 * The plugin hosts TWO resolvers reading `CLAUDE_SESSION_ID`:
 *   (a) THIS function — lenient `isValidSessionId` gate (path-safety only).
 *       Reachable as `claude-conductor/channels/api`. Used here because
 *       channel paths only need a path-safe id; tightening to UUID-shape
 *       would break test fixtures that use short ids ("alice", "bob").
 *   (b) `shared/session-id-discovery.ts:resolveSessionId` — strict UUID
 *       gate, with mtime/ppid fallback discovery. Reachable as
 *       `claude-conductor/shared/session-id-discovery`. Used in CLI-context
 *       where there's no hook input payload.
 * The divergence is intentional. A non-UUID `CLAUDE_SESSION_ID` (e.g.,
 * `"test-session"`) is accepted here verbatim but falls through (b)'s
 * strict path to ppid/missing. Tests in `test/channels/api.test.ts` (case c)
 * lock the divergence.
 *
 * @see src/shared/session-id-discovery.ts — strict-UUID CLI-context resolver
 */
export function resolveSessionId(
  raw: Record<string, unknown> | undefined,
): string {
  // Defense-in-depth: every session-id consumed here flows into filesystem
  // paths (channelDir, heartbeatPath, body file names). isValidSessionId
  // gates against `..`/`/`/empty/etc. — symmetric with session-id.ts:42 and
  // active-sessions/index.ts:302. Sub-step 0.10 RE-2.
  const envOverride = process.env["CLAUDE_SESSION_ID"];
  if (envOverride && envOverride.length > 0 && isValidSessionId(envOverride)) {
    return envOverride;
  }
  const fromInput = raw ? extractSessionId(raw) : undefined;
  if (fromInput && isValidSessionId(fromInput)) return fromInput;
  throw new Error(
    "[channels] session_id not found or invalid — pass hook input with raw.session_id (matching isValidSessionId) or set CLAUDE_SESSION_ID",
  );
}

// ─── Paths ──────────────────────────────────────────────────────

// ─── Per-channel substrate subdirs (CLI-12 closure) ──────────────────
// Each channel directory `<channelsDir>/<channel-id>/` contains:
//   - metadata.json + metadata.json.lock — channel metadata + RMW lock
//   - messages.jsonl                     — append-only message log
//   - bodies/                            — large message bodies (body_ref)
//   - heartbeats/<sid>                   — per-session liveness markers (renamed from heartbeat/ in Step G; dual-read fallback to heartbeat/ retained ≥30d)
//   - identities/<NATO-letter>           — per-letter sentinel files (Phase 1 Slice 2)
//   - identity-emit-cursors/<sid>.json   — identity-injector emission cursors (Phase 2 Slice 5; renamed from identity-emit/ in Step G; dual-read fallback ≥30d)
//   - reap-cursors/cursor                — channels-gc-reaper rate-gate cursor (Phase 2 Slice 4; renamed from gc-reap/ in Step G; dual-read fallback ≥30d)
//   - last-seen-cursors/<sid>.json       — channels read --since-cursor cursors (Phase 2 Slice 8; renamed from last-seen/ in Step G; dual-read fallback ≥30d)
//   - idle-emit-cursors/<sid>.json       — teammate-idle-reminder emission cursors (Phase 2 Slice 7; renamed from idle-emit/ in Step G; dual-read fallback ≥30d)
// ─────────────────────────────────────────────────────────────────────

function channelDir(id: string): string {
  return join(resolveChannelsDir(), id);
}
function metadataPath(id: string): string {
  return join(channelDir(id), "metadata.json");
}
function metadataLockPath(id: string): string {
  return join(channelDir(id), "metadata.json.lock");
}
function messagesPath(id: string): string {
  return join(channelDir(id), "messages.jsonl");
}
function bodyDir(id: string): string {
  return join(channelDir(id), "bodies");
}
// ─── Step G (ARCH-W2-4) substrate-rename: noun-form standardization ───
// Per-channel subdir names standardized to noun-form per `feedback-live-substrate-sequencing.md`
// additive-first discipline. Each subdir has a NEW name (current) + LEGACY name (pre-rename).
// Readers consult NEW first, fall back to LEGACY (dual-read). Writers write to NEW only.
// Legacy names retained ≥30 days; removal commit deferred to follow-up cycle.
const HEARTBEAT_SUBDIR = "heartbeats";
const LEGACY_HEARTBEAT_SUBDIR = "heartbeat";
const LAST_SEEN_SUBDIR = "last-seen-cursors";
const LEGACY_LAST_SEEN_SUBDIR = "last-seen";

function heartbeatDir(id: string): string {
  return join(channelDir(id), HEARTBEAT_SUBDIR);
}
function legacyHeartbeatDir(id: string): string {
  return join(channelDir(id), LEGACY_HEARTBEAT_SUBDIR);
}
function heartbeatPath(id: string, sessionId: string): string {
  return join(heartbeatDir(id), sessionId);
}
function legacyHeartbeatPath(id: string, sessionId: string): string {
  return join(legacyHeartbeatDir(id), sessionId);
}
function lastSeenDir(id: string): string {
  return join(channelDir(id), LAST_SEEN_SUBDIR);
}
function legacyLastSeenDir(id: string): string {
  return join(channelDir(id), LEGACY_LAST_SEEN_SUBDIR);
}
function lastSeenCursorPath(id: string, sessionId: string): string {
  return join(lastSeenDir(id), `${sessionId}.json`);
}
function legacyLastSeenCursorPath(id: string, sessionId: string): string {
  return join(legacyLastSeenDir(id), `${sessionId}.json`);
}
function archivedChannelDir(id: string): string {
  return join(resolveArchiveDir(), id);
}

// ─── Metadata RMW (O_EXCL lock + temp+rename) ───────────────────

/**
 * Acquire an O_EXCL lockfile with jittered exponential backoff. Async to
 * avoid blocking the event loop during retry — Wave 0 RE-CRIT-2 surfaced
 * that the prior sync spin-wait deadlocks in-process Promise.all fuzz
 * tests (every waiter holds the loop, no waiters can release).
 *
 * Stale-lock detection at LOCK_STALE_MS (30s); steals + retries.
 */
async function acquireLock(lockPath: string): Promise<number> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      );
      // Wave 2 RE-W2-5: write owner pid into the lockfile so future
      // acquireLock failures can surface the holder's pid in the error.
      // Sibling pattern of `active-sessions/index.ts:writeMetaIfMissing`'s
      // owner-of-meta convention. Best-effort — a writeSync failure does
      // not invalidate the lock (we still hold the fd via O_EXCL).
      try {
        writeSync(fd, `${process.pid}\n`);
      } catch {
        /* ignore — fd ownership via O_EXCL is the load-bearing primitive */
      }
      return fd;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      try {
        const st = statSync(lockPath);
        if (getWallClockNow() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* lock disappeared between EEXIST and stat */
      }
      const jitter = Math.floor(Math.random() * LOCK_BASE_DELAY_MS);
      const delay = LOCK_BASE_DELAY_MS * (attempt + 1) + jitter;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  // Wave 2 RE-W2-5: read the lockfile content to surface the holder pid in
  // the failure message. Best-effort — an unreadable lockfile means we just
  // omit the holder hint.
  let holderHint = "";
  try {
    const holderPid = readFileSync(lockPath, "utf-8").trim();
    if (holderPid !== "") holderHint = ` (held by pid ${holderPid})`;
  } catch {
    /* lockfile vanished between final attempt and read; no hint */
  }
  throw new Error(
    `[channels] failed to acquire lock ${lockPath}${holderHint}: ${lastErr?.message ?? "unknown"}`,
  );
}

function releaseLock(fd: number, lockPath: string): void {
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/** Run `fn` while holding the per-channel metadata lock. Atomic vs other
 *  metadata mutations on the same channel; does NOT serialize against
 *  sentinel-file `linkSync` operations (claimIdentity acquires sentinels
 *  BEFORE entering the lock).
 *
 *  Exported per Phase 2 Slice 4 — the channels-gc-reaper holds this lock
 *  during its mark-and-sweep passes for atomic-snapshot semantics vs
 *  concurrent metadata writers (commitIdentityClaim, removeIdentityClaim,
 *  setIdentityRole). Sentinel-side race protection is the reaper's mtime
 *  gate + sweep-phase invariant re-check, NOT this lock. See
 *  `feedback-atomic-wiring-discipline.md` ARCH-3 inline comment. */
export async function withMetadataLock<T>(
  id: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(channelDir(id), { recursive: true });
  const lockPath = metadataLockPath(id);
  const fd = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    releaseLock(fd, lockPath);
  }
}

/**
 * Pure validator for unmarshalled `ChannelMetadata` JSON. No filesystem
 * touches; throws with a path-agnostic `sourceLabel` so the same validator
 * works for both the active-channel branch (label = channel id) and the
 * archive branch (label = archived entry name).
 *
 * Sub-step 0.10 TS-1 + cross-audit TS-A6 — path-parameterized split. Replaces
 * the inline shape-check that lived only in `readMetadataRaw` and was bypassed
 * by the archive branch's `as ChannelMetadata` cast.
 */
export function validateChannelMetadata(
  parsed: unknown,
  sourceLabel: string,
): ChannelMetadata {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`[channels] metadata for ${sourceLabel} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const created_at = obj["created_at"];
  const lifecycle = obj["lifecycle"];
  const handoff_id = obj["handoff_id"];
  const participants = obj["participants"];
  if (
    typeof created_at !== "string" ||
    lifecycle !== "parallel" ||
    typeof handoff_id !== "string" ||
    !Array.isArray(participants) ||
    !participants.every((p): p is string => typeof p === "string")
  ) {
    throw new Error(
      `[channels] metadata for ${sourceLabel} has an invalid shape`,
    );
  }
  const meta: ChannelMetadata = {
    created_at,
    lifecycle,
    handoff_id,
    participants,
  };
  const closed_at = obj["closed_at"];
  if (typeof closed_at === "string") meta.closed_at = closed_at;

  // Phase 1 additive field: validate `identities?` shape if present, ignore absence.
  // Legacy channels (pre-Phase-1) have no `identities` field — read-with-default `?? {}`.
  const identities = obj["identities"];
  if (identities !== undefined) {
    if (
      typeof identities !== "object" ||
      identities === null ||
      Array.isArray(identities)
    ) {
      throw new Error(
        `[channels] metadata for ${sourceLabel} has invalid 'identities' shape (expected object)`,
      );
    }
    const validated: Record<string, IdentityClaim> = {};
    for (const [letter, claim] of Object.entries(
      identities as Record<string, unknown>,
    )) {
      if (typeof claim !== "object" || claim === null) {
        throw new Error(
          `[channels] metadata for ${sourceLabel} has invalid 'identities[${letter}]' (not an object)`,
        );
      }
      const c = claim as Record<string, unknown>;
      const session_id = c["session_id"];
      const role = c["role"];
      const joined_at = c["joined_at"];
      if (
        typeof session_id !== "string" ||
        (role !== "pen" && role !== "queue" && role !== "out") ||
        typeof joined_at !== "string"
      ) {
        throw new Error(
          `[channels] metadata for ${sourceLabel} has invalid 'identities[${letter}]' fields`,
        );
      }
      // Phase 4 Step A Layer 3 — additive optional `out_posted_at`
      // (ISO timestamp; sole writer this arc is the CLI send-verb
      // when `kind === "out"` via `makeSendOutMutator`). Validate
      // shape if present; ignore absence.
      const out_posted_at = c["out_posted_at"];
      if (out_posted_at !== undefined && typeof out_posted_at !== "string") {
        throw new Error(
          `[channels] metadata for ${sourceLabel} has invalid 'identities[${letter}].out_posted_at' (expected string or absent)`,
        );
      }
      const claimRecord: IdentityClaim = { session_id, role, joined_at };
      if (out_posted_at !== undefined)
        claimRecord.out_posted_at = out_posted_at;
      validated[letter] = claimRecord;
    }
    meta.identities = validated;
  }

  return meta;
}

/**
 * FS + validate. Both call sites (active-channel `readMetadataRaw` and
 * archive-branch listChannels iteration) flow through here so the validator
 * is impossible to bypass via the path-shape choice.
 */
function readAndValidateMetadata(
  path: string,
  sourceLabel: string,
): ChannelMetadata {
  const text = readFileSync(path, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  return validateChannelMetadata(parsed, sourceLabel);
}

function readMetadataRaw(id: string): ChannelMetadata {
  return readAndValidateMetadata(metadataPath(id), id);
}

function writeMetadataRaw(
  id: string,
  meta: ChannelMetadata,
  sessionId: string,
): void {
  const tmp = `${metadataPath(id)}.tmp.${sessionId}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  renameSync(tmp, metadataPath(id));
}

/** Read metadata without mutation. Retries once on race. */
export function readMetadata(id: string): ChannelMetadata {
  try {
    return readMetadataRaw(id);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof SyntaxError || code === "ENOENT") {
      return readMetadataRaw(id);
    }
    throw err;
  }
}

// ─── JSONL append ───────────────────────────────────────────────

function serializeLine(msg: ChannelMessage): string {
  const obj: Record<string, unknown> = {
    ts: msg.ts,
    from: msg.from,
    kind: msg.kind,
  };
  if (msg.body !== undefined) obj["body"] = msg.body;
  if (msg.body_ref !== undefined) obj["body_ref"] = msg.body_ref;
  // Phase 1 structured fields: write only when defined; preserves existing
  // line shape on legacy messages (forward-compat with pre-Phase-1 readers).
  if (msg.identity !== undefined) obj["identity"] = msg.identity;
  if (msg.role !== undefined) obj["role"] = msg.role;
  if (msg.version !== undefined) obj["version"] = msg.version;
  return `${JSON.stringify(obj)}\n`;
}

function appendLineAtomically(path: string, line: string): void {
  const buf = Buffer.from(line, "utf-8");
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
    0o644,
  );
  try {
    let written = 0;
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) throw new Error(`[channels] writeSync returned ${String(n)}`);
      written += n;
    }
  } finally {
    closeSync(fd);
  }
}

function writeBodyFile(id: string, body: string): string {
  mkdirSync(bodyDir(id), { recursive: true });
  const uuid = randomUUID();
  const dest = join(bodyDir(id), `${uuid}.txt`);
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, dest);
  return uuid;
}

export function readBodyFile(id: string, ref: string): string | null {
  try {
    return readFileSync(join(bodyDir(id), `${ref}.txt`), "utf-8");
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/** Create a new channel. Throws if one already exists at this id. */
export async function createChannel(args: {
  channelId: string;
  handoffId: string;
  sessionId: string;
}): Promise<ChannelMetadata> {
  const { channelId, handoffId, sessionId } = args;
  return withMetadataLock(channelId, () => {
    if (existsSync(metadataPath(channelId))) {
      throw new Error(`[channels] channel ${channelId} already exists`);
    }
    const meta: ChannelMetadata = {
      created_at: new Date().toISOString(),
      lifecycle: "parallel",
      handoff_id: handoffId,
      participants: [sessionId],
    };
    writeMetadataRaw(channelId, meta, sessionId);
    touchHeartbeat(channelId, sessionId);
    return meta;
  });
}

/** Join an existing channel. Idempotent. */
export async function joinChannel(args: {
  channelId: string;
  sessionId: string;
}): Promise<ChannelMetadata> {
  const { channelId, sessionId } = args;
  return withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    if (meta.closed_at) {
      throw new Error(
        `[channels] channel ${channelId} is closed (at ${meta.closed_at})`,
      );
    }
    if (!meta.participants.includes(sessionId)) {
      meta.participants.push(sessionId);
      writeMetadataRaw(channelId, meta, sessionId);
    }
    touchHeartbeat(channelId, sessionId);
    return meta;
  });
}

/** Close a channel. Idempotent. Prevents new messages. */
export async function closeChannel(args: {
  channelId: string;
  sessionId: string;
}): Promise<ChannelMetadata> {
  const { channelId, sessionId } = args;
  return withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    if (!meta.closed_at) {
      meta.closed_at = new Date().toISOString();
      writeMetadataRaw(channelId, meta, sessionId);
    }
    return meta;
  });
}

/**
 * Commit an identity claim to `metadata.identities` after a successful
 * sentinel-file linkSync. Phase 1 v2 §122 commit-after-claim ordering:
 * the per-letter sentinel file (atomic via linkSync EEXIST) is the
 * canonical claim; the metadata.identities map is a materialized cache
 * that downstream verbs (whoami / set-role / peers / read render) read
 * from. Without this commit, those verbs see `{}` after successful
 * claims (Wave 1 ARCH-1 finding).
 *
 * Used by `claimIdentity` (src/channels/identity.ts). Idempotent: writing
 * the same claim twice is a no-op semantically (overwrites with identical
 * content). Called under `withMetadataLock` for atomicity against
 * concurrent `joinChannel` / `closeChannel` mutations.
 */
export async function commitIdentityClaim(args: {
  channelId: string;
  identity: string;
  claim: IdentityClaim;
}): Promise<void> {
  const { channelId, identity, claim } = args;
  // Defense-in-depth: this function is exported on the public surface
  // (Decision Q4 enables direct primitive import for Phase 2 hooks).
  // claimIdentity already validates upstream, but a direct caller
  // wouldn't. Sibling-parity with claimIdentity's own boundary gate.
  // Slice 2.2 verification round RE-NEW-2.
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] commitIdentityClaim: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const identities = { ...(meta.identities ?? {}), [identity]: claim };
    const next: ChannelMetadata = { ...meta, identities };
    writeMetadataRaw(channelId, next, claim.session_id);
  });
}

/**
 * Remove a NATO identity claim from `metadata.identities`. Sibling-write to
 * `commitIdentityClaim` for the release path (Slice 5 close-peer + future
 * manual release flows). Sub-write under `withMetadataLock` for atomicity
 * against concurrent claim/join/close mutations.
 *
 * Returns the removed `IdentityClaim` so callers can attribute audit log
 * events (e.g., orphan-sentinel warnings) to the original claimant session.
 * Idempotent on absence: returns `null` and writes nothing.
 *
 * Used by `releaseIdentity` (src/channels/identity.ts) — RE-6 ordering
 * requires this metadata write to succeed before the sentinel unlink so a
 * crash mid-release leaves an orphan sentinel (recoverable on next claim
 * via the reconcile-on-rejoin path per Slice 2.2 Decision D) rather than a
 * phantom metadata entry with no sentinel (Slice 5 verbs would mistakenly
 * trust it).
 */
export async function removeIdentityClaim(args: {
  channelId: string;
  identity: string;
}): Promise<IdentityClaim | null> {
  const { channelId, identity } = args;
  // Defense-in-depth boundary validation per Slice 2.2 verification round
  // RE-NEW-2 (sibling-parity with commitIdentityClaim). Direct callers
  // outside identity.ts (Decision Q4 enables Phase 2 hook consumers) get
  // the same path-traversal guard.
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] removeIdentityClaim: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const existing = meta.identities;
    if (existing === undefined) return null;
    const removed = existing[identity];
    if (removed === undefined) return null;
    const nextIdentities: Record<string, IdentityClaim> = { ...existing };
    delete nextIdentities[identity];
    const next: ChannelMetadata = { ...meta, identities: nextIdentities };
    writeMetadataRaw(channelId, next, removed.session_id);
    return removed;
  });
}

/**
 * Atomically check a peer's heartbeat staleness AND remove its identity
 * claim under a SINGLE `withMetadataLock` section. Slice 5 RE-6 close-peer
 * race fix — without the same-lock sequence, a check-then-release split
 * lets a second concurrent metadata mutator squeeze in between, and the
 * staleness snapshot becomes irrelevant by the time the metadata write
 * lands. (The peer's own `touchHeartbeat` is independent of this lock —
 * heartbeat writes are not metadata-locked. The atomicity guarantee here
 * is against OTHER metadata mutators (claim/setRole/release), which is
 * the load-bearing race; the peer-heartbeat-write race is a tiny window
 * relative to the > 60 s stale threshold and `--force` covers operator
 * override.)
 *
 * Returns a discriminated result:
 *   - `{kind: "released", releasedClaim}` — heartbeat was stale (or
 *     `force === true`); metadata entry removed. Sentinel unlink is the
 *     caller's responsibility (use
 *     `unlinkIdentitySentinelOrLogOrphan` from `./identity.ts` for
 *     RE-6-aligned orphan handling).
 *   - `{kind: "still-active", ageMs}` — heartbeat is fresh; refused. The
 *     CLI verb maps this to a non-zero exit with a `--force` hint.
 *   - `{kind: "not-held"}` — the identity isn't claimed; nothing to
 *     close.
 *
 * `ageMs === null` means the peer has no heartbeat file at all (never
 * touched). Treated as stale (the most conservative interpretation —
 * a peer that never heartbeated is presumed dead).
 *
 * **Phase 2 Slice 1+2 RE-W0-8 audit-trail caveat:** the `peer-closed`
 * status message that documents the close (posted by the operator's CLI
 * via `appendMessage`) is best-effort post-metadata-commit. If the
 * audit-trail JSONL append fails (disk full, fd cap, etc.), the metadata
 * removal here is already committed — the close happened, but the audit
 * line may be missing. Failure surfaces via `appendPresenceFailure`
 * source=`channels-identity` and does NOT roll back the close. Operators
 * cross-referencing audit lines should treat absence as a forensic gap,
 * not as evidence the close didn't happen.
 */
export async function closeStalePeerIdentity(args: {
  channelId: string;
  identity: string;
  staleThresholdMs: number;
  force: boolean;
}): Promise<
  | { kind: "released"; releasedClaim: IdentityClaim }
  | { kind: "still-active"; ageMs: number | null }
  | { kind: "not-held" }
> {
  const { channelId, identity, staleThresholdMs, force } = args;
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] closeStalePeerIdentity: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const claim = meta.identities?.[identity];
    if (claim === undefined) {
      return { kind: "not-held" } as const;
    }
    // Heartbeat snapshot — read inside the lock so it's stable w/r/t
    // other metadata mutators (the peer's own touchHeartbeat is
    // independent; that's the documented narrow race).
    const peerMtime = heartbeatMtime(channelId, claim.session_id);
    const ageMs = peerMtime === null ? null : getWallClockNow() - peerMtime;
    const isStale = ageMs === null || ageMs > staleThresholdMs;
    if (!isStale && !force) {
      return { kind: "still-active", ageMs } as const;
    }
    const nextIdentities: Record<string, IdentityClaim> = {
      ...meta.identities,
    };
    delete nextIdentities[identity];
    const next: ChannelMetadata = { ...meta, identities: nextIdentities };
    writeMetadataRaw(channelId, next, claim.session_id);
    return { kind: "released", releasedClaim: claim } as const;
  });
}

/**
 * Atomically commit a named-identity takeover under `withMetadataLock`.
 * Sibling-of `closeStalePeerIdentity` for the P2 `claim --as <Identity>`
 * flow per plan giggly-bouncing-spark.md Decisions §3 + §4 + §9.
 *
 * **Two-phase contract.** Caller (`claimIdentityNamed` in identity.ts) does
 * P1's pre-lock `linkSync(tmpPath, sentinelPath)` first; on EEXIST, it calls
 * THIS function to perform P2 — heartbeat snapshot + CAS check + force gate
 * + atomic `renameSync(tmpPath, sentinelPath)` overwrite + metadata commit
 * — all under one `withMetadataLock` cycle. NO sentinel unlink ever; the
 * `renameSync` is the takeover atomicity primitive.
 *
 * **Lock-domain note** (per RE-1 / Bravo MAJ-1 cross-audit): `withMetadataLock`
 * serializes metadata writes only — sentinel filesystem operations are NOT
 * serialized by the lock. This function therefore performs the renameSync
 * inside the lock to bound the racing window with concurrent metadata
 * mutators (`commitIdentityClaim` / `removeIdentityClaim` / `setIdentityRole`
 * / `closeStalePeerIdentity`). The residual race with vanilla
 * `claimIdentity:240-259`'s pre-lock linkSync is documented in plan §3
 * acceptance section as bounded operator-only (`--force` + concurrent vanilla
 * join). Mitigation deferred to follow-up cycle.
 *
 * **Discriminated result:**
 *   - `{kind: "claimed", displacedSessionId}` — takeover succeeded; sentinel
 *     replaced + metadata committed. `displacedSessionId` is the prior
 *     holder's session_id (`null` if metadata had no entry — orphan-like
 *     sentinel-only state). Caller posts the audit-trail message post-lock.
 *   - `{kind: "active", holderSessionId, ageMs}` — refused: identity is held
 *     and `--force` was not passed. Caller throws `IdentityActiveError`.
 *   - `{kind: "cas-mismatch", expected, actual}` — refused: `--from-session`
 *     was passed but did not match the holder's session_id. Caller throws
 *     `IdentityCasMismatchError`.
 *
 * `tmpPath` MUST exist on the same filesystem as `sentinelPath` (renameSync
 * requires same-fs); the caller's `mkdirSync(identitiesDir, {recursive:true})`
 * + `writeFileSync(tmpPath)` discipline already satisfies this.
 */
export async function claimNamedIdentityWithLock(args: {
  channelId: string;
  identity: string;
  newClaim: IdentityClaim;
  tmpPath: string;
  sentinelPath: string;
  force: boolean;
  fromSession: string | undefined;
}): Promise<
  | { kind: "claimed"; displacedSessionId: string | null }
  | { kind: "active"; holderSessionId: string; ageMs: number | null }
  | { kind: "cas-mismatch"; expected: string; actual: string | null }
> {
  const { channelId, identity, newClaim, tmpPath, sentinelPath, force } = args;
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] claimNamedIdentityWithLock: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const existingMeta = meta.identities?.[identity];
    const holderSessionId = existingMeta?.session_id ?? null;

    // CAS gate (Decision §9). Operator passed --from-session — verify the
    // holder's session_id matches before takeover proceeds. Mismatch is
    // refused with discriminated kind so the CLI verb can emit a clear
    // forensic-style error without triggering the active-error path.
    if (args.fromSession !== undefined) {
      if (holderSessionId !== args.fromSession) {
        return {
          kind: "cas-mismatch",
          expected: args.fromSession,
          actual: holderSessionId,
        } as const;
      }
    }

    // Force gate (Decision §4). REQUIRE --force for ALL --as takeovers.
    // Drops the staleness-auto path (RE-5 closure) — 60s STALE_THRESHOLD_MS
    // can false-positive on Monitor-wake-delayed sessions.
    if (!force) {
      const heartbeatMs =
        holderSessionId !== null
          ? heartbeatMtime(channelId, holderSessionId)
          : null;
      const ageMs =
        heartbeatMs === null ? null : getWallClockNow() - heartbeatMs;
      return {
        kind: "active",
        holderSessionId: holderSessionId ?? "(unknown)",
        ageMs,
      } as const;
    }

    // Force=true: atomic takeover. renameSync replaces sentinelPath with
    // tmpPath in one syscall — there is NO between-state where sentinel is
    // absent or doubly-claimed. (POSIX rename(2) atomicity guarantee on
    // same-filesystem; same-fs is guaranteed by caller's mkdirSync +
    // writeFileSync of tmpPath in identitiesDir.)
    renameSync(tmpPath, sentinelPath);

    // Update metadata.identities under the same lock cycle so concurrent
    // metadata mutators see consistent post-state.
    const nextIdentities: Record<string, IdentityClaim> = {
      ...(meta.identities ?? {}),
      [identity]: newClaim,
    };
    const next: ChannelMetadata = { ...meta, identities: nextIdentities };
    writeMetadataRaw(channelId, next, newClaim.session_id);

    return {
      kind: "claimed",
      displacedSessionId: holderSessionId,
    } as const;
  });
}

/**
 * Atomically update the role of an existing identity claim. Read-modify-
 * write under `withMetadataLock` so set-role races against concurrent
 * claim/release/heartbeat operations are race-safe.
 *
 * Returns a discriminated result:
 *   - `{kind: "updated", previousRole}` — the role was changed (or set to
 *     the same value, idempotently).
 *   - `{kind: "not-held"}` — the identity isn't claimed; no write is
 *     performed. Callers (CLI's `set-role` verb) map this to exit 5 per
 *     Slice 5 RE-6 — silent no-op is the failure mode being prevented.
 *
 * The discriminated return avoids importing `IdentityNotHeldError` from
 * identity.ts (which would create a circular import); the caller wraps the
 * `not-held` case in the appropriate error class.
 */
export async function setIdentityRole(args: {
  channelId: string;
  identity: string;
  role: ChannelRole;
}): Promise<
  { kind: "updated"; previousRole: ChannelRole } | { kind: "not-held" }
> {
  const { channelId, identity, role } = args;
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] setIdentityRole: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const existing = meta.identities?.[identity];
    if (existing === undefined) {
      return { kind: "not-held" } as const;
    }
    const updated: IdentityClaim = { ...existing, role };
    const identities: Record<string, IdentityClaim> = {
      ...(meta.identities ?? {}),
      [identity]: updated,
    };
    const next: ChannelMetadata = { ...meta, identities };
    writeMetadataRaw(channelId, next, existing.session_id);
    return { kind: "updated", previousRole: existing.role } as const;
  });
}

/**
 * Thrown by `appendMessage` when the target channel's `metadata.closed_at`
 * is set. Lets callers discriminate closed-channel rejection via
 * `instanceof` rather than substring-matching on `Error.message` —
 * future channel-substrate refactors that change the message text will
 * not silently break discrimination at consumer sites.
 *
 * Sibling pattern to identity-error classes in `./identity.ts`
 * (`NatoExhaustedError`, `IdentityNotHeldError`, etc.) — same `extends
 * Error` shape, same name-via-super convention, same `this.name`
 * assignment so structured logs surface the discriminator.
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v3 MAJOR-3 fold (b);
 * backlog item under `wiki/backlog.md` "Plugin (`claude-conductor`) —
 * `ChannelClosedError` typed exception class" (filed 2026-05-13).
 */
export class ChannelClosedError extends Error {
  constructor(channelId: string, closedAt: string) {
    super(
      `[channels] channel '${channelId}' is closed (at ${closedAt}); cannot append`,
    );
    this.name = "ChannelClosedError";
  }
}

/**
 * Append a message. Large bodies are redirected to a sidecar file.
 *
 * Phase 2 Slice 1+2 (RE-W2-1 closure): the metadata-read + auto-attach +
 * JSONL append cycle runs inside `withMetadataLock` so concurrent
 * `setIdentityRole` / `closeStalePeerIdentity` / `removeIdentityClaim`
 * cannot race the auto-attach scan and produce wrong-attribution messages
 * (where the appended `role` disagrees with the role at-or-after-write
 * time). The lock domain is per-channel; cross-channel sends remain
 * parallel.
 *
 * **API-shape break (REV 2 ARCH-W0-7 acknowledgment):** this function was
 * sync prior to Phase 2; it now returns `Promise<ChannelMessage>`. Every
 * caller updates to `await`; cross-edge dotfiles consumers reach this via
 * the Slice 3a shim which already exposes the new async signature.
 *
 * **Risk #1 mitigation:** the lock-hold cost is one `withMetadataLock`
 * acquire per send; the metadata read + auto-attach scan are O(26) (NATO
 * pool size). If 1000-iter property-fuzz throughput regresses > 20%
 * post-merge, the follow-up is an RW-lock split (read for the auto-attach
 * scan, exclusive only for metadata mutations) — not promised in this
 * slice, just reserved as a Phase 3 follow-up slot.
 *
 * **Closed-channel rejection** (plan v3 MAJOR-3 fold (b)): throws
 * `ChannelClosedError` (defined just above) when `metadata.closed_at` is
 * set. Callers wanting to discriminate closed-channel rejection from
 * other failure modes should `catch (err) { if (err instanceof
 * ChannelClosedError) ... }` rather than substring-matching the message.
 */
export async function appendMessage(args: {
  channelId: string;
  message: ChannelMessage;
  /**
   * Optional metadata mutator run under the same `withMetadataLock` as
   * the message append. If provided, the mutator is called with the
   * current metadata (post-read, post-close-check); when it returns an
   * object that differs from the input by reference, the new metadata
   * is written back via `writeMetadataRaw` **AFTER** the JSONL line
   * lands (audit-trail-as-anchor per plan v5 RE-2 fold; see the inline
   * ordering note at the bottom of this function's lock callback for
   * the rationale).
   *
   * **Use case (Phase 4 Step A Layer 3):** atomic
   * "post-out-and-mark-self" for the CLI `kind=out` send path — the
   * caller (`makeSendOutMutator`) returns a mutator that sets BOTH
   * `role = "out"` AND `out_posted_at = ts` on the sender's claim.
   * Both the JSONL audit line and the metadata cache land under one
   * lock acquisition; readers (whoami / explicitlyOutPeers /
   * message-record) converge post-mutation.
   *
   * **Semantics:**
   *   - Mutator is sync; throwing from it aborts the entire transaction
   *     (no message lands, no metadata change). Validation also runs
   *     up-front; a mutator that returns a mis-shaped object throws
   *     before the JSONL append.
   *   - Reference-equality is the write-back signal — return the input
   *     `meta` unchanged to skip the write; return any other object
   *     (including a structural copy) to trigger `writeMetadataRaw`.
   *     **Do NOT mutate `meta` in place** — that returns reference-
   *     equal and silently skips disk-write while the in-memory object
   *     diverges.
   *   - Mutator runs AFTER auto-attach + closed-channel check. The
   *     auto-attach scan reads `meta.identities`; if the mutator
   *     depends on the post-write `identities` value, structure it to
   *     merge against the `meta` it receives.
   *   - Validates the returned metadata via `validateChannelMetadata`
   *     before the JSONL append, so a mis-shaped mutator output dies
   *     before either disk write.
   *   - **Single mutator per call.** If a future caller needs to
   *     compose multiple field mutations (e.g., Layer 4 digest +
   *     out-transition), wrap them in a single mutator function or
   *     add a `composeMutators(...mutators)` helper at that time.
   *
   * **Failure-mode tolerance (per plan v5 RE-2):** if the JSONL
   * append succeeds and the subsequent `writeMetadataRaw` fails
   * (ENOSPC, EACCES, EBUSY), the durable audit trail (JSONL line)
   * still lands but the metadata cache stays stale. There is NO
   * automatic JSONL → metadata reconciliation reader; recovery is
   * external (operator `claim --force` displaces the entire claim,
   * or hand-edit the metadata.json). The opposite ordering would
   * leave a permanently lying cache when the JSONL append fails,
   * which is the worse posture; JSONL-first preserves audit trail.
   */
  extraMetadataMutator?: (meta: ChannelMetadata) => ChannelMetadata;
}): Promise<ChannelMessage> {
  const { channelId } = args;
  if (!existsSync(metadataPath(channelId))) {
    throw new Error(`[channels] channel ${channelId} does not exist`);
  }
  return withMetadataLock(channelId, () => {
    const meta = readMetadata(channelId);
    if (meta.closed_at) {
      throw new ChannelClosedError(channelId, meta.closed_at);
    }

    let message = args.message;

    // Slice 6: auto-attach `identity` + `role` from `metadata.identities`
    // if the sender holds a claim. Legacy senders (no claim) keep both
    // fields absent → `renderMessage` shows them as `<unknown>: <body>`
    // (matrix row 5). Caller-wins: if the message already specifies
    // either field, leave it untouched (allows tests + callers that need
    // explicit override to bypass the auto-attach).
    //
    // Inline scan instead of importing `getIdentityForSession` from
    // `./identity.ts` — identity.ts already imports from this module
    // (`commitIdentityClaim`/`removeIdentityClaim`/etc.), so reverse-
    // importing would create a cycle. The scan is O(26) max (NATO pool
    // size) and `meta` is already in scope; no extra IO.
    //
    // Phase 2 Slice 1+2: this read is now serialized under
    // `withMetadataLock` against `setIdentityRole`/`closeStalePeerIdentity`/
    // `removeIdentityClaim`; the attached `role` matches metadata's role
    // at-or-before append time even under concurrent role flips.
    if (message.identity === undefined && message.role === undefined) {
      const identities = meta.identities;
      if (identities !== undefined) {
        for (const [letter, claim] of Object.entries(identities)) {
          if (claim.session_id === message.from) {
            message = { ...message, identity: letter, role: claim.role };
            break;
          }
        }
      }
    }

    // Phase 4 Step A Layer 3 — compute the post-mutation metadata
    // candidate UP FRONT (under the lock), but DO NOT write it yet.
    // The write follows after the JSONL append per the audit-trail-as-
    // anchor ordering (RE-2 fold). Validation runs here so a mis-shaped
    // mutator output throws BEFORE the JSONL line lands (no half-write
    // where the log gets the message but the cache write is rejected).
    let mutatedMetadata: ChannelMetadata | null = null;
    if (args.extraMetadataMutator !== undefined) {
      const nextMeta = args.extraMetadataMutator(meta);
      if (nextMeta !== meta) {
        // validateChannelMetadata throws on mis-shape — the throw
        // unwinds withMetadataLock and rejects appendMessage's promise,
        // so the caller sees a typed error (no message lands, no
        // metadata change).
        mutatedMetadata = validateChannelMetadata(
          nextMeta,
          `${channelId} (extraMetadataMutator)`,
        );
      }
    }

    const initialLine = serializeLine(message);
    if (
      Buffer.byteLength(initialLine, "utf-8") > SMALL_MESSAGE_MAX_BYTES &&
      message.body
    ) {
      const ref = writeBodyFile(channelId, message.body);
      // Preserve identity/role/version on the body-shunt rewrite — Slice 6
      // attribution must survive the sidecar redirect (otherwise large
      // bodies render as `<unknown> [body-ref:<ref>]` which is incorrect
      // when the sender held a claim).
      const shunted: ChannelMessage = {
        ts: message.ts,
        from: message.from,
        kind: message.kind,
        body_ref: ref,
      };
      if (message.identity !== undefined) shunted.identity = message.identity;
      if (message.role !== undefined) shunted.role = message.role;
      if (message.version !== undefined) shunted.version = message.version;
      message = shunted;
    }

    // RE-2 fold (audit-trail-as-anchor): JSONL append runs BEFORE the
    // metadata write. On JSONL-append failure (ENOSPC, EACCES, EBUSY),
    // the metadata stays unchanged — clean transaction failure. On
    // metadata-write failure AFTER a successful JSONL append, the
    // durable audit trail still lands but the cache stays stale; there
    // is NO automatic JSONL → metadata reconciliation reader, so
    // recovery is external (operator `claim --force` replaces the
    // entire claim record, OR hand-edit metadata.json). The opposite
    // ordering (metadata-first) is worse: a JSONL-append failure
    // post-metadata-write leaves a permanently lying cache with no
    // durable audit line to recover from. Sibling pattern: Layer 1
    // two-phase cursor commit (pending → committed) treats the durable
    // event as the anchor.
    const line = serializeLine(message);
    appendLineAtomically(messagesPath(channelId), line);
    if (mutatedMetadata !== null) {
      writeMetadataRaw(channelId, mutatedMetadata, message.from);
    }
    touchHeartbeat(channelId, message.from);
    return message;
  });
}

/**
 * Build an `extraMetadataMutator` for the manual-`out` send path. The
 * returned mutator finds the identity claim belonging to `sessionId`
 * and atomically updates it with `role = "out"` AND
 * `out_posted_at = ts` (defaults to "now" if omitted).
 *
 * **Three predicates converge post-mutation:**
 *   - `whoami` reads `metadata.identities[<L>].role` → `"out"`
 *   - `explicitlyOutPeers` reads `metadata.identities[<L>].out_posted_at` → present
 *   - JSONL `kind=out` line carries `role: "out"` via the auto-attach
 *     scan (auto-attach happens before the mutator in the lock callback;
 *     attach uses the PRE-mutation role, so the message's `role` field
 *     reflects "what the sender was at write-start". For first-time
 *     departure, this is the sender's prior role — consumers reading
 *     the `out` line know the prior posture from the message field and
 *     the new posture from the metadata).
 *
 * **Caller-wins / no-op:** if the session has no identity claim on the
 * channel (legacy / pre-join send), returns the input metadata by
 * reference → no metadata write-back, message still lands. The CLI
 * role-gate carve-out already permits `kind=out` from claimless
 * senders; the mutator gracefully no-ops in that case.
 *
 * Used by `src/channels/cli.ts` send-verb when `kind === "out"` to
 * make the manual `channels send <id> out` a true terminal transition
 * — sole writer of `out_posted_at` this arc per plan v5 (auto-out
 * extension dropped; SessionStart-reaper deferred to Phase 4 Step B).
 */
export function makeSendOutMutator(
  sessionId: string,
  postedAt: string = new Date().toISOString(),
): (meta: ChannelMetadata) => ChannelMetadata {
  return (meta) => {
    const identities = meta.identities;
    if (identities === undefined) return meta;
    for (const [letter, claim] of Object.entries(identities)) {
      if (claim.session_id === sessionId) {
        return {
          ...meta,
          identities: {
            ...identities,
            [letter]: {
              ...claim,
              role: "out",
              out_posted_at: postedAt,
            },
          },
        };
      }
    }
    return meta;
  };
}

/** Read all messages in order. Skips corrupt lines with a single warning. */
export function readMessages(channelId: string): ChannelMessage[] {
  const path = messagesPath(channelId);
  if (!existsSync(path)) return [];

  const text = readFileSync(path, "utf-8");
  const out: ChannelMessage[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isChannelMessage(parsed)) {
        skipped++;
        continue;
      }
      out.push(parsed);
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.error(
      `[channels] ${skipped} corrupt line(s) skipped in channel ${channelId}`,
    );
  }
  return out;
}

/** Strict ChannelMessage shape validator. Exported per Phase 4 Step A Layer 1
 *  RE-1 / ARCH-4 convergent fold (2026-05-14) — `peer-message-deliverer` hook
 *  consumes this primitive instead of re-implementing a weaker `typeof === "object"`
 *  check that would let prompt-injected schema metadata (non-string `from`,
 *  non-`ChannelKind` `kind`, etc.) slip past the body-fencing surface. Substrate
 *  is the SSOT; consumers validate via this exported predicate. */
export function isChannelMessage(v: unknown): v is ChannelMessage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  // Validator pulls directly from the SSOT tuple — adding a new kind to
  // `CHANNEL_KINDS` automatically widens this acceptance set (no separate
  // edit required here).
  if (typeof o["ts"] !== "string") return false;
  if (typeof o["from"] !== "string") return false;
  if (!CHANNEL_KINDS.includes(o["kind"] as ChannelKind)) return false;
  if (o["body"] !== undefined && typeof o["body"] !== "string") return false;
  if (o["body_ref"] !== undefined && typeof o["body_ref"] !== "string")
    return false;
  // Phase 1 additive optional fields: validate shape if present, ignore absence.
  if (o["identity"] !== undefined && typeof o["identity"] !== "string")
    return false;
  if (o["role"] !== undefined) {
    const role = o["role"];
    if (role !== "pen" && role !== "queue" && role !== "out") return false;
  }
  if (o["version"] !== undefined && o["version"] !== 1) return false;
  return true;
}

// ─── Heartbeat ──────────────────────────────────────────────────

/**
 * Touch the heartbeat marker for (channel, session). Signals liveness.
 *
 * Phase 2 Slice 7 schema extension: writes `Date.now()` (peer's user-space
 * wall-clock) into the file body. Pairs with `readHeartbeatBody` so peers
 * can detect clock-skew between this peer's user-space clock and the
 * filesystem-mtime stamp set by the kernel at the same write instant.
 *
 * Backwards-compat: legacy heartbeats with empty bodies still resolve via
 * mtime (`heartbeatMtime` is unchanged); body content is purely additive.
 * `writeFileSync` updates mtime as a side effect, so no separate
 * `utimesSync` is needed.
 */
export function touchHeartbeat(channelId: string, sessionId: string): void {
  mkdirSync(heartbeatDir(channelId), { recursive: true });
  writeFileSync(
    heartbeatPath(channelId, sessionId),
    String(getWallClockNow()),
    "utf-8",
  );
}

/** mtimeMs of the heartbeat marker, or null if none exists.
 *  Step G dual-read: tries NEW `heartbeats/` first, falls back to LEGACY
 *  `heartbeat/` for pre-rename peers. */
export function heartbeatMtime(
  channelId: string,
  sessionId: string,
): number | null {
  try {
    return statSync(heartbeatPath(channelId, sessionId)).mtimeMs;
  } catch {
    try {
      return statSync(legacyHeartbeatPath(channelId, sessionId)).mtimeMs;
    } catch {
      return null;
    }
  }
}

/**
 * Parse the heartbeat file body as the peer's `Date.now()` ms timestamp.
 *
 * Phase 2 Slice 7 reader: pairs with `touchHeartbeat`'s body-write to
 * support clock-skew detection. Returns `null` for missing/empty/corrupt
 * bodies (legacy peers, IO errors, malformed content). Strict parser —
 * only non-negative finite integer ms values are accepted.
 */
export function readHeartbeatBody(
  channelId: string,
  sessionId: string,
): number | null {
  let raw: string;
  try {
    raw = readFileSync(heartbeatPath(channelId, sessionId), "utf-8");
  } catch {
    // Step G dual-read fallback: try LEGACY `heartbeat/` for pre-rename peers.
    try {
      raw = readFileSync(legacyHeartbeatPath(channelId, sessionId), "utf-8");
    } catch {
      return null;
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0) return null;
  return n;
}

/** Newest heartbeat mtime across all participants. Null if no heartbeats.
 *  Step G dual-read: UNIONs NEW `heartbeats/` + LEGACY `heartbeat/` entries
 *  so pre-rename peers' heartbeats stay visible during 30-day transition. */
export function newestHeartbeatMtime(channelId: string): number | null {
  let newest: number | null = null;
  for (const dir of [heartbeatDir(channelId), legacyHeartbeatDir(channelId)]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      try {
        const m = statSync(join(dir, name)).mtimeMs;
        if (newest === null || m > newest) newest = m;
      } catch {
        /* skip */
      }
    }
  }
  return newest;
}

// ─── Listing / GC ───────────────────────────────────────────────

/** Enumerate all channels.
 *
 *  Archived channels are included only when asked.
 *
 *  By default (zero-arg or `{ includeArchived }`-only), channels whose
 *  `metadata.json` cannot be read/parsed are silently skipped — preserving
 *  legacy semantics ("list must not throw").
 *
 *  Phase 3 Step C addition (RE-W2-1 closure): opting in via
 *  `{ includeUnreachable: true }` surfaces such channels as
 *  `UnreachableChannelSummary` entries in the result, so consumers (the
 *  channel GC reaper, in particular) can act on them — e.g., emit
 *  operator-actionable breadcrumbs about orphan-sentinel state that would
 *  otherwise accumulate invisibly.
 *
 *  Overload ordering note: the specific `{ includeUnreachable: true }`
 *  overload is declared FIRST for call-site resolution; the legacy overload
 *  is declared LAST so `ReturnType<typeof listChannels>` resolves to
 *  `ChannelSummary[]` and pre-existing callers using that pattern (in
 *  hooks/checks/{active-channels-load,channel-gc,channels-gc-reaper}.ts)
 *  see no inferred-type drift.
 */
export function listChannels(opts: {
  includeUnreachable: true;
  includeArchived?: boolean;
}): Array<ChannelSummary | UnreachableChannelSummary>;
export function listChannels(opts?: {
  includeArchived?: boolean;
}): ChannelSummary[];
export function listChannels(opts?: {
  includeArchived?: boolean;
  includeUnreachable?: boolean;
}): Array<ChannelSummary | UnreachableChannelSummary> {
  const root = resolveChannelsDir();
  const out: Array<ChannelSummary | UnreachableChannelSummary> = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    if (entry === ".archive") continue;
    const id = entry;
    // Split try/catch (RE-1 v2.6 fold per Step C cross-audit): a failure
    // reading `metadata.json` is what defines "unreachable" — orphan
    // sentinels cannot be safely GC'd without a valid metadata anchor. A
    // failure reading `messages.jsonl` (via `lastMessageTs`) is a DIFFERENT
    // failure class (the channel's metadata is fine; just its message log
    // is unreadable) and must NOT misclassify the channel. Splitting the
    // catches keeps `UnreachableChannelSummary` semantics honest.
    let metadata: ChannelMetadata;
    try {
      metadata = readMetadata(id);
    } catch (err) {
      if (opts?.includeUnreachable) {
        out.push({
          kind: "unreachable",
          id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      /* else: skip malformed channel dirs — list must not throw */
      continue;
    }
    let lastTs: string | null;
    try {
      lastTs = lastMessageTs(id);
    } catch {
      /* messages.jsonl unreadable but metadata is fine — surface the channel
       *  with a null lastMessageTs (legacy semantics: list must not throw). */
      lastTs = null;
    }
    out.push({
      id,
      metadata,
      lastMessageTs: lastTs,
      archived: false,
    });
  }
  if (opts?.includeArchived) {
    const archive = resolveArchiveDir();
    if (existsSync(archive)) {
      for (const entry of readdirSync(archive)) {
        try {
          // Sub-step 0.10 TS-1 + TS-A6: archive branch routed through the
          // same validator as the active-channel branch via the
          // path-parameterized `readAndValidateMetadata`. Replaces the
          // unchecked `as ChannelMetadata` cast that previously trusted
          // archive metadata shape.
          const meta = readAndValidateMetadata(
            join(archive, entry, "metadata.json"),
            entry,
          );
          out.push({
            id: entry,
            metadata: meta,
            lastMessageTs: null,
            archived: true,
          });
        } catch (err) {
          if (opts?.includeUnreachable) {
            out.push({
              kind: "unreachable",
              id: entry,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          /* else: skip */
        }
      }
    }
  }
  return out;
}

function lastMessageTs(id: string): string | null {
  const msgs = readMessages(id);
  if (msgs.length === 0) return null;
  return msgs[msgs.length - 1]?.ts ?? null;
}

/** Move a channel dir into .archive/. Used by channel-gc. */
export function archiveChannel(channelId: string): void {
  const src = channelDir(channelId);
  const archive = resolveArchiveDir();
  mkdirSync(archive, { recursive: true });
  const dest = join(archive, channelId);
  if (existsSync(dest)) {
    const stamped = `${channelId}__${getWallClockNow()}`;
    renameSync(src, join(archive, stamped));
    return;
  }
  renameSync(src, dest);
}

/** Purge archive entries older than `retentionDays` and cap at `maxEntries`
 *  (oldest first). Returns the list of channel IDs purged. */
export function pruneArchive(opts: {
  retentionDays: number;
  maxEntries: number;
}): string[] {
  const archive = resolveArchiveDir();
  if (!existsSync(archive)) return [];
  const now = getWallClockNow();
  const retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;
  type ArchiveEntry = { id: string; path: string; mtimeMs: number };
  const entries: ArchiveEntry[] = [];
  for (const id of readdirSync(archive)) {
    const path = join(archive, id);
    try {
      entries.push({ id, path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      /* skip */
    }
  }
  const purged: string[] = [];
  for (const e of entries) {
    if (now - e.mtimeMs > retentionMs) {
      rmSync(e.path, { recursive: true, force: true });
      purged.push(e.id);
    }
  }
  const remaining = entries.filter((e) => !purged.includes(e.id));
  if (remaining.length > opts.maxEntries) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = remaining.length - opts.maxEntries;
    for (let i = 0; i < excess; i++) {
      const entry = remaining[i];
      if (!entry) continue;
      rmSync(entry.path, { recursive: true, force: true });
      purged.push(entry.id);
    }
  }
  return purged;
}

// ─── Last-seen cursor helpers (Phase 2 Slice 8) ──────────────────────

/** Discriminated result of `clearLastSeenCursor`. */
export type ClearLastSeenCursorResult =
  | { readonly kind: "cleared" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "error";
      readonly code: "EACCES" | "EBUSY" | "OTHER";
      readonly detail: string;
    };

/** Last-seen cursor shape: per-session, per-channel.
 *  - `mtime`: max `Date.parse(msg.ts)` across the last filtered batch
 *    (with `Number.isFinite` filter — RE-1 closure). NOT the file mtime.
 *  - `ts`: ISO 8601 form for human/debug. */
export type LastSeenCursor = {
  readonly mtime: number;
  readonly ts: string;
};

/** Read the per-session cursor for `channelId`. Returns null when absent
 *  or malformed. RE-1 closure: validates `Number.isFinite(parsed.mtime)`,
 *  not just `typeof === "number"` (NaN passes typeof check). RE-8 closure:
 *  `isValidArtifactId(channelId)` + `isValidSessionId(sessionId)` boundary
 *  checks. RE-13 closure: try/catch around readFileSync handles ENOENT
 *  during read (race with concurrent prune unlinking the file). */
export function readLastSeenCursor(
  channelId: string,
  sessionId: string,
): LastSeenCursor | null {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readLastSeenCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] readLastSeenCursor: invalid sessionId "${sessionId}"`,
    );
  }
  // Step G dual-read: try NEW `last-seen-cursors/` first, fall back to LEGACY
  // `last-seen/` so pre-rename peers' cursors remain readable during the
  // 30-day transition window.
  let raw: string;
  try {
    raw = readFileSync(lastSeenCursorPath(channelId, sessionId), "utf-8");
  } catch {
    try {
      raw = readFileSync(
        legacyLastSeenCursorPath(channelId, sessionId),
        "utf-8",
      );
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as LastSeenCursor;
    if (!Number.isFinite(c.mtime)) return null;
    if (typeof c.ts !== "string") return null;
    return { mtime: c.mtime, ts: c.ts };
  } catch {
    return null;
  }
}

/** Write the per-session cursor for `channelId`. Atomic via tmp+rename
 *  (RE-5 closure): `writeFileSync(tmpPath, ..., { flag: "wx" })` then
 *  `renameSync(tmpPath, finalPath)`. Concurrent writers race on rename;
 *  one wins, file always valid. RE-1 closure: rejects non-finite mtime.
 *  RE-8 closure: boundary checks. RE-12 closure: tmpPath includes
 *  `${pid}.${random}` suffix to avoid EEXIST collision on stale orphan. */
export function writeLastSeenCursor(
  channelId: string,
  sessionId: string,
  mtime: number,
  ts: string,
): void {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] writeLastSeenCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] writeLastSeenCursor: invalid sessionId "${sessionId}"`,
    );
  }
  if (!Number.isFinite(mtime)) {
    throw new Error(
      `[channels] writeLastSeenCursor: mtime must be finite, got ${mtime}`,
    );
  }
  const dir = lastSeenDir(channelId);
  mkdirSync(dir, { recursive: true });
  const finalPath = lastSeenCursorPath(channelId, sessionId);
  const tmpSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = `${finalPath}.${tmpSuffix}.tmp`;
  const cursor: LastSeenCursor = { mtime, ts };
  writeFileSync(tmpPath, `${JSON.stringify(cursor)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* tmp already gone; ignore */
    }
    throw err;
  }
}

/** Clear the per-session cursor for `channelId`. Idempotent — returns
 *  `{kind: "absent"}` on ENOENT (RE-10 closure: discriminated result for
 *  EACCES/EBUSY too). RE-8 closure: boundary checks. */
export function clearLastSeenCursor(
  channelId: string,
  sessionId: string,
): ClearLastSeenCursorResult {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] clearLastSeenCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] clearLastSeenCursor: invalid sessionId "${sessionId}"`,
    );
  }
  // Step G dual-clear: unlink BOTH NEW + LEGACY paths so the cursor is fully
  // cleared regardless of which path the writer used. Return "cleared" if
  // EITHER unlink succeeds; "absent" only if both ENOENT.
  let anyCleared = false;
  let firstError: { code: string; detail: string } | null = null;
  for (const path of [
    lastSeenCursorPath(channelId, sessionId),
    legacyLastSeenCursorPath(channelId, sessionId),
  ]) {
    try {
      unlinkSync(path);
      anyCleared = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") continue;
      const detail = err instanceof Error ? err.message : String(err);
      if (firstError === null) {
        firstError = {
          code: code === "EACCES" || code === "EBUSY" ? code : "OTHER",
          detail,
        };
      }
    }
  }
  if (anyCleared) return { kind: "cleared" };
  if (firstError !== null) {
    return {
      kind: "error",
      code: firstError.code as "EACCES" | "EBUSY" | "OTHER",
      detail: firstError.detail,
    };
  }
  return { kind: "absent" };
}

/** True iff the channel exists in the archive directory (per-channel
 *  archive dir at `<archiveDir>/<channelId>/`). Used by Slice 8's
 *  `forget-cursor` + `show-cursor` verbs to short-circuit on archived
 *  channels (CLI-11 closure). */
export function isChannelArchived(channelId: string): boolean {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] isChannelArchived: invalid channelId "${channelId}"`,
    );
  }
  return existsSync(archivedChannelDir(channelId));
}

/** Path to the per-channel `last-seen-cursors/` subdirectory (renamed in
 *  Step G from `last-seen/`). Exported so the Slice 4 GC reaper can scan +
 *  prune stale cursors (RE-W0-5). Reaper should ALSO consult
 *  `resolveLegacyLastSeenDir` for legacy-named entries during the 30-day
 *  dual-read transition window. */
export function resolveLastSeenDir(channelId: string): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveLastSeenDir: invalid channelId "${channelId}"`,
    );
  }
  return lastSeenDir(channelId);
}

/** Step G dual-read: path to the LEGACY per-channel `last-seen/`
 *  subdirectory. Exported so the GC reaper can enumerate + prune stale
 *  cursors written by pre-rename peers. Reaper unlinks stale entries from
 *  BOTH new + legacy dirs during the dual-read transition window. */
export function resolveLegacyLastSeenDir(channelId: string): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveLegacyLastSeenDir: invalid channelId "${channelId}"`,
    );
  }
  return legacyLastSeenDir(channelId);
}

/** Path to a specific session's last-seen cursor file. Exported for the
 *  Slice 4 GC reaper's per-cursor unlink path. */
export function resolveLastSeenCursorPath(
  channelId: string,
  sessionId: string,
): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveLastSeenCursorPath: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] resolveLastSeenCursorPath: invalid sessionId "${sessionId}"`,
    );
  }
  return lastSeenCursorPath(channelId, sessionId);
}
