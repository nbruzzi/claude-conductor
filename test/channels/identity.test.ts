// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { createChannel } from "../../src/channels/index.ts";
import {
  claimIdentity,
  isValidIdentity,
  NATO_POOL,
  NatoExhaustedError,
} from "../../src/channels/identity.ts";

const SANDBOX = `/tmp/test-identity-${process.pid}`;
const SESSION = "sess-identity-test";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

describe("identity", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  describe("NATO_POOL + isValidIdentity", () => {
    it("contains 26 letters Alpha through Zulu", async () => {
      expect(NATO_POOL).toHaveLength(26);
      expect(NATO_POOL[0]).toBe("Alpha");
      expect(NATO_POOL[1]).toBe("Bravo");
      expect(NATO_POOL[25]).toBe("Zulu");
    });

    it("isValidIdentity accepts NATO members and rejects non-members", async () => {
      expect(isValidIdentity("Alpha")).toBe(true);
      expect(isValidIdentity("Zulu")).toBe(true);
      expect(isValidIdentity("alpha")).toBe(false);
      expect(isValidIdentity("Foo")).toBe(false);
      expect(isValidIdentity("")).toBe(false);
      expect(isValidIdentity(null)).toBe(false);
      expect(isValidIdentity(42)).toBe(false);
    });
  });

  describe("claimIdentity (smoke)", () => {
    it("happy path: first claimant gets Alpha with default role queue", async () => {
      await createChannel({
        channelId: "c-claim-1",
        handoffId: "c-claim-1",
        sessionId: SESSION,
      });
      const result = await claimIdentity({
        channelId: "c-claim-1",
        sessionId: SESSION,
      });
      expect(result.identity).toBe("Alpha");
      expect(result.role).toBe("queue");
      expect(result.session_id).toBe(SESSION);
      expect(result.is_new_participant).toBe(true);
      expect(result.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    });

    it("idempotent rejoin: same session re-claiming returns existing identity", async () => {
      await createChannel({
        channelId: "c-claim-2",
        handoffId: "c-claim-2",
        sessionId: SESSION,
      });
      const first = await claimIdentity({
        channelId: "c-claim-2",
        sessionId: SESSION,
      });
      const second = await claimIdentity({
        channelId: "c-claim-2",
        sessionId: SESSION,
      });
      expect(second.identity).toBe(first.identity);
      expect(second.role).toBe(first.role);
      expect(second.joined_at).toBe(first.joined_at);
      expect(second.is_new_participant).toBe(false);
    });

    it("two different sessions get distinct letters (Alpha + Bravo)", async () => {
      await createChannel({
        channelId: "c-claim-3",
        handoffId: "c-claim-3",
        sessionId: "sess-a",
      });
      const a = await claimIdentity({
        channelId: "c-claim-3",
        sessionId: "sess-a",
      });
      const b = await claimIdentity({
        channelId: "c-claim-3",
        sessionId: "sess-b",
      });
      expect(a.identity).toBe("Alpha");
      expect(b.identity).toBe("Bravo");
      expect(a.session_id).not.toBe(b.session_id);
    });

    it("exhausts at 27th claim with NatoExhaustedError", async () => {
      await createChannel({
        channelId: "c-exhaust",
        handoffId: "c-exhaust",
        sessionId: "sess-0",
      });
      // Claim all 26 letters with 26 distinct sessions.
      for (let i = 0; i < 26; i++) {
        const result = await claimIdentity({
          channelId: "c-exhaust",
          sessionId: `sess-${i}`,
        });
        const expected = NATO_POOL[i];
        if (expected === undefined) throw new Error(`unreachable: i=${i}`);
        expect(result.identity).toBe(expected);
      }
      // 27th attempt should throw.
      await expect(
        claimIdentity({ channelId: "c-exhaust", sessionId: "sess-27" }),
      ).rejects.toThrow(NatoExhaustedError);
    });

    it("respects defaultRole arg", async () => {
      await createChannel({
        channelId: "c-role",
        handoffId: "c-role",
        sessionId: SESSION,
      });
      const result = await claimIdentity({
        channelId: "c-role",
        sessionId: SESSION,
        defaultRole: "pen",
      });
      expect(result.role).toBe("pen");
    });
  });
});
