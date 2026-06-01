// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 3 — identity-reclaim invariant + tests (validates the S1 reclaim
 * reaper for the fixed-eternal coordination channel).
 *
 * Plan: ~/.claude/plans-durable/channel-coordination-fixed-eternal-design-
 * 2026-05-31.md — Slice 3 + the AUTHORITATIVE "Build-kickoff addendum
 * (2026-06-01)".
 *
 * WHAT THIS GUARDS. The eternal `coordination` channel is exempt from the
 * channel-gc whole-channel archival that used to implicitly recycle the
 * 26-letter NATO pool every cycle. The reclaim reaper (Charlie, S1,
 * `src/channels/reclaim.ts` `reclaimStaleIdentities`) REPLACES that
 * recycling: it frees identity claims whose heartbeat is stale beyond the
 * liveness window (24h) so the pool never exhausts under real come-and-go
 * cadence (4-8 concurrent x many cycles). The exemption and the reaper are
 * COUPLED — neither ships without the other — and the split-detector test
 * below is the executable proof of that coupling.
 *
 * REAPER-UNDER-TEST. These tests run against Charlie's real S1 reaper
 * `reclaimStaleIdentities` (src/channels/reclaim.ts, curated via
 * claude-conductor/channels/api). Every assertion is about END-STATE (pool
 * drained, slot reclaimable, no key-revoke emitted, zero pool pressure from a
 * bump), independent of the reaper's internals. The suite was authored +
 * detector-validated against a faithful local model first (a metadata-only
 * reaper that skips the sentinel-unlink fails the invariant tests), then
 * swapped to the real fn — that swap is the Slice 3 validation gate.
 *
 * STALENESS IS SIMULATED BY BACKDATING THE HEARTBEAT MTIME, not by
 * withholding a heartbeat. `createChannel` writes a fresh heartbeat for the
 * CREATING session as a side-effect (index.ts:916), so "never heartbeated"
 * reads null only for a peer DISTINCT from the creator. `utimesSync`-
 * backdating the heartbeat file is the deterministic, creator-independent
 * staleness signal and exercises the real age>threshold comparison (not just
 * the null-presumed-dead branch, which is covered separately).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendMessage,
  createChannel,
  readMessages,
  readMetadata,
  touchHeartbeat,
} from "../../src/channels/index.ts";
import {
  claimIdentity,
  identitySentinelPath,
  listClaims,
  NATO_POOL,
  NatoExhaustedError,
} from "../../src/channels/identity.ts";
import { getWallClockNow } from "../../src/shared/clock.ts";
import {
  reclaimStaleIdentities,
  type ReclaimResult,
} from "../../src/channels/api.ts";

// ─── Reaper-under-test ───────────────────────────────────────────────────
//
// Wired to Charlie's real S1 reaper `reclaimStaleIdentities` (canonical
// src/channels/reclaim.ts, curated via claude-conductor/channels/api).
// `ReclaimResult` is imported from that same curated surface, so a future
// change to Charlie's result shape breaks these tests at compile time (no
// silent type drift — per the Test-Architect provenance note). `ReclaimFn`
// documents the contract the assertions rely on; `reclaimStaleIdentities`
// is structurally assignable to it.
type ReclaimFn = (args: {
  channelId: string;
  staleThresholdMs: number;
}) => Promise<ReclaimResult>;

const reaperUnderTest: ReclaimFn = reclaimStaleIdentities;

// ─── Harness ─────────────────────────────────────────────────────────────

let tmpRoot: string;
/** The per-test channels root (CLAUDE_CONDUCTOR_CHANNELS_DIR) — a fresh
 *  mkdtemp dir each test, matching the api.test.ts sibling convention. Avoids
 *  the hardcoded-/tmp macOS-symlink (/tmp→/private/tmp) CI-vs-local divergence
 *  class and uses atomic mkdtemp uniqueness over process.pid. */
let sandboxDir: string;
let prevChannelsDir: string | undefined;
/** Channel creator — DISTINCT from every peer session so its setup-time
 *  heartbeat (createChannel side-effect, index.ts:916) never masks a peer's
 *  staleness. */
const CREATOR = "sess-reclaim-creator";

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Reaper liveness window = 24h: Charlie's reaper threshold (the ONLINE_WINDOW
 *  dead-edge; the same 24h at which channel-gc archives). Deliberately NOT the
 *  60s manual close-peer gate, which false-positives on heartbeat-lagged live
 *  sessions — the live dogfood signal of 2026-06-01 (heads-down builders
 *  flagged at 5-9min lag). */
const WINDOW_MS = 24 * HOUR_MS;

function sandbox(): void {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-reclaim-test-"));
  sandboxDir = join(tmpRoot, "channels");
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  mkdirSync(sandboxDir, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = sandboxDir;
}

function cleanup(): void {
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}

/** Heartbeat file path — reconstructs the substrate layout (`heartbeats/`
 *  subdir, index.ts:534 + the Step G dual-read note at index.ts:1804),
 *  mirroring how identity.test.ts reconstructs sentinel paths under the
 *  channels dir. */
function heartbeatFile(channelId: string, sessionId: string): string {
  return join(sandboxDir, channelId, "heartbeats", sessionId);
}

/** Backdate a peer's heartbeat `ageMs` into the past so it reads stale w/r/t
 *  any reaper threshold < ageMs. `heartbeatMtime` reads `mtimeMs`, so the
 *  utimesSync backdate is the deterministic, creator-independent staleness
 *  signal. */
function ageHeartbeat(
  channelId: string,
  sessionId: string,
  ageMs: number,
): void {
  touchHeartbeat(channelId, sessionId);
  const pastSec = (getWallClockNow() - ageMs) / 1000;
  utimesSync(heartbeatFile(channelId, sessionId), pastSec, pastSec);
}

async function freshChannel(channelId: string): Promise<void> {
  await createChannel({ channelId, handoffId: channelId, sessionId: CREATOR });
}

/** True if a file can still be created inside `dir` despite its perms (e.g. a
 *  root CI runner ignoring `0o500`). Lets the EACCES stuck test skip rather
 *  than false-pass where the filesystem won't enforce the denial. */
function dirIsWritable(dir: string): boolean {
  const probe = join(dir, ".write-probe");
  try {
    writeFileSync(probe, "x");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("identity-reclaim invariant (Slice 3 — validates the reclaim reaper)", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  describe("stale claim freed after the liveness window", () => {
    it("reclaims a >24h-silent claim, spares a fresh one, and frees the slot for reuse", async () => {
      const CH = "c-window";
      await freshChannel(CH);
      // dead-peer claims Alpha (first claim), then its heartbeat ages past 24h.
      const dead = await claimIdentity({
        channelId: CH,
        sessionId: "dead-peer",
      });
      expect(dead.identity).toBe("Alpha");
      ageHeartbeat(CH, "dead-peer", 25 * HOUR_MS);
      // live-peer claims Bravo and stays fresh.
      const live = await claimIdentity({
        channelId: CH,
        sessionId: "live-peer",
      });
      expect(live.identity).toBe("Bravo");
      touchHeartbeat(CH, "live-peer");

      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });

      expect(res.reclaimed).toEqual(["Alpha"]);
      expect(res.skippedActive).toEqual(["Bravo"]);
      expect(res.stuck).toEqual([]);

      // Pool slot freed: BOTH the sentinel and the metadata entry are gone.
      // (Metadata-only removal would leave an orphan sentinel that blocks
      // reclaim — this is the two-call assertion.)
      expect(existsSync(identitySentinelPath(CH, "Alpha"))).toBe(false);
      expect(readMetadata(CH).identities?.["Alpha"]).toBeUndefined();
      // The live peer is untouched.
      expect(existsSync(identitySentinelPath(CH, "Bravo"))).toBe(true);
      expect(readMetadata(CH).identities?.["Bravo"]?.session_id).toBe(
        "live-peer",
      );

      // The freed slot is reclaimable — a fresh claimant gets Alpha back.
      const next = await claimIdentity({
        channelId: CH,
        sessionId: "new-peer",
      });
      expect(next.identity).toBe("Alpha");
      expect(next.is_new_participant).toBe(true);
      expect(next.session_id).toBe("new-peer");
    });

    it("no-friendly-fire: heartbeat-lag-band claims (min–hours, << 24h) are spared [live dogfood 2026-06-01]", async () => {
      // The teammate-idle hook false-positived heads-down builders at 5-9min
      // heartbeat-lag (Alpha's live signal). The 24h window must clear that
      // band by >150x; only truly-dead (>24h-silent) claims reclaim. Clean
      // exits self-release, so the reaper targets crashed/dead sessions only.
      const CH = "c-lag-band";
      await freshChannel(CH);
      await claimIdentity({ channelId: CH, sessionId: "laggy-builder" }); // Alpha
      ageHeartbeat(CH, "laggy-builder", 9 * MIN_MS); // 9-min lag — heads-down
      await claimIdentity({ channelId: CH, sessionId: "slow-builder" }); // Bravo
      ageHeartbeat(CH, "slow-builder", 23 * HOUR_MS); // 23h — still < 24h window

      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });

      expect(res.reclaimed).toEqual([]);
      expect([...res.skippedActive].sort()).toEqual(["Alpha", "Bravo"]);
      // Both claims survive intact.
      expect(readMetadata(CH).identities?.["Alpha"]?.session_id).toBe(
        "laggy-builder",
      );
      expect(readMetadata(CH).identities?.["Bravo"]?.session_id).toBe(
        "slow-builder",
      );
    });

    it("treats a claimed-but-never-heartbeated peer as presumed-dead and reclaims it", async () => {
      // A session that claimed a letter but never heartbeated (crashed right
      // after the claim) has a null heartbeat mtime — maximally stale under
      // any window. closeStalePeerIdentity treats null as stale, so the
      // reaper reclaims it without --force.
      const CH = "c-null-hb";
      await freshChannel(CH);
      await claimIdentity({ channelId: CH, sessionId: "crashed-after-claim" }); // Alpha
      // No heartbeat for the peer (distinct from CREATOR → mtime stays null).

      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });

      expect(res.reclaimed).toEqual(["Alpha"]);
      expect(existsSync(identitySentinelPath(CH, "Alpha"))).toBe(false);
      expect(readMetadata(CH).identities?.["Alpha"]).toBeUndefined();
    });
  });

  describe("26-letter pool never exhausts under come-and-go", () => {
    it("4–8 sessions churning over many cycles never throws NatoExhaustedError", async () => {
      // 18 persistent live sessions hold slots across every cycle; each cycle
      // a transient wave of 4-8 joins (peaking the pool at 22-26), then dies
      // and is reclaimed. Cumulative distinct claimants reach the hundreds —
      // impossible to satisfy from a 26-slot pool UNLESS the reaper frees the
      // dead slots each cycle. A reaper that forgot the sentinel-unlink would
      // leave orphan sentinels that accumulate and throw NatoExhaustedError
      // within a few cycles. This is the strongest end-to-end guard.
      const CH = "c-come-and-go";
      await freshChannel(CH);

      const PERSISTENT = 18;
      const persistent: string[] = [];
      for (let i = 0; i < PERSISTENT; i++) {
        const s = `persist-${i}`;
        await claimIdentity({ channelId: CH, sessionId: s });
        touchHeartbeat(CH, s);
        persistent.push(s);
      }

      const CYCLES = 30;
      let counter = 0;
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        // Persistent sessions stay alive (refresh their heartbeats).
        for (const s of persistent) touchHeartbeat(CH, s);

        // A transient wave joins (4..8) — must never throw.
        const wave = 4 + (cycle % 5);
        const transients: string[] = [];
        for (let i = 0; i < wave; i++) {
          const s = `peer-${counter++}`;
          await claimIdentity({ channelId: CH, sessionId: s });
          touchHeartbeat(CH, s);
          transients.push(s);
        }
        // Pool peaks at 18 + wave ≤ 26 — never over the cap.
        expect(listClaims(CH).length).toBeLessThanOrEqual(26);
        expect(listClaims(CH).length).toBe(PERSISTENT + wave);

        // The whole transient wave dies.
        for (const s of transients) ageHeartbeat(CH, s, 25 * HOUR_MS);

        // The reaper frees exactly the dead wave; persistent are spared.
        const res = await reaperUnderTest({
          channelId: CH,
          staleThresholdMs: WINDOW_MS,
        });
        expect(res.reclaimed.length).toBe(wave);
        expect(res.skippedActive.length).toBe(PERSISTENT);
        expect(res.stuck).toEqual([]);
        expect(listClaims(CH).length).toBe(PERSISTENT);
      }

      // Recycling proof: far more distinct claimants cycled through than the
      // 26-slot pool could ever hold concurrently.
      expect(counter).toBeGreaterThan(26 * 3);
      // The channel is still healthy — a fresh claim still succeeds.
      const final = await claimIdentity({ channelId: CH, sessionId: "final" });
      expect(NATO_POOL).toContain(final.identity);
    });
  });

  describe("reclaim composes — a reclaimed slot is indistinguishable from a fresh one", () => {
    it("a reclaimed letter re-issues as a clean fresh claim (no dead-claim residue)", async () => {
      const CH = "c-compose";
      await freshChannel(CH);
      // Dead claim took Alpha with a NON-default role.
      const dead = await claimIdentity({
        channelId: CH,
        sessionId: "dead",
        defaultRole: "pen",
      });
      expect(dead.identity).toBe("Alpha");
      expect(dead.role).toBe("pen");
      ageHeartbeat(CH, "dead", 25 * HOUR_MS);

      await reaperUnderTest({ channelId: CH, staleThresholdMs: WINDOW_MS });

      // Re-issue Alpha to a fresh session — must be a clean claim, no residue
      // of the dead claim's session or role.
      const fresh = await claimIdentity({ channelId: CH, sessionId: "fresh" });
      expect(fresh.identity).toBe("Alpha");
      expect(fresh.role).toBe("queue"); // default — NOT the dead claim's "pen"
      expect(fresh.session_id).toBe("fresh");
      expect(fresh.is_new_participant).toBe(true);
      const meta = readMetadata(CH).identities?.["Alpha"];
      expect(meta?.session_id).toBe("fresh");
      expect(meta?.role).toBe("queue");
    });

    it("is idempotent and spares an all-live channel (reclaims nothing)", async () => {
      const CH = "c-idempotent";
      await freshChannel(CH);
      await claimIdentity({ channelId: CH, sessionId: "alive-1" }); // Alpha
      touchHeartbeat(CH, "alive-1");
      await claimIdentity({ channelId: CH, sessionId: "alive-2" }); // Bravo
      touchHeartbeat(CH, "alive-2");

      const first = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });
      expect(first.reclaimed).toEqual([]);
      expect([...first.skippedActive].sort()).toEqual(["Alpha", "Bravo"]);

      // Running again changes nothing (no double-reclaim, no error).
      const second = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });
      expect(second.reclaimed).toEqual([]);
      expect(listClaims(CH).length).toBe(2);
    });
  });

  describe("split-detector — exemption+reaper coupling (executable)", () => {
    // Fill all 26 letters with distinct DEAD sessions. On the eternal channel
    // the gc-exemption removes the archival-driven pool recycle, so reclaim is
    // the ONLY path that reopens a slot. The contrast below is the executable
    // proof that the exemption and the reaper are coupled — ship the exemption
    // without the reaper and the pool exhausts.
    async function fill26Dead(channelId: string): Promise<void> {
      await freshChannel(channelId);
      for (let i = 0; i < 26; i++) {
        await claimIdentity({ channelId, sessionId: `dead-${i}` });
        ageHeartbeat(channelId, `dead-${i}`, 25 * HOUR_MS);
      }
    }

    it("reaper-disabled: 26 dead claims exhaust the pool — the 27th throws NatoExhaustedError", async () => {
      const CH = "c-split-noreaper";
      await fill26Dead(CH);
      // Reaper NOT called — the eternal channel cannot recycle any other way.
      await expect(
        claimIdentity({ channelId: CH, sessionId: "dead-27" }),
      ).rejects.toThrow(NatoExhaustedError);
    });

    it("reaper-enabled: the same 26 dead claims are reclaimed and the pool reopens", async () => {
      const CH = "c-split-reaper";
      await fill26Dead(CH);
      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });
      expect(res.reclaimed.length).toBe(26);
      expect(listClaims(CH).length).toBe(0);
      // The pool is fully reopened — the next claim succeeds (lowest slot).
      const survivor = await claimIdentity({
        channelId: CH,
        sessionId: "fresh-after-reap",
      });
      expect(survivor.identity).toBe("Alpha");
    });
  });

  describe("negative — no key-revoke on reclaim; bump-UUID consumes zero letters (D-INT-3)", () => {
    it("reclaiming stale claims appends NO kind=key-revoke message", async () => {
      // D-INT-3: routine reclaim does NOT emit key-revoke. Keys are per-NATO-
      // letter + persistent and the identity path is unsigned, so reclaiming a
      // dead session's letter never revokes a signing key. The reaper emits no
      // channel message at all on the reclaim path.
      const CH = "c-no-keyrevoke";
      await freshChannel(CH);
      for (let i = 0; i < 3; i++) {
        await claimIdentity({ channelId: CH, sessionId: `dead-${i}` });
        ageHeartbeat(CH, `dead-${i}`, 25 * HOUR_MS);
      }
      const before = readMessages(CH).length;

      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });
      expect(res.reclaimed.length).toBe(3);

      const after = readMessages(CH);
      expect(after.filter((m) => m.kind === "key-revoke")).toEqual([]);
      // Defensive: the reclaim path emits no message of any kind.
      expect(after.length).toBe(before);
    });

    it("[positive control] the key-revoke filter has teeth — it detects a key-revoke when one IS present", async () => {
      // Guards the negative assertion above from silently going inert (e.g. a
      // renamed kind or a changed readMessages shape): the SAME filter the
      // negative test relies on MUST catch a key-revoke that is actually
      // present. Proves the negative assertion has discriminating power rather
      // than passing by construction.
      const CH = "c-keyrevoke-control";
      await freshChannel(CH);
      await appendMessage({
        channelId: CH,
        message: {
          ts: "2026-06-01T00:00:00.000Z",
          kind: "key-revoke",
          from: "some-session",
          body: "{}",
        },
      });
      expect(
        readMessages(CH).filter((m) => m.kind === "key-revoke"),
      ).not.toEqual([]);
    });

    it("a pinned-UUID bump (send without join/--as) claims no letter and adds zero pool pressure", async () => {
      // The cohort-bump sender posts via a pinned UUID without ever joining or
      // claiming a NATO letter, so it never pressures the single 26-pool —
      // which is why default-ON cohort mode is safe (bump noise ≠ pool burn).
      const CH = "c-bump-zero-letter";
      await freshChannel(CH);
      const real = await claimIdentity({
        channelId: CH,
        sessionId: "real-peer",
      });
      expect(real.identity).toBe("Alpha");
      touchHeartbeat(CH, "real-peer"); // alive — so the later reap spares it
      const claimsBefore = listClaims(CH).length;

      const BUMP_UUID = "bump-pinned-uuid-0000";
      await appendMessage({
        channelId: CH,
        message: {
          ts: "2026-06-01T00:00:00.000Z",
          kind: "note",
          from: BUMP_UUID,
          body: "bump",
        },
      });

      // Zero pool pressure: no new claim, no sentinel, no metadata entry for
      // the bump UUID.
      expect(listClaims(CH).length).toBe(claimsBefore);
      expect(
        listClaims(CH).every((c) => c.claim.session_id !== BUMP_UUID),
      ).toBe(true);
      // The bump message carries no identity (legacy sender, no claim to
      // auto-attach).
      const bumpMsg = readMessages(CH).find((m) => m.from === BUMP_UUID);
      expect(bumpMsg?.identity).toBeUndefined();

      // Even after a reaper pass the bump never appears in the pool: only the
      // real (alive) peer is seen, and it is spared.
      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });
      expect(res.reclaimed).toEqual([]);
      expect(res.skippedActive).toEqual(["Alpha"]);
    });
  });

  describe("reclaim result — stuck arm", () => {
    it("a real sentinel-unlink failure (EACCES) reports the letter in stuck[], leaving a retryable orphan", async () => {
      // The third ReclaimResult arm: closeStalePeerIdentity removed the
      // metadata entry but the sentinel-unlink failed with a non-ENOENT errno;
      // the sentinel survives for the existing orphan-reaper to retry. Force a
      // REAL EACCES at the filesystem boundary (remove write on identities/)
      // rather than mocking an internal seam — so this validates ANY reaper's
      // unlink path, not just one that routes through unlinkIdentitySentinel*.
      // closeStalePeerIdentity still succeeds: it writes metadata.json in the
      // parent channel dir, which stays writable.
      const CH = "c-stuck";
      await freshChannel(CH);
      await claimIdentity({ channelId: CH, sessionId: "dead" }); // Alpha
      ageHeartbeat(CH, "dead", 25 * HOUR_MS);

      const idDir = join(sandboxDir, CH, "identities");
      chmodSync(idDir, 0o500); // r-x: unlink(2) inside the dir returns EACCES
      try {
        // Skip rather than false-pass where dir perms aren't enforced (e.g. a
        // root CI runner). Real CI runs non-root, so this exercises for real.
        if (dirIsWritable(idDir)) return;
        const res = await reaperUnderTest({
          channelId: CH,
          staleThresholdMs: WINDOW_MS,
        });
        expect(res.stuck).toEqual(["Alpha"]);
        expect(res.reclaimed).toEqual([]);
        // Metadata removed (closeStalePeerIdentity ran), sentinel orphaned.
        expect(readMetadata(CH).identities?.["Alpha"]).toBeUndefined();
        expect(existsSync(identitySentinelPath(CH, "Alpha"))).toBe(true);
      } finally {
        chmodSync(idDir, 0o700);
      }
    });
  });

  describe("liveness-window boundary resolution", () => {
    // Pin the staleness threshold tightly enough to catch an off-by-more-than-
    // 5min error (the wide 23h/25h margins elsewhere cannot). The substrate
    // boundary is strict `ageMs > staleThresholdMs` (index.ts:1149). The exact
    // single-tick `>` vs `>=` distinction is NOT deterministically testable
    // here — the reaper reads getWallClockNow() live, so test→reap elapsed
    // time perturbs an exactly-at-threshold age — so we assert a jitter-safe
    // ±5min around the window.
    it("spares a claim just INSIDE the window (threshold − 5min)", async () => {
      const CH = "c-boundary-inside";
      await freshChannel(CH);
      await claimIdentity({ channelId: CH, sessionId: "borderline-live" });
      ageHeartbeat(CH, "borderline-live", WINDOW_MS - 5 * MIN_MS);
      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });
      expect(res.reclaimed).toEqual([]);
      expect(res.skippedActive).toEqual(["Alpha"]);
      expect(readMetadata(CH).identities?.["Alpha"]?.session_id).toBe(
        "borderline-live",
      );
    });

    it("reclaims a claim just OUTSIDE the window (threshold + 5min)", async () => {
      const CH = "c-boundary-outside";
      await freshChannel(CH);
      await claimIdentity({ channelId: CH, sessionId: "just-dead" });
      ageHeartbeat(CH, "just-dead", WINDOW_MS + 5 * MIN_MS);
      const res = await reaperUnderTest({
        channelId: CH,
        staleThresholdMs: WINDOW_MS,
      });
      expect(res.reclaimed).toEqual(["Alpha"]);
      expect(res.skippedActive).toEqual([]);
      expect(existsSync(identitySentinelPath(CH, "Alpha"))).toBe(false);
    });
  });
});
