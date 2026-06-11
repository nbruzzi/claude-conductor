// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 5 helper tests for `getIdentityContextForSession`.
 *
 * Verifies the cross-channel context aggregator returns the correct shape
 * for each scenario: no-claim sessions, single-claim, multi-channel claims,
 * archived exclusion, peer roster (self filtered, heartbeat mtime present),
 * invalid-NATO filtering, corrupt-metadata skip-on-error.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { statSync } from "node:fs";

import {
  archiveChannel,
  createChannel,
  touchHeartbeat,
} from "../../src/channels/index.ts";
import { claimIdentity } from "../../src/channels/identity.ts";
import {
  getIdentityContextForSession,
  isPeerCoordinatedWithSelf,
  sortIdentityContextsByChannelId,
  type IdentityContext,
} from "../../src/channels/identity-context.ts";

const SANDBOX = `/tmp/test-identity-context-${process.pid}`;
const SESSION_A = "sess-ctx-a";
const SESSION_B = "sess-ctx-b";
const SESSION_C = "sess-ctx-c";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

describe("getIdentityContextForSession", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns [] for empty session id", () => {
    const result = getIdentityContextForSession("");
    expect(result).toEqual([]);
  });

  it("returns [] for session with no claims on any channel", async () => {
    await createChannel({
      channelId: "c-empty",
      handoffId: "c-empty",
      sessionId: SESSION_A,
    });
    const result = getIdentityContextForSession(SESSION_A);
    expect(result).toEqual([]);
  });

  it("returns 1 context for session with claim on a single channel", async () => {
    await createChannel({
      channelId: "c-single",
      handoffId: "c-single",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-single", sessionId: SESSION_A });

    const result = getIdentityContextForSession(SESSION_A);
    expect(result).toHaveLength(1);
    expect(result[0]?.channelId).toBe("c-single");
    expect(result[0]?.self.identity).toBe("Alpha");
    expect(result[0]?.self.role).toBe("queue");
    expect(result[0]?.peers).toEqual([]);
  });

  it("returns multiple contexts for session with claims across channels", async () => {
    for (const id of ["c-multi-1", "c-multi-2", "c-multi-3"]) {
      await createChannel({
        channelId: id,
        handoffId: id,
        sessionId: SESSION_A,
      });
      await claimIdentity({ channelId: id, sessionId: SESSION_A });
    }
    const result = getIdentityContextForSession(SESSION_A);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.channelId).sort()).toEqual([
      "c-multi-1",
      "c-multi-2",
      "c-multi-3",
    ]);
    for (const ctx of result) {
      expect(ctx.self.identity).toBe("Alpha");
    }
  });

  it("excludes archived channels", async () => {
    await createChannel({
      channelId: "c-live",
      handoffId: "c-live",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-live", sessionId: SESSION_A });
    await createChannel({
      channelId: "c-archived",
      handoffId: "c-archived",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-archived", sessionId: SESSION_A });
    archiveChannel("c-archived");

    const result = getIdentityContextForSession(SESSION_A);
    expect(result).toHaveLength(1);
    expect(result[0]?.channelId).toBe("c-live");
  });

  it("populates peer roster (self filtered) with heartbeat mtimes", async () => {
    await createChannel({
      channelId: "c-peers",
      handoffId: "c-peers",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-peers", sessionId: SESSION_A });
    await claimIdentity({ channelId: "c-peers", sessionId: SESSION_B });
    await claimIdentity({ channelId: "c-peers", sessionId: SESSION_C });

    touchHeartbeat("c-peers", SESSION_B);

    const result = getIdentityContextForSession(SESSION_A);
    expect(result).toHaveLength(1);
    const ctx = result[0];
    if (!ctx) throw new Error("expected context");
    expect(ctx.self.identity).toBe("Alpha");
    expect(ctx.peers).toHaveLength(2);

    const sessionB = ctx.peers.find((p) => p.session_id === SESSION_B);
    const sessionC = ctx.peers.find((p) => p.session_id === SESSION_C);
    expect(sessionB).toBeDefined();
    expect(sessionC).toBeDefined();
    expect(sessionB?.identity).toBe("Bravo");
    expect(sessionC?.identity).toBe("Charlie");
    expect(sessionB?.heartbeat_mtime_ms).not.toBeNull();
    expect(ctx.peers.find((p) => p.session_id === SESSION_A)).toBeUndefined();
  });

  it("filters identities entries with invalid NATO letters", async () => {
    await createChannel({
      channelId: "c-invalid",
      handoffId: "c-invalid",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-invalid", sessionId: SESSION_A });

    const metaPath = join(SANDBOX, "c-invalid", "metadata.json");
    const meta = JSON.parse(
      (await Bun.file(metaPath).text()) || "{}",
    ) as Record<string, unknown>;
    const identities = (meta["identities"] ?? {}) as Record<string, unknown>;
    identities["NotAletter"] = {
      session_id: "sess-invalid",
      role: "queue",
      joined_at: new Date().toISOString(),
    };
    meta["identities"] = identities;
    writeFileSync(metaPath, JSON.stringify(meta), "utf-8");

    const result = getIdentityContextForSession(SESSION_A);
    expect(result).toHaveLength(1);
    expect(result[0]?.peers).toEqual([]);
    expect(result[0]?.self.identity).toBe("Alpha");
  });

  it("skips channels with corrupt metadata without throwing", async () => {
    await createChannel({
      channelId: "c-good",
      handoffId: "c-good",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-good", sessionId: SESSION_A });
    await createChannel({
      channelId: "c-corrupt",
      handoffId: "c-corrupt",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-corrupt", sessionId: SESSION_A });

    writeFileSync(
      join(SANDBOX, "c-corrupt", "metadata.json"),
      "{ not json",
      "utf-8",
    );

    const result = getIdentityContextForSession(SESSION_A);
    expect(result).toHaveLength(1);
    expect(result[0]?.channelId).toBe("c-good");
  });

  it("returns separate contexts for two different sessions on same channel", async () => {
    await createChannel({
      channelId: "c-shared",
      handoffId: "c-shared",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-shared", sessionId: SESSION_A });
    await claimIdentity({ channelId: "c-shared", sessionId: SESSION_B });

    const aResult = getIdentityContextForSession(SESSION_A);
    const bResult = getIdentityContextForSession(SESSION_B);

    expect(aResult).toHaveLength(1);
    expect(bResult).toHaveLength(1);
    expect(aResult[0]?.self.identity).toBe("Alpha");
    expect(bResult[0]?.self.identity).toBe("Bravo");
    expect(aResult[0]?.peers[0]?.identity).toBe("Bravo");
    expect(bResult[0]?.peers[0]?.identity).toBe("Alpha");
  });
});

describe("isPeerCoordinatedWithSelf", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns coordinated=true when both sessions are participants in same channel", async () => {
    await createChannel({
      channelId: "c-coord",
      handoffId: "c-coord",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-coord", sessionId: SESSION_A });
    await claimIdentity({ channelId: "c-coord", sessionId: SESSION_B });

    const result = isPeerCoordinatedWithSelf(SESSION_A, SESSION_B);
    expect(result.coordinated).toBe(true);
    expect(result.channelIds).toEqual(["c-coord"]);
  });

  it("returns coordinated=false when peer not in any of self's claimed channels", async () => {
    await createChannel({
      channelId: "c-solo",
      handoffId: "c-solo",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-solo", sessionId: SESSION_A });

    const result = isPeerCoordinatedWithSelf(SESSION_A, SESSION_B);
    expect(result.coordinated).toBe(false);
    expect(result.channelIds).toEqual([]);
  });

  it("returns coordinated=false when self has no claimed channels", () => {
    const result = isPeerCoordinatedWithSelf(SESSION_A, SESSION_B);
    expect(result.coordinated).toBe(false);
    expect(result.channelIds).toEqual([]);
  });

  it("returns coordinated=true via ANY shared channel (multi-channel case)", async () => {
    // Alpha + Bravo on channel-a (shared coordination)
    await createChannel({
      channelId: "c-multi-a",
      handoffId: "c-multi-a",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-multi-a", sessionId: SESSION_A });
    await claimIdentity({ channelId: "c-multi-a", sessionId: SESSION_B });

    // Alpha + Charlie on channel-b (Bravo NOT on this channel)
    await createChannel({
      channelId: "c-multi-b",
      handoffId: "c-multi-b",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-multi-b", sessionId: SESSION_A });
    await claimIdentity({ channelId: "c-multi-b", sessionId: SESSION_C });

    const ab = isPeerCoordinatedWithSelf(SESSION_A, SESSION_B);
    expect(ab.coordinated).toBe(true);
    expect(ab.channelIds).toEqual(["c-multi-a"]);

    const ac = isPeerCoordinatedWithSelf(SESSION_A, SESSION_C);
    expect(ac.coordinated).toBe(true);
    expect(ac.channelIds).toEqual(["c-multi-b"]);
  });

  it("returns coordinated=true with multiple channelIds when peer is on multiple shared channels", async () => {
    for (const id of ["c-shared-1", "c-shared-2"]) {
      await createChannel({
        channelId: id,
        handoffId: id,
        sessionId: SESSION_A,
      });
      await claimIdentity({ channelId: id, sessionId: SESSION_A });
      await claimIdentity({ channelId: id, sessionId: SESSION_B });
    }

    const result = isPeerCoordinatedWithSelf(SESSION_A, SESSION_B);
    expect(result.coordinated).toBe(true);
    expect(result.channelIds.length).toBe(2);
    expect([...result.channelIds].sort()).toEqual(["c-shared-1", "c-shared-2"]);
  });

  it("returns coordinated=false for empty session ids (defensive)", () => {
    expect(isPeerCoordinatedWithSelf("", SESSION_B)).toEqual({
      coordinated: false,
      channelIds: [],
    });
    expect(isPeerCoordinatedWithSelf(SESSION_A, "")).toEqual({
      coordinated: false,
      channelIds: [],
    });
  });

  it("regression: zero fs writes during call (read-only invariant)", async () => {
    await createChannel({
      channelId: "c-ro",
      handoffId: "c-ro",
      sessionId: SESSION_A,
    });
    await claimIdentity({ channelId: "c-ro", sessionId: SESSION_A });
    await claimIdentity({ channelId: "c-ro", sessionId: SESSION_B });

    // Snapshot mtimes of all files in sandbox before call.
    const before = collectMtimes(SANDBOX);

    // Call twice to be thorough.
    isPeerCoordinatedWithSelf(SESSION_A, SESSION_B);
    isPeerCoordinatedWithSelf(SESSION_A, SESSION_B);

    const after = collectMtimes(SANDBOX);
    expect(after).toEqual(before);
  });
});

/**
 * Collect mtime-ms for every file under `root`, keyed by relative path. Used
 * by the read-only invariant test to detect any fs-write side effect.
 */
function collectMtimes(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  walk(root, root, out);
  return out;
}

function walk(root: string, dir: string, out: Record<string, number>): void {
  // Lazy walker; safe for the tiny sandbox dirs used in this test suite.
  const fs = require("node:fs") as typeof import("node:fs");
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (ent.isFile()) {
      const rel = full.slice(root.length + 1);
      out[rel] = statSync(full).mtimeMs;
    }
  }
}

describe("sortIdentityContextsByChannelId — deterministic channel order (readdir-flake fix)", () => {
  const mkCtx = (channelId: string): IdentityContext => ({
    channelId,
    self: {
      identity: "Alpha",
      role: "pen",
      joined_at: "2026-06-11T00:00:00.000Z",
    },
    peers: [],
  });

  it("reorders an arbitrary (readdir-order) input to channelId code-unit ASC — the cap-distribution determinism guarantee", () => {
    // listChannels() returns readdirSync order (ext4 hash-order on Linux,
    // sorted on APFS/macOS), so the deliverer's shared 50-message cap went to a
    // filesystem-dependent channel — green locally, flaky on Linux CI (the
    // "aggregate 50-cap" flake, 2026-06-11). A non-sorted input must still yield
    // a deterministic channelId-asc processing order. (Self-non-vacuous: revert
    // the sort in sortIdentityContextsByChannelId and this assertion fails.)
    const input = [
      mkCtx("test-ch-pmd-2"),
      mkCtx("zzz-last"),
      mkCtx("test-ch-pmd"),
      mkCtx("aaa-first"),
    ];
    const out = sortIdentityContextsByChannelId(input).map((c) => c.channelId);
    expect(out).toEqual([
      "aaa-first",
      "test-ch-pmd",
      "test-ch-pmd-2",
      "zzz-last",
    ]);
  });

  it("is pure — does not mutate the input array", () => {
    const input = [mkCtx("b"), mkCtx("a")];
    const before = input.map((c) => c.channelId);
    sortIdentityContextsByChannelId(input);
    expect(input.map((c) => c.channelId)).toEqual(before);
  });
});
