// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, mock, test } from "bun:test";

import { runPrCli } from "../../src/pr/cli.ts";

/**
 * Slice 0 §Test grid §8 (flag validation) + cli-level verb routing.
 * cascade-rebase impl coverage lives in test/pr/cascade-rebase.test.ts.
 */

describe("pr/cli — runPrCli", () => {
  test("T-cli.1: no verb → prints help + exit 0", async () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = mock((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runPrCli([]);
      expect(code).toBe(0);
      expect(stdoutChunks.join("")).toContain("claude-conductor pr");
      expect(stdoutChunks.join("")).toContain("cascade-rebase");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T-cli.2: --help → prints help + exit 0", async () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = mock((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runPrCli(["--help"]);
      expect(code).toBe(0);
      expect(stdoutChunks.join("")).toContain("Verbs:");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T-cli.3: unknown verb → stderr + exit 1", async () => {
    const stderrChunks: string[] = [];
    const stderrSpy = mock((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runPrCli(["__no_such_verb__"]);
      expect(code).toBe(1);
      expect(stderrChunks.join("")).toContain("unknown verb");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("T-cli.4: parse-error flag (missing --base value) → exit 2", async () => {
    const stderrChunks: string[] = [];
    const stderrSpy = mock((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : "");
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runPrCli(["cascade-rebase", "--base"]);
      expect(code).toBe(2);
      expect(stderrChunks.join("")).toContain("--base");
    } finally {
      process.stderr.write = orig;
    }
  });
});
