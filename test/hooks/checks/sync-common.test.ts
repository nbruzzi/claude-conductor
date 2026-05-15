// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for the cross-sibling sync-common primitives.
 *
 * `sync-common.ts` lifts the pieces that both the vault-sync and dotfiles-sync
 * loops need (log rotation, push-failure diagnostic, whitespace collapse) into
 * a single module so the two sibling trios cannot drift. These tests encode
 * the contracts both callers depend on; cross-caller regressions surface here
 * rather than showing up as a bug in one sibling after fixing the other.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendLogWithRotation,
  diagnosePushFailure,
  manualCommitInFlight,
  oneLine,
  PER_ENTRY_MAX_BYTES,
} from "../../../src/hooks/checks/sync-common.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sync-common-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("oneLine", () => {
  it("collapses runs of spaces to a single space", () => {
    expect(oneLine("hello   world")).toBe("hello world");
  });

  it("replaces embedded newlines with a single space", () => {
    expect(oneLine("line1\nline2\nline3")).toBe("line1 line2 line3");
  });

  it("treats \\r\\n as a single whitespace run", () => {
    expect(oneLine("windows\r\nstyle")).toBe("windows style");
  });

  it("replaces tabs with a single space", () => {
    expect(oneLine("tab\tseparated")).toBe("tab separated");
  });

  it("trims leading and trailing whitespace", () => {
    expect(oneLine("  trimmed  \n")).toBe("trimmed");
  });

  it("returns empty string for pure whitespace input", () => {
    expect(oneLine("   \n\t\n  ")).toBe("");
  });

  it("truncates to the default 200-char budget", () => {
    expect(oneLine("x".repeat(500))).toBe("x".repeat(200));
  });

  it("accepts a custom max length", () => {
    expect(oneLine("a".repeat(100), 10)).toBe("a".repeat(10));
  });

  it("truncates AFTER whitespace collapse — budget is predictable regardless of whitespace density", () => {
    const raw = "a" + "\n".repeat(50) + "b";
    expect(oneLine(raw, 10)).toBe("a b");
  });

  it("preserves non-whitespace content verbatim", () => {
    expect(oneLine("pre-commit rejected: foo.md is out of date")).toBe(
      "pre-commit rejected: foo.md is out of date",
    );
  });
});

describe("appendLogWithRotation", () => {
  it("creates the log file on first call when none exists", () => {
    const logPath = join(base, "new.log");
    appendLogWithRotation(logPath, "entry one\n", 1024);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toBe("entry one\n");
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it("creates missing parent directories for the log path", () => {
    const logPath = join(base, "nested", "deep", "sync.log");
    appendLogWithRotation(logPath, "nested\n", 1024);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toBe("nested\n");
  });

  it("appends without rotating when the existing log is under threshold", () => {
    const logPath = join(base, "under.log");
    writeFileSync(logPath, "prior\n", "utf-8");
    appendLogWithRotation(logPath, "next\n", 1024);
    expect(readFileSync(logPath, "utf-8")).toBe("prior\nnext\n");
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it("rotates the existing log to .1 when at or over the threshold", () => {
    const logPath = join(base, "full.log");
    writeFileSync(logPath, "x".repeat(1024), "utf-8");
    appendLogWithRotation(logPath, "fresh\n", 1024);
    expect(readFileSync(logPath, "utf-8")).toBe("fresh\n");
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("x".repeat(1024));
  });

  it("overwrites an existing .1 archive on the second rotation", () => {
    const logPath = join(base, "roll.log");
    writeFileSync(`${logPath}.1`, "oldest\n", "utf-8");
    writeFileSync(logPath, "y".repeat(1024), "utf-8");
    appendLogWithRotation(logPath, "fresh\n", 1024);
    expect(readFileSync(logPath, "utf-8")).toBe("fresh\n");
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("y".repeat(1024));
  });

  it("falls back to copy+truncate on EXDEV (cross-device) rename failure (L318 RE-2)", () => {
    const logPath = join(base, "exdev.log");
    writeFileSync(logPath, "z".repeat(1024), "utf-8");
    const origFs = { ...fs };
    let renameCalls = 0;
    try {
      mock.module("node:fs", () => ({
        ...origFs,
        renameSync: (oldPath: fs.PathLike, newPath: fs.PathLike) => {
          if (String(oldPath) === logPath) {
            renameCalls++;
            const err = new Error(
              "cross-device link not permitted",
            ) as NodeJS.ErrnoException;
            err.code = "EXDEV";
            throw err;
          }
          return origFs.renameSync(oldPath, newPath);
        },
      }));
      appendLogWithRotation(logPath, "fresh\n", 1024);
      expect(renameCalls).toBe(1);
      expect(readFileSync(logPath, "utf-8")).toBe("fresh\n");
      expect(existsSync(`${logPath}.1`)).toBe(true);
      expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("z".repeat(1024));
    } finally {
      mock.module("node:fs", () => origFs);
    }
  });

  it("clamps oversized entries to PER_ENTRY_MAX_BYTES with ellipsis sentinel (L320 RE-5)", () => {
    const logPath = join(base, "oversized.log");
    const oversized = `${"q".repeat(PER_ENTRY_MAX_BYTES + 100)}\n`;
    appendLogWithRotation(logPath, oversized, 100 * 1024); // generous maxBytes so rotation doesn't fire
    const written = readFileSync(logPath, "utf-8");
    expect(written.length).toBe(PER_ENTRY_MAX_BYTES);
    expect(written.endsWith("…\n")).toBe(true);
    expect(written.startsWith("q".repeat(100))).toBe(true);
  });

  it("does not clamp entries at or under PER_ENTRY_MAX_BYTES (L320 boundary)", () => {
    const logPath = join(base, "atcap.log");
    const atCap = "p".repeat(PER_ENTRY_MAX_BYTES - 1) + "\n"; // PER_ENTRY_MAX_BYTES bytes total
    appendLogWithRotation(logPath, atCap, 100 * 1024);
    const written = readFileSync(logPath, "utf-8");
    expect(written).toBe(atCap);
    expect(written.includes("…")).toBe(false);
  });

  // TA-1 fold — the append itself is intentionally NOT wrapped in a try/catch.
  // The contract at sync-common.ts §"append" docstring states: "if
  // `appendFileSync` throws (EACCES, EISDIR on the path, etc.) the caller
  // sees the error and is expected to log it via its own catch branch."
  // Without this test, a future refactor that wraps the append in try/catch
  // would silently swallow `logVaultFailure`'s only outbound signal — both
  // callers (`logVaultFailure` + `logSyncFailure`) rely on the throw to
  // surface failure through their own stderr fallback.
  it("propagates appendFileSync errors (TA-1: append contract is unwrapped)", () => {
    // Mock-injected error path: the platform-specific "logPath is a directory"
    // setup diverges (macOS reports dir size 0 → no rotation → append throws
    // EISDIR; Linux reports dir size 4096 → rotation moves the dir away →
    // append succeeds against a clean new path). The contract is about the
    // append CATCH behavior, not the os-specific stat shape — mock appendFileSync
    // directly so the test pins the contract platform-independently.
    const logPath = join(base, "mock-throws.log");
    const origFs = { ...fs };
    let appendCalls = 0;
    try {
      mock.module("node:fs", () => ({
        ...origFs,
        appendFileSync: () => {
          appendCalls++;
          const err = new Error(
            "EACCES: permission denied (test-injected)",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        },
      }));
      expect(() => appendLogWithRotation(logPath, "entry\n", 1024)).toThrow(
        /EACCES/,
      );
      // Confirm the mocked appendFileSync was actually reached (i.e., the
      // implementation did NOT short-circuit before calling append; the throw
      // surfaces from the unwrapped append path, not from the rotation prelude).
      expect(appendCalls).toBe(1);
    } finally {
      mock.module("node:fs", () => origFs);
    }
  });

  // TA-2 fold — rotation errors OTHER than ENOENT are intentionally caught
  // and stderr'd (non-fatal); the append still runs against the un-rotated
  // log. Without this test, a future refactor that re-raised non-ENOENT
  // rotation errors would block the append silently AND drop the warning to
  // stderr. The "rotation failed but log preserved" graceful path is the
  // load-bearing post-condition.
  it("stderrs and proceeds on non-ENOENT rotation error (TA-2: .1 is non-empty dir)", () => {
    const logPath = join(base, "blocked-archive.log");
    writeFileSync(logPath, "x".repeat(1024), "utf-8");
    // Pre-create `.1` as a non-empty directory. renameSync(file → dir) on
    // POSIX fails with EISDIR or ENOTEMPTY depending on platform; both are
    // non-ENOENT and exercise the stderr-and-continue branch.
    const archivePath = `${logPath}.1`;
    mkdirSync(archivePath, { recursive: true });
    writeFileSync(join(archivePath, "blocker"), "blocks-rename", "utf-8");

    const captured: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => {
      captured.push(String(msg));
    };
    try {
      expect(() =>
        appendLogWithRotation(logPath, "fresh\n", 1024),
      ).not.toThrow();
    } finally {
      console.error = origError;
    }
    // Append landed against the un-rotated file (`fresh` is now appended
    // after the 1024-byte `x` prefix — rotation didn't run, so the original
    // contents are preserved alongside the new entry).
    const written = readFileSync(logPath, "utf-8");
    expect(written.endsWith("fresh\n")).toBe(true);
    expect(written).toContain("x".repeat(1024));
    // Warning landed on stderr per the contract (single-line, source-tagged).
    expect(captured.join("\n")).toContain("[sync-common]");
    expect(captured.join("\n")).toContain("log rotation check failed");
  });
});

// TA-3 fold — diagnosePushFailure is exhaustively unit-tested above as a
// pure function (exit code in → diagnostic string out). But the upstream
// callers depend on Bun's subprocess `timeout` option delivering SIGTERM and
// producing `exitCode === 143` in practice. If Bun changes that semantic
// (SIGKILL, `null` exit code, different signal number), the unit tests stay
// green because they pass in hardcoded `143` — the real-wire signal would
// regress silently. This integration test pins the Bun timeout → SIGTERM
// → exitCode 143 contract by spawning a hanging subprocess with a tight
// timeout and asserting the exit code is `143`. Coarse is fine — the entry
// (L337 TA-3) frames it as "push against a URL that hangs proves the wire";
// any hanging child suffices because the Bun primitive is what's under
// test, not git's behavior against the URL.
describe("Bun subprocess timeout → SIGTERM contract (TA-3)", () => {
  it("delivers SIGTERM at the timeout boundary and exits with code 143", async () => {
    const start = Date.now();
    // `sleep 5` would hang for 5s without intervention; with timeout=150ms,
    // Bun should SIGTERM the child at ~150ms and the process exits 143.
    const proc = Bun.spawn(["sleep", "5"], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 150,
    });
    const exitCode = await proc.exited;
    const elapsed = Date.now() - start;

    // Bun's documented behavior: `timeout` delivers SIGTERM (signal 15),
    // child exits with 128 + 15 = 143. If Bun ever changes this to SIGKILL
    // (137), `null`, or some other shape, diagnosePushFailure's literal
    // `exitCode === 143` test would mis-classify a hung push as "non-timeout
    // failure", forcing operators to chase the wrong diagnostic.
    expect(exitCode).toBe(143);
    // Sanity-bound elapsed: at least near the timeout, at most a generous
    // post-timeout slack (test scheduler / signal-delivery overhead). The
    // wide upper bound tolerates slow CI without losing the test's intent.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("diagnosePushFailure", () => {
  it("returns the timeout message when exit code is 143 (SIGTERM)", () => {
    expect(diagnosePushFailure("whatever git wrote", 100, 10_000, 143)).toBe(
      "push timeout after 10s — network or remote hung",
    );
  });

  it("prefers stderr over elapsed-margin when exit is not 143 (RE-11)", () => {
    expect(
      diagnosePushFailure("fatal: Authentication failed", 9_500, 10_000, 128),
    ).toBe("fatal: Authentication failed");
  });

  it("returns the timeout message on exit 143 even when elapsed equals the full timeout", () => {
    expect(diagnosePushFailure("", 10_000, 10_000, 143)).toBe(
      "push timeout after 10s — network or remote hung",
    );
  });

  it("falls back to elapsed-margin timeout when stderr is empty and elapsed is at the margin", () => {
    expect(diagnosePushFailure("", 9_500, 10_000, 1)).toBe(
      "push timeout after 10s — network or remote hung",
    );
  });

  it("prefers stderr over exit-code when the failure is not a timeout", () => {
    expect(
      diagnosePushFailure("fatal: remote rejected", 2_000, 10_000, 1),
    ).toBe("fatal: remote rejected");
  });

  it("falls back to the exit code when stderr is empty and elapsed is below the margin", () => {
    expect(diagnosePushFailure("", 500, 10_000, 128)).toBe(
      "git push exited with code 128",
    );
  });

  it("treats elapsed at (timeout - 501ms) as a non-timeout failure", () => {
    expect(diagnosePushFailure("slow but completed", 9_499, 10_000, 1)).toBe(
      "slow but completed",
    );
  });
});

// L328 closure (backlog 2026-04-22): manualCommitInFlight lifted from
// dotfiles-common.ts to sync-common.ts. Trio-agnostic primitive — caller
// passes repoRoot. Covers all 8 mid-op markers.
describe("manualCommitInFlight", () => {
  it("returns false when no mid-op markers exist", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mcif-clean-"));
    try {
      writeFileSync(join(repoRoot, ".git"), "", "utf-8"); // pre-create so the dir check below has somewhere to look
      rmSync(join(repoRoot, ".git"));
      // .git directory absent → all marker paths fail existsSync → false.
      expect(manualCommitInFlight(repoRoot)).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns true for each of the 8 mid-op markers", () => {
    const markers = [
      ".git/index.lock",
      ".git/MERGE_HEAD",
      ".git/CHERRY_PICK_HEAD",
      ".git/REVERT_HEAD",
      ".git/rebase-merge",
      ".git/rebase-apply",
      ".git/gc.pid",
      ".git/shallow.lock",
    ];
    for (const marker of markers) {
      const repoRoot = mkdtempSync(join(tmpdir(), "mcif-marker-"));
      try {
        const markerPath = join(repoRoot, marker);
        // mkdir parent (.git) then create the marker as file or dir per the marker name.
        const dirPart = marker.includes("rebase-")
          ? markerPath
          : join(repoRoot, ".git");
        mkdirSync(dirPart, { recursive: true });
        if (!marker.includes("rebase-")) {
          writeFileSync(markerPath, "", "utf-8");
        }
        expect(manualCommitInFlight(repoRoot)).toBe(true);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("checks all markers — return true even when only the last (.git/shallow.lock) exists", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mcif-last-"));
    try {
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      writeFileSync(join(repoRoot, ".git", "shallow.lock"), "", "utf-8");
      expect(manualCommitInFlight(repoRoot)).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
