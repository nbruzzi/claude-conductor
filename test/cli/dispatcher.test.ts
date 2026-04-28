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

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const BINARY = join(PACKAGE_ROOT, "bin", "claude-conductor");

// Valid UUID-shaped session id used by the CLI-B propagation tests below;
// channels CLI gates on strict UUID format for cross-edge invocation.
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000002";

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function run(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): RunResult {
  const result = Bun.spawnSync({
    cmd: [BINARY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
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

  // CLI-B (Wave 1, Slice 4.5): pre-verb --json/--quiet must propagate to
  // the spawned subcommand. The dispatcher partitions argv into pre-verb
  // propagated flags + remaining, then re-appends the propagated flags to
  // subArgs so the verb's parseFlags sees them regardless of placement.
  describe("--json position-insensitivity (CLI-B)", () => {
    let tempChannelsDir: string;
    beforeAll(() => {
      tempChannelsDir = mkdtempSync(join(tmpdir(), "dispatcher-cli-b-"));
    });
    afterAll(() => {
      rmSync(tempChannelsDir, { recursive: true, force: true });
    });

    function runMeta(extraArgs: readonly string[]): RunResult {
      return run(["channels", "meta", ...extraArgs, "bogus-channel-id"], {
        CLAUDE_CONDUCTOR_CHANNELS_DIR: tempChannelsDir,
        CLAUDE_SESSION_ID: TEST_SESSION_ID,
      });
    }

    function runMetaWithLeadingFlag(flag: string): RunResult {
      return run([flag, "channels", "meta", "bogus-channel-id"], {
        CLAUDE_CONDUCTOR_CHANNELS_DIR: tempChannelsDir,
        CLAUDE_SESSION_ID: TEST_SESSION_ID,
      });
    }

    it("post-verb --json produces structured JSON stderr on uncaught throw", () => {
      const result = runMeta(["--json"]);
      expect(result.exitCode).not.toBe(0);
      const firstLine = result.stderr.trim().split("\n")[0] ?? "";
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      expect(parsed["category"]).toBe("UNCAUGHT");
    });

    it("pre-verb --json produces structured JSON stderr on uncaught throw", () => {
      const result = runMetaWithLeadingFlag("--json");
      expect(result.exitCode).not.toBe(0);
      const firstLine = result.stderr.trim().split("\n")[0] ?? "";
      let parsed: Record<string, unknown>;
      expect(() => {
        parsed = JSON.parse(firstLine) as Record<string, unknown>;
        expect(parsed["category"]).toBe("UNCAUGHT");
      }).not.toThrow();
    });

    it("pre-verb and post-verb --json produce equivalent structured output", () => {
      const post = runMeta(["--json"]);
      const pre = runMetaWithLeadingFlag("--json");
      expect(post.exitCode).toBe(pre.exitCode);
      const postJson = JSON.parse(post.stderr.trim().split("\n")[0] ?? "{}");
      const preJson = JSON.parse(pre.stderr.trim().split("\n")[0] ?? "{}");
      expect(preJson.category).toBe(postJson.category);
      expect(preJson.code).toBe(postJson.code);
    });

    it("pre-verb --quiet propagates without breaking subcommand routing", () => {
      // --quiet is propagated alongside --json. We can't observe its effect
      // on stderr here (verbs don't yet consume flags.quiet — deferred to
      // Slice 5), but we can confirm the dispatcher doesn't choke on
      // --quiet in pre-verb position by routing successfully.
      const result = run(["--quiet", "channels", "help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("channels CLI");
    });

    it("--json before --help still routes to top-level help (not a verb)", () => {
      // The dispatcher's pre-verb partitioning treats --help/-h/help as
      // the cmd, not a propagated flag. --json before --help is OK; help
      // wins and exits 0 with usage banner.
      const result = run(["--json", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  });

  // RE-W1-6 (Wave 1, Slice 4.5): bin/claude-conductor's symlink-chain
  // resolver must refuse over-long chains (defense-in-depth against cycles
  // that the OS doesn't reject at posix_spawn). Self-referential cycles
  // are caught at OS level (ELOOP at posix_spawn) before bash even starts;
  // these tests instead exercise the bash MAX_DEPTH guard directly by
  // building a long-but-non-cyclic chain that the kernel would happily
  // resolve but which is suspicious enough for the bash resolver to
  // refuse — the same protection that catches cycles the OS misses.
  describe("symlink chain depth protection (RE-W1-6)", () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "dispatcher-symlink-"));
    });
    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("chain exceeding MAX_DEPTH (>8) fails with bash 'too deep' error", () => {
      // Build a chain of 10 symlinks: link-0 → link-1 → ... → link-9 →
      // BINARY. macOS's kernel allows ~16 hops at posix_spawn, so the
      // kernel happily spawns bash; bash's MAX_DEPTH=8 then fires at hop
      // 9 with the explicit "too deep — possible cycle" error. This is
      // the test path: kernel allows, bash refuses. Cycles at higher
      // chain lengths get caught by the kernel ELOOP layer before bash
      // even starts, which is also valid protection but unreachable from
      // this layer.
      const chainLength = 10;
      let prevTarget = BINARY;
      for (let i = chainLength - 1; i >= 0; i--) {
        const linkPath = join(tempDir, `link-${i}`);
        symlinkSync(prevTarget, linkPath);
        prevTarget = linkPath;
      }
      const head = join(tempDir, "link-0");
      const result = Bun.spawnSync({
        cmd: [head, "--help"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(result.stderr);
      expect(result.exitCode).not.toBe(0);
      expect(stderr).toContain("too deep");
      expect(stderr.toLowerCase()).toContain("cycle");
    });

    it("normal single-hop symlink still resolves correctly", () => {
      const linkPath = join(tempDir, "claude-conductor-link");
      symlinkSync(BINARY, linkPath);
      const result = Bun.spawnSync({
        cmd: [linkPath, "--help"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new TextDecoder().decode(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
    });

    it("short chain (3 hops) within budget resolves correctly", () => {
      const linkA = join(tempDir, "short-a");
      const linkB = join(tempDir, "short-b");
      const linkC = join(tempDir, "short-c");
      symlinkSync(BINARY, linkC);
      symlinkSync(linkC, linkB);
      symlinkSync(linkB, linkA);
      const result = Bun.spawnSync({
        cmd: [linkA, "--help"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new TextDecoder().decode(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
    });
  });
});
