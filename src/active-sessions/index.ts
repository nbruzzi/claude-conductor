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
import { VALID_ID_REGEX, isValidArtifactId } from "../shared/artifact-id.ts";

// Re-export isValidArtifactId to preserve existing consumer imports
// (6 src/channels/* + 3 test/channels/* call sites resolve from this module).
export { isValidArtifactId } from "../shared/artifact-id.ts";

// Boundary-throw classifiers — exposed so downstream adapters can
// discriminate kind:"invalid-input" vs kind:"malformed" via the substrate
// primitive, not via inline string-match. Mirrors `claude-conductor/channels/api`
// `isInvalidChannelIdError`. See `boundary-errors.ts` JSDoc.
export {
  INVALID_ARTIFACT_ID_MESSAGE_FRAGMENT,
  INVALID_SESSION_ID_MESSAGE_FRAGMENT,
  isInvalidArtifactIdError,
  isInvalidSessionIdError,
} from "./boundary-errors.ts";

/** 30-minute live window — mirrors channel heartbeat TTL. */
export const LIVE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Opportunistic GC threshold — drop heartbeats older than 2× TTL (60min).
 * Exported (Cycle 2 boot-reconciliation): `reconcile-boot` reuses it as the
 * GC-eligibility safety-floor, so the threshold is single-sourced here rather
 * than recomputed (`2 * LIVE_WINDOW_MS`) at the call site.
 */
export const GC_WINDOW_MS = 2 * LIVE_WINDOW_MS;

/**
 * Ceiling for the C1-S2 session-pid PROTECT lane. A same-host `kill(pid, 0)`
 * probe ({@link isOsPidAlive}) that finds a session's RECORDED OS pid alive
 * forces `gc_eligible = false` — but ONLY while the heartbeat is within this
 * ceiling. Beyond it, mtime-staleness wins regardless of the pid, so a
 * RECYCLED-pid false-protect cannot leak forever (the protect degrades to
 * today's proxy behaviour past the ceiling).
 *
 * MUST be strictly greater than `GC_WINDOW_MS`, or the protect is a no-op:
 * `gc_eligible` already requires `age > GC_WINDOW_MS` (the 60min safety-floor),
 * so a ceiling ≤ that floor would never widen the protected band. The protect
 * therefore lives in the band `(GC_WINDOW_MS, PID_PROTECT_CEILING_MS]`.
 *
 * The value is a coverage-vs-leak-bound trade: wider protects a genuinely-
 * alive-but-heartbeat-silent session for longer, but also lets a recycled-pid
 * false-protect persist longer (always bounded). 2× `GC_WINDOW_MS` (120min) is
 * the Nick-ratified start value (post-spike), tunable later.
 * (RFC #200 §3.2 — the ceiling-trade.)
 */
export const PID_PROTECT_CEILING_MS = 2 * GC_WINDOW_MS;

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
 * Same-host OS-process liveness probe (C1 S2). `process.kill(pid, 0)` sends NO
 * signal — it only tests whether a process with that pid exists and is
 * signalable. POSIX-portable (macOS + Linux); no `/proc`, no fork.
 *
 * Returns `true` (ALIVE) on no-throw AND on `EPERM` (a process exists at that
 * pid that we lack permission to signal — e.g. pid 1; the spike confirmed it
 * throws `EPERM`, not `ESRCH`). Returns `false` (NOT ALIVE) on `ESRCH` (no such
 * process) and on a missing/invalid pid (`≤ 0` / non-integer — an ABSENT
 * signal, never a protect).
 *
 * The asymmetry is deliberate. This feeds a SUBTRACT-ONLY protect on a MUTATING
 * gate (`reconcile-boot` `--apply`), which must fail toward NOT-reaping on an
 * ambiguous-but-present pid (`EPERM`); but an ABSENT pid must NOT protect, or a
 * legacy heartbeat with no recorded session pid would be pinned live forever. A
 * future fast-reap (S3b) keys on `ESRCH` SPECIFICALLY — never on `EPERM`.
 *
 * Same-host only: a pid is meaningless across hosts, so callers gate this on a
 * host match (`owner.host === currentHost`) before probing.
 */
export function isOsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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
  // Cycle 6 item-4 (pause/end-session, agetor steal-list A-P1-7) — `pausedAt`
  // marks a session DELIBERATELY paused (epoch ms; presence == paused).
  // Optional + additive (mirrors `dotfilesRoot?`): old readers tolerate its
  // absence. Written by `markSessionPaused`, cleared by `clearSessionPaused`
  // (resume). reconcile-boot's gc_eligible AND-term reads it so a paused
  // session is NEVER GC'd until an explicit resume (F-b Model A, cohort-
  // unanimous). Preserved across `touchHeartbeat` + setter writes via
  // `mergeOwnerRecord`'s read-merge-write.
  pausedAt?: number;
  // C1 S2 (session-pid PROTECT lane) — the session's REAL OS pid (the Claude
  // Code harness pid read from ~/.claude/sessions/<pid>.json), DISTINCT from
  // `pid` above which is the EPHEMERAL dispatcher/actor `process.pid`. Optional
  // + additive (mirrors `pausedAt?` / `dotfilesRoot?`): old readers tolerate its
  // absence, and `mergeOwnerRecord` preserves it across every write. Recorded
  // once at session-init by `recordSessionOsPid`; read SESSION-LEVEL by
  // reconcile-boot's pid-protect via `readSessionOsPid`. Absent → the protect
  // degrades to mtime (the safe-augment shape).
  sessionOsPid?: number;
};

export type PeerInfo = {
  sessionId: string;
  ageMs: number;
  owner: OwnerRecord;
};

export type HeartbeatListing = PeerInfo & {
  likelyDead: boolean;
};

/**
 * A heartbeat entry that {@link scanHeartbeats} found on disk but could NOT
 * turn into a {@link HeartbeatListing}. Surfaced rather than silently dropped
 * so an operator report can show what it could not evaluate — a report honest
 * about its own blind spots (#174 F2/F3). `sessionId` is the raw directory
 * entry (the filename); `reason` is why the valid-walk dropped it:
 *   - "unparseable-owner": the body is not a valid OwnerRecord (corrupt JSON,
 *     missing/mistyped fields) — readOwnerRecord returned null.
 *   - "future-mtime": mtime sits implausibly far in the future, past the
 *     clock-skew tolerance — defensiveAgeMs returned null (corrupt/garbage).
 * A stat() failure (file vanished mid-walk) is NOT malformed — it is a benign
 * race (nothing to GC, nothing corrupt), so scanHeartbeats skips it from BOTH
 * sets, exactly as listAllHeartbeats always has.
 */
export type MalformedHeartbeat = {
  sessionId: string;
  reason: "unparseable-owner" | "future-mtime";
};

/**
 * Result of ONE walk over an artifact's heartbeat directory: the valid
 * listings plus the entries that existed but could not be evaluated.
 * {@link listAllHeartbeats} is the `.valid`-only projection — the two sets
 * come from a single pass over the same readdir, so they can never drift.
 */
export type HeartbeatScan = {
  valid: HeartbeatListing[];
  malformed: MalformedHeartbeat[];
};

/**
 * Three-bucket liveness classification of a heartbeat by mtime-age.
 *
 * NOTE the axis: `"stale"` is the OLDEST bucket here (age > LIVE_WINDOW_MS) —
 * the opposite end from a GC-lifecycle "stale". Cycle-2 `reconcile-boot` keeps
 * the two axes separate (this `classification` vs a derived `gc_eligible`) so
 * the same word never means both "aged-out liveness bucket" and "ready to GC".
 *
 * Lifted from the dotfiles `/presence` CLI (de-dup, Cycle 2) so reconcile-boot
 * and any hook/dashboard can classify over the registry's own data model
 * without a backwards dotfiles import. The dotfiles `active-sessions/cli.ts`
 * now imports this via the shim instead of redefining it.
 */
export type Liveness = "live" | "likely-dead" | "stale";

export function classifyLiveness(h: HeartbeatListing): Liveness {
  if (h.ageMs > LIVE_WINDOW_MS) return "stale";
  if (h.ageMs > LIKELY_DEAD_MS || h.likelyDead) return "likely-dead";
  return "live";
}

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

// Session-id validation uses the same syntactic shape as artifact-id
// (`../shared/artifact-id.ts` is the SSOT for the regex). Two predicates
// exist as separate exports for caller-side naming intent — sessionId-shaped
// values (UUIDs) and artifact-id-shaped values (paths into filesystem
// registries) share the same shape check but document their distinct purpose.
export function isValidSessionId(s: unknown): s is string {
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
/**
 * Build a merged `OwnerRecord` (read-merge-write). Re-derives the COMMON-WRITE
 * fields (`pid`/`host`/`touchedAt`) from the current call; preserves
 * `createdAt` + EVERY other existing optional field (`dotfilesRoot`,
 * `pausedAt`, any future optional) by spreading `existing`. `overrides`
 * set fields via `overrides`; `clear` DELETEs optional fields so they are
 * ABSENT on the written record (exactOptionalPropertyTypes forbids setting an
 * optional field to `undefined`, so absence — not `undefined` — is how
 * `clearSessionPaused` resumes + `clearSentinelDotfilesRoot` un-pins).
 *
 * Cycle 6 item-4 F1 (Bravo): the prior per-field preserve-branch (dotfilesRoot
 * only, REV-0.2 ARCH-2 / RE-9.0) silently CLOBBERED any other optional field
 * and re-armed the trap for each new one. This shared merge CLOSES that class:
 * a new optional `OwnerRecord` field survives every write path that uses this
 * helper, with no per-field branch and no regression test required per field.
 */
function mergeOwnerRecord(
  existing: OwnerRecord | null,
  sessionId: string,
  now: number,
  overrides: Partial<OwnerRecord> = {},
  clear: ReadonlyArray<"dotfilesRoot" | "pausedAt"> = [],
): OwnerRecord {
  const record: OwnerRecord = {
    ...(existing ?? {}),
    sessionId,
    pid: process.pid,
    host: hostname(),
    createdAt: existing?.createdAt ?? now,
    touchedAt: now,
    ...overrides,
  };
  for (const key of clear) delete record[key];
  return record;
}

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
  // Read-merge-write (REV 0.2 ARCH-2 / RE-101, GENERALIZED by Cycle-6 item-4
  // F1 via `mergeOwnerRecord`): re-derive common-write fields from this call;
  // preserve createdAt + every existing optional field (dotfilesRoot, pausedAt,
  // future). The prior dotfilesRoot-only preserve-branch re-armed a clobber
  // trap per new field; the shared merge closes that class.
  const record = mergeOwnerRecord(existing, sessionId, now);
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
    const dotfilesRootRaw = obj["dotfilesRoot"];
    const dotfilesRoot =
      typeof dotfilesRootRaw === "string" && dotfilesRootRaw.length > 0
        ? { dotfilesRoot: dotfilesRootRaw }
        : {};
    // Cycle 6 item-4 — carry the optional `pausedAt` marker through. This is the
    // DESERIALIZATION twin of the mergeOwnerRecord write-preserve: a parse
    // boundary that DROPPED pausedAt would silently kill the pause feature
    // (markSessionPaused writes it to disk, but readSessionPausedAt would never
    // read it back). Unlike the write-merge (GENERALIZED in mergeOwnerRecord per
    // F1), this read path stays per-field-EXPLICIT on purpose — it VALIDATES
    // each optional field's type; a generic carry-all would forfeit that.
    const pausedAtRaw = obj["pausedAt"];
    const pausedAt =
      typeof pausedAtRaw === "number" ? { pausedAt: pausedAtRaw } : {};
    // C1 S2 — carry the optional `sessionOsPid` (the real session OS pid)
    // through. The DESERIALIZATION twin of recordSessionOsPid's write:
    // mergeOwnerRecord PRESERVES it on every write, but this read path is
    // per-field-EXPLICIT (see the pausedAt note above), so a new optional field
    // must be added HERE too or readSessionOsPid never reads back what was
    // persisted. Type-validated, like dotfilesRoot/pausedAt.
    const sessionOsPidRaw = obj["sessionOsPid"];
    const sessionOsPid =
      typeof sessionOsPidRaw === "number"
        ? { sessionOsPid: sessionOsPidRaw }
        : {};
    return {
      sessionId,
      pid,
      host,
      createdAt,
      touchedAt,
      ...dotfilesRoot,
      ...pausedAt,
      ...sessionOsPid,
    };
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

    // Clock-skew garbage or aged-out — opportunistic reap, UNLESS the session is
    // deliberately paused. Pause is a PROTECTION independent of liveness (mirrors
    // reconcile-boot `casRecheckFlip`): a paused session stops heartbeating so its
    // mtime ages out, but its heartbeat must NOT be reaped. Cycle-6 Task #6 closes
    // the item-4 pause-completeness gap — reconcile-boot honored !paused, the
    // opportunistic reap did not.
    if (ageMs === null || ageMs > GC_WINDOW_MS) {
      if (readSessionPausedAt(entry) != null) continue; // paused → protected
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
export function scanHeartbeats(args: {
  artifactId: string;
  now: number;
}): HeartbeatScan {
  const { artifactId, now } = args;
  const dir = heartbeatsDir(artifactId);
  const valid: HeartbeatListing[] = [];
  const malformed: MalformedHeartbeat[] = [];
  if (!existsSync(dir)) return { valid, malformed };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { valid, malformed };
  }

  for (const entry of entries) {
    const path = join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // File vanished mid-walk — benign race, nothing to GC. Skip from BOTH
      // sets (not malformed): exactly the prior listAllHeartbeats behavior.
      continue;
    }
    const owner = readOwnerRecord(path);
    if (!owner) {
      malformed.push({ sessionId: entry, reason: "unparseable-owner" });
      continue;
    }
    const ageMs = defensiveAgeMs(now, mtimeMs);
    if (ageMs === null) {
      // future-mtime garbage — skipped from the operator view, but surfaced.
      malformed.push({ sessionId: entry, reason: "future-mtime" });
      continue;
    }
    valid.push({
      sessionId: entry,
      ageMs,
      owner,
      likelyDead: ageMs > LIKELY_DEAD_MS,
    });
  }
  return { valid, malformed };
}

/**
 * List the valid heartbeats for an artifact. Thin projection of
 * {@link scanHeartbeats} — its `.valid` half. Callers that also need to know
 * what was dropped (reconcile-boot's malformed surfacing) call scanHeartbeats
 * directly. Behavior of the valid set is unchanged from the pre-scan version.
 */
export function listAllHeartbeats(args: {
  artifactId: string;
  now: number;
}): HeartbeatListing[] {
  return scanHeartbeats(args).valid;
}

/**
 * Cross-artifact liveness probe by session-id PREFIX — "is the session that
 * owns a per-session worktree still alive, ANYWHERE?"
 *
 * A worktree path encodes only the 8-char sid-prefix, so the worktree GC
 * reapers (`dotfiles-worktree-gc` / `repo-worktree-gc`) must decide liveness
 * from the prefix alone before reaping. The prior fallback
 * (`sidPrefixHasLiveAnchor`, hook-local) scanned ONLY the `~/.claude` ANCHOR
 * artifact's heartbeats. But per-tool heartbeat refresh lands on the session's
 * CWD artifact (its worktree dir), NOT the anchor — the anchor refreshes only
 * at session-start + per-tool heartbeats on the ~/.claude artifact (NOT
 * channel-send: that touches the separate CHANNEL store — the cross-store gap
 * L1049 slice-2b closes). So a session actively editing files is FRESH
 * on its cwd artifact while its anchor heartbeat has aged out, and an anchor-only
 * scan mis-reads it as dead → reaps a LIVE worktree (the 4/4 live-reap of
 * 2026-06-02; backlog L1049). This probe scans ALL artifacts and returns true if
 * ANY heartbeat whose sessionId starts with `sidPrefix` is fresh within
 * `GC_WINDOW_MS` — i.e. the owning session is alive on some artifact, so the
 * worktree must NOT be reaped.
 *
 * Read-only + fail-soft: a missing/unreadable artifact dir is skipped, never
 * thrown. Deliberately broader than the old fallback's `!likelyDead` (≤10min)
 * cutoff — it uses the reaper's own `< GC_WINDOW_MS` (60min) staleness boundary
 * so a session that touched any artifact within the window is protected
 * (conservative toward never-reap-live; a truly-dead session's worktree just
 * lingers one window longer). Cross-host heartbeats are NOT excluded — a fresh
 * same-prefix heartbeat is protection regardless of host (over-protecting
 * against a live-reap is the safe direction; 8-hex-prefix collisions across
 * hosts are vanishingly unlikely). First match short-circuits.
 */
export function isSessionLiveByPrefix(
  sidPrefix: string,
  now: number,
  // Freshness window; defaults to GC_WINDOW_MS (60min — the worktree reaper's
  // own staleness boundary). `repo-worktree-gc` passes its per-repo window
  // (the `cleanupAfterIdleHours` override) so the liveness threshold matches
  // that repo's configured reap threshold.
  windowMs: number = GC_WINDOW_MS,
): boolean {
  if (sidPrefix.length === 0) return false;
  let artifactIds: readonly string[];
  try {
    artifactIds = listArtifactIds();
  } catch {
    return false;
  }
  for (const artifactId of artifactIds) {
    let listings: HeartbeatListing[];
    try {
      listings = listAllHeartbeats({ artifactId, now });
    } catch {
      continue;
    }
    for (const h of listings) {
      if (!h.sessionId.startsWith(sidPrefix)) continue;
      if (h.ageMs >= 0 && h.ageMs < windowMs) return true;
    }
  }
  return false;
}

/**
 * Remove a heartbeat by (artifactId, sessionId). Best-effort (unlink; swallow
 * if already gone or never existed).
 *
 * MULTI-CALLER (the "Own" in the name is a misnomer — DEFERRED-RENAME, below):
 *   1. Stop-hook SELF-removal (session-presence-unregister.ts) — own heartbeat,
 *      no `opts` → forensic detail records "self-stop".
 *   2. reconcile-boot `--apply` GC (Cycle-2 increment-2; the reconcile-boot
 *      "2b", distinct from L1049 slice-2b reaper channel-liveness) — removes a DEAD
 *      PEER's heartbeat (NOT own); passes `{reason:"reconcile-gc", actorPid}` so
 *      the forensic record is HONEST — never "self-stop pid=<operator>" for a
 *      peer's removal (F1 honest-telemetry; the never-auto-kill mutation's
 *      removal record must not lie about who/why).
 *   3. dotfiles `cli.ts` target-removal — a TARGET session (also not "own").
 *
 * DEFERRED RENAME (tracked cross-edge slice, Cycle-2 follow-up): the honest name
 * is `removeHeartbeat` — `removeOwnHeartbeat` lies for callers 2+3. Separable
 * naming-hygiene: the `opts` telemetry already makes the multi-caller reality
 * honest-IN-THE-LOG, so the rename adds no safety. It is a COORDINATED cross-edge
 * change (conductor rename + dotfiles shim/cli/cross-edge-test migration + drop a
 * back-compat alias), kept OUT of the safety-critical 2b mutation PR to isolate
 * it (cohort-ratified — Alpha §1-author + Bravo + the 2b A-vs-B sounding-board).
 *
 * `opts` (F1 honest-telemetry): when a caller removes a heartbeat that is NOT
 * its own, it passes `{reason, actorPid}` so the presence-failure-log records
 * WHO removed it (actor pid + caller_top4 stack) and WHY (reason) — mirroring
 * the caller-stack capture of `unregisterActiveSession` / `tryReapHeartbeat`.
 */
/**
 * The outcome of a removal — so a caller that GCs a NON-own heartbeat
 * (reconcile-boot `--apply`) can tell a real failure from a benign already-gone:
 *   - "removed": unlinked successfully.
 *   - "absent": the file was already gone (ENOENT) — benign; "gone" IS the GC's
 *     desired end-state, so this is not a failure (the benign-final-gap: a peer
 *     or Stop may have removed it between the CAS-recheck and the unlink).
 *   - "failed": invalid input, or a non-ENOENT unlink error (EACCES/EISDIR/...)
 *     — a real removal failure the caller should surface (reconcile-boot → exit 1).
 * (The Stop-hook self path ignores the return — its only caller never failed
 * meaningfully; the return exists for the GC caller's gc-failed detection.)
 */
export type RemoveHeartbeatOutcome = "removed" | "absent" | "failed";

export function removeOwnHeartbeat(
  artifactId: string,
  sessionId: string,
  opts?: { reason: string; actorPid: number },
): RemoveHeartbeatOutcome {
  if (!isValidArtifactId(artifactId) || !isValidSessionId(sessionId)) {
    return "failed";
  }
  const path = heartbeatPath(artifactId, sessionId);
  try {
    unlinkSync(path);
    // Honest forensic record: a non-self caller (opts) logs target_sid + reason
    // + actor pid + caller-stack; the Stop-hook self path keeps "self-stop".
    const detail = opts
      ? `target_sid=${sessionId} reason=${opts.reason} actor_pid=${opts.actorPid} caller_top4=${callerTop4()}`
      : `pid=${process.pid} self-stop`;
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: "active-sessions-registry",
      kind: "heartbeat-removed",
      artifactPath: path,
      detail,
    });
    return "removed";
  } catch (err) {
    // ENOENT = already gone (benign — the GC's end-state). Anything else is a
    // real removal failure the caller surfaces.
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return "absent";
    }
    return "failed";
  }
}

/**
 * Re-read a SINGLE heartbeat by (artifactId, sessionId) — the targeted CAS
 * re-read reconcile-boot `--apply` uses at apply-time to confirm a `gc_eligible`
 * candidate is STILL gc-able before removing it (closing the enumeration→apply
 * TOCTOU). Returns the fresh {@link HeartbeatListing}, or `null` if the heartbeat
 * is now GONE / unparseable / future-mtime garbage (any of which means "do not
 * GC"). Same per-entry acceptance as {@link scanHeartbeats}, for one path.
 */
export function reReadHeartbeat(args: {
  artifactId: string;
  sessionId: string;
  now: number;
}): HeartbeatListing | null {
  const { artifactId, sessionId, now } = args;
  const path = heartbeatPath(artifactId, sessionId);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null; // gone
  }
  const owner = readOwnerRecord(path);
  if (!owner) return null; // unparseable / corrupt
  const ageMs = defensiveAgeMs(now, mtimeMs);
  if (ageMs === null) return null; // future-mtime garbage
  return { sessionId, ageMs, owner, likelyDead: ageMs > LIKELY_DEAD_MS };
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
          // Pause is a PROTECTION independent of liveness (mirrors reconcile-boot
          // + listLivePeers, Cycle-6 Task #6): a deliberately-paused session's
          // aged-out heartbeat must NOT be reaped. It persists, so the dir is
          // still occupied — don't trigger the recursive empty-dir cleanup.
          if (readSessionPausedAt(entry) != null) {
            dirStillOccupied = true;
          } else if (tryReapHeartbeat(artifactId, entry, path)) {
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
  // Cycle-6 item-4 F1: shared read-merge-write — setting dotfilesRoot now
  // PRESERVES pausedAt (+ any future optional) instead of rebuilding the
  // record (the prior explicit rebuild silently clobbered other fields).
  const record = mergeOwnerRecord(existing, sessionId, now, {
    dotfilesRoot: canonical,
  });

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
  // Cycle-6 item-4 F1: shared read-merge-write — clearing dotfilesRoot now
  // PRESERVES pausedAt (+ any future optional) instead of rebuilding the
  // record (the prior explicit rebuild silently dropped them). The
  // `dotfilesRoot: undefined` override is dropped by JSON.stringify = cleared.
  const record = mergeOwnerRecord(existing, existing.sessionId, now, {}, [
    "dotfilesRoot",
  ]);
  writeAtomic(path, `${JSON.stringify(record)}\n`);
}

/**
 * Cycle 6 item-4 (pause-session, agetor steal-list A-P1-7) — mark a session
 * DELIBERATELY paused by setting `pausedAt` on its canonical-claude-home anchor
 * heartbeat (the same per-session anchor `setSentinelDotfilesRoot` uses).
 * reconcile-boot's gc_eligible AND-term reads this via `readSessionPausedAt`
 * (Option X — a SESSION-LEVEL check) so that NONE of the session's candidates,
 * across ALL artifacts, are GC-eligible while paused (not just the anchor
 * heartbeat). Idempotent; no-op if the session has no anchor heartbeat (not
 * registered — nothing to pause). Never throws.
 *
 * (Telemetry deferred: emitting a `session-paused` PresenceFailureKind would be
 * a cross-edge union change — out of this slice's scope; follow-up.)
 */
export function markSessionPaused(sessionId: string): void {
  if (!isValidSessionId(sessionId)) return;
  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return;

  const path = heartbeatPath(artifactId, sessionId);
  const existing = readOwnerRecord(path);
  if (existing === null) return;

  const now = getWallClockNow();
  const record = mergeOwnerRecord(existing, sessionId, now, { pausedAt: now });
  writeAtomic(path, `${JSON.stringify(record)}\n`);
}

/**
 * Cycle 6 item-4 (resume-session) — clear a session's `pausedAt` on its
 * canonical anchor heartbeat. This is the DELIBERATE resume that F-b Model A
 * requires: a normal `touchHeartbeat` PRESERVES pausedAt (a paused-but-alive
 * session keeps firing the dispatcher), so resume must be explicit. Idempotent;
 * no-op if the heartbeat is absent or the session is not paused. Never throws.
 */
export function clearSessionPaused(sessionId: string): void {
  if (!isValidSessionId(sessionId)) return;
  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return;

  const path = heartbeatPath(artifactId, sessionId);
  const existing = readOwnerRecord(path);
  if (existing === null) return;
  if (existing.pausedAt === undefined) return; // already not paused — no-op

  const now = getWallClockNow();
  const record = mergeOwnerRecord(existing, sessionId, now, {}, ["pausedAt"]);
  writeAtomic(path, `${JSON.stringify(record)}\n`);
}

/**
 * Cycle 6 item-4 — read a session's pause marker from its canonical anchor
 * heartbeat. Returns the `pausedAt` epoch ms, or `null` if the session is not
 * paused / has no anchor heartbeat. reconcile-boot's gc_eligible AND-term uses
 * this for a SESSION-LEVEL pause check (Option X): a paused session's
 * candidates across ALL artifacts are protected, not just its anchor heartbeat.
 */
export function readSessionPausedAt(sessionId: string): number | null {
  if (!isValidSessionId(sessionId)) return null;
  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return null;

  const path = heartbeatPath(artifactId, sessionId);
  if (!existsSync(path)) return null;
  const record = readOwnerRecord(path);
  return record?.pausedAt ?? null;
}

/**
 * C1 S2 (session-pid PROTECT lane) — record a session's REAL OS pid (the harness
 * pid, discovered via `resolveSessionOsPid`) onto its canonical anchor heartbeat,
 * mirroring `markSessionPaused`'s SESSION-LEVEL write. reconcile-boot reads it
 * back SESSION-LEVEL via `readSessionOsPid`, so the pid-protect applies to ALL of
 * the session's candidates, not just its anchor. No-create (like
 * `markSessionPaused`): the call-site (the provisioner, post-anchor-pin) has
 * already force-created the anchor; a missing anchor → no-op (degrades to mtime).
 * Rejects a non-positive / non-integer pid — never record a garbage signal.
 */
export function recordSessionOsPid(sessionId: string, osPid: number): void {
  if (!isValidSessionId(sessionId)) return;
  if (!Number.isInteger(osPid) || osPid <= 0) return;
  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return;

  const path = heartbeatPath(artifactId, sessionId);
  const existing = readOwnerRecord(path);
  if (existing === null) return;

  const now = getWallClockNow();
  const record = mergeOwnerRecord(existing, sessionId, now, {
    sessionOsPid: osPid,
  });
  writeAtomic(path, `${JSON.stringify(record)}\n`);
}

/**
 * C1 S2 — read a session's recorded OS pid from its canonical anchor heartbeat
 * (mirrors `readSessionPausedAt`). Returns the harness pid, or `null` if unset /
 * no anchor. reconcile-boot's pid-protect uses this for a SESSION-LEVEL probe.
 */
export function readSessionOsPid(sessionId: string): number | null {
  if (!isValidSessionId(sessionId)) return null;
  const artifactId = canonicalClaudeHomeArtifactId();
  if (!isValidArtifactId(artifactId)) return null;

  const path = heartbeatPath(artifactId, sessionId);
  if (!existsSync(path)) return null;
  const record = readOwnerRecord(path);
  return record?.sessionOsPid ?? null;
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

// Cycle 2 boot-reconciliation — re-export the reconcile-boot surface from the
// canonical module path so the dotfiles shim (`claude-conductor/active-sessions`)
// and any hook/dashboard reach it WITHOUT a gated subpath import
// (feedback-bun-exports-map-gates-everything). The index.ts <-> reconcile-boot.ts
// import cycle is safe: reconcile-boot.ts reads this module's bindings only
// inside function bodies (call-time), never at module-evaluation time.
export { runReconcileBoot } from "./reconcile-boot.ts";
export type {
  ReconcileBootArtifactClass,
  ReconcileBootCandidate,
  ReconcileBootError,
  ReconcileBootOptions,
  ReconcileBootOutput,
  ReconcileBootSignal,
} from "./reconcile-boot.ts";
