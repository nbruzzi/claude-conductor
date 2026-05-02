// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER 3 ci-verification-reminder tests — PostToolUse Bash post-push reminder.
 *
 * 16-row matrix per Bravo's PHASE-2-DESIGN-BRAVO + plan
 * ~/.claude/plans/typed-sleeping-snowglobe.md:
 *   - canonical successful push → warn
 *   - failed push (exit 1)      → pass
 *   - dry-run filtered           → pass
 *   - --no-verify --force        → warn
 *   - leading -c flags           → warn
 *   - compound chains            → warn (any segment match)
 *   - quoted text                → pass (quote-strip)
 *   - non-push (git status)      → pass
 *   - wrong tool / no command    → pass
 *   - kill-switches              → pass
 *
 * HOME-overridden tmp sandbox per HOME-per-call pattern (test-gate.ts:23-26).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  check,
  INTERNAL,
} from "../../../src/hooks/checks/ci-verification-reminder.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "33333333-4444-4555-8666-777777777777";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ci-rem-"));
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
  exitCode?: number | undefined;
  sessionId?: string | undefined;
}): HookInput {
  const raw: Record<string, unknown> = {};
  if (opts.sessionId !== undefined) raw["session_id"] = opts.sessionId;
  if (opts.exitCode !== undefined)
    raw["tool_response"] = { exit_code: opts.exitCode };
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

describe("ci-verification-reminder", () => {
  describe("real successful push → warn", () => {
    it("canonical `git push` exit 0 → warn with reminder", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.source).toBe("ci-verification-reminder");
      expect(result.stdout).toContain("CI Verification Reminder");
      expect(result.stdout).toContain("gh pr checks");
      expect(result.stdout).toContain("gh run watch");
    });

    it("`git push --no-verify --force` exit 0 → warn", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push --no-verify --force",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.source).toBe("ci-verification-reminder");
    });

    it("`git -c http.proxy=x push origin main` exit 0 → warn", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git -c http.proxy=x push origin main",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.source).toBe("ci-verification-reminder");
    });

    it("compound `cd /repo && git push` exit 0 → warn (segment match)", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "cd /repo && git push",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.source).toBe("ci-verification-reminder");
    });

    it("`git pull && git push --tags` exit 0 → warn (tags push is delivery)", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git pull && git push --tags",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.source).toBe("ci-verification-reminder");
    });

    it("`git push --dry-run && git push` exit 0 → warn (last segment is real)", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push --dry-run && git push",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.source).toBe("ci-verification-reminder");
    });

    it("warn message contains session-scoped kill-switch path", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.stdout).toContain(
        `ci-verification-reminder-disabled-${SID}`,
      );
    });

    it("warn message uses global flag when sessionId missing", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push",
          exitCode: 0,
          sessionId: undefined,
        }),
      );
      expect(result.stdout).toContain("ci-verification-reminder-disabled");
      expect(result.stdout).not.toContain("ci-verification-reminder-disabled-");
    });
  });

  describe("failed / dry-run push → pass", () => {
    it("`git push` exit 1 → pass (failed push isn't delivery)", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push",
          exitCode: 1,
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("`git push --dry-run` exit 0 → pass (dry-run filtered)", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push --dry-run",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("`git push -n` exit 0 → pass", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push -n",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.stdout).toBe("");
    });
  });

  describe("quote-strip suppresses false positives", () => {
    it('`echo "git push to remote"` exit 0 → pass', async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: 'echo "git push to remote"',
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.stdout).toBe("");
    });
  });

  describe("non-push and non-Bash → pass", () => {
    it("`git status` exit 0 → pass", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git status",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.stdout).toBe("");
    });

    it("Edit tool → pass (wrong tool)", async () => {
      const result = await check(
        inputFor({ toolName: "Edit", exitCode: 0, sessionId: SID }),
      );
      expect(result.stdout).toBe("");
    });

    it("no command field → pass", async () => {
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: undefined,
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.stdout).toBe("");
    });

    it("no tool_response (exit_code unknown) → pass", async () => {
      const result = await check(
        inputFor({ toolName: "Bash", command: "git push", sessionId: SID }),
      );
      expect(result.stdout).toBe("");
    });
  });

  describe("kill switches → pass", () => {
    it("session-scoped kill-switch → pass", async () => {
      const ks = INTERNAL.killSwitchPaths(SID);
      if (ks.session === undefined) throw new Error("session ks expected");
      writeFileSync(ks.session, "");
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.stdout).toBe("");
    });

    it("global kill-switch → pass", async () => {
      const ks = INTERNAL.killSwitchPaths(SID);
      writeFileSync(ks.global, "");
      const result = await check(
        inputFor({
          toolName: "Bash",
          command: "git push",
          exitCode: 0,
          sessionId: SID,
        }),
      );
      expect(result.stdout).toBe("");
    });
  });

  describe("INTERNAL helpers", () => {
    it("extractExitCode reads exit_code: number", () => {
      expect(
        INTERNAL.extractExitCode({ tool_response: { exit_code: 0 } }),
      ).toBe(0);
      expect(
        INTERNAL.extractExitCode({ tool_response: { exit_code: 2 } }),
      ).toBe(2);
    });

    it("extractExitCode reads success: boolean", () => {
      expect(
        INTERNAL.extractExitCode({ tool_response: { success: true } }),
      ).toBe(0);
      expect(
        INTERNAL.extractExitCode({ tool_response: { success: false } }),
      ).toBe(1);
    });

    it("extractExitCode returns undefined when shape unknown", () => {
      expect(INTERNAL.extractExitCode({})).toBeUndefined();
      expect(INTERNAL.extractExitCode({ tool_response: null })).toBeUndefined();
      expect(
        INTERNAL.extractExitCode({ tool_response: "something" }),
      ).toBeUndefined();
    });
  });
});
