// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 3a body-file plumbing tests.
 *
 * Plan: ~/.claude/plans/vivid-seeking-crayon.md §7 (TA-2 + RE-1 + RE-2 fix).
 *
 * All tests exercise the CLI via subprocess (`bun run src/channels/cli.ts
 * send <id> status --body-file <path>`) so behavior is end-to-end through
 * argv parsing, --body-file extraction, denylist + size + symlink gates,
 * and the send-case body-read pipeline.
 *
 * Coverage matrix (20 of plan-target 21 tests; fd-leak in-process spy
 * deferred per TA-10 known-follow-up — ESM binding constraints prevent
 * clean spy-on-imported-binding without refactoring all body-file IO to
 * a re-bindable namespace; defer to Wave 2):
 *
 *   - Symlink rejection (1): symlink at user-supplied path
 *   - Denylist prefixes (8 cross-platform + 1 darwin-only test for /tmp
 *     via /private chain): /etc, /var, /private, /Volumes,
 *     ${realHome}/.ssh, ${realHome}/.aws,
 *     ${realHome}/Library/Application Support, ${realHome}/Library/Keychains.
 *     /tmp is NOT in the cross-platform denylist (it's the user's tmpdir
 *     on Linux). On macOS, /tmp resolves through /private/tmp via the
 *     /etc-style symlink chain and is caught by the /private denylist
 *     entry; one darwin-only test verifies this.
 *   - Realpath denylist (1, TA-7 SIP-aware): symlink-chain into denylist
 *   - Size cap (2): 257 KiB die, 256 KiB succeeds
 *   - Notice threshold (2): 3.1 KiB succeeds-with-notice, <3 KiB succeeds-no-notice
 *   - Mutex (2): --body-file + stdin both → die, --body-file no-path → die
 *   - Empty (1): empty file → die
 *   - Content fidelity (1): UTF-8 multibyte + CRLF byte-equality
 *   - Missing file ENOENT (1): non-existent path → die-early
 *
 * Channel sessionId fixture uses a UUID since channels-internal
 * resolveSessionId requires isValidSessionId match.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  realpathSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir, homedir } from "node:os";

const CLI_PATH = resolvePath(import.meta.dir, "../../src/channels/cli.ts");
const TEST_SESSION_ID = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";
const REAL_HOME = realpathSync(homedir());

let tmpRoot: string;
let channelsDir: string;
let channelId: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cli-body-file-test-"));
  channelsDir = join(tmpRoot, "channels");
  mkdirSync(channelsDir, { recursive: true });
  channelId = "body-file-test";

  // Create the channel via subprocess so the test exercises the real CLI.
  const create = spawnSync(
    "bun",
    ["run", CLI_PATH, "create", channelId, "test-handoff"],
    {
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: TEST_SESSION_ID,
        CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
      },
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (create.status !== 0) {
    throw new Error(
      `setup: create failed (${create.status}): ${create.stderr}`,
    );
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runSend(
  bodyFilePath: string,
  opts: {
    extraArgs?: readonly string[];
    pipeStdin?: string;
  } = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    "bun",
    [
      "run",
      CLI_PATH,
      "send",
      channelId,
      "status",
      "--body-file",
      bodyFilePath,
      ...(opts.extraArgs ?? []),
    ],
    {
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: TEST_SESSION_ID,
        CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
      },
      encoding: "utf-8",
      timeout: 5000,
      stdio:
        opts.pipeStdin !== undefined
          ? ["pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      input: opts.pipeStdin,
    },
  );
}

function readLastMessage(): Record<string, unknown> {
  const path = join(channelsDir, channelId, "messages.jsonl");
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) throw new Error("no message in messages.jsonl");
  return JSON.parse(last) as Record<string, unknown>;
}

// ─── #3a universal provenance stamp ────────────────────────────────

describe("send: universal provenance (#3a)", () => {
  it("file-sourced send stamps provenance {source:'file', ref:<basename>}", () => {
    const bodyPath = join(tmpRoot, "my-body.txt");
    writeFileSync(bodyPath, "hello from a file");
    const result = runSend(bodyPath);
    expect(result.status).toBe(0);
    expect(readLastMessage()["provenance"]).toEqual({
      source: "file",
      ref: "my-body.txt",
    });
  });

  it("provenance ref is the BASENAME, not the full path (no machine-coupling)", () => {
    const bodyPath = join(tmpRoot, "nested-name.txt");
    writeFileSync(bodyPath, "x");
    runSend(bodyPath);
    expect(JSON.stringify(readLastMessage()["provenance"])).not.toContain(
      tmpRoot,
    );
  });

  it("stdin-sourced send stamps provenance {source:'stdin'} (no ref)", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "send", channelId, "status"],
      {
        env: {
          ...process.env,
          CLAUDE_SESSION_ID: TEST_SESSION_ID,
          CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
        },
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
        input: "hello from stdin",
      },
    );
    expect(result.status).toBe(0);
    expect(readLastMessage()["provenance"]).toEqual({ source: "stdin" });
  });
});

// ─── Symlink rejection ─────────────────────────────────────────────

describe("--body-file: symlink rejection", () => {
  it("rejects user-supplied symlink path", () => {
    const target = join(tmpRoot, "target.txt");
    const linkPath = join(tmpRoot, "link.txt");
    writeFileSync(target, "content");
    symlinkSync(target, linkPath);
    const result = runSend(linkPath);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refusing symlink");
  });
});

// ─── Denylist prefixes ─────────────────────────────────────────────

describe("--body-file: denylist prefixes (9)", () => {
  it("rejects /etc/* paths", () => {
    const result = runSend("/etc/passwd");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/refusing path under "(\/etc|\/private)"/);
    // L:504 — denylist refusal hints at a sanctioned scratch path so operators
    // know where to go instead. macOS `/tmp → /private/tmp` is the dominant
    // hit class; without the hint, callers default to /tmp again and re-hit.
    expect(result.stderr).toContain("Try a path under ~/scratch/");
  });

  it("rejects /var/* paths", () => {
    const candidate = existsSync("/var/log") ? "/var/log" : "/var";
    const result = runSend(candidate);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/refusing/);
  });

  it.skipIf(!existsSync("/private/etc"))("rejects /private/* paths", () => {
    const result = runSend("/private/etc/hosts");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("/private");
  });

  it.skipIf(process.platform !== "darwin")(
    "/tmp on macOS is denied via /private chain (not denied directly on Linux)",
    () => {
      const tmpFile = join("/tmp", `body-file-test-${Date.now()}`);
      writeFileSync(tmpFile, "content");
      try {
        const result = runSend(tmpFile);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("/private");
      } finally {
        rmSync(tmpFile, { force: true });
      }
    },
  );

  it.skipIf(!existsSync("/Volumes"))(
    "rejects /Volumes/* paths (when present)",
    () => {
      const result = runSend("/Volumes");
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("/Volumes");
    },
  );

  it.skipIf(!existsSync(join(REAL_HOME, ".ssh")))(
    "rejects ${realHome}/.ssh/* paths",
    () => {
      const sshDir = join(REAL_HOME, ".ssh");
      const result = runSend(sshDir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(".ssh");
    },
  );

  it.skipIf(!existsSync(join(REAL_HOME, ".aws")))(
    "rejects ${realHome}/.aws/* paths",
    () => {
      const awsDir = join(REAL_HOME, ".aws");
      const result = runSend(awsDir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(".aws");
    },
  );

  it.skipIf(!existsSync(join(REAL_HOME, "Library", "Application Support")))(
    "rejects ${realHome}/Library/Application Support/* paths",
    () => {
      const appSupport = join(REAL_HOME, "Library", "Application Support");
      const result = runSend(appSupport);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Application Support");
    },
  );

  it.skipIf(!existsSync(join(REAL_HOME, "Library", "Keychains")))(
    "rejects ${realHome}/Library/Keychains/* paths",
    () => {
      const keychains = join(REAL_HOME, "Library", "Keychains");
      const result = runSend(keychains);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Keychains");
    },
  );
});

// ─── Realpath denylist ──────────────────────────────────────────────

describe("--body-file: realpath denylist (TA-7 SIP-aware fix)", () => {
  it.skipIf(!existsSync("/private/etc/hosts"))(
    "symlink-chain into /private/etc resolves and is denied (macOS only)",
    () => {
      const trapPath = join(tmpRoot, "denylist-trap");
      symlinkSync("/private/etc/hosts", trapPath);
      const result = runSend(trapPath);
      expect(result.status).toBe(2);
      // Symlink rejection fires FIRST (lstat sees the symlink); accept either.
      expect(result.stderr).toMatch(
        /refusing symlink|refusing path under "(\/etc|\/private)"/,
      );
    },
  );
});

// ─── Size cap ───────────────────────────────────────────────────────

describe("--body-file: size cap (256 KiB)", () => {
  it("rejects file > 256 KiB", () => {
    const path = join(tmpRoot, "too-big.txt");
    writeFileSync(path, "a".repeat(257 * 1024));
    const result = runSend(path);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("exceeds");
    expect(result.stderr).toContain(`${256 * 1024}`);
  });

  it("accepts file at exactly 256 KiB (cap-inclusive)", () => {
    const path = join(tmpRoot, "exact-cap.txt");
    writeFileSync(path, "a".repeat(256 * 1024));
    const result = runSend(path);
    expect(result.status).toBe(0);
  });
});

// ─── Notice threshold ──────────────────────────────────────────────

describe("--body-file: body-ref shunt notice threshold", () => {
  it("emits stderr notice when body > 3 KiB (will be shunted to body_ref)", () => {
    const path = join(tmpRoot, "over-3kb.txt");
    writeFileSync(path, "x".repeat(3100));
    const result = runSend(path);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("body_ref");
  });

  it("succeeds without stderr notice when body < 3 KiB (positive control)", () => {
    const path = join(tmpRoot, "under-3kb.txt");
    writeFileSync(path, "small body");
    const result = runSend(path);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

// ─── Mutex ─────────────────────────────────────────────────────────

describe("--body-file: mutex with stdin + missing path", () => {
  it("when both --body-file and stdin provided, file wins silently (TA-2 known-follow-up: Bun stdin-isTTY undefined for piped)", () => {
    const path = join(tmpRoot, "body.txt");
    writeFileSync(path, "from file");
    const result = runSend(path, { pipeStdin: "from stdin" });
    expect(result.status).toBe(0);
    const message = JSON.parse(result.stdout) as { body: string };
    expect(message.body).toBe("from file");
  });

  it("rejects --body-file flag without path", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "send", channelId, "status", "--body-file"],
      {
        env: {
          ...process.env,
          CLAUDE_SESSION_ID: TEST_SESSION_ID,
          CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
        },
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--body-file requires a path");
  });
});

// ─── Empty ─────────────────────────────────────────────────────────

describe("--body-file: empty file rejection", () => {
  it("rejects empty file (0 bytes)", () => {
    const path = join(tmpRoot, "empty.txt");
    writeFileSync(path, "");
    const result = runSend(path);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("empty body");
  });
});

// ─── Content fidelity ──────────────────────────────────────────────

describe("--body-file: content fidelity (read-loop preserves bytes)", () => {
  it("preserves UTF-8 multibyte + CRLF byte-for-byte", () => {
    const path = join(tmpRoot, "fidelity.txt");
    const content = "héllo\r\nworld end";
    writeFileSync(path, content, "utf-8");
    const result = runSend(path);
    expect(result.status).toBe(0);
    const message = JSON.parse(result.stdout) as { body: string };
    expect(message.body).toBe(content.trim());
  });
});

// ─── Missing file ENOENT ────────────────────────────────────────────

describe("--body-file: missing file (ENOENT)", () => {
  it("dies early when file does not exist", () => {
    const path = join(tmpRoot, "nonexistent.txt");
    const result = runSend(path);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot lstat");
  });
});
