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
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { extractSessionId } from "../hooks/session-id.ts";

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

export type ChannelMessage = {
  ts: string;
  from: string;
  kind: ChannelKind;
  body?: string;
  body_ref?: string;
};

export type ChannelMetadata = {
  created_at: string;
  lifecycle: ChannelLifecycle;
  handoff_id: string;
  participants: string[];
  closed_at?: string;
};

export type ChannelSummary = {
  id: string;
  metadata: ChannelMetadata;
  lastMessageTs: string | null;
  archived: boolean;
};

/** Root directory for all channel state. Tests override via `CHANNELS_DIR`. */
export function resolveChannelsDir(): string {
  return process.env["CHANNELS_DIR"] ?? join(homedir(), ".claude", "channels");
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
 * Canonical session-id resolver. Prefers `CLAUDE_SESSION_ID` (tests) then
 * the hook input's raw session_id. Throws loudly if neither is available —
 * never guesses.
 */
export function resolveSessionId(
  raw: Record<string, unknown> | undefined,
): string {
  const envOverride = process.env["CLAUDE_SESSION_ID"];
  if (envOverride && envOverride.length > 0) return envOverride;
  const fromInput = raw ? extractSessionId(raw) : undefined;
  if (fromInput) return fromInput;
  throw new Error(
    "[channels] session_id not found — pass hook input with raw.session_id or set CLAUDE_SESSION_ID",
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

function acquireLock(lockPath: string): number {
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
      const until = Date.now() + delay;
      while (Date.now() < until) {
        /* spin-wait — lock holds are tens of ms */
      }
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

function withMetadataLock<T>(id: string, fn: () => T): T {
  mkdirSync(channelDir(id), { recursive: true });
  const lockPath = metadataLockPath(id);
  const fd = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(fd, lockPath);
  }
}

function readMetadataRaw(id: string): ChannelMetadata {
  const text = readFileSync(metadataPath(id), "utf-8");
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`[channels] metadata for ${id} is not an object`);
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
    throw new Error(`[channels] metadata for ${id} has an invalid shape`);
  }
  const meta: ChannelMetadata = {
    created_at,
    lifecycle,
    handoff_id,
    participants,
  };
  const closed_at = obj["closed_at"];
  if (typeof closed_at === "string") meta.closed_at = closed_at;
  return meta;
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
export function createChannel(args: {
  channelId: string;
  handoffId: string;
  sessionId: string;
}): ChannelMetadata {
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
export function joinChannel(args: {
  channelId: string;
  sessionId: string;
}): ChannelMetadata {
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
export function closeChannel(args: {
  channelId: string;
  sessionId: string;
}): ChannelMetadata {
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
  const initialLine = serializeLine(message);
  if (
    Buffer.byteLength(initialLine, "utf-8") > SMALL_MESSAGE_MAX_BYTES &&
    message.body
  ) {
    const ref = writeBodyFile(channelId, message.body);
    message = {
      ts: message.ts,
      from: message.from,
      kind: message.kind,
      body_ref: ref,
    };
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
          const text = readFileSync(
            join(archive, entry, "metadata.json"),
            "utf-8",
          );
          const meta = JSON.parse(text) as ChannelMetadata;
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
