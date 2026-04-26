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
import { hostname } from "node:os";
import { join } from "node:path";

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

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 10;
const DEFAULT_MAX_AGE_MS = 60_000;
const DEFAULT_OWNER_TAG = "anonymous";

type AttemptOutcome =
  | { kind: "acquired" }
  | { kind: "reaped-retry" }
  | { kind: "contended"; holder: OwnerInfo | null };

function tryAcquireOnce(opts: LockOpts): AttemptOutcome {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const ownerTag = opts.ownerTag ?? DEFAULT_OWNER_TAG;
  const ownerFile = join(opts.lockDir, "owner");

  try {
    mkdirSync(opts.lockDir);
    const info: OwnerInfo = {
      pid: process.pid,
      host: hostname(),
      ts: Date.now(),
      tag: ownerTag,
    };
    writeFileSync(ownerFile, JSON.stringify(info), "utf-8");
    return { kind: "acquired" };
  } catch {
    const holder = readOwner(ownerFile);
    if (isStale(opts.lockDir, holder, maxAgeMs)) {
      try {
        rmSync(opts.lockDir, { recursive: true, force: true });
      } catch {
        // Another writer reaped concurrently; caller will retry.
      }
      return { kind: "reaped-retry" };
    }
    return { kind: "contended", holder };
  }
}

function acquireLock(opts: LockOpts): void {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

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
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

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
      return Date.now() - stat.mtimeMs > maxAgeMs;
    } catch {
      return true;
    }
  }

  if (Date.now() - owner.ts > maxAgeMs) return true;

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
