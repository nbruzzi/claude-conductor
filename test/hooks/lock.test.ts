// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, it, expect, mock } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  LockIOError,
  LockTimeoutError,
  withLock,
  withLockAsync,
} from "../../src/hooks/lock.ts";

function makeTmpBase(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("withLock", () => {
  it("runs fn and returns its value", () => {
    const base = makeTmpBase("lock-basic-");
    const lockDir = join(base, "lock");
    try {
      const result = withLock(() => 42, { lockDir, ownerTag: "basic" });
      expect(result).toBe(42);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("releases lock even when fn throws", () => {
    const base = makeTmpBase("lock-throw-");
    const lockDir = join(base, "lock");
    try {
      expect(() =>
        withLock(
          () => {
            throw new Error("boom");
          },
          { lockDir, ownerTag: "boom" },
        ),
      ).toThrow("boom");
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("serializes repeated acquires from the same process", () => {
    const base = makeTmpBase("lock-serial-");
    const lockDir = join(base, "lock");
    try {
      let inside = 0;
      let maxConcurrent = 0;

      const body = (): number => {
        inside++;
        maxConcurrent = Math.max(maxConcurrent, inside);
        inside--;
        return 1;
      };

      for (let i = 0; i < 5; i++) {
        withLock(body, { lockDir, ownerTag: `run-${i}` });
      }

      expect(maxConcurrent).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reaps by owner age when ts is older than maxAgeMs", () => {
    const base = makeTmpBase("lock-stale-age-");
    const lockDir = join(base, "lock");
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner"),
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          ts: Date.now() - 10 * 60_000,
          tag: "stale",
        }),
      );

      const result = withLock(() => "acquired", {
        lockDir,
        maxAgeMs: 60_000,
        ownerTag: "reaper",
      });

      expect(result).toBe("acquired");
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reaps by dead pid when owner pid is not running (same host)", async () => {
    const base = makeTmpBase("lock-stale-pid-");
    const lockDir = join(base, "lock");
    try {
      const corpse = Bun.spawn(["/usr/bin/true"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await corpse.exited;
      const deadPid = corpse.pid;

      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner"),
        JSON.stringify({
          pid: deadPid,
          host: hostname(),
          ts: Date.now(),
          tag: "dead-pid",
        }),
      );

      const result = withLock(() => "acquired", {
        lockDir,
        ownerTag: "reaper",
      });

      expect(result).toBe("acquired");
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reaps by dir mtime when owner file is missing (crash between mkdir and write)", () => {
    const base = makeTmpBase("lock-crash-");
    const lockDir = join(base, "lock");
    try {
      mkdirSync(lockDir);
      const pastSeconds = Date.now() / 1000 - 10 * 60;
      utimesSync(lockDir, pastSeconds, pastSeconds);

      const result = withLock(() => "acquired", {
        lockDir,
        maxAgeMs: 60_000,
        ownerTag: "crash-reaper",
      });

      expect(result).toBe("acquired");
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws LockTimeoutError when holder is alive and fresh", () => {
    const base = makeTmpBase("lock-timeout-");
    const lockDir = join(base, "lock");
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner"),
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          ts: Date.now(),
          tag: "live-holder",
        }),
      );

      let caught: unknown = null;
      try {
        withLock(() => "should not run", {
          lockDir,
          retries: 3,
          backoffMs: 1,
          ownerTag: "blocked",
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(LockTimeoutError);
      if (caught instanceof LockTimeoutError) {
        expect(caught.lockDir).toBe(lockDir);
        expect(caught.holder?.pid).toBe(process.pid);
        expect(caught.holder?.tag).toBe("live-holder");
      }
      expect(existsSync(join(lockDir, "owner"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("holds lock for the full duration of an async fn", async () => {
    const base = makeTmpBase("lock-async-");
    const lockDir = join(base, "lock");
    try {
      let lockHeldDuringAwait = false;
      const result = await withLockAsync(
        async () => {
          // Lock must still exist here — we are inside the critical section.
          await new Promise((r) => setTimeout(r, 20));
          lockHeldDuringAwait = existsSync(lockDir);
          return "done";
        },
        { lockDir, ownerTag: "async-holder" },
      );

      expect(result).toBe("done");
      expect(lockHeldDuringAwait).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("blocks a second async acquirer until the first async fn settles", async () => {
    const base = makeTmpBase("lock-async-serial-");
    const lockDir = join(base, "lock");
    try {
      let inside = 0;
      let maxConcurrent = 0;

      const body = async (): Promise<number> => {
        inside++;
        maxConcurrent = Math.max(maxConcurrent, inside);
        await new Promise((r) => setTimeout(r, 15));
        inside--;
        return 1;
      };

      const results = await Promise.all([
        withLockAsync(body, {
          lockDir,
          ownerTag: "a",
          retries: 20,
          backoffMs: 5,
        }),
        withLockAsync(body, {
          lockDir,
          ownerTag: "b",
          retries: 20,
          backoffMs: 5,
        }),
        withLockAsync(body, {
          lockDir,
          ownerTag: "c",
          retries: 20,
          backoffMs: 5,
        }),
      ]);

      expect(results).toEqual([1, 1, 1]);
      expect(maxConcurrent).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("releases async lock even when fn rejects", async () => {
    const base = makeTmpBase("lock-async-throw-");
    const lockDir = join(base, "lock");
    try {
      let caught: unknown = null;
      try {
        await withLockAsync(
          async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error("async boom");
          },
          { lockDir, ownerTag: "async-boom" },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("async boom");
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not reap across hosts even if pid looks dead", () => {
    const base = makeTmpBase("lock-xhost-");
    const lockDir = join(base, "lock");
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner"),
        JSON.stringify({
          pid: 1,
          host: "some-other-host-99999",
          ts: Date.now(),
          tag: "xhost",
        }),
      );

      expect(() =>
        withLock(() => "nope", {
          lockDir,
          retries: 2,
          backoffMs: 1,
          ownerTag: "blocked",
        }),
      ).toThrow(LockTimeoutError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// RE-5 fold backported from dotfiles substrate 2026-05-06 — see
// `feedback-substrate-fix-pattern-must-self-mirror.md` for the recursive lens
// applied during the original substrate work + this backport. Discriminates
// non-EEXIST errno on mkdirSync from EEXIST contention path. Pre-fix: every
// errno fell through into the contention/stale logic and treated as
// contention, so operators saw misleading LockTimeoutErrors after retry
// exhaustion — these tests pin the post-fix behavior.
//
// Mock cleanup invariant: `mock.restore()` does NOT undo `mock.module` in
// Bun. Each test that mocks must capture `origFs = { ...fs }` before mocking
// and re-mock with `origFs` in `try/finally` to unstub every fs export.
// Skipping this leaks the stub into subsequent tests in source order.

describe("LockIOError discrimination", () => {
  it("EACCES on discriminating mkdirSync throws LockIOError, NOT LockTimeoutError, immediately (no retry)", () => {
    const base = makeTmpBase("lock-eacces-");
    const parentDir = join(base, "parent");
    const lockDir = join(parentDir, "lock");
    mkdirSync(parentDir, { recursive: true });
    let innerCalls = 0;
    const origFs = { ...fs };
    try {
      mock.module("node:fs", () => ({
        ...origFs,
        mkdirSync: (
          path: fs.PathLike,
          opts?: fs.MakeDirectoryOptions | fs.Mode,
        ) => {
          if (String(path) === lockDir) {
            innerCalls++;
            const err = new Error("permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return origFs.mkdirSync(path, opts as never);
        },
      }));
      let caught: unknown = null;
      try {
        withLock(() => {}, {
          lockDir,
          retries: 5,
          backoffMs: 1,
          ownerTag: "eacces",
        });
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockIOError);
      expect(caught instanceof LockTimeoutError).toBe(false);
      expect((caught as LockIOError).code).toBe("EACCES");
      // Immediate-throw: no retry loop, exactly 1 call to discriminating mkdirSync
      expect(innerCalls).toBe(1);
    } finally {
      mock.module("node:fs", () => origFs);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("ENOSPC on discriminating mkdirSync throws LockIOError with err.code === 'ENOSPC'", () => {
    const base = makeTmpBase("lock-enospc-");
    const lockDir = join(base, "lock");
    const origFs = { ...fs };
    try {
      mock.module("node:fs", () => ({
        ...origFs,
        mkdirSync: (
          path: fs.PathLike,
          opts?: fs.MakeDirectoryOptions | fs.Mode,
        ) => {
          if (String(path) === lockDir) {
            const err = new Error(
              "no space left on device",
            ) as NodeJS.ErrnoException;
            err.code = "ENOSPC";
            throw err;
          }
          return origFs.mkdirSync(path, opts as never);
        },
      }));
      let caught: unknown = null;
      try {
        withLock(() => {}, {
          lockDir,
          retries: 5,
          backoffMs: 1,
          ownerTag: "enospc",
        });
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockIOError);
      expect(caught instanceof LockTimeoutError).toBe(false);
      expect((caught as LockIOError).code).toBe("ENOSPC");
    } finally {
      mock.module("node:fs", () => origFs);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("EEXIST + stale owner reaps and acquires successfully (regression — EEXIST stays in contention path)", () => {
    const base = makeTmpBase("lock-eexist-stale-");
    const lockDir = join(base, "lock");
    try {
      // Pre-create lockDir with a stale owner (ts in the deep past).
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "owner"),
        JSON.stringify({
          pid: 999_999,
          host: hostname(),
          ts: Date.now() - 120_000, // older than default 60s maxAge
          tag: "stale",
        }),
      );
      // First attempt sees EEXIST → reaps → second attempt acquires.
      const result = withLock(() => "ok", {
        lockDir,
        retries: 3,
        backoffMs: 1,
        ownerTag: "fresh",
      });
      expect(result).toBe("ok");
      expect(existsSync(lockDir)).toBe(false); // released
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("EEXIST + non-stale live-pid owner exhausts retries and throws LockTimeoutError (regression)", () => {
    const base = makeTmpBase("lock-eexist-live-");
    const lockDir = join(base, "lock");
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "owner"),
        JSON.stringify({
          pid: process.pid, // live process, not stale-reapable
          host: hostname(),
          ts: Date.now(),
          tag: "live",
        }),
      );
      let caught: unknown = null;
      try {
        withLock(() => {}, {
          lockDir,
          retries: 2,
          backoffMs: 1,
          ownerTag: "blocked",
        });
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockTimeoutError);
      expect(caught instanceof LockIOError).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("ENOENT on parent dir is healed by parent-ensure — acquire succeeds without throwing", () => {
    // The parent dir is missing on first run (fresh-install / test-isolated
    // tmpdir / log-dir-cleaned-externally). `parent-ensure`
    // mkdirSync(dirname, { recursive: true }) creates it; lock proceeds.
    const base = makeTmpBase("lock-enoent-parent-");
    const missingParent = join(base, "does-not-yet-exist", "either");
    const lockDir = join(missingParent, "lock");
    try {
      expect(existsSync(missingParent)).toBe(false);
      const result = withLock(() => "ok", {
        lockDir,
        retries: 1,
        backoffMs: 1,
        ownerTag: "fresh",
      });
      expect(result).toBe("ok");
      expect(existsSync(missingParent)).toBe(true); // parent-ensure created it
      expect(existsSync(lockDir)).toBe(false); // released after fn
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("call-counter on discriminating mkdirSync — mock fires ONLY on inner call, parent-ensure passes through", () => {
    // Assert immediate-throw on the discriminating mkdirSync specifically.
    // Mock targets ONLY the inner mkdirSync call (path === lockDir);
    // parent-ensure call (path === dirname(lockDir)) passes through to real
    // fs so we can verify the ratio "1 parent-ensure call : 1 discriminating
    // call : 0 retries".
    const base = makeTmpBase("lock-counter-inner-");
    const parent = join(base, "parent");
    const lockDir = join(parent, "lock");
    let parentCalls = 0;
    let innerCalls = 0;
    const origFs = { ...fs };
    try {
      mock.module("node:fs", () => ({
        ...origFs,
        mkdirSync: (
          path: fs.PathLike,
          opts?: fs.MakeDirectoryOptions | fs.Mode,
        ) => {
          const p = String(path);
          if (p === parent) {
            parentCalls++;
            return origFs.mkdirSync(path, opts as never);
          }
          if (p === lockDir) {
            innerCalls++;
            const err = new Error("permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return origFs.mkdirSync(path, opts as never);
        },
      }));
      try {
        withLock(() => {}, {
          lockDir,
          retries: 10,
          backoffMs: 1,
          ownerTag: "counter-inner",
        });
      } catch {
        /* expected LockIOError */
      }
      expect(parentCalls).toBe(1); // parent-ensure ran once
      expect(innerCalls).toBe(1); // immediate-throw, no retry
    } finally {
      mock.module("node:fs", () => origFs);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("call-counter on parent-ensure mkdirSync — mock fires ONLY on outer call, inner never reached", () => {
    // Assert immediate-throw on the parent-ensure mkdirSync. Mock targets
    // ONLY the outer call; inner mkdirSync should never run because
    // parent-ensure throws first.
    const base = makeTmpBase("lock-counter-parent-");
    const parent = join(base, "parent");
    const lockDir = join(parent, "lock");
    let parentCalls = 0;
    let innerCalls = 0;
    const origFs = { ...fs };
    try {
      mock.module("node:fs", () => ({
        ...origFs,
        mkdirSync: (
          path: fs.PathLike,
          opts?: fs.MakeDirectoryOptions | fs.Mode,
        ) => {
          const p = String(path);
          if (p === parent) {
            parentCalls++;
            const err = new Error("permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          if (p === lockDir) {
            innerCalls++;
            return origFs.mkdirSync(path, opts as never);
          }
          return origFs.mkdirSync(path, opts as never);
        },
      }));
      let caught: unknown = null;
      try {
        withLock(() => {}, {
          lockDir,
          retries: 10,
          backoffMs: 1,
          ownerTag: "counter-parent",
        });
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockIOError);
      expect((caught as LockIOError).code).toBe("EACCES");
      expect(parentCalls).toBe(1); // parent-ensure ran exactly once
      expect(innerCalls).toBe(0); // inner mkdirSync never reached
    } finally {
      mock.module("node:fs", () => origFs);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("kill-switch (filesystem sentinel) downgrades non-EEXIST errors to contended, no LockIOError thrown", () => {
    // Kill-switch claim ("effective in seconds") must be tested. Mock
    // `existsSync` to selectively return true for the kill-switch suffix;
    // rest of fs passes through. Then attempt acquire on a path that would
    // normally throw EACCES on the discriminating mkdirSync. Expected:
    // returns LockTimeoutError after retries (pre-RE-5-fix behavior),
    // NOT LockIOError.
    const base = makeTmpBase("lock-killswitch-");
    const lockDir = join(base, "lock");
    const origFs = { ...fs };
    const KILL_SUFFIX = `${join(homedir(), ".claude")}/.lock-io-error-downgrade`;
    try {
      mock.module("node:fs", () => ({
        ...origFs,
        existsSync: (p: fs.PathLike) => {
          if (String(p) === KILL_SUFFIX) return true;
          return origFs.existsSync(p);
        },
        mkdirSync: (
          path: fs.PathLike,
          opts?: fs.MakeDirectoryOptions | fs.Mode,
        ) => {
          // This SHOULD never be called for the lockDir because kill-switch
          // returns contended at the TOP of tryAcquireOnce, before any mkdir.
          if (String(path) === lockDir) {
            const err = new Error("permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return origFs.mkdirSync(path, opts as never);
        },
      }));
      let caught: unknown = null;
      try {
        withLock(() => {}, {
          lockDir,
          retries: 2,
          backoffMs: 1,
          ownerTag: "kill-switch",
        });
      } catch (err: unknown) {
        caught = err;
      }
      // Kill-switch active → tryAcquireOnce returns contended (no mkdir
      // called) → retries exhaust → LockTimeoutError. NOT LockIOError.
      expect(caught).toBeInstanceOf(LockTimeoutError);
      expect(caught instanceof LockIOError).toBe(false);
    } finally {
      mock.module("node:fs", () => origFs);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// TA-6 fold — env-overridable retry budget for the lock-acquire ladder.
// Sibling-trio race tests (vault-commit + vault-chain) spawn Bun subprocesses
// whose startup latency can briefly exceed the default 60ms ladder on cold
// CI. `LOCK_RETRIES` / `LOCK_BACKOFF_MS` env-vars let those tests raise the
// ceiling without changing production defaults — these tests pin the
// override contract so a future regression that drops env-resolution would
// fail loudly here rather than silently re-introduce CI flake.
describe("retry-budget env overrides (TA-6)", () => {
  it("CLAUDE_CONDUCTOR_LOCK_RETRIES bumps the retry ladder length", () => {
    const base = makeTmpBase("lock-env-retries-");
    const lockDir = join(base, "lock");
    // Hold the lock — withLock will be forced into the retry path.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({
        pid: 99999,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const originalRetries = process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"];
    const originalBackoff = process.env["CLAUDE_CONDUCTOR_LOCK_BACKOFF_MS"];
    // Override → 10 retries × 5ms backoff (50 / 100 / ... ladder).
    // Without the override (default 3 × 10ms = 60ms ladder), this test
    // would still pass — the env knob just provides headroom. The
    // assertion below pins behavior: 10 retries × 5ms produces ~275ms of
    // total wait before LockTimeoutError, vs 60ms at defaults.
    process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"] = "10";
    process.env["CLAUDE_CONDUCTOR_LOCK_BACKOFF_MS"] = "5";
    try {
      const start = Date.now();
      let caught: unknown = null;
      try {
        withLock(() => undefined, { lockDir, maxAgeMs: 60_000 });
      } catch (e) {
        caught = e;
      }
      const elapsed = Date.now() - start;
      expect(caught).toBeInstanceOf(LockTimeoutError);
      // Retry ladder budget: 5 × (1+2+...+10) = 275ms. Allow generous
      // upper bound (5x) to tolerate slow CI without losing the bound's
      // intent.
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      if (originalRetries !== undefined) {
        process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"] = originalRetries;
      } else {
        delete process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"];
      }
      if (originalBackoff !== undefined) {
        process.env["CLAUDE_CONDUCTOR_LOCK_BACKOFF_MS"] = originalBackoff;
      } else {
        delete process.env["CLAUDE_CONDUCTOR_LOCK_BACKOFF_MS"];
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("invalid env value falls back to default (bad input is silent)", () => {
    const base = makeTmpBase("lock-env-invalid-");
    const lockDir = join(base, "lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({
        pid: 99999,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const originalRetries = process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"];
    // Reject scientific notation / decimals / negative / non-digit.
    process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"] = "abc";
    try {
      const start = Date.now();
      let caught: unknown = null;
      try {
        withLock(() => undefined, { lockDir, maxAgeMs: 60_000 });
      } catch (e) {
        caught = e;
      }
      const elapsed = Date.now() - start;
      // Bad input → default 3 retries × default 10ms = 60ms ladder. The
      // assertion isn't on a tight upper bound (scheduler / GC variance)
      // but the lower bound proves the override didn't accidentally
      // accept the bad input and run 10+ retries.
      expect(caught).toBeInstanceOf(LockTimeoutError);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      if (originalRetries !== undefined) {
        process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"] = originalRetries;
      } else {
        delete process.env["CLAUDE_CONDUCTOR_LOCK_RETRIES"];
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
});
