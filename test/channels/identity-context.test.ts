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

import {
  archiveChannel,
  createChannel,
  touchHeartbeat,
} from "../../src/channels/index.ts";
import { claimIdentity } from "../../src/channels/identity.ts";
import { getIdentityContextForSession } from "../../src/channels/identity-context.ts";

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
