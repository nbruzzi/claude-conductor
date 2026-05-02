// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER-3a ci-verification-auth-warn tests — gh auth status branching at
 * SessionStart.
 *
 * PATH-stub harness: write small shell scripts to a temp dir + override
 * process.env.PATH so `gh` resolves to the stub. Bun.spawnSync respects the
 * mutated PATH per probe (2026-05-02). Stubs exercise:
 *   - exit 0                                            → pass (authed)
 *   - exit 1 + stderr "not logged into …"               → warn (not-authed)
 *   - exit 1 + stderr "… expired"                       → warn (expired)
 *   - exit 1 + stderr "Logged in to github.com as foo"  → pass (defense-in-depth)
 *   - exit 1 + unrecognized stderr                      → warn (generic)
 *   - empty PATH                                         → warn (not-installed; ENOENT)
 *   - kill-switch present                                → pass
 *   - classifyAuth INTERNAL exhaustive branch coverage
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  check,
  INTERNAL,
} from "../../../src/hooks/checks/ci-verification-auth-warn.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "22222222-3333-4444-8555-666666666666";

let tmpHome: string;
let stubDir: string;
let prevHome: string | undefined;
let prevPath: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ci-auth-"));
  stubDir = mkdtempSync(join(tmpdir(), "ci-auth-stub-"));
  mkdirSync(join(tmpHome, ".claude", ".flags"), { recursive: true });
  prevHome = process.env["HOME"];
  prevPath = process.env["PATH"];
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = prevPath;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

function writeStub(body: string): void {
  const stubPath = join(stubDir, "gh");
  writeFileSync(stubPath, body);
  chmodSync(stubPath, 0o755);
  process.env["PATH"] = stubDir;
}

function inputFor(sessionId: string | undefined): HookInput {
  const raw: Record<string, unknown> =
    sessionId === undefined ? {} : { session_id: sessionId };
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw,
    dispatch: DEFAULT_DISPATCH,
  };
}

describe("ci-verification-auth-warn", () => {
  describe("authed → pass", () => {
    it("gh exit 0 → pass()", async () => {
      writeStub("#!/bin/sh\nexit 0\n");
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("gh exit 1 with 'Logged in to github.com as' → pass (defense-in-depth)", async () => {
      writeStub(
        '#!/bin/sh\necho "Logged in to github.com as someuser" >&2\nexit 1\n',
      );
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("not authed → warn", () => {
    it("gh exit 1 with 'not logged into' → warn (auth login)", async () => {
      writeStub('#!/bin/sh\necho "not logged into github.com" >&2\nexit 1\n');
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CI Verification Auth");
      expect(result.stdout).toContain("gh auth login");
      expect(result.source).toBe("ci-verification-auth-warn");
    });

    it("gh exit 1 with 'expired' → warn (auth refresh)", async () => {
      writeStub('#!/bin/sh\necho "Token expired" >&2\nexit 1\n');
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("expired");
      expect(result.stdout).toContain("gh auth refresh");
    });

    it("gh exit 1 with unrecognized stderr → warn (generic)", async () => {
      writeStub('#!/bin/sh\necho "weird error from gh" >&2\nexit 1\n');
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("returned non-zero");
    });

    it("warn message includes session-scoped kill-switch path", async () => {
      writeStub('#!/bin/sh\necho "not logged into github.com" >&2\nexit 1\n');
      const result = await check(inputFor(SID));
      expect(result.stdout).toContain(
        `ci-verification-auth-warn-disabled-${SID}`,
      );
    });

    it("warn message uses global flag when sessionId missing", async () => {
      writeStub('#!/bin/sh\necho "not logged into github.com" >&2\nexit 1\n');
      const result = await check(inputFor(undefined));
      expect(result.stdout).toContain("ci-verification-auth-warn-disabled");
      expect(result.stdout).not.toContain(
        "ci-verification-auth-warn-disabled-",
      );
    });
  });

  describe("not installed → warn", () => {
    it("empty PATH → warn (gh not found, install message)", async () => {
      process.env["PATH"] = "";
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("not found in PATH");
      expect(result.stdout).toContain("brew install gh");
    });
  });

  describe("kill switches → pass", () => {
    it("session-scoped kill-switch → pass (no spawn)", async () => {
      const ks = INTERNAL.killSwitchPaths(SID);
      if (ks.session === undefined) throw new Error("session ks expected");
      writeFileSync(ks.session, "");
      process.env["PATH"] = "";
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("global kill-switch → pass (no spawn)", async () => {
      const ks = INTERNAL.killSwitchPaths(SID);
      writeFileSync(ks.global, "");
      process.env["PATH"] = "";
      const result = await check(inputFor(SID));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("classifyAuth INTERNAL", () => {
    it("exit 0 → authed", () => {
      expect(
        INTERNAL.classifyAuth({
          kind: "ok",
          exitCode: 0,
          signalCode: null,
          stdout: "",
          stderr: "",
        }).outcome,
      ).toBe("authed");
    });

    it("SIGTERM with null exit → timeout", () => {
      expect(
        INTERNAL.classifyAuth({
          kind: "ok",
          exitCode: null,
          signalCode: "SIGTERM",
          stdout: "",
          stderr: "",
        }).outcome,
      ).toBe("timeout");
    });

    it("exit 1 + 'expired' → expired", () => {
      expect(
        INTERNAL.classifyAuth({
          kind: "ok",
          exitCode: 1,
          signalCode: null,
          stdout: "",
          stderr: "Your token is expired",
        }).outcome,
      ).toBe("expired");
    });

    it("exit 1 + 'not logged into' → not-authed", () => {
      expect(
        INTERNAL.classifyAuth({
          kind: "ok",
          exitCode: 1,
          signalCode: null,
          stdout: "",
          stderr: "You are not logged into any GitHub hosts.",
        }).outcome,
      ).toBe("not-authed");
    });

    it("exit 1 + 'Logged in to github.com as' → authed (defense-in-depth)", () => {
      expect(
        INTERNAL.classifyAuth({
          kind: "ok",
          exitCode: 1,
          signalCode: null,
          stdout: "",
          stderr: "Logged in to github.com as foo (oauth_token)",
        }).outcome,
      ).toBe("authed");
    });

    it("exit 1 + unrecognized → warn-other", () => {
      expect(
        INTERNAL.classifyAuth({
          kind: "ok",
          exitCode: 1,
          signalCode: null,
          stdout: "",
          stderr: "some unknown failure",
        }).outcome,
      ).toBe("warn-other");
    });
  });
});
