// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createChannel, readMetadata } from "../../src/channels/index.ts";
import {
  claimIdentity,
  getIdentityForSession,
  IdentityNotHeldError,
  INTERNAL,
  isValidIdentity,
  NATO_POOL,
  NatoExhaustedError,
  releaseIdentity,
  setRole,
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

  describe("getIdentityForSession", () => {
    it("returns the claim for a session that has joined", async () => {
      await createChannel({
        channelId: "c-get-1",
        handoffId: "c-get-1",
        sessionId: SESSION,
      });
      await claimIdentity({ channelId: "c-get-1", sessionId: SESSION });
      const claim = await getIdentityForSession("c-get-1", SESSION);
      expect(claim).not.toBeNull();
      expect(claim?.identity).toBe("Alpha");
      expect(claim?.role).toBe("queue");
      expect(claim?.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    });

    it("returns null for a session with no claim on the channel", async () => {
      await createChannel({
        channelId: "c-get-2",
        handoffId: "c-get-2",
        sessionId: SESSION,
      });
      const claim = await getIdentityForSession(
        "c-get-2",
        "unknown-session-no-claim",
      );
      expect(claim).toBeNull();
    });
  });

  describe("setRole", () => {
    it("updates the role of a held identity", async () => {
      await createChannel({
        channelId: "c-setrole-1",
        handoffId: "c-setrole-1",
        sessionId: SESSION,
      });
      await claimIdentity({ channelId: "c-setrole-1", sessionId: SESSION });
      await setRole("c-setrole-1", "Alpha", "pen");
      const updated = await getIdentityForSession("c-setrole-1", SESSION);
      expect(updated?.role).toBe("pen");
    });

    it("RE-6: throws IdentityNotHeldError for an unclaimed identity", async () => {
      await createChannel({
        channelId: "c-setrole-2",
        handoffId: "c-setrole-2",
        sessionId: SESSION,
      });
      // No claim — Alpha is unclaimed. set-role MUST surface as
      // IdentityNotHeldError (CLI maps to exit 5) — silent no-op is the
      // failure mode the gate prevents.
      await expect(setRole("c-setrole-2", "Alpha", "pen")).rejects.toThrow(
        IdentityNotHeldError,
      );
    });
  });

  describe("releaseIdentity", () => {
    it("removes metadata + unlinks the sentinel (happy path)", async () => {
      await createChannel({
        channelId: "c-rel-1",
        handoffId: "c-rel-1",
        sessionId: SESSION,
      });
      await claimIdentity({ channelId: "c-rel-1", sessionId: SESSION });
      await releaseIdentity("c-rel-1", "Alpha");

      // Metadata: identities['Alpha'] gone.
      const meta = readMetadata("c-rel-1");
      expect(meta.identities?.["Alpha"]).toBeUndefined();

      // Sentinel: file gone.
      const sentinelPath = join(SANDBOX, "c-rel-1", "identities", "Alpha");
      expect(existsSync(sentinelPath)).toBe(false);
    });

    it("idempotent on absent identity (no error)", async () => {
      await createChannel({
        channelId: "c-rel-2",
        handoffId: "c-rel-2",
        sessionId: SESSION,
      });
      // Never claim anything; release should be a no-op (matches
      // close-peer flow where peer may have already self-released
      // between operator's intent and verb invocation).
      await expect(
        releaseIdentity("c-rel-2", "Alpha"),
      ).resolves.toBeUndefined();
    });

    it("RE-6 ordering: metadata is removed even when sentinel unlink fails", async () => {
      await createChannel({
        channelId: "c-rel-3",
        handoffId: "c-rel-3",
        sessionId: SESSION,
      });
      await claimIdentity({ channelId: "c-rel-3", sessionId: SESSION });

      const originalUnlink = INTERNAL.unlinkSentinel;
      let unlinkCallCount = 0;
      INTERNAL.unlinkSentinel = (_path: string) => {
        unlinkCallCount++;
        throw Object.assign(new Error("simulated EACCES on unlink"), {
          code: "EACCES",
        });
      };
      try {
        // releaseIdentity must NOT throw — orphan sentinel is logged
        // via appendPresenceFailure but the metadata removal already
        // succeeded so the caller sees a clean release.
        await expect(
          releaseIdentity("c-rel-3", "Alpha"),
        ).resolves.toBeUndefined();
      } finally {
        INTERNAL.unlinkSentinel = originalUnlink;
      }

      expect(unlinkCallCount).toBe(1);

      // Metadata: identities['Alpha'] gone (RE-6 ordering: metadata-
      // first guarantees the removal happened BEFORE the unlink attempt).
      const meta = readMetadata("c-rel-3");
      expect(meta.identities?.["Alpha"]).toBeUndefined();

      // Sentinel: still present (the mocked unlink threw). Reconcilable
      // on next claimIdentity for this letter (Slice 2.2 Decision D).
      const sentinelPath = join(SANDBOX, "c-rel-3", "identities", "Alpha");
      expect(existsSync(sentinelPath)).toBe(true);
    });
  });
});
