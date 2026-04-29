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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  claimIdentity,
  NATO_POOL,
  setRole,
} from "../../src/channels/identity.ts";
import {
  appendMessage,
  createChannel,
  readMessages,
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
  }, 90_000); // headroom for slow CI runners. // 90s timeout — 1000 iterations × ~30ms per iter = ~30s typical;

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
