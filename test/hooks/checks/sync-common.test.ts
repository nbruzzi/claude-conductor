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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
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
  oneLine,
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
