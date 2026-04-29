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
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  isValidArtifactId,
  isValidSessionId,
} from "../active-sessions/index.ts";
import { extractSessionId } from "../hooks/session-id.ts";
import { channelsDir } from "../shared/paths.ts";

/** Conservative atomic-append threshold. POSIX guarantees PIPE_BUF (512 on
 *  macOS); Linux regular-file O_APPEND is typically safe up to 4096. We
 *  use 3KB as a safe middle ground — anything larger redirects the body
 *  to a sidecar file and only a pointer message is appended. */
const SMALL_MESSAGE_MAX_BYTES = 3 * 1024;

const LOCK_STALE_MS = 30 * 1000;
const LOCK_MAX_ATTEMPTS = 5;
const LOCK_BASE_DELAY_MS = 50;

export type ChannelLifecycle = "parallel";

export type ChannelKind = "note" | "question" | "handoff" | "status";

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
function heartbeatDir(id: string): string {
  return join(channelDir(id), "heartbeat");
}
function heartbeatPath(id: string, sessionId: string): string {
  return join(heartbeatDir(id), sessionId);
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
      return openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      );
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
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
  throw new Error(
    `[channels] failed to acquire lock ${lockPath}: ${lastErr?.message ?? "unknown"}`,
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

async function withMetadataLock<T>(
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
      validated[letter] = { session_id, role, joined_at };
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
    const ageMs = peerMtime === null ? null : Date.now() - peerMtime;
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

/** Append a message. Large bodies are redirected to a sidecar file. */
export function appendMessage(args: {
  channelId: string;
  message: ChannelMessage;
}): ChannelMessage {
  const { channelId } = args;
  if (!existsSync(metadataPath(channelId))) {
    throw new Error(`[channels] channel ${channelId} does not exist`);
  }
  const meta = readMetadata(channelId);
  if (meta.closed_at) {
    throw new Error(`[channels] channel ${channelId} is closed; cannot append`);
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
  const line = serializeLine(message);
  appendLineAtomically(messagesPath(channelId), line);
  touchHeartbeat(channelId, message.from);
  return message;
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

function isChannelMessage(v: unknown): v is ChannelMessage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const validKinds: readonly ChannelKind[] = [
    "note",
    "question",
    "handoff",
    "status",
  ];
  if (typeof o["ts"] !== "string") return false;
  if (typeof o["from"] !== "string") return false;
  if (!validKinds.includes(o["kind"] as ChannelKind)) return false;
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

/** Touch the heartbeat marker for (channel, session). Signals liveness. */
export function touchHeartbeat(channelId: string, sessionId: string): void {
  mkdirSync(heartbeatDir(channelId), { recursive: true });
  const path = heartbeatPath(channelId, sessionId);
  const now = new Date();
  if (!existsSync(path)) {
    writeFileSync(path, "", "utf-8");
  } else {
    utimesSync(path, now, now);
  }
}

/** mtimeMs of the heartbeat marker, or null if none exists. */
export function heartbeatMtime(
  channelId: string,
  sessionId: string,
): number | null {
  try {
    return statSync(heartbeatPath(channelId, sessionId)).mtimeMs;
  } catch {
    return null;
  }
}

/** Newest heartbeat mtime across all participants. Null if no heartbeats. */
export function newestHeartbeatMtime(channelId: string): number | null {
  const dir = heartbeatDir(channelId);
  if (!existsSync(dir)) return null;
  let newest: number | null = null;
  for (const name of readdirSync(dir)) {
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch {
      /* skip */
    }
  }
  return newest;
}

// ─── Listing / GC ───────────────────────────────────────────────

/** Enumerate all channels. Archived channels are included only when asked. */
export function listChannels(opts?: {
  includeArchived?: boolean;
}): ChannelSummary[] {
  const root = resolveChannelsDir();
  const out: ChannelSummary[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    if (entry === ".archive") continue;
    const id = entry;
    try {
      const metadata = readMetadata(id);
      out.push({
        id,
        metadata,
        lastMessageTs: lastMessageTs(id),
        archived: false,
      });
    } catch {
      /* skip malformed channel dirs — list must not throw */
    }
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
        } catch {
          /* skip */
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
    const stamped = `${channelId}__${Date.now()}`;
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
  const now = Date.now();
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
