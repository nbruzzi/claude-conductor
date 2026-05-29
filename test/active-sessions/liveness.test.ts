// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 2 boot-reconciliation — classifyLiveness unit tests.
 *
 * Pins the 3-bucket boundary semantics after lifting classifyLiveness from the
 * dotfiles `/presence` CLI into the plugin (de-dup). These boundaries are
 * load-bearing for reconcile-boot's `gc_eligible` predicate, which keys off the
 * "stale" (OLDEST) bucket — so the LIVE_WINDOW_MS / LIKELY_DEAD_MS thresholds
 * must classify exactly. Strict `>` at both boundaries; the likelyDead flag
 * forces at-least likely-dead; stale takes precedence over the flag.
 */

import { describe, expect, it } from "bun:test";
import {
  LIKELY_DEAD_MS,
  LIVE_WINDOW_MS,
  classifyLiveness,
  type HeartbeatListing,
} from "../../src/active-sessions/index.ts";

function listing(ageMs: number, likelyDead = false): HeartbeatListing {
  return {
    sessionId: "s",
    ageMs,
    likelyDead,
    owner: { sessionId: "s", pid: 1, host: "h", createdAt: 0, touchedAt: 0 },
  };
}

describe("classifyLiveness — 3-bucket boundary semantics", () => {
  it("classifies fresh heartbeats as live, inclusive of exactly LIKELY_DEAD_MS", () => {
    expect(classifyLiveness(listing(0))).toBe("live");
    // Strict `>`: exactly at LIKELY_DEAD_MS is still live.
    expect(classifyLiveness(listing(LIKELY_DEAD_MS))).toBe("live");
  });

  it("classifies likely-dead between LIKELY_DEAD_MS and LIVE_WINDOW_MS (inclusive of the upper boundary)", () => {
    expect(classifyLiveness(listing(LIKELY_DEAD_MS + 1))).toBe("likely-dead");
    // Strict `>`: exactly at LIVE_WINDOW_MS is still likely-dead, not stale.
    expect(classifyLiveness(listing(LIVE_WINDOW_MS))).toBe("likely-dead");
  });

  it("classifies stale (oldest bucket) strictly beyond LIVE_WINDOW_MS", () => {
    expect(classifyLiveness(listing(LIVE_WINDOW_MS + 1))).toBe("stale");
    expect(classifyLiveness(listing(LIVE_WINDOW_MS * 10))).toBe("stale");
  });

  it("the likelyDead flag forces likely-dead even for a fresh age", () => {
    expect(classifyLiveness(listing(0, true))).toBe("likely-dead");
  });

  it("stale takes precedence over the likelyDead flag", () => {
    expect(classifyLiveness(listing(LIVE_WINDOW_MS + 1, true))).toBe("stale");
  });
});
