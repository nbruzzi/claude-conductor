// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for joinOrCreateChannel (src/channels/index.ts) — the eternal
 * coordination channel's join-or-create bootstrap path: join if the channel
 * exists, else create-then-join. Covers the no-handoff-id case (handoff_id
 * defaults to the channelId, a self/sentinel anchor) and idempotent join.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import {
  createChannel,
  joinOrCreateChannel,
  readMetadata,
} from "../../src/channels/index.ts";

const SANDBOX = `/tmp/test-channels-joc-${process.pid}`;
const CHANNEL = "coordination";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  delete process.env["CLAUDE_SESSION_ID"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
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
