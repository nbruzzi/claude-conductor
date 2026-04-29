// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  closeStalePeerIdentity,
  createChannel,
  readMetadata,
  removeIdentityClaim,
  setIdentityRole,
  touchHeartbeat,
} from "../../src/channels/index.ts";
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
  unlinkIdentitySentinelOrLogOrphan,
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

    it("reconcile-on-rejoin: torn write (sentinel exists, metadata empty) heals on next claim — Wave 2 RE-W2-7 + Decision D", async () => {
      await createChannel({
        channelId: "c-torn",
        handoffId: "c-torn",
        sessionId: SESSION,
      });
      const initial = await claimIdentity({
        channelId: "c-torn",
        sessionId: SESSION,
      });
      expect(initial.identity).toBe("Alpha");

      const metaPath = join(SANDBOX, "c-torn", "metadata.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      expect(meta.identities?.["Alpha"]).toBeDefined();
      meta.identities = {};
      writeFileSync(metaPath, JSON.stringify(meta), "utf-8");

      const sentinelPath = join(SANDBOX, "c-torn", "identities", "Alpha");
      expect(existsSync(sentinelPath)).toBe(true);

      const reclaim = await claimIdentity({
        channelId: "c-torn",
        sessionId: SESSION,
      });
      expect(reclaim.identity).toBe("Alpha");
      expect(reclaim.is_new_participant).toBe(false);
      expect(reclaim.session_id).toBe(SESSION);

      const reconciled = JSON.parse(readFileSync(metaPath, "utf-8"));
      expect(reconciled.identities?.["Alpha"]).toBeDefined();
      expect(reconciled.identities["Alpha"].session_id).toBe(SESSION);
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

  // ─── Phase 2 Slice 3 — UnlinkResult discriminated return (RE-W2-4) ───
  //
  // unlinkIdentitySentinelOrLogOrphan returns a discriminated union per
  // plan prismatic-orbiting-mesh §Slice 3 so callers (close-peer CLI verb)
  // can surface orphan-sentinel state in structured output without
  // re-executing the unlink. These tests cover all 4 return discriminants.

  describe("Phase 2 Slice 3 — unlinkIdentitySentinelOrLogOrphan discriminated return (RE-W2-4)", () => {
    it("ok: true on successful unlink (happy path)", async () => {
      await createChannel({
        channelId: "c-unlink-ok",
        handoffId: "c-unlink-ok",
        sessionId: SESSION,
      });
      const claim = await claimIdentity({
        channelId: "c-unlink-ok",
        sessionId: SESSION,
      });
      // Direct call (releaseIdentity does the metadata removal first;
      // here we exercise the unlink helper standalone after that).
      const releasedClaim = {
        session_id: SESSION,
        role: claim.role,
        joined_at: claim.joined_at,
      };
      const result = unlinkIdentitySentinelOrLogOrphan(
        "c-unlink-ok",
        "Alpha",
        releasedClaim,
      );
      expect(result.ok).toBe(true);
      // Sentinel gone post-unlink.
      const sentinelPath = join(SANDBOX, "c-unlink-ok", "identities", "Alpha");
      expect(existsSync(sentinelPath)).toBe(false);
    });

    it("ok: false, code: 'ENOENT' when sentinel was already absent (race-cleared)", async () => {
      // Setup: claim then directly remove the sentinel out-of-band so the
      // unlink helper hits ENOENT. Simulates the race where another
      // reconciler beat us to the unlink.
      await createChannel({
        channelId: "c-unlink-enoent",
        handoffId: "c-unlink-enoent",
        sessionId: SESSION,
      });
      const claim = await claimIdentity({
        channelId: "c-unlink-enoent",
        sessionId: SESSION,
      });
      // Out-of-band sentinel removal.
      const sentinelPath = join(
        SANDBOX,
        "c-unlink-enoent",
        "identities",
        "Alpha",
      );
      rmSync(sentinelPath, { force: true });

      const releasedClaim = {
        session_id: SESSION,
        role: claim.role,
        joined_at: claim.joined_at,
      };
      const result = unlinkIdentitySentinelOrLogOrphan(
        "c-unlink-enoent",
        "Alpha",
        releasedClaim,
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe("ENOENT");
        expect(typeof result.detail).toBe("string");
      }
    });

    it("ok: false, code: 'EACCES' when unlink throws EACCES (true orphan)", async () => {
      await createChannel({
        channelId: "c-unlink-eacces",
        handoffId: "c-unlink-eacces",
        sessionId: SESSION,
      });
      const claim = await claimIdentity({
        channelId: "c-unlink-eacces",
        sessionId: SESSION,
      });

      const originalUnlink = INTERNAL.unlinkSentinel;
      INTERNAL.unlinkSentinel = (_path: string) => {
        throw Object.assign(new Error("simulated EACCES on unlink"), {
          code: "EACCES",
        });
      };
      try {
        const releasedClaim = {
          session_id: SESSION,
          role: claim.role,
          joined_at: claim.joined_at,
        };
        const result = unlinkIdentitySentinelOrLogOrphan(
          "c-unlink-eacces",
          "Alpha",
          releasedClaim,
        );
        expect(result.ok).toBe(false);
        if (result.ok === false) {
          expect(result.code).toBe("EACCES");
          expect(result.detail).toContain("simulated EACCES");
        }
      } finally {
        INTERNAL.unlinkSentinel = originalUnlink;
      }
    });

    it("ok: false, code: 'OTHER' when unlink throws an unrecognized errno", async () => {
      await createChannel({
        channelId: "c-unlink-other",
        handoffId: "c-unlink-other",
        sessionId: SESSION,
      });
      const claim = await claimIdentity({
        channelId: "c-unlink-other",
        sessionId: SESSION,
      });

      const originalUnlink = INTERNAL.unlinkSentinel;
      INTERNAL.unlinkSentinel = (_path: string) => {
        throw Object.assign(new Error("unrecognized errno"), {
          code: "ENOTRECOVERABLE",
        });
      };
      try {
        const releasedClaim = {
          session_id: SESSION,
          role: claim.role,
          joined_at: claim.joined_at,
        };
        const result = unlinkIdentitySentinelOrLogOrphan(
          "c-unlink-other",
          "Alpha",
          releasedClaim,
        );
        expect(result.ok).toBe(false);
        if (result.ok === false) {
          expect(result.code).toBe("OTHER");
          expect(result.detail).toContain("unrecognized errno");
        }
      } finally {
        INTERNAL.unlinkSentinel = originalUnlink;
      }
    });
  });

  // ─── Slice 7 joint-piece — primitive boundary + closeStalePeerIdentity ───
  //
  // These 6 tests extend the Slice 5 functional coverage with boundary
  // inputs + the close-peer atomic primitive that wasn't unit-tested at
  // Slice 5 (only exercised via the cli verb subprocess test). Mirrors
  // the vault-commit pattern: per-primitive boundary + per-discriminated-
  // return-shape coverage so future refactors of the primitive are
  // detected at the unit layer rather than only at integration.

  describe("Slice 7 — primitive boundaries + closeStalePeerIdentity", () => {
    it("claimIdentity rejects path-traversal channelId at the boundary gate", async () => {
      // isValidArtifactId boundary at claimIdentity entry (Wave 1 RE-W1-2).
      // Without this gate `../etc` would escape channels root via the
      // identitiesDir join + write a sentinel under the parent path.
      await expect(
        claimIdentity({
          channelId: "../etc",
          sessionId: "boundary-test",
        }),
      ).rejects.toThrow(/invalid channelId/u);
    });

    it("setRole rejects invalid role string before reaching withMetadataLock", async () => {
      // Defense-in-depth: invalid role values are caught BEFORE the lock
      // acquisition + metadata read so a malformed CLI input doesn't
      // pollute lock contention metrics or block other callers.
      await createChannel({
        channelId: "c-setrole-bad",
        handoffId: "c-setrole-bad",
        sessionId: SESSION,
      });
      await claimIdentity({
        channelId: "c-setrole-bad",
        sessionId: SESSION,
      });
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setRole("c-setrole-bad", "Alpha", "invalid-role" as any),
      ).rejects.toThrow(/invalid role/u);
    });

    it("removeIdentityClaim returns the removed claim on success (not just null)", async () => {
      // Discriminated return shape: removed → claim object; absent → null.
      // Slice 5 callers (releaseIdentity) attribute orphan-sentinel logs
      // to the removed claim's session_id, which depends on this return.
      await createChannel({
        channelId: "c-rmclaim-1",
        handoffId: "c-rmclaim-1",
        sessionId: SESSION,
      });
      await claimIdentity({ channelId: "c-rmclaim-1", sessionId: SESSION });

      const removed = await removeIdentityClaim({
        channelId: "c-rmclaim-1",
        identity: "Alpha",
      });
      expect(removed).not.toBeNull();
      expect(removed?.session_id).toBe(SESSION);
      expect(removed?.role).toBe("queue");

      // Idempotent re-call returns null (already absent).
      const removedAgain = await removeIdentityClaim({
        channelId: "c-rmclaim-1",
        identity: "Alpha",
      });
      expect(removedAgain).toBeNull();
    });

    it("closeStalePeerIdentity: not-held when peer never claimed", async () => {
      await createChannel({
        channelId: "c-csp-1",
        handoffId: "c-csp-1",
        sessionId: SESSION,
      });
      const result = await closeStalePeerIdentity({
        channelId: "c-csp-1",
        identity: "Alpha",
        staleThresholdMs: 60_000,
        force: false,
      });
      expect(result.kind).toBe("not-held");
    });

    it("closeStalePeerIdentity: still-active with fresh heartbeat + force=false", async () => {
      // Peer claimed AND just heartbeated. Without --force the gate
      // refuses to close (RE-6 — operator must explicitly override
      // for active peers).
      await createChannel({
        channelId: "c-csp-active",
        handoffId: "c-csp-active",
        sessionId: SESSION,
      });
      const peerSession = "peer-active-session";
      await claimIdentity({
        channelId: "c-csp-active",
        sessionId: peerSession,
      });
      // Fresh heartbeat — way under the 60s threshold.
      touchHeartbeat("c-csp-active", peerSession);

      const result = await closeStalePeerIdentity({
        channelId: "c-csp-active",
        identity: "Alpha",
        staleThresholdMs: 60_000,
        force: false,
      });
      expect(result.kind).toBe("still-active");
      if (result.kind === "still-active") {
        // Fresh heartbeat: ageMs is small + non-null.
        expect(result.ageMs).not.toBeNull();
        expect(result.ageMs ?? Infinity).toBeLessThan(60_000);
      }
    });

    it("closeStalePeerIdentity: released when peer never heartbeated (peerMtime null → stale)", async () => {
      // Most-conservative branch: peer claimed but never touched
      // heartbeat. closeStalePeerIdentity treats peerMtime=null as
      // stale (presumed dead) so close-peer succeeds without --force.
      await createChannel({
        channelId: "c-csp-stale",
        handoffId: "c-csp-stale",
        sessionId: SESSION,
      });
      const peerSession = "peer-never-heartbeated";
      await claimIdentity({
        channelId: "c-csp-stale",
        sessionId: peerSession,
      });
      // No touchHeartbeat call — peerMtime is null.

      const result = await closeStalePeerIdentity({
        channelId: "c-csp-stale",
        identity: "Alpha",
        staleThresholdMs: 60_000,
        force: false,
      });
      expect(result.kind).toBe("released");
      if (result.kind === "released") {
        expect(result.releasedClaim.session_id).toBe(peerSession);
      }

      // Direct setIdentityRole on now-released identity returns
      // not-held (downstream of closeStalePeerIdentity). This pins the
      // discriminated return shape that Slice 5's setRole wrapper
      // depends on for the IdentityNotHeldError mapping.
      const setResult = await setIdentityRole({
        channelId: "c-csp-stale",
        identity: "Alpha",
        role: "pen",
      });
      expect(setResult.kind).toBe("not-held");
    });
  });
});
