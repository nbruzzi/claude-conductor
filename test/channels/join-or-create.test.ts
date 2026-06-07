// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for joinOrCreateChannel (src/channels/index.ts) — the eternal
 * coordination channel's join-or-create bootstrap path: join if the channel
 * exists, else create-then-join. Covers the no-handoff-id case (handoff_id
 * defaults to the channelId, a self/sentinel anchor) and idempotent join.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createChannel,
  joinOrCreateChannel,
  readMetadata,
} from "../../src/channels/index.ts";
import { claimIdentityNamed } from "../../src/channels/identity.ts";

const CHANNEL = "coordination";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

function sandbox(): void {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-joc-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
}

function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
  if (prevSessionId !== undefined) {
    process.env["CLAUDE_SESSION_ID"] = prevSessionId;
  } else {
    delete process.env["CLAUDE_SESSION_ID"];
  }
}

describe("joinOrCreateChannel", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("creates the channel when absent, defaulting handoff_id to the channelId (no-handoff-id case)", async () => {
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: A,
    });
    expect(meta.participants).toEqual([A]);
    expect(meta.handoff_id).toBe(CHANNEL); // self/sentinel anchor
    expect(meta.lifecycle).toBe("parallel");
    expect(meta.closed_at).toBeUndefined();
    // Persisted to disk.
    expect(readMetadata(CHANNEL).participants).toEqual([A]);
  });

  it("joins an existing channel without throwing (does not re-create)", async () => {
    await createChannel({
      channelId: CHANNEL,
      handoffId: CHANNEL,
      sessionId: A,
    });
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: B,
    });
    expect(meta.participants).toEqual([A, B]);
  });

  it("is idempotent when the same session join-or-creates twice", async () => {
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: A });
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: A,
    });
    expect(meta.participants).toEqual([A]);
  });

  it("two sessions converge on a single channel (first creates, second joins)", async () => {
    const m1 = await joinOrCreateChannel({ channelId: CHANNEL, sessionId: A });
    expect(m1.participants).toEqual([A]);
    const m2 = await joinOrCreateChannel({ channelId: CHANNEL, sessionId: B });
    expect(m2.participants).toEqual([A, B]);
  });

  it("honors an explicit handoffId when creating", async () => {
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: A,
      handoffId: "explicit-anchor",
    });
    expect(meta.handoff_id).toBe("explicit-anchor");
  });
});

describe("joinOrCreateChannel — participants-prune (L171, prune-on-join via injected pruneStale)", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // a "dead" participant

  it("drops a stale participant in-place when joining", async () => {
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: A });
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: D });
    expect(readMetadata(CHANNEL).participants).toEqual([A, D]);
    // B joins with a predicate that marks D stale.
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: B,
      pruneStale: (sid) => sid === D,
    });
    expect(meta.participants).toEqual([A, B]); // D pruned, B added, A kept
    expect(readMetadata(CHANNEL).participants).toEqual([A, B]); // persisted
  });

  it("keeps a live participant (pruneStale returns false)", async () => {
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: A });
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: D });
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: B,
      pruneStale: () => false, // nobody stale
    });
    expect(meta.participants).toEqual([A, D, B]); // all kept
  });

  it("never prunes self even when the predicate marks everyone stale", async () => {
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: A });
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: B,
      pruneStale: () => true, // marks all (incl. self) stale
    });
    expect(meta.participants).toEqual([B]); // self kept; A (not self/identity) pruned
  });

  it("never prunes a current identity-holder even when marked stale", async () => {
    await createChannel({
      channelId: CHANNEL,
      handoffId: CHANNEL,
      sessionId: A,
    });
    await claimIdentityNamed({
      channelId: CHANNEL,
      sessionId: A,
      identity: "Alpha",
    });
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: D });
    // B joins; predicate marks A and D stale. A holds Alpha -> kept; D -> pruned.
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: B,
      pruneStale: (sid) => sid === A || sid === D,
    });
    expect(meta.participants).toContain(A); // identity-holder kept despite stale
    expect(meta.participants).toContain(B); // self
    expect(meta.participants).not.toContain(D); // pruned
  });

  it("idempotent rejoin re-appends a previously pruned participant", async () => {
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: A });
    await joinOrCreateChannel({ channelId: CHANNEL, sessionId: D });
    // A re-joins, pruning D.
    await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: A,
      pruneStale: (sid) => sid === D,
    });
    expect(readMetadata(CHANNEL).participants).toEqual([A]); // D pruned
    // D rejoins (no longer stale) -> re-appended (over-prune costs ~zero).
    const meta = await joinOrCreateChannel({
      channelId: CHANNEL,
      sessionId: D,
    });
    expect(meta.participants).toEqual([A, D]);
  });
});
