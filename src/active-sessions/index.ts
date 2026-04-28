// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Preventive cross-session presence registry.
 *
 * Sibling to `src/channels/` (reactive, workflow-keyed) and `src/todos/`.
 * This module implements the preventive dimension (ARCHITECTURE.md principle
 * #9): artifact-keyed peer discovery so a PreToolUse gate can detect another
 * live Claude session editing the same artifact BEFORE the edit collides.
 *
 * Storage layout (never synced — locally-ephemeral tier):
 *
 *   ~/.claude/active-sessions/
 *   └── <artifact-id>/
 *       ├── meta.json                  # { artifactPath, createdAt }
 *       └── heartbeats/
 *           └── <session-id>           # one-line JSON owner record
 *
 * Liveness of a heartbeat requires all three:
 *   - file mtime within LIVE_WINDOW_MS
 *   - body parses as OwnerRecord JSON
 *   - host field matches the current hostname
 *
 * The JSON-body requirement (not an empty utimes-touched file) defends
 * against mtime-only ghost heartbeats that macOS Time Machine, Spotlight
 * `mdworker`, and cloud-sync daemons can produce — they bump mtime without
 * writing content, which would otherwise pin a dead session as "live".
 *
 * Artifact identification:
 *   1. realpath() the file — coordination roots are often symlinked.
 *   2. walk up looking for `.git` (dir or worktree file) → repo root.
 *   3. fallback to COORDINATION_ROOTS (~/.claude, ~/.claude-dotfiles,
 *      Obsidian Vault) for paths outside any repo that are still collision-
 *      prone (memory files, hook config, wiki pages).
 *
 * Concurrency: every fs operation is wrapped so a corrupt or mid-write file
 * never propagates as an exception. Writes use write-temp + rename-atomic.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { appendPresenceFailure } from "../shared/presence-failure-log.ts";
import { activeSessionsDir } from "../shared/paths.ts";

/** 30-minute live window — mirrors channel heartbeat TTL. */
export const LIVE_WINDOW_MS = 30 * 60 * 1000;

/** Opportunistic GC threshold — drop heartbeats older than 2× TTL. */
const GC_WINDOW_MS = 2 * LIVE_WINDOW_MS;

/** "Likely dead" threshold for operator listings. */
export const LIKELY_DEAD_MS = 10 * 60 * 1000;

/**
 * Clock-skew tolerance for future-dated mtimes. NTP rewinds, Time Machine
 * restores, and cloud-sync daemons can produce mtimes > `Date.now()`. Without
 * a defensive policy, `now - mtime < 0 < LIVE_WINDOW_MS` makes such entries
 * look perpetually live. Anything beyond this tolerance is treated as
 * corrupt garbage and reaped by the mutating callers; the non-mutating
 * listings simply skip it.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Defensive age computation. Returns `null` when `mtimeMs` is suspiciously
 * far in the future (callers should treat as garbage); otherwise returns a
 * non-negative age. Centralizes the one place where we translate mtime into
 * liveness signal so every caller gets consistent skew handling.
 */
function defensiveAgeMs(now: number, mtimeMs: number): number | null {
  if (mtimeMs > now + CLOCK_SKEW_TOLERANCE_MS) return null;
  return Math.max(0, now - mtimeMs);
}

export type OwnerRecord = {
  sessionId: string;
  pid: number;
  host: string;
  createdAt: number;
  touchedAt: number;
};

export type PeerInfo = {
  sessionId: string;
  ageMs: number;
  owner: OwnerRecord;
};

export type HeartbeatListing = PeerInfo & {
  likelyDead: boolean;
};

export type ArtifactMeta = {
  artifactPath: string;
  createdAt: number;
};

/** Root directory for all presence state. Delegates to the centralized
 *  resolver in `src/shared/paths.ts` which honors `CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR`,
 *  `CLAUDE_CONDUCTOR_ROOT`, and falls back to `~/.claude/conductor/active-sessions`. */
export function resolveActiveSessionsDir(): string {
  return activeSessionsDir();
}

/**
 * Coordination roots override — tests inject their own list. Production
 * resolves to realpath'd home-relative roots on each call so a fake `$HOME`
 * in a test sandbox works without patching.
 */
export type CoordinationRootOverride = { roots: readonly string[] };

let coordinationRootOverride: CoordinationRootOverride | null = null;

/** Test hook — inject a specific root list. Pass null to restore defaults. */
export function setCoordinationRootsForTesting(
  override: CoordinationRootOverride | null,
): void {
  coordinationRootOverride = override;
}

function defaultCoordinationRoots(): readonly string[] {
  // NOTE: this calls homedir() directly (NOT effectiveHome()) by design —
  // coordination roots are intentionally generic per RE-8 and span multiple
  // substrates (~/.claude, ~/.claude-dotfiles, ~/Documents/Obsidian Vault).
  // Test isolation via `process.env.HOME` mutation does NOT apply here because
  // os.homedir() caches at process start. Tests should use
  // setCoordinationRootsForTesting() above to inject their own root list.
  const home = homedir();
  const candidates = [
    join(home, ".claude"),
    join(home, ".claude-dotfiles"),
    join(home, "Documents", "Obsidian Vault"),
  ];
  const resolved: string[] = [];
  for (const c of candidates) {
    try {
      resolved.push(realpathSync(c));
    } catch {
      /* root doesn't exist on this machine — skip */
    }
  }
  return resolved;
}

function coordinationRoots(): readonly string[] {
  if (coordinationRootOverride) return coordinationRootOverride.roots;
  return defaultCoordinationRoots();
}

/**
 * Resolve a file path to the artifact root that owns it, or null if the
 * file is outside every tracked artifact.
 *
 * The returned path is realpath'd — callers compare against other realpath'd
 * values without worrying about macOS `/Users` vs `/private/Users` drift.
 */
export function artifactPathFromFile(filePath: string): string | null {
  let canonical: string;
  try {
    canonical = realpathSync(filePath);
  } catch {
    canonical = tryRealpathParent(filePath);
    if (canonical === "") return null;
  }

  const repoRoot = walkUpForGit(canonical);
  if (repoRoot) return repoRoot;

  const roots = coordinationRoots();
  for (const root of roots) {
    if (canonical === root || canonical.startsWith(`${root}/`)) {
      return root;
    }
  }
  return null;
}

/**
 * realpath can fail if the target doesn't exist yet (creating a brand-new
 * file). Fall back to realpath of the nearest existing parent, then append
 * the original basename — good enough to decide repo-root / coord-root.
 */
function tryRealpathParent(filePath: string): string {
  let parent = dirname(filePath);
  const leaf = basename(filePath);
  while (parent !== "/" && parent !== ".") {
    try {
      const real = realpathSync(parent);
      return join(real, leaf);
    } catch {
      parent = dirname(parent);
    }
  }
  return "";
}

function walkUpForGit(startPath: string): string | null {
  let dir = startPath;
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }

  let prev = "";
  while (dir !== prev && dir !== "/" && dir !== ".") {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    }
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Deterministic 12-char hash + sanitized basename — filesystem-safe,
 * human-inspectable, and guaranteed to satisfy VALID_ID_REGEX. Basename
 * characters outside `[a-zA-Z0-9._-]` (most commonly spaces in paths like
 * `Obsidian Vault`) are replaced with `-` so the id can embed in filesystem
 * paths and pass boundary validation. Uniqueness is carried by the hash —
 * two distinct roots with basenames that sanitize to the same string still
 * produce distinct ids because the hash is computed over the full path.
 */
export function artifactIdFromPath(root: string): string {
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
  const rawBase = basename(root) || "root";
  const safeBase = rawBase.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${hash}-${safeBase}`;
}

/**
 * Session IDs and artifact IDs are joined into filesystem paths inside
 * ~/.claude/active-sessions/. A malformed value containing .., /, or NUL
 * would escape the registry directory. Defense-in-depth: validate at every
 * boundary, even though Claude Code's raw.session_id is normally a UUID.
 */
const VALID_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && VALID_ID_REGEX.test(s);
}

export function isValidArtifactId(s: unknown): s is string {
  return typeof s === "string" && VALID_ID_REGEX.test(s);
}

// ─── Registry paths ────────────────────────────────────────────────

function artifactDir(artifactId: string): string {
  return join(resolveActiveSessionsDir(), artifactId);
}

function metaPath(artifactId: string): string {
  return join(artifactDir(artifactId), "meta.json");
}

function heartbeatsDir(artifactId: string): string {
  return join(artifactDir(artifactId), "heartbeats");
}

function heartbeatPath(artifactId: string, sessionId: string): string {
  return join(heartbeatsDir(artifactId), sessionId);
}

// ─── Heartbeat write ───────────────────────────────────────────────

/**
 * Write (or refresh) a heartbeat for (artifact, session). Creates meta.json
 * on first write. Atomic via write-temp + rename.
 */
export function touchHeartbeat(args: {
  artifactId: string;
  sessionId: string;
  artifactPath: string;
  now: number;
}): void {
  const { artifactId, sessionId, artifactPath, now } = args;
  if (!isValidArtifactId(artifactId))
    throw new Error(`invalid artifactId: ${artifactId}`);
  if (!isValidSessionId(sessionId))
    throw new Error(`invalid sessionId: ${sessionId}`);
  mkdirSync(heartbeatsDir(artifactId), { recursive: true });

  const metaFile = metaPath(artifactId);
  if (!existsSync(metaFile)) {
    writeMetaIfMissing(metaFile, { artifactPath, createdAt: now });
  }

  const existing = readOwnerRecord(heartbeatPath(artifactId, sessionId));
  const createdAt = existing?.createdAt ?? now;
  const record: OwnerRecord = {
    sessionId,
    pid: process.pid,
    host: hostname(),
    createdAt,
    touchedAt: now,
  };
  writeAtomic(
    heartbeatPath(artifactId, sessionId),
    `${JSON.stringify(record)}\n`,
  );
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

/**
 * Write meta.json only if it doesn't exist — resolves the RE-1 race where
 * two concurrent first-writers both passed an `existsSync` gate and the
 * second's rename clobbered the first's meta. linkSync is atomic-if-target-
 * missing on POSIX: it fails with EEXIST when the target already exists,
 * giving us the O_EXCL primitive without an explicit open() dance.
 *
 * Sequence:
 *   1. Write tmp file with `wx` (O_CREAT | O_EXCL) to random-suffix path.
 *   2. linkSync tmp → metaFile. Wins if target missing; EEXIST if peer won.
 *   3. Unlink tmp. (After the link, tmp is redundant — metaFile has its own
 *      inode entry; removing tmp doesn't affect the linked file.)
 *
 * Failure policy: this is a fail-soft path. If linkSync throws for a
 * reason other than EEXIST (EACCES, ENOSPC, EIO), re-check `existsSync` —
 * if meta now exists, a peer won the race in a non-standard way and we
 * accept that as success. Otherwise log a registry-contention event and
 * return cleanly. Never propagate — the caller (touchHeartbeat) is part
 * of the preventive-coordination hot path and must not fail Edits.
 */
export function writeMetaIfMissing(metaFile: string, meta: ArtifactMeta): void {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const tmp = `${metaFile}.tmp.${suffix}`;
  try {
    try {
      writeFileSync(tmp, `${JSON.stringify(meta)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (err: unknown) {
      logRegistryContention(null, `meta tmp write failed: ${errMessage(err)}`);
      return;
    }
    try {
      linkSync(tmp, metaFile);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return;
      if (existsSync(metaFile)) return;
      logRegistryContention(null, `meta link failed: ${errMessage(err)}`);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp may never have been created, or already cleaned — ignore */
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logRegistryContention(
  artifactPath: string | null,
  detail: string,
): void {
  appendPresenceFailure({
    timestamp: new Date().toISOString(),
    sessionId: null,
    source: "active-sessions-registry",
    kind: "registry-contention",
    artifactPath,
    detail,
  });
}

/**
 * Per-process dedupe for GC-miss logging. First non-ENOENT unlink failure
 * for an `${artifactId}/${sessionId}` key writes one event; repeated misses
 * on the same key stay silent until the process exits. A restart clears
 * the set, which is the right signal — new process, operator wants fresh
 * visibility.
 */
const gcMissReported = new Set<string>();

/** Test hook — clear the dedupe set between cases. */
export function resetGcMissDedupeForTesting(): void {
  gcMissReported.clear();
}

/**
 * Unlink a stale heartbeat. Returns true when the file is gone afterward
 * (successful unlink OR benign ENOENT race). ENOENT is silent by design
 * — it means a peer's concurrent GC already reaped it. Non-ENOENT
 * failures (EACCES, EPERM, EBUSY, EIO, EISDIR, etc.) log a registry-
 * contention event on first occurrence per (artifactId, sessionId) per
 * process.
 */
function tryReapHeartbeat(
  artifactId: string,
  sessionId: string,
  path: string,
): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    const key = `${artifactId}/${sessionId}`;
    if (!gcMissReported.has(key)) {
      gcMissReported.add(key);
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        sessionId,
        source: "active-sessions-registry",
        kind: "registry-contention",
        artifactPath: null,
        detail: `gc-miss on ${artifactId}/${sessionId}: ${errMessage(err)}`,
      });
    }
    return false;
  }
}

// ─── Peer listing ──────────────────────────────────────────────────

function readOwnerRecord(path: string): OwnerRecord | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const sessionId = obj["sessionId"];
    const pid = obj["pid"];
    const host = obj["host"];
    const createdAt = obj["createdAt"];
    const touchedAt = obj["touchedAt"];
    if (
      typeof sessionId !== "string" ||
      typeof pid !== "number" ||
      typeof host !== "string" ||
      typeof createdAt !== "number" ||
      typeof touchedAt !== "number"
    ) {
      return null;
    }
    return { sessionId, pid, host, createdAt, touchedAt };
  } catch {
    return null;
  }
}

/**
 * List live peer heartbeats for an artifact, excluding `self`.
 *
 * "Live" requires all of:
 *   - mtime within LIVE_WINDOW_MS
 *   - body parses as OwnerRecord
 *   - host matches current hostname (cross-host presence is not checked)
 *
 * Opportunistic GC: entries older than 2× TTL are removed in-place while we
 * walk the directory. This avoids needing a separate sweep scheduler.
 */
export function listLivePeers(args: {
  artifactId: string;
  self: string;
  now: number;
}): PeerInfo[] {
  const { artifactId, self, now } = args;
  if (!isValidArtifactId(artifactId)) return [];
  const dir = heartbeatsDir(artifactId);
  if (!existsSync(dir)) return [];

  const out: PeerInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  const currentHost = hostname();
  for (const entry of entries) {
    // Never GC own heartbeat — fixes RE-1. If we're the one scanning, skip
    // our own entry before the age-based GC branch so a long-idle session
    // doesn't self-reap on its next PreToolUse.
    if (entry === self) continue;

    const path = join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const ageMs = defensiveAgeMs(now, mtimeMs);

    // Clock-skew garbage or aged-out — opportunistic reap.
    if (ageMs === null || ageMs > GC_WINDOW_MS) {
      tryReapHeartbeat(artifactId, entry, path);
      continue;
    }
    if (ageMs > LIVE_WINDOW_MS) continue;

    // INVARIANT: this null-filter is what makes PeerInfo.owner non-nullable.
    // readOwnerRecord returns OwnerRecord | null (corrupt/missing on-disk
    // records produce null). Removing this filter without changing PeerInfo.owner
    // to OwnerRecord | null turns the type into a lie — callers would read
    // `peer.owner.host` on a null and crash at runtime.
    // Regression test: src/__tests__/active-sessions/peer-info-owner-invariant.test.ts
    const owner = readOwnerRecord(path);
    if (!owner) continue;
    if (owner.host !== currentHost) continue;

    out.push({ sessionId: entry, ageMs, owner });
  }
  return out;
}

/**
 * List every heartbeat for an artifact — operator view. Includes stale-but-
 * not-yet-GC'd entries with a `likelyDead` flag so `/presence list` can
 * distinguish recently-dead from live.
 */
export function listAllHeartbeats(args: {
  artifactId: string;
  now: number;
}): HeartbeatListing[] {
  const { artifactId, now } = args;
  const dir = heartbeatsDir(artifactId);
  if (!existsSync(dir)) return [];

  const out: HeartbeatListing[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    const path = join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const owner = readOwnerRecord(path);
    if (!owner) continue;
    const ageMs = defensiveAgeMs(now, mtimeMs);
    if (ageMs === null) continue; // future-mtime garbage — skip in operator view
    out.push({
      sessionId: entry,
      ageMs,
      owner,
      likelyDead: ageMs > LIKELY_DEAD_MS,
    });
  }
  return out;
}

/** Remove our own heartbeat — called at Stop. Best-effort. */
export function removeOwnHeartbeat(
  artifactId: string,
  sessionId: string,
): void {
  if (!isValidArtifactId(artifactId) || !isValidSessionId(sessionId)) return;
  try {
    unlinkSync(heartbeatPath(artifactId, sessionId));
  } catch {
    /* already gone or never existed */
  }
}

/** Enumerate tracked artifact IDs that exist in the registry. */
export function listArtifactIds(): string[] {
  const root = resolveActiveSessionsDir();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** Read the meta.json for an artifact — null on any failure. */
export function readArtifactMeta(artifactId: string): ArtifactMeta | null {
  try {
    const raw = readFileSync(metaPath(artifactId), "utf-8").trim();
    if (raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const artifactPath = obj["artifactPath"];
    const createdAt = obj["createdAt"];
    if (typeof artifactPath !== "string" || typeof createdAt !== "number")
      return null;
    return { artifactPath, createdAt };
  } catch {
    return null;
  }
}

/**
 * Operator tool — sweep every artifact dir. Removes dead heartbeats and
 * empty artifact directories. Not called from the hot path; the
 * `listLivePeers` opportunistic GC is sufficient there.
 */
export function gcStaleArtifacts(now: number): string[] {
  const root = resolveActiveSessionsDir();
  if (!existsSync(root)) return [];
  const reaped: string[] = [];
  for (const artifactId of listArtifactIds()) {
    const dir = heartbeatsDir(artifactId);
    if (!existsSync(dir)) {
      tryRemoveEmptyArtifactDir(artifactId);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    // `dirStillOccupied` tracks whether we have any reason to believe the
    // artifact dir is not actually empty — either a live heartbeat OR a
    // stuck heartbeat (unlink failed). Either means the post-loop cleanup
    // must NOT recursively rm the dir. Without this, an EISDIR'd heartbeat
    // would get blown away by the recursive-rm cleanup, defeating the RE-3
    // contention-log signal that's supposed to persist across scans.
    let dirStillOccupied = false;
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        const mtime = statSync(path).mtimeMs;
        const age = defensiveAgeMs(now, mtime);
        if (age === null || age > GC_WINDOW_MS) {
          if (tryReapHeartbeat(artifactId, entry, path)) {
            reaped.push(`${artifactId}/${entry}`);
          } else {
            // Unlink failed (EISDIR/EACCES/EPERM/EIO). The entry is still on
            // disk, so the dir is not empty. Do not trigger recursive cleanup.
            dirStillOccupied = true;
          }
        } else {
          dirStillOccupied = true;
        }
      } catch {
        // statSync failed — could be a concurrent reap (ENOENT, benign) or
        // a transient fs error. Assume transient and mark the dir occupied
        // so we don't recursive-rm a partially-observed state.
        dirStillOccupied = true;
      }
    }
    if (!dirStillOccupied) tryRemoveEmptyArtifactDir(artifactId);
  }
  return reaped;
}

/**
 * Remove the artifact dir iff it is truly empty. Uses non-recursive
 * `rmdirSync` so a concurrent writer that just planted a fresh heartbeat
 * (race with `touchHeartbeat`) triggers ENOTEMPTY and leaves the new
 * state intact. Recursive rm here was a data-loss hazard: the GC scan
 * could classify the dir empty milliseconds before a peer re-registered,
 * then the recursive rm would blow the new heartbeat away.
 *
 * Also best-effort for the heartbeats subdir — if that's empty we can
 * rmdir it, then rmdir the artifact dir. Either step failing is fine;
 * the next sweep tries again.
 */
function tryRemoveEmptyArtifactDir(artifactId: string): void {
  const hbDir = heartbeatsDir(artifactId);
  try {
    rmdirSync(hbDir);
  } catch {
    /* not empty OR gone — either way stop here */
  }
  const dir = artifactDir(artifactId);
  // meta.json may still be present; reap it only if we own the dir and
  // nothing else is inside. Non-recursive rmdir handles that safely.
  try {
    const remaining = readdirSync(dir);
    if (remaining.length === 1 && remaining[0] === "meta.json") {
      unlinkSync(join(dir, "meta.json"));
    }
  } catch {
    /* dir gone or unreadable */
  }
  try {
    rmdirSync(dir);
  } catch {
    /* not empty (concurrent writer) OR gone — both fine */
  }
}

// ─── Operator reset ────────────────────────────────────────────────

/**
 * Operator escape hatch — destroy all registry state for one artifact.
 *
 * Called by `/presence reset <artifact-id>` when the shared failure log
 * shows persistent contention on an artifact and the operator wants a
 * clean slate. Live peers lose their heartbeat; their next Edit
 * re-registers via touchHeartbeat.
 *
 * Defense-in-depth guards (all required — each closes a different
 * attack/accident surface):
 *
 *   1. `isValidArtifactId` — syntactic boundary (prevents `..` / `/` in id).
 *   2. `listArtifactIds().includes(id)` — membership check (prevents
 *      operator typo like `reset logs` from validating and rm-ing a
 *      non-registry directory that happens to match the regex).
 *   3. `lstatSync` + symlink refuse (prevents symlink-substitution where
 *      a local attacker replaces the artifact dir with a symlink to a
 *      sensitive target between validation and rmSync).
 *   4. realpath equality against `resolveActiveSessionsDir()` (prevents
 *      any remaining way for the resolved path to escape the registry).
 *   5. Atomic rename-then-rm — after the guards pass, rename the dir to
 *      a pid+ts-tagged sibling BEFORE removing. This closes the TOCTOU
 *      window between guards 3/4 and `rmSync` where a local attacker
 *      could swap the dir for a symlink. `renameSync` moves the symlink
 *      itself (not its target), so a post-rename `lstatSync` catches the
 *      substitution and we unlink just the symlink.
 *
 * Emits an `operator-reset` event to the shared failure log so
 * concurrent peer write-failures can be correlated with the reset in
 * post-mortem.
 */
export function resetArtifactRegistry(artifactId: string): {
  metaRemoved: boolean;
  heartbeatsRemoved: string[];
} {
  if (!isValidArtifactId(artifactId)) {
    throw new Error(`invalid artifactId: ${artifactId}`);
  }
  if (!listArtifactIds().includes(artifactId)) {
    return { metaRemoved: false, heartbeatsRemoved: [] };
  }

  const dir = artifactDir(artifactId);

  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to reset: ${artifactId} is a symlink`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { metaRemoved: false, heartbeatsRemoved: [] };
    }
    throw err;
  }

  const rootReal = realpathSync(resolveActiveSessionsDir());
  const dirReal = realpathSync(dir);
  if (dirReal !== join(rootReal, artifactId)) {
    throw new Error(
      `refusing to reset: ${artifactId} resolves outside registry`,
    );
  }

  const artifactPath = readArtifactMeta(artifactId)?.artifactPath ?? null;
  const heartbeats = listAllHeartbeats({ artifactId, now: Date.now() });
  const heartbeatsRemoved = heartbeats.map((h) => h.sessionId);
  const metaRemoved = existsSync(metaPath(artifactId));

  // Rename under a quarantine suffix before rm. renameSync is atomic and
  // operates on the named entry — if the dir was swapped for a symlink
  // between the lstat/realpath guards and this point, we move the symlink
  // (not its target). The post-rename lstat then refuses and unlinks only
  // the symlink itself, leaving the target untouched.
  const quarantine = `${dir}.reset-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(dir, quarantine);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { metaRemoved: false, heartbeatsRemoved: [] };
    }
    throw err;
  }

  try {
    const stAfter = lstatSync(quarantine);
    if (stAfter.isSymbolicLink()) {
      try {
        unlinkSync(quarantine);
      } catch {
        /* best effort — we're already refusing the reset */
      }
      throw new Error(
        `refusing to reset: ${artifactId} was substituted with a symlink`,
      );
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { metaRemoved: false, heartbeatsRemoved: [] };
    }
    throw err;
  }

  rmSync(quarantine, { recursive: true, force: true });

  appendPresenceFailure({
    timestamp: new Date().toISOString(),
    sessionId: null,
    source: "active-sessions-registry",
    kind: "operator-reset",
    artifactPath,
    detail: `reset ${artifactId}: meta=${metaRemoved}, ${heartbeatsRemoved.length} heartbeats removed`,
  });

  return { metaRemoved, heartbeatsRemoved };
}
