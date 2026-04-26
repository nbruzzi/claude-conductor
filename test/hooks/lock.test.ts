// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, it, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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
