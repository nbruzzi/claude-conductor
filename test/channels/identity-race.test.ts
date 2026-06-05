// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 7 — identity claim race stress.
 *
 * Two complementary race surfaces:
 *
 *   1. **Subprocess stress (load-bearing).** 26 concurrent OS processes
 *      each call `claimIdentity` on the same channel with distinct
 *      session ids. Each child claims a NATO letter via `linkSync`'s
 *      atomic create-only EEXIST primitive. Asserts every child
 *      succeeds AND each gets a distinct letter (i.e., the race is
 *      safe at the OS level — kernel guarantees `link(2)` atomicity).
 *
 *      This is the test the Slice 2 design promised. In-process
 *      `Promise.all` (test 2 below) interleaves on a single event loop
 *      and cannot exercise the OS-level lock semantics that the
 *      sentinel-file primitive depends on.
 *
 *   2. **In-process property-based fuzz.** 1000 iterations × N concurrent
 *      `claimIdentity` calls (N varies 2-4 for runtime sanity). Each
 *      iteration creates a fresh channel and asserts that the N
 *      concurrent claims yield N distinct identities. Now safe after
 *      the `acquireLock` sync→async conversion in Slice 2 — pre-fix
 *      this would deadlock on the spin-wait.
 *
 *      Fuzz catches edge cases the deterministic 26-letter test
 *      misses: lock retry interleaving with linkSync EEXIST, partial
 *      sentinel writes under contention, etc.
 *
 * Plan: ~/.claude/plans/vivid-seeking-crayon.md §Slice 7 (joint test budget).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

import {
  claimIdentity,
  claimIdentityNamed,
  identitySentinelPath,
  IdentityRacedError,
  NATO_POOL,
  setRole,
} from "../../src/channels/identity.ts";
import {
  appendMessage,
  claimNamedIdentityWithLock,
  createChannel,
  readMessages,
  readMetadata,
  touchHeartbeat,
} from "../../src/channels/index.ts";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const IDENTITY_TS_PATH = join(PACKAGE_ROOT, "src", "channels", "identity.ts");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "identity-race-"));
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = sandbox;
});

afterEach(() => {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

/**
 * Inline child-process script. Uses dynamic import + absolute path so
 * the child resolves the same `identity.ts` module the test does (no
 * cross-process module-state divergence). Reads channel id + session id
 * from env vars set by the parent.
 */
const CHILD_SCRIPT = `
const { claimIdentity } = await import(${JSON.stringify(IDENTITY_TS_PATH)});
const channelId = process.env["RACE_CHANNEL_ID"];
const sessionId = process.env["RACE_SESSION_ID"];
if (!channelId || !sessionId) {
  process.stderr.write("missing RACE_CHANNEL_ID or RACE_SESSION_ID\\n");
  process.exit(2);
}
try {
  const result = await claimIdentity({ channelId, sessionId });
  process.stdout.write(JSON.stringify({
    identity: result.identity,
    role: result.role,
    sessionId,
    isNewParticipant: result.is_new_participant,
  }));
  process.exit(0);
} catch (err) {
  process.stderr.write("claim failed: " + (err && err.message ? err.message : String(err)) + "\\n");
  process.exit(1);
}
`;

type ChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Spawn a single child process, return its captured output. */
function spawnClaimChild(
  channelId: string,
  sessionId: string,
): Promise<ChildResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "-e", CHILD_SCRIPT],
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: sandbox,
      RACE_CHANNEL_ID: channelId,
      RACE_SESSION_ID: sessionId,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  })();
}

describe("identity claim — subprocess stress (26-concurrent)", () => {
  it("26 concurrent OS processes each get a distinct NATO letter", async () => {
    const channelId = "c-race-26";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: "race-init",
    });

    // Spawn 26 children in true parallel — kernel scheduler interleaves
    // their linkSync attempts so the race is OS-level, not event-loop.
    const sessionIds = Array.from({ length: 26 }, (_, i) => {
      // UUID-shaped ids so any downstream gates that assert UUID format
      // accept them (race here exercises claimIdentity directly, but
      // belt-and-suspenders for forward-compat).
      const suffix = String(i).padStart(12, "0");
      return `00000000-0000-4000-8000-${suffix}`;
    });

    const children = await Promise.all(
      sessionIds.map((sid) => spawnClaimChild(channelId, sid)),
    );

    // All children must succeed. Aggregate failures rather than
    // bailing on first — race regressions often produce N partial
    // failures, and seeing the aggregate is debuggable.
    const failures = children.filter((c) => c.exitCode !== 0);
    if (failures.length > 0) {
      const stderrs = failures
        .map(
          (f, i) => `child ${i}: exit=${f.exitCode} stderr=${f.stderr.trim()}`,
        )
        .join("\n");
      throw new Error(`${failures.length} child(ren) failed:\n${stderrs}`);
    }

    // Parse identity from each child stdout.
    const claims = children.map((c, i) => {
      try {
        return JSON.parse(c.stdout) as {
          identity: string;
          role: string;
          sessionId: string;
          isNewParticipant: boolean;
        };
      } catch {
        throw new Error(`child ${i} produced unparseable stdout: ${c.stdout}`);
      }
    });

    // Distinct letters — the load-bearing assertion. If linkSync EEXIST
    // semantics fail, two children see identical letters here.
    const identities = claims.map((c) => c.identity);
    const distinctIdentities = new Set(identities);
    expect(distinctIdentities.size).toBe(26);

    // Coverage: all 26 NATO letters were used (no skips).
    expect(distinctIdentities).toEqual(new Set(NATO_POOL));

    // Every claim is a new-participant claim (no rejoins).
    expect(claims.every((c) => c.isNewParticipant)).toBe(true);

    // Default role is "queue" for every claimant (Slice 2 invariant).
    expect(claims.every((c) => c.role === "queue")).toBe(true);
  }, 60_000); // spike on slow CI. Each child should still finish in <2s in practice. // 60s timeout — subprocess startup + 26x linkSync contention can
});

describe("identity claim — in-process property-based fuzz", () => {
  it("1000 iterations of N concurrent claims (N=2-4) yield distinct letters", async () => {
    // Seeded by iteration index — `iter % 3 + 2` for N keeps the test
    // reproducible without an external PRNG dependency.
    let totalClaims = 0;
    for (let iter = 0; iter < 1000; iter++) {
      const n = (iter % 3) + 2; // N ∈ {2, 3, 4}
      const channelId = `c-fuzz-${iter}`;
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: `fuzz-init-${iter}`,
      });

      const claims = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          claimIdentity({
            channelId,
            sessionId: `fuzz-${iter}-${i}`,
          }),
        ),
      );

      const identities = claims.map((c) => c.identity);
      const distinct = new Set(identities);
      if (distinct.size !== n) {
        throw new Error(
          `iter=${iter} N=${n} produced ${distinct.size} distinct ids: ${JSON.stringify(identities)}`,
        );
      }
      totalClaims += n;
    }
    // Sanity: the loop did the work it was supposed to do.
    // (1000 * avg(N=2,3,4)=3 = ~3000 total claims.)
    expect(totalClaims).toBeGreaterThanOrEqual(2000);
    expect(totalClaims).toBeLessThanOrEqual(4000);
  }, 180_000); // 180s timeout. 1000 iterations × ~30ms typical = ~30s normal; observed 90132ms on slow GitHub Actions runner (CI run 25216032584 on plugin main e5b5e9d, 2026-05-01) — bumped from 90s to 180s for ample headroom. Test asserts structural invariants (distinct letters per claim batch); timing is incidental.

  it("50 iterations of N=20 concurrent claims yield distinct letters (high-N coverage)", async () => {
    // High-N branch: smaller iteration count but exercises the
    // 20-concurrent linkSync EEXIST contention in-process. Catches
    // races the subprocess test misses (subprocess uses N=26 once;
    // in-process fuzz at N=20 hits the contention 50 times).
    for (let iter = 0; iter < 50; iter++) {
      const channelId = `c-fuzz-high-${iter}`;
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: `fuzz-high-init-${iter}`,
      });
      const claims = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          claimIdentity({
            channelId,
            sessionId: `fuzz-high-${iter}-${i}`,
          }),
        ),
      );
      const identities = claims.map((c) => c.identity);
      const distinct = new Set(identities);
      if (distinct.size !== 20) {
        throw new Error(
          `iter=${iter} N=20 produced ${distinct.size} distinct ids: ${JSON.stringify(identities)}`,
        );
      }
    }
  }, 60_000);
});

/**
 * Phase 2 Slice 1+2 — appendMessage role-flip interleave (RE-W0-1 closure).
 *
 * Pre-Slice-1+2 the auto-attach scan (`metadata.identities` read inside
 * appendMessage) ran OUTSIDE `withMetadataLock`. A concurrent `setIdentityRole`
 * via `setRole` could mutate the role between the auto-attach read and the
 * JSONL append, producing a message attributed with a stale role.
 *
 * Post-Slice-1+2 the read+attach+append cycle runs inside the lock, so the
 * appended `role` matches `metadata.identities[<letter>].role` at-or-before
 * append time even under concurrent flips.
 *
 * Test shape: 1 sender claims Alpha; runs N=20 concurrent (sender, role-flip)
 * pairs via `Promise.all`. After all settle, asserts EVERY message has
 * `role` defined AND its value is one of the roles the sender ever held
 * (queue / pen / out — never some torn intermediate or undefined).
 */
describe("appendMessage role-flip interleave (Phase 2 Slice 1+2 / RE-W0-1)", () => {
  it("concurrent send + set-role: every appended message has a valid role attached", async () => {
    const channelId = "c-interleave";
    const sessionId = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";
    await createChannel({ channelId, handoffId: channelId, sessionId });
    const claim = await claimIdentity({ channelId, sessionId });
    expect(claim.identity).toBe("Alpha");

    const N = 20;
    const roles = ["queue", "pen", "out"] as const;

    // Interleave: N concurrent sends + N concurrent role-flips. Bun's
    // microtask scheduler interleaves Promise.all members on a single
    // event loop, so the sends + flips race for the metadata lock —
    // exactly the surface the lock fix prevents wrong-attribution on.
    const sends = Array.from({ length: N }, (_, i) =>
      appendMessage({
        channelId,
        message: {
          ts: new Date(Date.now() + i).toISOString(),
          from: sessionId,
          kind: "note",
          body: `interleave-${i}`,
        },
      }),
    );
    const flips = Array.from({ length: N }, (_, i) =>
      setRole(channelId, "Alpha", roles[i % roles.length] ?? "queue"),
    );

    await Promise.all([...sends, ...flips]);

    const messages = readMessages(channelId);
    const interleaveMsgs = messages.filter((m) =>
      m.body?.startsWith("interleave-"),
    );
    expect(interleaveMsgs).toHaveLength(N);

    for (const m of interleaveMsgs) {
      // Every interleaved message must have role attached (auto-attach
      // consulted metadata.identities under the lock).
      expect(m.identity).toBe("Alpha");
      expect(m.role).toBeDefined();
      if (m.role !== undefined) {
        expect(roles).toContain(m.role);
      }
    }
  }, 30_000);
});

/**
 * Plan v1.3 §7 — claimIdentityNamed takeover-race-fuzz (RE-6 closure).
 *
 * Two complementary surfaces:
 *
 *   1. **Heartbeat-touch + takeover interleaving (load-bearing).** N=20
 *      concurrent (prior-holder-heartbeat-touch, claimIdentityNamed --force)
 *      pairs across N different channels (one per NATO letter A through T).
 *      Asserts ALL takeovers succeed AND post-state consistency: sentinel
 *      content's session_id === metadata.identities[Letter].session_id for
 *      every channel. The race is between the prior holder's heartbeat
 *      write (independent of metadata lock per `index.ts:668-673`) and the
 *      new claimant's takeover (acquires metadata lock; reads heartbeat
 *      snapshot inside lock). Force=true short-circuits the staleness gate
 *      so all 20 takeovers proceed regardless of heartbeat freshness.
 *
 *   2. **Takeover races vanilla claimIdentity pool-walking (residual race).**
 *      Tracked as `it.todo` per Plan v1.3 §residual-race-documentation:
 *      vanilla `claimIdentity:240-259` does linkSync OUTSIDE the metadata
 *      lock; concurrent claimIdentityNamed --force can have its metadata
 *      clobbered by the vanilla claimer's later commitIdentityClaim. The
 *      mitigation is in `claimIdentity`'s commitIdentityClaim — verify
 *      sentinel content under lock + abort if mismatch. Tracked as
 *      known-follow-up in Plan v1.3 §Substrate-debt-mirror; remove `.todo`
 *      when the hardening lands.
 */
describe("claimIdentityNamed — takeover race fuzz (Plan v1.3 §7 / RE-6)", () => {
  it("N=20 concurrent (heartbeat-touch + claimIdentityNamed --force) takeovers — all succeed, all post-state-consistent", async () => {
    const N = 20;
    const letters = NATO_POOL.slice(0, N); // A through T
    const oldSessions = letters.map((_, i) => `sess-old-takeover-${i}`);
    const newSessions = letters.map((_, i) => `sess-new-takeover-${i}`);

    // Setup: N channels, each with prior holder claiming the letter and
    // having an initial heartbeat. Sequential setup (each channel needs
    // its own seeding before takeover concurrency starts).
    for (let i = 0; i < N; i++) {
      const channelId = `c-takeover-${i}`;
      const oldSession = oldSessions[i] ?? "";
      const letter = letters[i];
      if (letter === undefined) continue;
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: oldSession,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: oldSession,
        identity: letter,
      });
      touchHeartbeat(channelId, oldSession);
    }

    // Concurrent: 2N promises = N heartbeat-touches (prior-holder freshness)
    // interleaved with N claimIdentityNamed --force takeovers (new claimant).
    // Promise.all on a single event loop interleaves microtasks so the
    // heartbeat-write and metadata-lock-read race within each channel.
    const heartbeatPromises = oldSessions.map((sid, i) =>
      Promise.resolve().then(() => touchHeartbeat(`c-takeover-${i}`, sid)),
    );
    const takeoverPromises = letters.map((letter, i) => {
      const newSession = newSessions[i] ?? "";
      return claimIdentityNamed({
        channelId: `c-takeover-${i}`,
        sessionId: newSession,
        identity: letter,
        force: true,
      });
    });

    const [, takeoverResults] = await Promise.all([
      Promise.all(heartbeatPromises),
      Promise.all(takeoverPromises),
    ]);

    // Assert all takeovers succeeded with takeover_displaced_session_id set.
    for (let i = 0; i < N; i++) {
      const result = takeoverResults[i];
      expect(result?.identity).toBe(letters[i]);
      expect(result?.session_id).toBe(newSessions[i]);
      expect(result?.is_new_participant).toBe(true);
      expect(result?.takeover_displaced_session_id).toBe(oldSessions[i]);
    }

    // Post-state consistency: sentinel content session_id matches metadata
    // identities[Letter].session_id for ALL N letters. This is the
    // load-bearing assertion — if takeovers race against each other or
    // against heartbeat writes in a way that produces torn state, this
    // will catch it.
    for (let i = 0; i < N; i++) {
      const channelId = `c-takeover-${i}`;
      const letter = letters[i];
      const expectedSession = newSessions[i];
      if (letter === undefined || expectedSession === undefined) continue;
      const sentinelContent = JSON.parse(
        readFileSync(identitySentinelPath(channelId, letter), "utf-8"),
      ) as { session_id: string };
      const meta = readMetadata(channelId);
      const metaSession = meta.identities?.[letter]?.session_id;
      expect(sentinelContent.session_id).toBe(expectedSession);
      expect(metaSession).toBe(expectedSession);
      // Coherence: sentinel and metadata agree (the load-bearing invariant).
      expect(sentinelContent.session_id).toBe(metaSession ?? "");
    }
  }, 30_000);

  it("takeover --force YIELDS (IdentityRacedError) when the sentinel was reclaimed out from under the metadata snapshot — D3 (b) sentinel-reverify-under-lock close", async () => {
    // Closes the residual race the prior it.todo tracked. The documented
    // failure: vanilla claimIdentity's pre-lock linkSync (lock-free) reclaims a
    // letter inside the takeover window; the old unconditional renameSync then
    // clobbered that fresh claim -> permanent sentinel/metadata divergence +
    // double-claim. The fix lives in claimNamedIdentityWithLock (the named
    // side, narrower than the it.todo's vanilla-commitIdentityClaim plan):
    // reverify the on-disk sentinel vs the metadata snapshot under the lock and
    // YIELD on divergence rather than clobber.
    //
    // Deterministic reproduction of the divergent mid-race state: claim Alpha
    // for X (sentinel=X, metadata=X), then overwrite ONLY the sentinel to V
    // (simulating a lock-free vanilla reclaim metadata hasn't caught up to). A
    // --force takeover by N must DETECT sentinel(V) != metadata(X) and refuse.
    const channelId = "c-reverify-race";
    const letter = "Alpha";
    const xSession = "sess-reverify-x";
    const vSession = "sess-reverify-v";
    const nSession = "sess-reverify-n";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: xSession,
    });
    await claimIdentityNamed({
      channelId,
      sessionId: xSession,
      identity: letter,
    });

    const sentinelPath = identitySentinelPath(channelId, letter);
    writeFileSync(
      sentinelPath,
      `${JSON.stringify({ session_id: vSession, role: "queue", joined_at: new Date().toISOString() })}\n`,
    );

    await expect(
      claimIdentityNamed({
        channelId,
        sessionId: nSession,
        identity: letter,
        force: true,
      }),
    ).rejects.toThrow(IdentityRacedError);

    // No-clobber: sentinel still V, metadata still X. N did NOT win.
    const sentinelAfter = JSON.parse(readFileSync(sentinelPath, "utf-8")) as {
      session_id: string;
    };
    expect(sentinelAfter.session_id).toBe(vSession);
    expect(readMetadata(channelId).identities?.[letter]?.session_id).toBe(
      xSession,
    );
  }, 30_000);
});

/**
 * D3 (b) — claimNamedIdentityWithLock sentinel-reverify-under-lock, branch
 * coverage at the primitive level (the integration path above proves the
 * caller throws; these pin each reverify branch in isolation).
 */
describe("claimNamedIdentityWithLock — sentinel-reverify-under-lock branches (D3 (b))", () => {
  let tmpCounter = 0;
  // Write a tmpPath claim file in the sentinel's dir (same fs, as the real
  // claimIdentityNamed P1 does) so renameSync/linkSync are valid.
  function writeTmpClaim(sentinelPath: string, sessionId: string): string {
    const dir = dirname(sentinelPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.tmp.test.${tmpCounter++}`);
    writeFileSync(
      tmpPath,
      `${JSON.stringify({ session_id: sessionId, role: "queue", joined_at: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return tmpPath;
  }

  it("MATCH (sentinel === metadata snapshot): renameSync path -> claimed + post-state consistent", async () => {
    const channelId = "c-revlock-match";
    const letter = "Alpha";
    const xSession = "sess-match-x";
    const nSession = "sess-match-n";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: xSession,
    });
    await claimIdentityNamed({
      channelId,
      sessionId: xSession,
      identity: letter,
    });
    const sentinelPath = identitySentinelPath(channelId, letter);
    const tmpPath = writeTmpClaim(sentinelPath, nSession);

    const result = await claimNamedIdentityWithLock({
      channelId,
      identity: letter,
      newClaim: {
        session_id: nSession,
        role: "queue",
        joined_at: new Date().toISOString(),
      },
      tmpPath,
      sentinelPath,
      force: true,
      fromSession: undefined,
    });

    expect(result.kind).toBe("claimed");
    if (result.kind === "claimed") {
      expect(result.displacedSessionId).toBe(xSession);
    }
    expect(
      (
        JSON.parse(readFileSync(sentinelPath, "utf-8")) as {
          session_id: string;
        }
      ).session_id,
    ).toBe(nSession);
    expect(readMetadata(channelId).identities?.[letter]?.session_id).toBe(
      nSession,
    );
    expect(existsSync(tmpPath)).toBe(false); // renameSync consumed tmpPath
  });

  it("DIVERGED (sentinel !== metadata snapshot): yields raced, mutates nothing", async () => {
    const channelId = "c-revlock-diverged";
    const letter = "Bravo";
    const xSession = "sess-div-x";
    const vSession = "sess-div-v";
    const nSession = "sess-div-n";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: xSession,
    });
    await claimIdentityNamed({
      channelId,
      sessionId: xSession,
      identity: letter,
    });
    const sentinelPath = identitySentinelPath(channelId, letter);
    // Sentinel reclaimed to V; metadata still records X.
    writeFileSync(
      sentinelPath,
      `${JSON.stringify({ session_id: vSession, role: "queue", joined_at: new Date().toISOString() })}\n`,
    );
    const tmpPath = writeTmpClaim(sentinelPath, nSession);

    const result = await claimNamedIdentityWithLock({
      channelId,
      identity: letter,
      newClaim: {
        session_id: nSession,
        role: "queue",
        joined_at: new Date().toISOString(),
      },
      tmpPath,
      sentinelPath,
      force: true,
      fromSession: undefined,
    });

    expect(result.kind).toBe("raced");
    if (result.kind === "raced") {
      expect(result.expectedHolder).toBe(xSession);
      expect(result.actualHolder).toBe(vSession);
    }
    // Mutated nothing: sentinel still V, metadata still X.
    expect(
      (
        JSON.parse(readFileSync(sentinelPath, "utf-8")) as {
          session_id: string;
        }
      ).session_id,
    ).toBe(vSession);
    expect(readMetadata(channelId).identities?.[letter]?.session_id).toBe(
      xSession,
    );
    expect(existsSync(tmpPath)).toBe(true); // primitive left tmpPath for caller
    rmSync(tmpPath, { force: true });
  });

  it("UNHELD (metadata null + sentinel absent): create-only linkSync path -> claimed", async () => {
    const channelId = "c-revlock-unheld";
    const letter = "Charlie";
    const nSession = "sess-unheld-n";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: "sess-unheld-init",
    });
    const sentinelPath = identitySentinelPath(channelId, letter);
    const tmpPath = writeTmpClaim(sentinelPath, nSession);
    expect(existsSync(sentinelPath)).toBe(false);

    const result = await claimNamedIdentityWithLock({
      channelId,
      identity: letter,
      newClaim: {
        session_id: nSession,
        role: "queue",
        joined_at: new Date().toISOString(),
      },
      tmpPath,
      sentinelPath,
      force: true,
      fromSession: undefined,
    });

    expect(result.kind).toBe("claimed");
    if (result.kind === "claimed") {
      expect(result.displacedSessionId).toBeNull();
    }
    expect(
      (
        JSON.parse(readFileSync(sentinelPath, "utf-8")) as {
          session_id: string;
        }
      ).session_id,
    ).toBe(nSession);
    expect(readMetadata(channelId).identities?.[letter]?.session_id).toBe(
      nSession,
    );
    expect(existsSync(tmpPath)).toBe(false); // linkSync + unlink consumed tmpPath
  });
});
