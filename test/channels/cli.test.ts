// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * channels CLI tests — uncaught-throw funneling (CLI-A).
 *
 * Per Phase 1 plan v2 §Slice 4.5 (Wave 1 CLI-DX finding CLI-A — main()
 * lacks try/catch; sid()/readMetadata throws bypass die() structured
 * output). The fix wraps the verb dispatch in try/catch; the catch funnels
 * the error message through die() with category="UNCAUGHT" so operators
 * see structured stderr under --json instead of an unhandled rejection.
 *
 * Strategy: invoke channels/cli.ts directly (NOT through the bin
 * dispatcher) on a verb that internally throws (readMetadata on a
 * non-existent channel). With --json, stderr should be structured
 * {code, category: "UNCAUGHT", message}; without, plain stderr.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claimIdentity } from "../../src/channels/identity.ts";
import { createChannel, readMetadata } from "../../src/channels/index.ts";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const CLI_PATH = join(PACKAGE_ROOT, "src", "channels", "cli.ts");

// A valid UUID-shaped session id so the strict UUID gate inside
// resolveSessionId accepts the env. The throw we want to exercise comes
// from readMetadata on a missing channel, NOT from session-id discovery.
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const PEER_SESSION_ID = "00000000-0000-4000-8000-000000000002";

let tempChannelsDir: string;

beforeAll(() => {
  tempChannelsDir = mkdtempSync(join(tmpdir(), "channels-cli-test-"));
});

afterAll(() => {
  rmSync(tempChannelsDir, { recursive: true, force: true });
});

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function run(
  args: readonly string[],
  sessionId: string = TEST_SESSION_ID,
): RunResult {
  const result = Bun.spawnSync({
    cmd: ["bun", CLI_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: tempChannelsDir,
      CLAUDE_SESSION_ID: sessionId,
    },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("channels CLI — uncaught-throw funneling (CLI-A)", () => {
  it("non-existent channel meta exits non-zero with stderr (plain mode)", () => {
    const result = run(["meta", "definitely-does-not-exist-channel"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
  });

  it("non-existent channel meta with --json emits JSON stderr with UNCAUGHT category", () => {
    const result = run(["meta", "definitely-does-not-exist-channel", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(firstLine);
    }).not.toThrow();
    expect(typeof parsed).toBe("object");
    const obj = parsed as Record<string, unknown>;
    expect(obj["category"]).toBe("UNCAUGHT");
    expect(typeof obj["message"]).toBe("string");
    expect((obj["message"] as string).length).toBeGreaterThan(0);
    expect(obj["code"]).toBe(1);
  });

  it("plain-mode stderr on uncaught throw is not JSON-formatted", () => {
    const result = run(["meta", "definitely-does-not-exist-channel"]);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    let isStructuredJson = false;
    try {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      isStructuredJson =
        typeof parsed["category"] === "string" &&
        typeof parsed["message"] === "string";
    } catch {
      isStructuredJson = false;
    }
    expect(isStructuredJson).toBe(false);
  });

  it("known-shape errors (validation) still emit their explicit category, not UNCAUGHT", () => {
    // Trigger an explicit die() with category VALIDATION, not the catch.
    // Bogus channel-id (path-traversal shape) hits requireChannelId's die().
    const result = run(["meta", "../escape", "--json"]);
    expect(result.exitCode).not.toBe(0);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    // The explicit die() inside requireChannelId fires BEFORE readMetadata
    // throws — proving process.exit() short-circuits before the catch, so
    // categories from explicit die() callers are preserved.
    expect(parsed["category"]).toBe("VALIDATION");
  });
});

/**
 * Slice 5 verb subprocess tests — `whoami` / `set-role` / modified `join`
 * / `close-peer`. Each test seeds channel state via library calls then
 * invokes `cli.ts` end-to-end via `Bun.spawnSync`.
 *
 * Per-test sandbox isolation (beforeEach/afterEach within the describe)
 * avoids cross-test channel-state contamination — each verb test runs
 * against a fresh channels-dir.
 */

describe("channels CLI — Slice 5 identity verbs (subprocess)", () => {
  let slice5Dir: string;

  beforeEach(() => {
    slice5Dir = mkdtempSync(join(tmpdir(), "channels-slice5-"));
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = slice5Dir;
  });

  afterEach(() => {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
    if (existsSync(slice5Dir)) {
      rmSync(slice5Dir, { recursive: true, force: true });
    }
  });

  function runSlice5(
    args: readonly string[],
    sessionId: string = TEST_SESSION_ID,
  ): RunResult {
    // Slice 5 tests run against the per-test slice5Dir, NOT the
    // top-level tempChannelsDir used by the CLI-A funneling tests.
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_PATH, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_CONDUCTOR_CHANNELS_DIR: slice5Dir,
        CLAUDE_SESSION_ID: sessionId,
      },
    });
    return {
      exitCode: result.exitCode ?? -1,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }

  it("modified join: claims identity post-metadata-join + prints {metadata, identity}", async () => {
    await createChannel({
      channelId: "c-cli-join",
      handoffId: "c-cli-join",
      sessionId: TEST_SESSION_ID,
    });
    const result = runSlice5(["join", "c-cli-join"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      metadata: { participants: readonly string[] };
      identity: {
        identity: string;
        role: string;
        joined_at: string;
        is_new_participant: boolean;
      };
    };
    expect(parsed.metadata.participants).toContain(TEST_SESSION_ID);
    expect(parsed.identity.identity).toBe("Alpha");
    expect(parsed.identity.role).toBe("queue");
    expect(parsed.identity.is_new_participant).toBe(true);
    expect(parsed.identity.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("whoami: prints {identity, role, joined_at} for a session that has claimed", async () => {
    await createChannel({
      channelId: "c-cli-who",
      handoffId: "c-cli-who",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-cli-who",
      sessionId: TEST_SESSION_ID,
    });
    const result = runSlice5(["whoami", "c-cli-who"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      identity: string;
      role: string;
      joined_at: string;
    };
    expect(parsed.identity).toBe("Alpha");
    expect(parsed.role).toBe("queue");
    expect(parsed.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("set-role: updates role + prints {identity, role, previous_role}", async () => {
    await createChannel({
      channelId: "c-cli-role",
      handoffId: "c-cli-role",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-cli-role",
      sessionId: TEST_SESSION_ID,
    });
    const result = runSlice5(["set-role", "c-cli-role", "--role", "pen"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      identity: string;
      role: string;
      previous_role: string;
    };
    expect(parsed.identity).toBe("Alpha");
    expect(parsed.role).toBe("pen");
    expect(parsed.previous_role).toBe("queue");

    // Persistence check — a follow-up whoami shows the new role.
    const verify = runSlice5(["whoami", "c-cli-role"]);
    const verifyParsed = JSON.parse(verify.stdout) as { role: string };
    expect(verifyParsed.role).toBe("pen");
  });

  it("close-peer: releases stale peer's identity + appends peer-closed status", async () => {
    await createChannel({
      channelId: "c-cli-close",
      handoffId: "c-cli-close",
      sessionId: TEST_SESSION_ID,
    });
    // Seed: a peer claims Alpha but never touches its heartbeat. With
    // peerMtime === null the close-peer staleness gate treats the peer
    // as stale (most conservative interpretation per
    // closeStalePeerIdentity), so the verb releases without --force.
    await claimIdentity({
      channelId: "c-cli-close",
      sessionId: PEER_SESSION_ID,
    });

    const result = runSlice5(["close-peer", "c-cli-close", "--peer", "Alpha"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      kind: string;
      identity: string;
      previous_session_id: string;
      orphan_sentinel: boolean;
      sentinel_error?: { code: string; detail: string };
    };
    expect(parsed.kind).toBe("released");
    expect(parsed.identity).toBe("Alpha");
    expect(parsed.previous_session_id).toBe(PEER_SESSION_ID);
    // Phase 2 Slice 3 RE-W2-4: orphan_sentinel field always present.
    // Happy path: false (unlink succeeded; no sentinel_error).
    expect(parsed.orphan_sentinel).toBe(false);
    expect(parsed.sentinel_error).toBeUndefined();

    // Metadata: identities['Alpha'] gone.
    const meta = readMetadata("c-cli-close");
    expect(meta.identities?.["Alpha"]).toBeUndefined();

    // Sentinel: gone (default INTERNAL.unlinkSentinel succeeds).
    const sentinelPath = join(slice5Dir, "c-cli-close", "identities", "Alpha");
    expect(existsSync(sentinelPath)).toBe(false);

    // Audit-trail: a peer-closed status message landed on the channel.
    const messagesPath = join(slice5Dir, "c-cli-close", "messages.jsonl");
    expect(existsSync(messagesPath)).toBe(true);
  });
});
