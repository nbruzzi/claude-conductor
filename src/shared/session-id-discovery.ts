// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Session ID discovery for CLI-context invocations.
 *
 * Distinct from `src/hooks/session-id.ts` (which is the IN-HOOK canonical
 * helper). Hook-context callers have access to `input.raw.session_id` —
 * use the hook helper there. This file is only for CLI-context callers
 * (channels CLI, future todos CLI extensions, etc.) where there is no hook
 * input payload available.
 *
 * **Cross-edge env-var contract (ARCH-1, plan vivid-seeking-crayon §1):**
 * The plugin hosts TWO resolvers reading `CLAUDE_SESSION_ID`:
 *   (a) `src/channels/index.ts:resolveSessionId` — lenient `isValidSessionId`
 *       gate (path-safety only); reachable as `claude-conductor/channels/api`
 *       via the curated re-export. Used for channel-internal session-id
 *       handling where any path-safe id works.
 *   (b) THIS module's `resolveSessionId` — strict UUID-shape gate; reachable
 *       as `claude-conductor/shared/session-id-discovery`. Used in CLI-context
 *       where mtime/ppid fallback discovery requires UUID-tight matching.
 * The divergence is intentional. A non-UUID `CLAUDE_SESSION_ID` (e.g.,
 * `"test-session"`) hits (a)'s lenient path verbatim but falls through (b)'s
 * strict path to ppid/missing. Tests in `test/channels/api.test.ts` (case c)
 * lock the divergence.
 *
 * Why mtime is acceptable here when `hooks/session-id.ts` forbids it:
 * hook-context has a canonical, verified session_id passed in by Claude
 * Code itself. CLI-context doesn't. The fallback discovery uses mtime ONLY
 * when (a) the env var isn't set and (b) the deterministic ppid-tree walk
 * has exhausted retries. mtime here is a LAST RESORT, with body-validation
 * (filename must match the embedded session_id field) and a sanity check
 * (resolved id must have a matching `<pid>.json` written by the CC binary,
 * per SE-2).
 *
 * Resolution order (FAIL-LOUD throughout):
 *   1. `CLAUDE_SESSION_ID` env (strict UUID-shape)
 *   2. PPID-tree walk: bun's process.ppid → bash → CC binary. Walks up to
 *      MAX_PPID_DEPTH levels via `ps -o ppid= -p <pid>` looking for a
 *      `~/.claude/sessions/<pid>.json` file written by the CC binary.
 *      Empirical 2026-04-26: bun's direct ppid is the bash subprocess
 *      that wrapped the Bash tool call; the CC binary is one hop further.
 *   3. Cold-start retry on the walk (3 × 250ms = <1s budget)
 *   4. Worktree-path tier (SPAWN-2, liveness-hardened in P6): match the
 *      per-session worktree dir's 8-hex prefix against a UNIQUE, LIVE
 *      `<pid>.json` (CC-binary, embedded sessionId, `process.kill(pid,0)` alive).
 *      The `<pid>.json` is eager (written at session start) + present-at-join +
 *      liveness-bearing — so this fires for a cold spawn (where tier 5's telemetry
 *      is not yet written) and rejects a foreign/dead worktree (no live pidfile).
 *   5. mtime fallback on UUID-keyed telemetry-tracker files
 *      (filename must equal embedded session_id; dedupe by sessionId)
 *   6. Sanity check (per SE-2): discovered id must have a matching
 *      `<pid>.json` from the CC binary; otherwise downgrade to missing
 *   7. fail-loud (kind: "missing" | "ambiguous")
 *
 * @see src/hooks/session-id.ts — in-hook canonical resolver (different context)
 * @see src/channels/index.ts:resolveSessionId — channels-internal lenient resolver
 * @see src/active-sessions/index.ts — defensiveAgeMs / isValidSessionId
 */

import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

/** Strict UUID v4-shaped regex; tighter than `isValidSessionId` (path-safety only). */
const STRICT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bound the parent-process walk; pathological chains rejected. */
const MAX_PPID_DEPTH = 10;

/** Default mtime window for fallback discovery (1 minute). */
const DEFAULT_WINDOW_MS = 60_000;

/** Cold-start retry budget (3 attempts × 250ms = max ~750ms). */
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

/** Clock-skew tolerance for future-dated mtimes (5 min). Inlined to avoid coupling. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** `ps` invocation timeout — short to avoid blocking CLI startup. */
const PS_TIMEOUT_MS = 1000;

export type DiscoveryResult =
  | { kind: "env"; sessionId: string }
  | { kind: "ppid"; sessionId: string; pid: number; source: string }
  | { kind: "mtime"; sessionId: string; mtime: number; source: string }
  | { kind: "worktree"; sessionId: string; prefix: string; source: string }
  | { kind: "missing" }
  | {
      kind: "ambiguous";
      candidates: Array<{ sessionId: string; mtime: number; source: string }>;
    };

export type ResolveOptions = {
  windowMs?: number;
  sessionsDir?: string;
  retryDelayMs?: number;
  retryCount?: number;
  /** Injectable worktree start path for the SPAWN-2 worktree-path tier (test seam + explicit override). */
  startDir?: string;
  /**
   * Invoked before each cold-start retry sleep (after a ppid + worktree miss), with the
   * 0-based attempt index. Observability + test seam: a test writes the eager `<pid>.json`
   * here to exercise the not-yet-written-at-join window the worktree tier retries across.
   * MUST NOT throw — it runs inside the resolver, ahead of the mtime fallback.
   */
  onColdStartRetry?: (attempt: number) => void;
};

type CCBinaryFile = { pid: number; sessionId: string };
type TelemetryFile = { session_id: string };

/**
 * Compile-time-exhaustive default-branch helper (RE-4, plan vivid-seeking-crayon §2).
 *
 * If a future variant is added to `DiscoveryResult` and any switch over
 * `result.kind` doesn't handle it, TypeScript narrows the unhandled
 * variant to a non-`never` type at the `assertNever` call site, producing
 * a compile error. This is stricter than relying on `noImplicitReturns`
 * alone: that flag only catches missing returns, not missing case bodies.
 */
function assertNever(x: never): never {
  throw new Error(
    `Unreachable: unexpected DiscoveryResult variant ${JSON.stringify(x)}`,
  );
}

function effectiveSessionsDir(opts?: ResolveOptions): string {
  if (opts?.sessionsDir !== undefined) return opts.sessionsDir;
  return join(process.env["HOME"] ?? homedir(), ".claude", "sessions");
}

function isStrictUUID(s: unknown): s is string {
  return typeof s === "string" && STRICT_UUID.test(s);
}

function fileOwnedByMe(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (typeof process.geteuid === "function") {
      return stat.uid === process.geteuid();
    }
    return true; // platforms without geteuid (Windows) — skip the check
  } catch {
    return false;
  }
}

function readCCBinaryFile(path: string): CCBinaryFile | null {
  try {
    if (!fileOwnedByMe(path)) return null;
    const text = readFileSync(path, "utf-8");
    const obj: unknown = JSON.parse(text);
    if (typeof obj !== "object" || obj === null) return null;
    const pid = (obj as Record<string, unknown>)["pid"];
    const sessionId = (obj as Record<string, unknown>)["sessionId"];
    if (typeof pid !== "number" || !isStrictUUID(sessionId)) return null;
    return { pid, sessionId };
  } catch {
    return null;
  }
}

function readTelemetryFile(path: string): TelemetryFile | null {
  try {
    if (!fileOwnedByMe(path)) return null;
    const text = readFileSync(path, "utf-8");
    const obj: unknown = JSON.parse(text);
    if (typeof obj !== "object" || obj === null) return null;
    const sessionId = (obj as Record<string, unknown>)["session_id"];
    if (!isStrictUUID(sessionId)) return null;
    return { session_id: sessionId };
  } catch {
    return null;
  }
}

function getParentPid(pid: number): number | null {
  try {
    const out = execSync(`ps -o ppid= -p ${pid}`, {
      encoding: "utf-8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = parseInt(out, 10);
    if (!Number.isInteger(parsed) || parsed === pid || parsed <= 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function walkPpidTree(
  sessionsDir: string,
): { pid: number; sessionId: string } | null {
  let pid: number | null = process.ppid;
  for (
    let depth = 0;
    depth < MAX_PPID_DEPTH && pid !== null && pid > 1;
    depth++
  ) {
    const candidate = readCCBinaryFile(join(sessionsDir, `${pid}.json`));
    if (candidate !== null) {
      return { pid: candidate.pid, sessionId: candidate.sessionId };
    }
    pid = getParentPid(pid);
  }
  return null;
}

function sleepSync(ms: number): void {
  // Cross-runtime synchronous sleep without busy-wait (Bun + Node).
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

/**
 * Tiers 2–3b (ppid-tree walk, then the worktree-path tier) on a SHARED cold-start
 * retry budget. Both tiers read the EAGER `<pid>.json` the CC binary writes at
 * session start; a true first-action cold spawn can run BEFORE that write lands, so
 * each attempt tries ppid (authoritative) then worktree, retrying up to `retryCount`
 * times (× `retryDelayMs`). Sharing ONE loop — rather than giving the worktree tier
 * its own retry after ppid's — keeps its cold-start grace EXPLICIT (it no longer
 * relies on ppid's retries having incidentally elapsed first) WITHOUT doubling the
 * wall-clock on the genuine-missing path. Returns the first hit (ppid before worktree
 * within an attempt) or null once the budget exhausts. `onColdStartRetry` fires before
 * each inter-attempt sleep (observability + test seam).
 */
function resolveViaPpidOrWorktree(
  sessionsDir: string,
  startDirs: Array<string | undefined>,
  retryCount: number,
  retryDelayMs: number,
  onColdStartRetry?: (attempt: number) => void,
): DiscoveryResult | null {
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    // ppid-tree walk (authoritative) — reads the CC binary file directly.
    const ppid = walkPpidTree(sessionsDir);
    if (ppid !== null) {
      return {
        kind: "ppid",
        sessionId: ppid.sessionId,
        pid: ppid.pid,
        source: join(sessionsDir, `${ppid.pid}.json`),
      };
    }
    // worktree-path tier — match the worktree dir's 8-hex prefix to a unique LIVE
    // <pid>.json (resolveViaWorktreePath); try each candidate start path in order.
    const seenStartDirs = new Set<string>();
    for (const dir of startDirs) {
      if (dir === undefined || dir.length === 0 || seenStartDirs.has(dir))
        continue;
      seenStartDirs.add(dir);
      const wt = resolveViaWorktreePath(sessionsDir, dir);
      if (wt !== null) {
        return {
          kind: "worktree",
          sessionId: wt.sessionId,
          prefix: wt.prefix,
          source: wt.source,
        };
      }
    }
    // Both missed — wait for the eager <pid>.json to land, then retry.
    if (attempt < retryCount) {
      onColdStartRetry?.(attempt);
      sleepSync(retryDelayMs);
    }
  }
  return null;
}

function listMtimeCandidates(
  sessionsDir: string,
  windowMs: number,
  now: number,
): Array<{ sessionId: string; mtime: number; source: string }> {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const candidates: Array<{
    sessionId: string;
    mtime: number;
    source: string;
  }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -5);
    // Skip <PID>.json — those are handled by the ppid path
    if (!isStrictUUID(stem)) continue;
    const fullPath = join(sessionsDir, entry);

    let mtime: number;
    try {
      mtime = lstatSync(fullPath).mtimeMs;
    } catch {
      continue;
    }

    // Defensive age (clock skew defense)
    if (mtime > now + CLOCK_SKEW_TOLERANCE_MS) continue;
    if (now - mtime > windowMs) continue;

    const body = readTelemetryFile(fullPath);
    if (body === null) continue;
    // Filename must match embedded session_id (per SE-1)
    if (body.session_id !== stem) continue;
    // Dedupe by sessionId (per RE-2)
    if (seen.has(body.session_id)) continue;
    seen.add(body.session_id);

    candidates.push({ sessionId: body.session_id, mtime, source: fullPath });
  }

  return candidates.sort((a, b) => b.mtime - a.mtime);
}

function sanityCheckHasCCFile(sessionId: string, sessionsDir: string): boolean {
  // Per SE-2: discovered id MUST have a matching <pid>.json from CC binary
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -5);
    // PID-keyed files only (numeric)
    if (!/^\d+$/.test(stem)) continue;
    const ccFile = readCCBinaryFile(join(sessionsDir, entry));
    if (ccFile !== null && ccFile.sessionId === sessionId) return true;
  }
  return false;
}

/**
 * Liveness probe: does a process with this pid currently exist? Uses the signal-0
 * trick — `process.kill(pid, 0)` runs the kernel's existence/permission check
 * WITHOUT delivering a signal. `ESRCH` ("no such process") → dead; success or
 * `EPERM` (process exists but is not ours to signal) → alive. Biased toward
 * "alive": only the unambiguous `ESRCH` returns false, so the worktree-tier
 * liveness gate never falsely rejects a live self-session (must-not-re-break-cohort).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}

/**
 * Extract the 8-hex session-id prefix from a worktree path's final segment.
 * The provisioner (`worktrees/index.ts:worktreePathForSession`, SID_PREFIX_LEN=8)
 * names per-session worktrees `~/.claude-dotfiles-<sid8>`. Anchored to that
 * literal basename — NOT a `.claude-*-` wildcard (zero real coverage, wider
 * false-match surface). Returns the lowercase 8-hex prefix, or null.
 */
function extractSid8FromPath(p: string): string | null {
  const seg = p.replace(/\/+$/, "").split("/").pop() ?? "";
  const m = seg.match(/^\.claude-dotfiles-([0-9a-f]{8})$/);
  return m === null ? null : (m[1] ?? null);
}

/**
 * Worktree-path discovery (SPAWN-2; match-source switched to the live `<pid>.json`
 * + liveness gate in P6). Resolve the FULL session id from a worktree start path by
 * matching its 8-hex prefix against the EAGER `<pid>.json` (CC-binary) files in
 * `sessionsDir` whose embedded `sessionId` shares the prefix AND whose pid is
 * currently ALIVE (`process.kill(pid, 0)`). Returns null (→ fall through to mtime)
 * on 0 or >1 DISTINCT live matches.
 *
 * Why the `<pid>.json`, not the `<uuid>.json` telemetry this tier originally
 * matched: empirically the telemetry file is written LAZILY (a PostToolUse hook,
 * only on a memory-dir op or a `bun run test|typecheck|...` command) and is
 * therefore ABSENT at a true cold-spawn join — so a telemetry-keyed tier could not
 * fire for the very case SPAWN-2 targets (a spawned session resolving its own id at
 * `join` before it has touched memory). The `<pid>.json` is written EAGERLY by the
 * CC binary at session start, so it is present at join; it carries the embedded
 * `sessionId`; and its pid IS a liveness signal. Matching it does three things at
 * once: (1) fires for the cold-spawn headline case, (2) is liveness-bearing, and
 * (3) closes the foreign/dead-worktree boundary below.
 *
 * Boundary CLOSED (was a tracked SPAWN-2 follow-up): a solo session with env unset
 * + broken ppid whose cwd is a FOREIGN/DEAD worktree (`.claude-dotfiles-<hexB>`) no
 * longer resolves B's id — a dead B has no LIVE pidfile (clean exit → the CC binary
 * removes it; crash → a stale pidfile with a dead pid → the alive-check rejects it).
 * The cohort/self case still resolves (its own pidfile is eager + alive). Residual
 * (narrow, by design — consistent with the module's no-`procStart` convention): pid
 * RECYCLING — if a crashed B's pid is reassigned to an unrelated live process, the
 * alive-check passes; defending that would require comparing the recorded process
 * start time against the live process, which no resolver in this module does.
 */
function resolveViaWorktreePath(
  sessionsDir: string,
  startDir: string,
): { sessionId: string; prefix: string; source: string } | null {
  const prefix = extractSid8FromPath(startDir);
  if (prefix === null) return null;

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return null;
  }

  const matches: Array<{ sessionId: string; source: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -5);
    if (!/^\d+$/.test(stem)) continue; // CC-binary <pid>.json only (skip uuid telemetry)
    const fullPath = join(sessionsDir, entry);
    const cc = readCCBinaryFile(fullPath);
    if (cc === null) continue;
    if (!cc.sessionId.startsWith(prefix)) continue;
    if (!isPidAlive(cc.pid)) continue; // liveness: a dead/foreign session is rejected
    matches.push({ sessionId: cc.sessionId, source: fullPath });
  }

  // Uniqueness gate — only a single unambiguous LIVE session is trustworthy. Dedupe
  // by sessionId so a session with a stale + live pidfile (or a restart) is still
  // unambiguous; distinct live sessionIds sharing the prefix → null (never guess).
  const distinctIds = new Set(matches.map((m) => m.sessionId));
  if (distinctIds.size !== 1) return null;
  const only = matches[0];
  if (only === undefined) return null;
  return { sessionId: only.sessionId, prefix, source: only.source };
}

export function resolveSessionId(opts?: ResolveOptions): DiscoveryResult {
  const sessionsDir = effectiveSessionsDir(opts);
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const retryCount = opts?.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // 1. env path (strict UUID-shape per SE-1)
  const envValue = process.env["CLAUDE_SESSION_ID"];
  if (
    typeof envValue === "string" &&
    envValue.length > 0 &&
    isStrictUUID(envValue)
  ) {
    return { kind: "env", sessionId: envValue };
  }

  // 2–3b. ppid-tree walk (authoritative) + the worktree-path tier (SPAWN-2, P6) on a
  // SHARED cold-start retry budget. A spawned cohort session has CLAUDE_SESSION_ID
  // unset and a broken ppid-tree; the per-session worktree dir name
  // (`~/.claude-dotfiles-<sid8>`) identifies it, and resolveViaWorktreePath maps that
  // 8-hex prefix to a UNIQUE, LIVE `<pid>.json` (eager at session start, present at
  // join — unlike the lazy telemetry the mtime tier matches). Both tiers read that
  // eager pidfile, so they share ONE retry loop: a true first-action cold spawn may
  // run before the CC binary writes it, and the shared retry lets it land — keeping
  // the worktree tier's cold-start grace EXPLICIT (not reliant on ppid's retries
  // having elapsed first). startDir is the explicit opt, else the env ladder
  // CLAUDE_DOTFILES_ROOT_RESOLVED / PWD / cwd.
  const startDirs =
    opts?.startDir !== undefined
      ? [opts.startDir]
      : [
          process.env["CLAUDE_DOTFILES_ROOT_RESOLVED"],
          process.env["PWD"],
          process.cwd(),
        ];
  const ppidOrWorktree = resolveViaPpidOrWorktree(
    sessionsDir,
    startDirs,
    retryCount,
    retryDelayMs,
    opts?.onColdStartRetry,
  );
  if (ppidOrWorktree !== null) return ppidOrWorktree;

  // 4. mtime fallback — LAST resort, on the LAZY UUID-keyed telemetry. SPAWN-3a
  // investigation (document+defer): the <uuid>.json telemetry is written lazily (a
  // PostToolUse hook, ^-anchored so a compound `cd && bun test` never fires it), so a
  // session with absent telemetry can't resolve HERE. NARROW residual: mtime is reached
  // only after env → ppid → worktree(eager <pid>.json, P6) all miss — i.e. a non-worktree
  // session with a broken ppid-tree + unset env + absent telemetry (worktree sessions
  // resolve at the eager-pidfile tier; the ppid-break is worktree-shell-specific). The
  // eager <pid>.json would be the better signal here too; adding that fallback is deferred
  // (SPAWN-3 backlog) until the case manifests — a moderate critical-path change for a rare
  // unmanifested residual is gold-plating. (Other telemetry consumers are unaffected:
  // active-sessions liveness composes the heartbeat + channel stores, NOT this telemetry.)
  const candidates = listMtimeCandidates(sessionsDir, windowMs, Date.now());
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length === 1) {
    const c = candidates[0];
    if (c === undefined) return { kind: "missing" };
    // 5. Sanity check (per SE-2)
    if (!sanityCheckHasCCFile(c.sessionId, sessionsDir)) {
      return { kind: "missing" };
    }
    return {
      kind: "mtime",
      sessionId: c.sessionId,
      mtime: c.mtime,
      source: c.source,
    };
  }
  return { kind: "ambiguous", candidates };
}

/**
 * Resolve the REAL OS pid for a KNOWN session (C1 S2): scan the Claude Code
 * binary's `~/.claude/sessions/` registry for the pid-stemmed `<pid>.json` whose
 * embedded `sessionId` matches, and return its `pid`. The sessionId-match is the
 * load-bearing safety guard — a pid that is NOT ours (a stale/recycled pidfile)
 * must never be returned. Skips uuid-stemmed telemetry files (the registry dir
 * carries mixed pid/uuid stems).
 *
 * The caller knows its sessionId (a SessionStart hook), so this scans BY the
 * known sessionId rather than walking the ppid tree ({@link resolveSessionId}'s
 * discover-my-UNKNOWN-id path) — the scan is the natural operation for a known
 * id, and it is deterministically testable. It reuses the same `<pid>.json`
 * reader + cold-start retry (the harness may not have written the pidfile yet at
 * session-init). Returns `null` when no matching pidfile is found within the
 * retry budget — the caller then records nothing and the pid-protect degrades
 * to mtime.
 */
export function resolveSessionOsPid(
  sessionId: string,
  opts?: ResolveOptions,
): number | null {
  if (!isStrictUUID(sessionId)) return null;
  const sessionsDir = effectiveSessionsDir(opts);
  const retryCount = opts?.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    let entries: string[];
    try {
      entries = readdirSync(sessionsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const stem = entry.slice(0, -5);
      if (!/^\d+$/.test(stem)) continue; // pid-stemmed CC files only (skip uuid telemetry)
      const cc = readCCBinaryFile(join(sessionsDir, entry));
      if (cc !== null && cc.sessionId === sessionId) return cc.pid;
    }
    if (attempt < retryCount) sleepSync(retryDelayMs);
  }
  return null;
}

function truncateId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

export function formatRecoveryHint(result: DiscoveryResult): string {
  switch (result.kind) {
    case "env":
    case "ppid":
    case "mtime":
    case "worktree":
      return "";
    case "missing":
      return "CLAUDE_SESSION_ID not set and no recent session telemetry found. Set explicitly: export CLAUDE_SESSION_ID=<your-session-id> and re-run.";
    case "ambiguous": {
      const lines = result.candidates.map(
        (c) =>
          `  ${truncateId(c.sessionId)} (touched ${new Date(c.mtime).toISOString()})`,
      );
      return `CLAUDE_SESSION_ID not set; ${result.candidates.length} recent sessions detected:\n${lines.join("\n")}\nSet explicitly to disambiguate: export CLAUDE_SESSION_ID=<your-session-id> and re-run.`;
    }
    default:
      return assertNever(result);
  }
}

export function describeSource(result: DiscoveryResult): string {
  switch (result.kind) {
    case "env":
      return "env";
    case "ppid":
      return `process tree (resolved at pid ${result.pid})`;
    case "mtime":
      return `mtime fallback (touched ${new Date(result.mtime).toISOString()})`;
    case "worktree":
      return `worktree path (sid-prefix ${result.prefix})`;
    case "missing":
      return "missing";
    case "ambiguous":
      return `ambiguous (${result.candidates.length} candidates)`;
    default:
      return assertNever(result);
  }
}

/** Internal helpers exported for testing only. Do not import from production code. */
export const INTERNAL = {
  truncateId,
  isStrictUUID,
  isPidAlive,
  walkPpidTree,
  listMtimeCandidates,
  sanityCheckHasCCFile,
  readCCBinaryFile,
  readTelemetryFile,
  extractSid8FromPath,
  resolveViaWorktreePath,
};
