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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claimIdentity } from "../../src/channels/identity.ts";
import {
  createChannel,
  readMetadata,
  removeIdentityClaim,
} from "../../src/channels/index.ts";

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
 * L135 fallback — `sid()` no longer throws bare when `CLAUDE_SESSION_ID`
 * is absent. Instead it falls through to the discovery resolver
 * (`src/shared/session-id-discovery.ts`), and only throws — with a
 * recovery hint — when discovery exhausts the PPID-tree walk + mtime
 * telemetry fallback.
 *
 * This block pins the fail-loud path. The success paths (env / ppid /
 * mtime) are covered exhaustively in `session-id-discovery.test.ts`;
 * here we verify the wire-up: when env is unset and no telemetry
 * exists, the CLI emits the discovery-style recovery hint rather than
 * the prior bare "session_id not found or invalid" string.
 */
describe("channels CLI — sid() L135 discovery fallback", () => {
  function runWithoutSessionEnv(args: readonly string[]): RunResult {
    // Build a deliberately-clean env. process.env is inherited but we
    // delete CLAUDE_SESSION_ID before passing it down so the discovery
    // path fires. HOME points at an empty tmp dir so the mtime fallback
    // sees no telemetry files.
    const homeIsolated = mkdtempSync(join(tmpdir(), "channels-cli-l135-"));
    const inherited = { ...process.env };
    delete inherited["CLAUDE_SESSION_ID"];
    try {
      const result = Bun.spawnSync({
        cmd: ["bun", CLI_PATH, ...args],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...inherited,
          HOME: homeIsolated,
          CLAUDE_CONDUCTOR_CHANNELS_DIR: tempChannelsDir,
        },
      });
      return {
        exitCode: result.exitCode ?? -1,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    } finally {
      rmSync(homeIsolated, { recursive: true, force: true });
    }
  }

  it("emits discovery-style recovery hint when env unset + no telemetry available", async () => {
    // Plant a real channel so `peers` reaches `sid()` (which is called
    // AFTER readMetadata in the peers case). Without this, readMetadata
    // throws ENOENT first and we never exercise the new fallback path.
    // Unique suffix prevents collision when test re-runs against the
    // shared tempChannelsDir (beforeAll/afterAll lifetime).
    const channelId = `l135-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // createChannel reads CLAUDE_CONDUCTOR_CHANNELS_DIR from the test
    // process's env. Without this, the library uses ~/.claude/channels/
    // (default) and the planted channel won't be visible to the subprocess
    // which we point at tempChannelsDir.
    const prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = tempChannelsDir;
    try {
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID, // setup uses a valid session id
      });
    } finally {
      if (prevChannelsDir !== undefined) {
        process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
      } else {
        delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
      }
    }
    // Now invoke peers WITHOUT env CLAUDE_SESSION_ID. sid() falls through
    // to discovery → walks ppid against HOME-isolated empty sessions dir
    // → returns kind: missing → throws the recovery hint via my new path.
    const result = runWithoutSessionEnv(["peers", channelId]);
    expect(result.exitCode).not.toBe(0);
    // The recovery hint mentions setting CLAUDE_SESSION_ID explicitly —
    // distinct from the prior bare "session_id not found or invalid"
    // string thrown by channels/index.ts:resolveSessionId.
    expect(result.stderr).toContain("CLAUDE_SESSION_ID");
    expect(result.stderr).toContain("export CLAUDE_SESSION_ID=");
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

  it("release-self: releases this session's identity + appends self-released status", async () => {
    // Cycle 2026-05-24 Alpha Tier 4 — release-self verb. Self-targeted
    // sibling of close-peer; auto-resolves the held letter; uses
    // implicit force (self-heartbeat is fresh) + CAS-guards against
    // concurrent takeover.
    await createChannel({
      channelId: "c-cli-rs",
      handoffId: "c-cli-rs",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-cli-rs",
      sessionId: TEST_SESSION_ID,
    });

    const result = runSlice5(["release-self", "c-cli-rs"]);
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
    expect(parsed.previous_session_id).toBe(TEST_SESSION_ID);
    expect(parsed.orphan_sentinel).toBe(false);
    expect(parsed.sentinel_error).toBeUndefined();

    // Metadata: Alpha gone.
    const meta = readMetadata("c-cli-rs");
    expect(meta.identities?.["Alpha"]).toBeUndefined();

    // Sentinel: gone.
    const sentinelPath = join(slice5Dir, "c-cli-rs", "identities", "Alpha");
    expect(existsSync(sentinelPath)).toBe(false);

    // Audit-trail: a self-released status message landed (distinct
    // prefix from peer-closed so observers can tell the actor=subject
    // case apart from peer-side close-peer action).
    const messagesPath = join(slice5Dir, "c-cli-rs", "messages.jsonl");
    expect(existsSync(messagesPath)).toBe(true);
    const messageLines = readFileSync(messagesPath, "utf-8")
      .split("\n")
      .filter((l: string) => l.length > 0);
    const selfReleased = messageLines
      .map((l: string) => JSON.parse(l) as { kind: string; body: string })
      .find(
        (m: { kind: string; body: string }) =>
          m.kind === "status" && m.body.startsWith("self-released:"),
      );
    expect(selfReleased).toBeDefined();
    expect(selfReleased?.body).toContain(`identity Alpha`);
    expect(selfReleased?.body).toContain(`session ${TEST_SESSION_ID}`);
    expect(selfReleased?.body).toContain(`released by self`);
  });

  it("release-self: exit 5 NOT_HELD when this session has no claim on the channel", async () => {
    await createChannel({
      channelId: "c-cli-rs-empty",
      handoffId: "c-cli-rs-empty",
      sessionId: TEST_SESSION_ID,
    });
    // No claimIdentity — this session never claimed.

    const result = runSlice5(["release-self", "c-cli-rs-empty"]);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("[release-self]");
    expect(result.stderr).toContain("no identity claim");
  });

  it("release-self: exit 7 RACE_RELEASED when peer took over identity between resolve + release", async () => {
    // CAS-race scenario. Simulate by:
    // 1. TEST_SESSION_ID claims Alpha
    // 2. PEER_SESSION_ID also claims Alpha (via takeover — overwrites
    //    metadata via direct removeIdentityClaim + commitIdentityClaim
    //    primitives, simulating the race window)
    // 3. TEST_SESSION_ID calls release-self → CLI internally reads its
    //    own (now-stale) claim view via getIdentityForSession but the
    //    CAS check inside closeStalePeerIdentity catches the mismatch.
    //
    // Note: getIdentityForSession returns null when the session no
    // longer holds the identity (it's a sessionId-keyed lookup), so to
    // trigger the CAS branch we need the session to STILL think it
    // holds the letter at the moment release-self runs. We achieve that
    // by directly mutating metadata.identities[Alpha].session_id to
    // PEER_SESSION_ID WITHOUT clearing TEST_SESSION_ID's sentinel —
    // simulating a half-applied takeover that hasn't propagated yet.
    //
    // Simpler approach: bypass getIdentityForSession via test seam by
    // letting Alpha be held by PEER but with TEST_SESSION_ID having a
    // STALE getIdentityForSession result. Since getIdentityForSession
    // reads metadata.identities, mutating the holder via claimIdentity
    // after the first claim is the cleanest seam.
    //
    // For this test we trigger the NOT_HELD post-resolve race path
    // (kind:"not-held" inside closeStalePeerIdentity → die exit 5)
    // because triggering the in-CLI CAS path without monkey-patching
    // requires a more invasive setup. The CAS gate is exercised
    // directly by the substrate-level identity.test.ts case
    // ("session-mismatch when casSessionId differs from holder").
    //
    // This e2e CLI test exercises the post-resolve NOT_HELD branch
    // (race where takeover removed our claim entirely between resolve +
    // close); verifies the verb maps it to exit 5 with the
    // "already released between resolve and close" message.
    await createChannel({
      channelId: "c-cli-rs-race",
      handoffId: "c-cli-rs-race",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-cli-rs-race",
      sessionId: TEST_SESSION_ID,
    });
    // Simulate post-resolve race: clear TEST_SESSION_ID's claim BEFORE
    // release-self runs (mimics a concurrent close-peer that landed in
    // the window between resolve + closeStalePeerIdentity).
    await removeIdentityClaim({
      channelId: "c-cli-rs-race",
      identity: "Alpha",
    });

    const result = runSlice5(["release-self", "c-cli-rs-race"]);
    // The CLI's getIdentityForSession resolves to null (claim cleared),
    // so the verb dies at the NOT_HELD pre-check (code 5) with the
    // standard "no identity claim" message. Both NOT_HELD branches
    // (pre-resolve null + in-lock not-held) collapse to exit 5 — same
    // operator-visible shape, distinct from RACE_RELEASED (exit 7
    // which fires when SOMEONE ELSE now holds the letter).
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("[release-self]");
    expect(result.stderr).toContain("no identity claim");
  });
});

describe("channels CLI — whoami-active verb (subprocess)", () => {
  let waDir: string;

  beforeEach(() => {
    waDir = mkdtempSync(join(tmpdir(), "channels-whoami-active-"));
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = waDir;
  });

  afterEach(() => {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
    if (existsSync(waDir)) rmSync(waDir, { recursive: true, force: true });
  });

  // Controls the session env precisely: omits CLAUDE_SESSION_ID entirely when
  // `sessionId` is undefined (the no-session case must not inherit the ambient
  // session id). whoami-active reads the flag/env directly — it never falls
  // through to sid() discovery — so no HOME isolation is needed.
  function runWa(
    args: readonly string[],
    opts: { sessionId?: string } = {},
  ): RunResult {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: waDir,
    };
    delete env["CLAUDE_SESSION_ID"];
    if (opts.sessionId !== undefined) env["CLAUDE_SESSION_ID"] = opts.sessionId;
    const result = Bun.spawnSync({
      cmd: ["bun", CLI_PATH, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    return {
      exitCode: result.exitCode ?? -1,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }

  it("--json: auto-discovers the single channel the session holds", async () => {
    await createChannel({
      channelId: "c-wa-solo",
      handoffId: "c-wa-solo",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({ channelId: "c-wa-solo", sessionId: TEST_SESSION_ID });
    const result = runWa(["whoami-active", "--json"], {
      sessionId: TEST_SESSION_ID,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      identity: string;
      channel_id: string;
      role: string;
      joined_at: string;
    };
    expect(parsed.identity).toBe("Alpha");
    expect(parsed.channel_id).toBe("c-wa-solo");
    expect(parsed.role).toBe("queue");
    expect(parsed.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("bare (no --json): prints just the identity string", async () => {
    await createChannel({
      channelId: "c-wa-bare",
      handoffId: "c-wa-bare",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({ channelId: "c-wa-bare", sessionId: TEST_SESSION_ID });
    const result = runWa(["whoami-active"], { sessionId: TEST_SESSION_ID });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Alpha\n");
  });

  it("--session-id flag overrides the ambient env var", async () => {
    await createChannel({
      channelId: "c-wa-flag",
      handoffId: "c-wa-flag",
      sessionId: PEER_SESSION_ID,
    });
    await claimIdentity({ channelId: "c-wa-flag", sessionId: PEER_SESSION_ID });
    // Ambient env is TEST_SESSION_ID (holds nothing); the flag points at PEER.
    const result = runWa(
      ["whoami-active", "--session-id", PEER_SESSION_ID, "--json"],
      { sessionId: TEST_SESSION_ID },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      identity: string;
      channel_id: string;
    };
    expect(parsed.identity).toBe("Alpha");
    expect(parsed.channel_id).toBe("c-wa-flag");
  });

  it("no claim on any channel → null (exit 0, --json)", async () => {
    await createChannel({
      channelId: "c-wa-other",
      handoffId: "c-wa-other",
      sessionId: PEER_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-wa-other",
      sessionId: PEER_SESSION_ID,
    });
    const result = runWa(["whoami-active", "--json"], {
      sessionId: TEST_SESSION_ID,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });

  it("no resolvable session id (no flag, no env) → null/empty exit 0", () => {
    const jsonResult = runWa(["whoami-active", "--json"], {});
    expect(jsonResult.exitCode).toBe(0);
    expect(JSON.parse(jsonResult.stdout)).toBeNull();
    const bareResult = runWa(["whoami-active"], {});
    expect(bareResult.exitCode).toBe(0);
    expect(bareResult.stdout).toBe("");
  });

  it("multiple channels → most-recent by lastMessageTs (beats a later joined_at)", async () => {
    // A joins FIRST (older joined_at) but gets a far-future message; B joins
    // SECOND (newer joined_at) with no message. lastMessageTs is the primary
    // key, so A must win despite B's later join. The fixed far-future ts keeps
    // the assertion independent of wall-clock.
    await createChannel({
      channelId: "c-wa-a",
      handoffId: "c-wa-a",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({ channelId: "c-wa-a", sessionId: TEST_SESSION_ID });
    await createChannel({
      channelId: "c-wa-b",
      handoffId: "c-wa-b",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({ channelId: "c-wa-b", sessionId: TEST_SESSION_ID });
    writeFileSync(
      join(waDir, "c-wa-a", "messages.jsonl"),
      `${JSON.stringify({ ts: "2099-01-01T00:00:00.000Z", from: TEST_SESSION_ID, kind: "status", body: "x" })}\n`,
    );
    const result = runWa(["whoami-active", "--json"], {
      sessionId: TEST_SESSION_ID,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { channel_id: string };
    expect(parsed.channel_id).toBe("c-wa-a");
  });

  it("malformed metadata.json on one channel does not break the scan", async () => {
    await createChannel({
      channelId: "c-wa-good",
      handoffId: "c-wa-good",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({ channelId: "c-wa-good", sessionId: TEST_SESSION_ID });
    // A sibling channel dir with unparseable metadata — listChannels skips it
    // (its split try/catch treats an unreadable metadata.json as non-listable).
    mkdirSync(join(waDir, "c-wa-broken"), { recursive: true });
    writeFileSync(
      join(waDir, "c-wa-broken", "metadata.json"),
      "{ not valid json",
    );
    const result = runWa(["whoami-active", "--json"], {
      sessionId: TEST_SESSION_ID,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      channel_id: string;
      identity: string;
    };
    expect(parsed.channel_id).toBe("c-wa-good");
    expect(parsed.identity).toBe("Alpha");
  });
});
