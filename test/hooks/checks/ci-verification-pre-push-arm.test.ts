// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER 4 ci-verification-pre-push-arm tests — sentinel write on PreToolUse Bash
 * matching real-shape `git push`.
 *
 * 16-row matrix per ~/.claude/plans/typed-sleeping-snowglobe.md:
 *   - happy paths (canonical, --no-verify --force, compound chains, branchHint)
 *   - dry-run filtered (--dry-run, -n)
 *   - quote-strip (echo "git push" suppressed)
 *   - non-push (git status)
 *   - wrong tool / no command / no sessionId
 *   - kill switches (session-scoped + global)
 *
 * HOME-overridden tmp sandbox per HOME-per-call pattern (test-gate.ts:23-26).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  check,
  INTERNAL,
} from "../../../src/hooks/checks/ci-verification-pre-push-arm.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "11111111-2222-4333-8444-555555555555";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ci-arm-"));
  mkdirSync(join(tmpHome, ".claude", ".flags"), { recursive: true });
  prevHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function inputFor(opts: {
  toolName?: string | undefined;
  command?: string | undefined;
  sessionId?: string | undefined;
}): HookInput {
  const raw: Record<string, unknown> =
    opts.sessionId === undefined ? {} : { session_id: opts.sessionId };
  return {
    toolName: opts.toolName,
    filePath: undefined,
    command: opts.command,
    cwd: undefined,
    transcriptPath: undefined,
    raw,
    dispatch: DEFAULT_DISPATCH,
  };
}

function sentinelFiles(): string[] {
  const dir = join(tmpHome, ".claude", ".flags");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("ci-verification-armed-"));
}

function readSentinel(filename: string): Record<string, unknown> {
  const full = join(tmpHome, ".claude", ".flags", filename);
  return JSON.parse(readFileSync(full, "utf-8")) as Record<string, unknown>;
}

describe("ci-verification-pre-push-arm", () => {
  describe("real-push detection writes sentinel", () => {
    it("canonical `git push` writes a sentinel file", async () => {
      const result = await check(
        inputFor({ toolName: "Bash", command: "git push", sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const files = sentinelFiles();
      expect(files.length).toBe(1);
    });

    it("`git push --no-verify --force` writes a sentinel", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push --no-verify --force",
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(1);
    });

    it("compound `cd /repo && git push` writes a sentinel", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "cd /repo && git push",
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(1);
    });

    it("`git pull && git push --tags` writes a sentinel", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git pull && git push --tags",
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(1);
    });

    it("`git push --dry-run && git push` writes sentinel (last segment is real)", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push --dry-run && git push",
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(1);
    });

    it("`git -c http.proxy=x push origin main` writes sentinel (leading -c absorbed)", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git -c http.proxy=x push origin main",
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(1);
    });
  });

  describe("dry-run filtered → no sentinel", () => {
    it("`git push --dry-run` does NOT write sentinel", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push --dry-run",
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });

    it("`git push -n` does NOT write sentinel", async () => {
      const result = await check(
        inputFor({ toolName: "Bash", command: "git push -n", sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });
  });

  describe("quote-strip suppresses false positives", () => {
    it('`echo "git push to remote"` does NOT write sentinel', async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: 'echo "git push to remote"',
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });

    it("`echo 'git push'` (single-quoted) does NOT write sentinel", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "echo 'git push'",
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });
  });

  describe("non-push and non-Bash → no sentinel", () => {
    it("`git status` does NOT write sentinel", async () => {
      const result = await check(
        inputFor({ toolName: "Bash", command: "git status", sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });

    it("Edit tool does NOT write sentinel", async () => {
      const result = await check(
        inputFor({ toolName: "Edit", command: undefined, sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });

    it("no command field does NOT write sentinel", async () => {
      const result = await check(
        inputFor({ toolName: "Bash", command: undefined, sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });

    it("empty command does NOT write sentinel", async () => {
      const result = await check(
        inputFor({ toolName: "Bash", command: "", sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });
  });

  describe("session-id requirement", () => {
    it("missing sessionId → no sentinel", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push",
          sessionId: undefined,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });
  });

  describe("kill switches", () => {
    it("session-scoped kill-switch present → no sentinel", async () => {
      writeFileSync(INTERNAL.killSwitchPaths(SID).session, "");
      const result = await check(
        inputFor({ toolName: "Bash", command: "git push", sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });

    it("global kill-switch present → no sentinel", async () => {
      writeFileSync(INTERNAL.killSwitchPaths(SID).global, "");
      const result = await check(
        inputFor({ toolName: "Bash", command: "git push", sessionId: SID }),
      );
      expect(result.exitCode).toBe(0);
      expect(sentinelFiles().length).toBe(0);
    });
  });

  describe("sentinel payload shape + branchHint extraction", () => {
    it("payload contains push_ts, command_preview, sessionId, claimed=false, evidenced=false", async () => {
      await check(
        inputFor({ toolName: "Bash", command: "git push", sessionId: SID }),
      );
      const files = sentinelFiles();
      expect(files.length).toBe(1);
      const path = files[0];
      if (path === undefined) throw new Error("expected sentinel file");
      const data = readSentinel(path);
      expect(typeof data["push_ts"]).toBe("string");
      expect(data["command_preview"]).toBe("git push");
      expect(data["sessionId"]).toBe(SID);
      expect(data["claimed"]).toBe(false);
      expect(data["evidenced"]).toBe(false);
    });

    it("`git push origin main` records branchHint='main'", async () => {
      await check(
        inputFor({
          toolName: "Bash",
          command: "git push origin main",
          sessionId: SID,
        }),
      );
      const files = sentinelFiles();
      expect(files.length).toBe(1);
      const path = files[0];
      if (path === undefined) throw new Error("expected sentinel file");
      const data = readSentinel(path);
      expect(data["branchHint"]).toBe("main");
    });

    it("`git push some-feature` (single-positional) records branchHint='some-feature'", async () => {
      await check(
        inputFor({
          toolName: "Bash",
          command: "git push some-feature",
          sessionId: SID,
        }),
      );
      const files = sentinelFiles();
      expect(files.length).toBe(1);
      const path = files[0];
      if (path === undefined) throw new Error("expected sentinel file");
      const data = readSentinel(path);
      expect(data["branchHint"]).toBe("some-feature");
    });

    it("long command is truncated with ellipsis in command_preview", async () => {
      const longCmd = `git push origin ${"a".repeat(250)}`;
      await check(
        inputFor({ toolName: "Bash", command: longCmd, sessionId: SID }),
      );
      const files = sentinelFiles();
      expect(files.length).toBe(1);
      const path = files[0];
      if (path === undefined) throw new Error("expected sentinel file");
      const data = readSentinel(path);
      const preview = data["command_preview"];
      expect(typeof preview).toBe("string");
      expect((preview as string).endsWith("…")).toBe(true);
      expect((preview as string).length).toBe(201);
    });
  });
});
