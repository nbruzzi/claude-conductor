// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `explicitlyOutPeers` predicate (Phase 4 Step A Layer 3).
 *
 * Covers:
 *   - Empty channel (no identities) → empty array
 *   - Identities without `out_posted_at` → not returned
 *   - Identities with `out_posted_at` → returned
 *   - Unreadable metadata (channel doesn't exist) → empty array
 *     (skip-on-error per the predicate's contract)
 *   - Multiple out-peers → multi-letter return
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v5
 * §"explicitlyOutPeers semantics".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createChannel,
  readMetadata,
  resolveChannelsDir,
} from "../../src/channels/index.ts";
import { explicitlyOutPeers } from "../../src/channels/explicitly-out-peers.ts";

const SANDBOX = `/tmp/test-explicit-out-${process.pid}`;
const SESSION = "00000000-0000-4000-8000-0000000000ee";

beforeEach(() => {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
});

afterEach(() => {
  cleanup();
});

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  delete process.env["CLAUDE_SESSION_ID"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

/**
 * Write metadata directly to disk with a custom identities map.
 * Bypasses claimIdentity to keep the test focused on the predicate
 * (claim mechanics are tested elsewhere).
 */
function setIdentities(
  channelId: string,
  identities: Record<
    string,
    {
      session_id: string;
      role: "pen" | "queue" | "out";
      joined_at: string;
      out_posted_at?: string;
    }
  >,
): void {
  const meta = readMetadata(channelId);
  const next = { ...meta, identities };
  const metaPath = join(resolveChannelsDir(), channelId, "metadata.json");
  writeFileSync(metaPath, JSON.stringify(next, null, 2));
}

describe("explicitlyOutPeers", () => {
  it("returns empty array for a channel with no identities", async () => {
    await createChannel({
      channelId: "c-empty",
      handoffId: "c-empty",
      sessionId: SESSION,
    });
    expect(explicitlyOutPeers("c-empty")).toEqual([]);
  });

  it("skips identities without out_posted_at", async () => {
    await createChannel({
      channelId: "c-active",
      handoffId: "c-active",
      sessionId: SESSION,
    });
    setIdentities("c-active", {
      Alpha: {
        session_id: SESSION,
        role: "pen",
        joined_at: "2026-05-13T00:00:00.000Z",
      },
      Bravo: {
        session_id: "another-sid",
        role: "queue",
        joined_at: "2026-05-13T00:01:00.000Z",
      },
    });
    expect(explicitlyOutPeers("c-active")).toEqual([]);
  });

  it("returns letters with out_posted_at set", async () => {
    await createChannel({
      channelId: "c-mixed",
      handoffId: "c-mixed",
      sessionId: SESSION,
    });
    setIdentities("c-mixed", {
      Alpha: {
        session_id: SESSION,
        role: "pen",
        joined_at: "2026-05-13T00:00:00.000Z",
      },
      Bravo: {
        session_id: "another-sid",
        role: "out",
        joined_at: "2026-05-13T00:01:00.000Z",
        out_posted_at: "2026-05-13T00:02:00.000Z",
      },
    });
    expect(explicitlyOutPeers("c-mixed")).toEqual(["Bravo"]);
  });

  it("returns multiple letters when multiple peers are out", async () => {
    await createChannel({
      channelId: "c-multi-out",
      handoffId: "c-multi-out",
      sessionId: SESSION,
    });
    setIdentities("c-multi-out", {
      Alpha: {
        session_id: SESSION,
        role: "out",
        joined_at: "2026-05-13T00:00:00.000Z",
        out_posted_at: "2026-05-13T00:00:30.000Z",
      },
      Bravo: {
        session_id: "sid-b",
        role: "out",
        joined_at: "2026-05-13T00:01:00.000Z",
        out_posted_at: "2026-05-13T00:01:30.000Z",
      },
      Charlie: {
        session_id: "sid-c",
        role: "queue",
        joined_at: "2026-05-13T00:02:00.000Z",
      },
    });
    const result = explicitlyOutPeers("c-multi-out");
    expect(result.length).toBe(2);
    expect(new Set(result)).toEqual(new Set(["Alpha", "Bravo"]));
  });

  it("returns empty array on unreadable metadata (skip-on-error)", () => {
    // No channel created — readMetadata will throw; predicate swallows.
    expect(explicitlyOutPeers("c-does-not-exist")).toEqual([]);
  });
});
