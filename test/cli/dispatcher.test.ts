// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Dispatcher tests for the claude-conductor binary.
 *
 * Exercises the bash dispatcher (bin/claude-conductor) end-to-end by
 * spawning it via Bun.spawnSync and asserting on stdout/stderr/exitCode.
 * The bash → bun → TS dispatcher chain is what consumers actually invoke;
 * testing end-to-end ensures both layers route correctly.
 *
 * Per Phase 1 plan v2 §Slice 0.
 */

import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const BINARY = join(PACKAGE_ROOT, "bin", "claude-conductor");

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function run(args: readonly string[]): RunResult {
  const result = Bun.spawnSync({
    cmd: [BINARY, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("claude-conductor dispatcher", () => {
  describe("--help / -h / help / no-args", () => {
    it("--help exits 0 and prints usage banner", () => {
      const result = run(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("claude-conductor <subcommand>");
      expect(result.stdout).toContain("channels");
      expect(result.stdout).toContain("todos");
    });

    it("-h is an alias for --help", () => {
      const result = run(["-h"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });

    it("'help' bare subcommand prints help (operator convenience)", () => {
      const result = run(["help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });

    it("no args prints help (no silent exit)", () => {
      const result = run([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  });

  describe("subcommand routing", () => {
    it("'channels help' routes to channels CLI's help", () => {
      const result = run(["channels", "help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("channels CLI");
    });

    it("'todos' with no args invokes todos CLI (which prints its usage)", () => {
      const result = run(["todos"]);
      // todos CLI exits 1 on missing subcommand; that's the routing-OK
      // signal. If routing failed we'd see top-level "unknown subcommand
      // 'todos'" instead of todos CLI's own error.
      expect(result.stderr).not.toContain("unknown subcommand 'todos'");
    });
  });

  describe("unknown subcommand handling", () => {
    it("unknown subcommand exits 1 with hint pointing at --help", () => {
      const result = run(["bogus-subcommand"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown subcommand");
      expect(result.stderr).toContain("bogus-subcommand");
      expect(result.stderr).toContain("--help");
    });

    it("unknown subcommand emits error to stderr (not stdout)", () => {
      const result = run(["bogus-subcommand"]);
      expect(result.stderr).toContain("unknown subcommand");
      expect(result.stdout).toBe("");
    });
  });

  describe("help text discoverability (CLI DX Wave 1 audit-gate)", () => {
    it("help mentions every routed subcommand by name", () => {
      const result = run(["--help"]);
      expect(result.stdout).toContain("channels");
      expect(result.stdout).toContain("todos");
    });

    it("help directs operator to per-subcommand --help for details", () => {
      const result = run(["--help"]);
      expect(result.stdout).toContain("--help");
      expect(result.stdout.toLowerCase()).toContain("subcommand");
    });

    it("help acknowledges presence routing is deferred (truth-in-advertising)", () => {
      const result = run(["--help"]);
      expect(result.stdout).toContain("presence");
      expect(result.stdout.toLowerCase()).toContain("deferred");
    });
  });
});
