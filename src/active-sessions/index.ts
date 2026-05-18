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

import { spawnSync } from "node:child_process";
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
import { basename, dirname, join, resolve } from "node:path";
import { getWallClockNow } from "../shared/clock.ts";
import { effectiveHome } from "../shared/home.ts";
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

/**
 * Caller-stack capture for slice-7 A2 telemetry breadcrumbs (plan v1.3
 * Points 2/3/5/7). Takes the top 4 non-native frames from `new Error().stack`
 * after dropping `Error` + this helper itself. Used to disambiguate which
 * caller path triggered a sensitive event (clear/unregister/reap/reset)
 * during post-incident triage. Joined with " | " for single-line log shape.
 */
function callerTop4(): string {
  const stack = (new Error().stack ?? "").split("\n").slice(2);
  return stack
    .filter((f) => !f.includes("at native:") && !f.includes("(native:"))
    .slice(0, 4)
    .map((f) => f.trim())
    .join(" | ");
}

export type OwnerRecord = {
  sessionId: string;
  pid: number;
  host: string;
  createdAt: number;
  touchedAt: number;
  // Phase 3 Slice 2 — per-session worktree sentinel (anchored at the
  // canonical-claude-home heartbeat per D-ARCH3). Optional + additive: old
  // readers tolerate missing field; new writers preserve any earlier value
  // through `touchHeartbeat`'s read-merge-write semantics. The provisioner
  // hook explicitly pins this anchor at session-start (ARCH-1 fix) so the
  // resolver's heartbeat-body sentinel read path is reachable regardless
  // of CWD.
  dotfilesRoot?: string;
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
 *  `CLAUDE_CONDUCTOR_ROOT`, and falls back to `~/.claude/active-sessions`
 *  (per Decision N: shared canonical with dotfiles, not under `conductor/`). */
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
 *
 * REV 0.2 RE-1 (mandatory canonicalization): when `root` resolves to a
 * directory inside a git working tree, the hash is computed over the
 * canonical toplevel derived from `git rev-parse --git-common-dir` (NOT
 * `--show-toplevel`, which returns the worktree's own path). This maps
 * worktree paths (`~/.claude-dotfiles-<sid>/...`) to their canonical
 * toplevel (`~/.claude-dotfiles`), so cross-worktree collision detection
 * still works under Phase 3 Slice 2's per-session-worktree substrate.
 * See `canonicalizeViaGit` below for the exact derivation.
 *
 * Falls back to raw root + breadcrumb if rev-parse fails (root is not
 * inside a git tree, git is unavailable, etc.). Never throws.
 */
export function artifactIdFromPath(root: string): string {
  const canonical = canonicalizeViaGit(root);
  const hash = createHash("sha1").update(canonical).digest("hex").slice(0, 12);
  const rawBase = basename(canonical) || "root";
  const safeBase = rawBase.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${hash}-${safeBase}`;
}

/**
 * Map a path to its canonical-worktree root when possible. Falls back
 * to the input unchanged on any error — git not installed, root outside
 * any git tree, root non-existent. Errors are silent here because
 * `artifactIdFromPath` is on the hot path (every PreToolUse fires it)
 * and a breadcrumb-on-fallback would be too noisy.
 *
 * Uses `--git-common-dir` (NOT `--show-toplevel`) so a path inside a
 * worktree resolves to the CANONICAL toplevel, not the worktree's own
 * toplevel. `--show-toplevel` returns the worktree's path; the goal of
 * the RE-1 canonicalization is to map worktree paths to their canonical
 * counterpart, so we read the common gitdir (always points at the
 * canonical's `.git`) and strip the trailing `/.git` to get the path.
 *
 * The common-dir output is `.git` for the canonical itself when run
 * from the canonical's working tree; we resolve that to absolute via
 * `--path-format=absolute` so callers don't get the bare relative form.
 */
function canonicalizeViaGit(root: string): string {
  try {
    const result = spawnSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.status === 0) {
      const common = result.stdout.toString("utf-8").trim();
      if (common.length > 0) return stripTrailingGitDir(common);
    }
  } catch {
    /* git missing / cwd doesn't exist / etc — fall through */
  }
  return root;
}

/**
 * Convert `/path/to/repo/.git` → `/path/to/repo`. If the path doesn't
 * end in `/.git`, return it unchanged (defensive for bare repos or
 * non-standard layouts).
 */
function stripTrailingGitDir(path: string): string {
  if (path.endsWith("/.git")) return path.slice(0, -"/.git".length);
  if (path.endsWith("/.git/")) return path.slice(0, -"/.git/".length);
  return path;
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

export function heartbeatPath(artifactId: string, sessionId: string): string {
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
  // REV 0.2 ARCH-2 / RE-101 — read-merge-write semantics. Existing
  // touchHeartbeat callers don't set `dotfilesRoot`; the merge preserves
  // any value the provisioner wrote earlier in the session so subsequent
  // dispatcher fires don't clobber the sentinel. Per Bravo B8 + the
  // bounded re-audit RE 9.0 verdict, the only field the merge actively
  // preserves is `dotfilesRoot` (the rare-write field); common-write
  // fields (touchedAt/pid/host) come from the current call's context.
  const record: OwnerRecord =
    existing?.dotfilesRoot !== undefined
      ? {
          sessionId,
          pid: process.pid,
          host: hostname(),
          createdAt,
          touchedAt: now,
          dotfilesRoot: existing.dotfilesRoot,
        }
      : {
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

  // Slice 7 A2 — Point 4: anomaly log when canonical-anchor heartbeat
  // exists WITHOUT a dotfilesRoot field. Anchor-gated via artifactId-eq
  // (per plan v1.4 FOLD-6 — macOS realpath-drift makes path-string-eq
  // fragile; canonicalClaudeHomeArtifactId() is robust). Anchor-only
  // scope eliminates 99% of noise.
  if (
    existing !== null &&
    existing.dotfilesRoot === undefined &&
    artifactId === canonicalClaudeHomeArtifactId()
  ) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "active-sessions-registry",
      kind: "heartbeat-no-dotfilesroot-on-existing",
      artifactPath,
      detail: `existing.touchedAt=${String(existing.touchedAt)} existing.createdAt=${String(existing.createdAt)} pid=${process.pid}`,
    });
  }
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
    // Slice 7 A2 — Point 5: emit AFTER successful unlinkSync. Single
    // instrumentation covers ALL 3 reap call sites atomically
    // (listLivePeers opportunistic-GC + gcStaleHeartbeats sweeper +
    // unregisterActiveSession explicit). Reaper-vs-reapee semantics
    // per plan v1.3: event.sessionId IS the reapee (matches existing
    // registry-contention precedent above); redundant reaper_sid in
    // detail enables single-sid grep to find both roles.
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "active-sessions-registry",
      kind: "heartbeat-reaped",
      artifactPath: path,
      detail: `target_sid=${sessionId} reaper_sid=${process.env["CLAUDE_SESSION_ID"] ?? "unknown"} pid=${process.pid} caller_top4=${callerTop4()}`,
    });
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
    // REV 0.2 ARCH-2 — carry the optional `dotfilesRoot` field through.
    // Older heartbeats written before Slice 2 don't have this field; the
    // typeof-string guard accepts both shapes. Empty-string is treated as
    // absent (defensive — write paths never produce empty strings).
    const dotfilesRoot = obj["dotfilesRoot"];
    return typeof dotfilesRoot === "string" && dotfilesRoot.length > 0
      ? { sessionId, pid, host, createdAt, touchedAt, dotfilesRoot }
      : { sessionId, pid, host, createdAt, touchedAt };
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
  const path = heartbeatPath(artifactId, sessionId);
  try {
    unlinkSync(path);
    // Slice 7 A2 — Point 6: success-path emit. Stop-hook self-removal
    // is single-caller (`session-presence-unregister.ts:41`); no
    // caller-stack capture needed.
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "active-sessions-registry",
      kind: "heartbeat-removed",
      artifactPath: path,
      detail: `pid=${process.pid} self-stop`,
    });
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
  const heartbeats = listAllHeartbeats({ artifactId, now: getWallClockNow() });
  const heartbeatsRemoved = heartbeats.map((h) => h.sessionId);
  const metaRemoved = existsSync(metaPath(artifactId));

  // Slice 7 A2 — Point 7 (v1.4 NEW per FOLD-4): emit BEFORE the
  // rename-to-quarantine (which precedes rm) so we capture the state
  // being destroyed. Post-rmSync emit would be trivially empty.
  // Shape per Q3 disposition: count + first-8-of-each-sid-prefix list
  // capped at 10 entries (operator-friendly; bounds log-bloat on
  // pathological reset-of-large-fleet).
  const sidPrefixSample = heartbeats
    .slice(0, 10)
    .map((h) => h.sessionId.slice(0, 8))
    .join(",");
  appendPresenceFailure({
    timestamp: new Date().toISOString(),
    sessionId: null,
    source: "active-sessions-registry",
    kind: "artifact-reset",
    artifactPath,
    detail: `artifactId=${artifactId} heartbeats_count=${String(heartbeatsRemoved.length)} sid_prefix_sample=[${sidPrefixSample}] pid=${process.pid} caller_top4=${callerTop4()}`,
  });

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

// ─── Phase 3 Slice 2: heartbeat-body sentinel extension (D-ARCH3) ──

/**
 * Compute the canonical-claude-home artifact-id used as the sentinel anchor
 * for per-session `dotfilesRoot`. Always resolvable from `homedir()`; no
 * dependency on whether the session has touched `~/.claude/` yet.
 *
 * The anchor is intentionally NOT artifactPathFromFile-derived — that
 * function walks CWD upward to the first git toplevel, which for a
 * worktree-CWD session resolves to the worktree, not `~/.claude`. The
 * provisioner hook (Phase 3 Slice 2 Commit 4) explicitly pins this
 * anchor at session-start so the resolver's read path is reachable
 * regardless of CWD (REV 0.2 ARCH-1 fix).
 */
export function canonicalClaudeHomeArtifactId(): string {
  // Use effectiveHome() so tests that mutate $HOME for isolation see a
  // tmp-rooted artifact-id (matching what they'd compute via the same
  // helper). Production behavior unchanged — when $HOME is unset/empty,
  // effectiveHome() falls back to os.homedir().
  return artifactIdFromPath(join(effectiveHome(), ".claude"));
}

/**
 * Anchor `dotfilesRoot` for the session at the canonical-claude-home
 * heartbeat. Force-creates the heartbeat record if absent (the provisioner
 * hook calls this at session-start regardless of whether the session has
 * touched `~/.claude/` yet). Idempotent — re-pinning with the same value
 * is a no-op merge through `touchHeartbeat`'s read-merge-write semantics.
 *
 * **L588 race-fix (chokepoint):** the input `dotfilesRoot` is canonicalized
 * via `realpathSync()` before storing so consumers (notably
 * `mapByDotfilesRoot` in `src/hooks/checks/dotfiles-worktree-gc.ts:243`) can
 * compare against `realpathSync`-resolved worktree paths without drift.
 * Without canonicalization, a provisioner that stores e.g. `/var/folders/.../X`
 * while GC enumerates the on-disk realpath `/private/var/folders/.../X` would
 * mis-classify the worktree as orphan and reap it. Backlog L588 documents the
 * 3 cross-session evidence points that triggered the race-fix slot.
 *
 * If `realpathSync` throws (target doesn't exist yet — possible during the
 * fresh-provisioning race window before the worktree directory is fully
 * written), fall back to `path.resolve()` which strips `.`/`..` segments
 * without filesystem access. The eventual `realpathSync`-side reader (GC) is
 * tolerant of this transient form — its own `mapByDotfilesRoot` compare
 * still keys against the (non-resolved) sentinel value, so a one-cycle
 * mismatch self-heals at next anchor-pin on a successful realpath.
 */
export function setSentinelDotfilesRoot(args: {
  sessionId: string;
  dotfilesRoot: string;
}): void {
  const { sessionId, dotfilesRoot } = args;
  if (!isValidSessionId(sessionId)) return;
  if (dotfilesRoot.length === 0) return;

  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return;

  mkdirSync(heartbeatsDir(artifactId), { recursive: true });

  // L588 — canonicalize to realpath form so GC's compare keys against the
  // same shape the on-disk enumeration produces. Fall back to resolve() if
  // realpath throws (target may not exist during fresh-provisioning).
  let canonical: string;
  try {
    canonical = realpathSync(dotfilesRoot);
  } catch {
    canonical = resolve(dotfilesRoot);
  }

  const path = heartbeatPath(artifactId, sessionId);
  const existing = readOwnerRecord(path);
  const now = getWallClockNow();
  const createdAt = existing?.createdAt ?? now;
  const record: OwnerRecord = {
    sessionId,
    pid: process.pid,
    host: hostname(),
    createdAt,
    touchedAt: now,
    dotfilesRoot: canonical,
  };

  // Ensure meta.json exists for this artifact — first-write path mirrors
  // touchHeartbeat. Without this, a fresh-install session whose first
  // active-sessions interaction is the anchor pin would leave meta absent.
  const metaFile = metaPath(artifactId);
  if (!existsSync(metaFile)) {
    writeMetaIfMissing(metaFile, {
      artifactPath: join(effectiveHome(), ".claude"),
      createdAt: now,
    });
  }

  writeAtomic(path, `${JSON.stringify(record)}\n`);

  // Slice 7 A2 — Point 1: telemetry for every sentinel set (including
  // idempotent re-pins). pid + host enable lsof/ps cross-reference for
  // session-id correspondence during triage.
  appendPresenceFailure({
    timestamp: new Date().toISOString(),
    sessionId,
    source: "active-sessions-registry",
    kind: "sentinel-dotfilesroot-set",
    artifactPath: join(effectiveHome(), ".claude"),
    detail: `dotfilesRoot=${canonical} prior=${existing?.dotfilesRoot ?? "null"} pid=${process.pid} host=${hostname()}`,
  });
}

/**
 * Read the per-session `dotfilesRoot` sentinel from the canonical-
 * claude-home heartbeat. Returns the field or `null` if the heartbeat
 * is absent, the body is corrupt, or the field is unset.
 *
 * On parse failure, emits a `sentinel-corrupt` breadcrumb so operators
 * can correlate downstream resolver fall-throughs with the corruption.
 * Parse-failure path is rare in practice — `writeAtomic` is tmp+rename
 * atomic, so corruption only happens on disk-corruption-class failures.
 */
export function readSentinelDotfilesRoot(sessionId: string): string | null {
  if (!isValidSessionId(sessionId)) return null;
  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return null;

  const path = heartbeatPath(artifactId, sessionId);
  if (!existsSync(path)) return null;

  const record = readOwnerRecord(path);
  if (record === null) {
    // readOwnerRecord swallows JSON.parse errors and returns null; we can't
    // distinguish "missing file" from "corrupt body" by return value alone.
    // Use existsSync above as the gate for "missing"; reaching here with
    // existsSync=true and record=null implies a parse / shape failure.
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "active-sessions-registry",
      kind: "sentinel-corrupt",
      artifactPath: join(effectiveHome(), ".claude"),
      detail: `heartbeat body parse failed at ${path}`,
    });
    return null;
  }

  return record.dotfilesRoot ?? null;
}

/**
 * Clear the `dotfilesRoot` sentinel from the canonical-claude-home
 * heartbeat. Stop-hook + GC reaper invoke this between worktree-remove
 * and `unregisterActiveSession`. Idempotent — no-op if the heartbeat is
 * absent or the field is unset.
 */
export function clearSentinelDotfilesRoot(sessionId: string): void {
  if (!isValidSessionId(sessionId)) return;
  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return;

  const path = heartbeatPath(artifactId, sessionId);
  if (!existsSync(path)) return;

  const existing = readOwnerRecord(path);
  if (existing === null) return;

  // Slice 7 A2 — Point 2: emit BEFORE the dotfilesRoot===undefined
  // early-return so idempotent no-op clears are observable too (TS-6 fold
  // from plan v1.3 — `existing` already non-null here, narrow holds).
  appendPresenceFailure({
    timestamp: new Date().toISOString(),
    sessionId,
    source: "active-sessions-registry",
    kind: "sentinel-dotfilesroot-cleared",
    artifactPath: join(effectiveHome(), ".claude"),
    detail: `prior=${existing.dotfilesRoot ?? "null"} pid=${process.pid} caller_top4=${callerTop4()}`,
  });

  if (existing.dotfilesRoot === undefined) return;

  const now = getWallClockNow();
  const record: OwnerRecord = {
    sessionId: existing.sessionId,
    pid: process.pid,
    host: hostname(),
    createdAt: existing.createdAt,
    touchedAt: now,
  };
  writeAtomic(path, `${JSON.stringify(record)}\n`);
}

/**
 * Self-heal entry point for GC reaper + Stop-hook abnormal-exit recovery.
 * Removes ALL heartbeat entries for the given sessionId across all
 * artifact-ids in the registry. Returns the count of heartbeats unlinked.
 *
 * Idempotent — never throws on already-cleared, returns 0 if the session
 * has no heartbeats. Best-effort per-entry: ENOENT is silent (already
 * gone), other unlink failures are logged via the existing registry-
 * contention path but do not propagate. The reconciliation guard at the
 * call site (provisioner / cleanup hook) is responsible for surfacing
 * partial-completion to the operator.
 */
export function unregisterActiveSession(sessionId: string): number {
  if (!isValidSessionId(sessionId)) return 0;
  const root = resolveActiveSessionsDir();
  if (!existsSync(root)) return 0;

  let cleared = 0;
  for (const artifactId of listArtifactIds()) {
    const path = heartbeatPath(artifactId, sessionId);
    if (!existsSync(path)) continue;
    if (tryReapHeartbeat(artifactId, sessionId, path)) {
      cleared++;
    }
  }

  // Slice 7 A2 — Point 3: emit IF cleared > 0 (avoid no-op spam).
  if (cleared > 0) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "active-sessions-registry",
      kind: "session-unregistered",
      artifactPath: null,
      detail: `cleared=${cleared} pid=${process.pid} caller_top4=${callerTop4()}`,
    });
  }

  return cleared;
}
