// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 1 — registry primitives meta-test (TS-2 / V2 anticipation).
 *
 * Asserts SealedRegistry's three new full-registry primitives:
 *   - allCheckNames(): union of names across all events.
 *   - allBlockingNames(): union of canBlock=true names across all events.
 *   - nameToEvents(): map from name to events the check is registered for.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 1.1.
 * Consumed by: src/shared/disable-hooks.ts:parseDisableHooksEnv via the
 * dotfiles dispatcher (~/.claude-dotfiles/src/hooks/dispatcher.ts).
 */

import { describe, expect, it } from "bun:test";
import { RegistryBuilder } from "../../src/hooks/registry.ts";
import { pass } from "../../src/hooks/types.ts";

function buildFixtureRegistry() {
  const builder = new RegistryBuilder();

  builder.register("pre-tool-use", {
    name: "destructive-cmd",
    fn: async () => pass(),
    description: "Block rm -rf etc.",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "prefer-bun",
    fn: async () => pass(),
    description: "Nudge npm→bun.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "channel-gc",
    fn: async () => pass(),
    description: "Channel archive gc.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "channels-gc-reaper",
    fn: async () => pass(),
    description: "Sentinel reaper.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  // Same-name across events — RegistryBuilder allows it (duplicate-name
  // check is per-event). Tests dedup correctness in primitives.
  builder.register("stop", {
    name: "session-presence-unregister",
    fn: async () => pass(),
    description: "Drop session.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "session-presence-unregister",
    fn: async () => pass(),
    description: "(hypothetical multi-event registration for fixture coverage)",
    canBlock: false,
    profiles: ["standard", "strict"],
  });

  return builder.seal();
}

describe("SealedRegistry.allCheckNames", () => {
  it("returns the deduped union of names across all events", () => {
    const reg = buildFixtureRegistry();
    const names = reg.allCheckNames();

    expect(names.size).toBe(5);
    expect(names.has("destructive-cmd")).toBe(true);
    expect(names.has("prefer-bun")).toBe(true);
    expect(names.has("channel-gc")).toBe(true);
    expect(names.has("channels-gc-reaper")).toBe(true);
    expect(names.has("session-presence-unregister")).toBe(true);
  });

  it("supports .has() lookup correctly", () => {
    const reg = buildFixtureRegistry();
    const names = reg.allCheckNames();
    expect(names.has("destructive-cmd")).toBe(true);
    expect(names.has("nonexistent-name")).toBe(false);
  });

  it("empty registry returns empty set", () => {
    const empty = new RegistryBuilder().seal();
    expect(empty.allCheckNames().size).toBe(0);
  });
});

describe("SealedRegistry.allBlockingNames", () => {
  it("returns only canBlock=true names", () => {
    const reg = buildFixtureRegistry();
    const blocking = reg.allBlockingNames();

    expect(blocking.size).toBe(1);
    expect(blocking.has("destructive-cmd")).toBe(true);
    expect(blocking.has("prefer-bun")).toBe(false);
    expect(blocking.has("channel-gc")).toBe(false);
  });

  it("empty registry returns empty set", () => {
    const empty = new RegistryBuilder().seal();
    expect(empty.allBlockingNames().size).toBe(0);
  });
});

describe("SealedRegistry.nameToEvents", () => {
  it("maps each name to its registered event(s)", () => {
    const reg = buildFixtureRegistry();
    const map = reg.nameToEvents();

    expect(map.get("destructive-cmd")).toEqual(["pre-tool-use"]);
    expect(map.get("prefer-bun")).toEqual(["pre-tool-use"]);
    expect(map.get("channel-gc")).toEqual(["session-start"]);
    expect(map.get("channels-gc-reaper")).toEqual(["session-start"]);

    const multiEvents = map.get("session-presence-unregister");
    expect(multiEvents).toBeDefined();
    expect(multiEvents?.length).toBe(2);
    expect(multiEvents).toContain("stop");
    expect(multiEvents).toContain("session-start");
    // HOOK_EVENTS lifecycle order: pre-tool-use, post-tool-use, stop,
    // session-start, user-prompt-submit. So "stop" precedes "session-start".
    expect(multiEvents).toEqual(["stop", "session-start"]);
  });

  it("empty registry returns empty map", () => {
    const empty = new RegistryBuilder().seal();
    expect(empty.nameToEvents().size).toBe(0);
  });

  it("name not in registry returns undefined", () => {
    const reg = buildFixtureRegistry();
    const map = reg.nameToEvents();
    expect(map.get("nonexistent-hook")).toBeUndefined();
  });
});

describe("Cross-primitive consistency", () => {
  it("allBlockingNames is a subset of allCheckNames", () => {
    const reg = buildFixtureRegistry();
    const all = reg.allCheckNames();
    const blocking = reg.allBlockingNames();
    for (const name of blocking) {
      expect(all.has(name)).toBe(true);
    }
  });

  it("nameToEvents.keys() == allCheckNames (set equality)", () => {
    const reg = buildFixtureRegistry();
    const all = reg.allCheckNames();
    const mapKeys = new Set(reg.nameToEvents().keys());
    expect(mapKeys.size).toBe(all.size);
    for (const name of all) {
      expect(mapKeys.has(name)).toBe(true);
    }
  });
});
