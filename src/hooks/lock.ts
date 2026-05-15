// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared mkdir-based file lock with crash-safe stale reap.
 *
 * Design:
 * - Acquire by mkdirSync(lockDir) — atomic against concurrent writers.
 * - On success, write owner metadata (pid/host/ts/tag) inside lockDir so
 *   operators can trace the holder and stale-reap logic has evidence.
 * - On conflict, inspect the existing owner:
 *     (a) if age > maxAgeMs, reap
 *     (b) if same host and pid dead (ESRCH from kill 0), reap
 *     (c) else busy-wait backoff and retry
 * - On retry exhaustion, throw LockTimeoutError — callers decide skip/fail.
 *
 * This is a deliberate break from the previous fact-force.ts lock, which
 * silently ran the protected function when acquire failed (bypassing mutual
 * exclusion). Fail-closed is required for the dotfiles commit path; fact-force
 * callers choose to catch the error and fail-soft.
 *
 * Errno discrimination (RE-5 fold, backported from dotfiles 2026-05-06 — see
 * `feedback-substrate-fix-pattern-must-self-mirror.md` for the recursive lens
 * that caught the homedir-cache trap during the original substrate work):
 * - mkdirSync EEXIST → contention/stale path (existing behavior — retry)
 * - mkdirSync non-EEXIST (EACCES, ENOSPC, EROFS, EMFILE, ...) → throw
 *   LockIOError immediately so operators see the actual errno instead of
 *   a misleading LockTimeoutError after retries
 * - Parent-ensure: `mkdirSync(dirname(lockDir), { recursive: true })` runs
 *   BEFORE the discriminating mkdirSync to eliminate fresh-install /
 *   test-isolated tmpdir / log-dir-cleaned-externally false-positive
 *   LockIOErrors on ENOENT-on-parent
 * - Kill switch: filesystem sentinel `~/.claude/.lock-io-error-downgrade`,
 *   checked at TOP of tryAcquireOnce before any mkdirSync — when present,
 *   downgrade non-EEXIST errors to `{kind: "contended", holder: null}` to
 *   restore pre-fix behavior. Filesystem (not env var) so in-flight IDE
 *   sessions see the toggle without process restart.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { getWallClockNow } from "../shared/clock.ts";

export type OwnerInfo = {
  pid: number;
  host: string;
  ts: number;
  tag: string;
};

export type LockOpts = {
  lockDir: string;
  retries?: number;
  backoffMs?: number;
  maxAgeMs?: number;
  ownerTag?: string;
};

export class LockTimeoutError extends Error {
  readonly lockDir: string;
  readonly holder: OwnerInfo | null;

  constructor(lockDir: string, holder: OwnerInfo | null) {
    const tag = holder ? ` held by pid ${holder.pid} (${holder.tag})` : "";
    super(`Could not acquire lock at ${lockDir}${tag}`);
    this.name = "LockTimeoutError";
    this.lockDir = lockDir;
    this.holder = holder;
  }
}

/**
 * Thrown when `mkdirSync` for the lock dir (or its parent) fails for reasons
 * OTHER than EEXIST (lock-already-held). Discriminated from LockTimeoutError
 * so operators see the actual errno (EACCES, ENOSPC, EROFS, ENOENT, EMFILE,
 * ...) instead of a misleading "lock held by another process" diagnostic
 * after retries.
 *
 * Wraps the original errno via native ES2022 `Error(message, { cause })`
 * pass-through — `this.cause` is set by the superclass (no field shadow that
 * would trigger TS2611 / TS4114 under strict + noImplicitOverride). Exposes
 * `code` and `path` directly so consumers don't need to re-cast `cause`.
 */
export class LockIOError extends Error {
  readonly lockDir: string;
  readonly code: string | undefined;
  readonly path: string | undefined;

  constructor(lockDir: string, cause: unknown) {
    const errno = cause as NodeJS.ErrnoException | undefined;
    const code = errno?.code;
    const path = errno?.path;
    super(
      `I/O error acquiring lock at ${lockDir} (errno: ${code ?? "unknown"})`,
      { cause },
    );
    this.name = "LockIOError";
    this.lockDir = lockDir;
    this.code = code;
    this.path = path;
  }
}

/**
 * Filesystem-sentinel kill-switch. When this file exists, `tryAcquireOnce`
 * downgrades non-EEXIST errors to `{kind: "contended", holder: null}` —
 * effectively restoring pre-RE-5-fix behavior. Operator workflow:
 *   touch ~/.claude/.lock-io-error-downgrade   # immediate effect
 *   rm    ~/.claude/.lock-io-error-downgrade   # immediate revert
 * Filesystem (not env var) because env vars are read at process start;
 * sentinel is read each call so in-flight Claude Code IDE sessions see
 * the toggle without process restart.
 *
 * Reads `process.env["HOME"]` live so in-process tests that mutate HOME
 * for isolation see the override (per `feedback-homedir-not-live-from-env`
 * — `homedir()` caches HOME at process start, breaking env-mutation
 * isolation). `homedir()` remains the fallback for the production case
 * where HOME is set at startup and never mutated. Mirrors the substrate's
 * `killSwitchPath()` per `feedback-substrate-fix-pattern-must-self-mirror`.
 */
function killSwitchPath(): string {
  const home = process.env["HOME"] ?? homedir();
  return join(home, ".claude", ".lock-io-error-downgrade");
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 10;
const DEFAULT_MAX_AGE_MS = 60_000;
const DEFAULT_OWNER_TAG = "anonymous";

/**
 * Env-overridable retry budget for the lock-acquire ladder. Sibling-trio
 * race tests (`vault-commit.test.ts` + `vault-chain.test.ts`) spawn Bun
 * subprocesses whose startup time can briefly exceed the 60ms (3 × 10ms)
 * default ladder on cold CI (noisy neighbor, cold Bun cache, GC pause).
 * `LOCK_RETRIES` / `LOCK_BACKOFF_MS` env-vars let those tests raise the
 * ceiling without changing production defaults. Plain digit-only parsing
 * to reject scientific notation, decimals, NaN, and signed values; bad
 * input degrades silently to the default (caller is operating either
 * intent-shaped or not-at-all). Backlog L340 TA-6 closure.
 */
const ENV_VAR_RETRIES = "CLAUDE_CONDUCTOR_LOCK_RETRIES";
const ENV_VAR_BACKOFF_MS = "CLAUDE_CONDUCTOR_LOCK_BACKOFF_MS";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function effectiveRetries(opts: LockOpts): number {
  return opts.retries ?? readPositiveIntEnv(ENV_VAR_RETRIES, DEFAULT_RETRIES);
}

function effectiveBackoffMs(opts: LockOpts): number {
  return (
    opts.backoffMs ?? readPositiveIntEnv(ENV_VAR_BACKOFF_MS, DEFAULT_BACKOFF_MS)
  );
}

type AttemptOutcome =
  | { kind: "acquired" }
  | { kind: "reaped-retry" }
  | { kind: "contended"; holder: OwnerInfo | null };

function tryAcquireOnce(opts: LockOpts): AttemptOutcome {
  // Kill-switch (RE-5 fold) — checked at TOP, before any mkdirSync, so
  // an operator under outage pressure can immediately restore pre-RE-5-fix
  // behavior without process restart. existsSync call cost (~µs) is
  // negligible vs human-minutes stuck-rollback cost.
  if (existsSync(killSwitchPath())) {
    return { kind: "contended", holder: null };
  }

  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const ownerTag = opts.ownerTag ?? DEFAULT_OWNER_TAG;
  const ownerFile = join(opts.lockDir, "owner");

  // Parent-ensure (RE-5 fold): avoid ENOENT-on-parent failures during
  // fresh-install / test-isolated tmpdir / log-dir-cleaned-externally
  // scenarios. Recursive mkdir is idempotent on already-existing parents.
  // Non-EEXIST failures here ARE structural (parent path unwritable etc.)
  // and propagate as LockIOError — we can't acquire if we can't create
  // the parent.
  try {
    mkdirSync(dirname(opts.lockDir), { recursive: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EEXIST") {
      throw new LockIOError(opts.lockDir, err);
    }
  }

  try {
    mkdirSync(opts.lockDir);
    const info: OwnerInfo = {
      pid: process.pid,
      host: hostname(),
      ts: getWallClockNow(),
      tag: ownerTag,
    };
    writeFileSync(ownerFile, JSON.stringify(info), "utf-8");
    return { kind: "acquired" };
  } catch (err: unknown) {
    // EEXIST is the expected "lock dir already exists" path → contention/
    // stale logic below. Anything else is structural (EACCES, ENOSPC,
    // EROFS, EMFILE, ...) and propagates immediately as LockIOError so
    // operators see the actual errno instead of a misleading
    // LockTimeoutError after retries.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EEXIST") {
      throw new LockIOError(opts.lockDir, err);
    }
    const holder = readOwner(ownerFile);
    if (isStale(opts.lockDir, holder, maxAgeMs)) {
      try {
        rmSync(opts.lockDir, { recursive: true, force: true });
      } catch {
        // Another writer reaped concurrently; caller will retry. rmSync
        // errno discrimination (EBUSY/ENOTEMPTY/EPERM benign-list +
        // EACCES/EROFS propagate) is filed as a separate follow-up.
      }
      return { kind: "reaped-retry" };
    }
    return { kind: "contended", holder };
  }
}

function acquireLock(opts: LockOpts): void {
  const retries = effectiveRetries(opts);
  const backoffMs = effectiveBackoffMs(opts);

  let lastHolder: OwnerInfo | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    const outcome = tryAcquireOnce(opts);
    if (outcome.kind === "acquired") return;
    if (outcome.kind === "reaped-retry") continue;
    lastHolder = outcome.holder;
    busyWait(backoffMs * (attempt + 1));
  }

  throw new LockTimeoutError(opts.lockDir, lastHolder);
}

async function acquireLockAsync(opts: LockOpts): Promise<void> {
  const retries = effectiveRetries(opts);
  const backoffMs = effectiveBackoffMs(opts);

  let lastHolder: OwnerInfo | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    const outcome = tryAcquireOnce(opts);
    if (outcome.kind === "acquired") return;
    if (outcome.kind === "reaped-retry") continue;
    lastHolder = outcome.holder;
    // `busyWait` blocks the event loop — under intra-process contention
    // the holder's awaited work can't resume. Use real async sleep here.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, backoffMs * (attempt + 1)),
    );
  }

  throw new LockTimeoutError(opts.lockDir, lastHolder);
}

function releaseLock(opts: LockOpts): void {
  try {
    unlinkSync(join(opts.lockDir, "owner"));
  } catch {
    // Owner file already gone — benign.
  }
  try {
    rmdirSync(opts.lockDir);
  } catch {
    // Lock dir already removed — benign.
  }
}

export function withLock<T>(fn: () => T, opts: LockOpts): T {
  acquireLock(opts);
  try {
    return fn();
  } finally {
    releaseLock(opts);
  }
}

/**
 * Async variant of `withLock`. REQUIRED for fns that return a Promise —
 * `withLock` releases the lock synchronously when `fn()` returns, which for
 * async fns means releasing before the promise settles. `withLockAsync`
 * awaits the promise inside the try/finally so the lock is held for the
 * full duration of the async work.
 */
export async function withLockAsync<T>(
  fn: () => Promise<T>,
  opts: LockOpts,
): Promise<T> {
  await acquireLockAsync(opts);
  try {
    return await fn();
  } finally {
    releaseLock(opts);
  }
}

function readOwner(ownerFile: string): OwnerInfo | null {
  try {
    if (!existsSync(ownerFile)) return null;
    const raw = readFileSync(ownerFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;
    const pid = obj["pid"];
    const host = obj["host"];
    const ts = obj["ts"];
    const tag = obj["tag"];

    if (
      typeof pid !== "number" ||
      typeof host !== "string" ||
      typeof ts !== "number" ||
      typeof tag !== "string"
    ) {
      return null;
    }

    return { pid, host, ts, tag };
  } catch {
    return null;
  }
}

function isStale(
  lockDir: string,
  owner: OwnerInfo | null,
  maxAgeMs: number,
): boolean {
  if (!owner) {
    // mkdir succeeded but writer died before writing owner — reap by dir age.
    try {
      const stat = statSync(lockDir);
      return getWallClockNow() - stat.mtimeMs > maxAgeMs;
    } catch {
      return true;
    }
  }

  if (getWallClockNow() - owner.ts > maxAgeMs) return true;

  // Cross-host locks can't be probed; only verify liveness on same host.
  if (owner.host !== hostname()) return false;

  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === "ESRCH";
  }
}

function busyWait(ms: number): void {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    // Sub-ms precision required; setTimeout is too coarse.
  }
}
