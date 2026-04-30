// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — dotfiles-root resolver matrix per Bravo B8 spec.
 *
 * 9 cases T1-T9 covering the 4-tier precedence chain + memoization +
 * deprecation breadcrumb emit-once invariant + corruption handling:
 *
 *   T1: CLAUDE_DOTFILES_ROOT set, sentinel absent, DOTFILES_ROOT absent
 *   T2: only sentinel present (heartbeat-body via canonical-claude-home)
 *   T3: only DOTFILES_ROOT set → returns + emits deprecation breadcrumb
 *   T4: all 3 unset → returns ${HOME}/.claude-dotfiles
 *   T5: precedence — all 3 set → returns CLAUDE_DOTFILES_ROOT
 *   T6: memoization-reset behavior
 *   T7: malformed sentinel → fallback + sentinel-corrupt breadcrumb
 *   T8: sentinel for DIFFERENT sessionId → ignored
 *   T9: deprecation breadcrumb is emit-ONCE per process
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactIdFromPath,
  setSentinelDotfilesRoot,
} from "../../src/active-sessions/index.ts";
import {
  __resetDotfilesRootForTests,
  dotfilesRoot,
  resetDotfilesRoot,
} from "../../src/shared/dotfiles-root.ts";
import { readPresenceFailures } from "../../src/shared/presence-failure-log.ts";

const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";
const SID2 = "76b84abc-a6a2-4395-bb65-f5bd799c525c";
const TIER1_PATH = "/explicit/override/path";
const TIER2_PATH = "/sentinel/path";
const TIER3_PATH = "/legacy/path";

let tmpDir: string;
let prevActiveSessionsDir: string | undefined;
let prevHome: string | undefined;
let prevExplicit: string | undefined;
let prevLegacy: string | undefined;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "dr-"));
  tmpDir = join(base, "active-sessions");
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevHome = process.env["HOME"];
  prevExplicit = process.env["CLAUDE_DOTFILES_ROOT"];
  prevLegacy = process.env["DOTFILES_ROOT"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  process.env["HOME"] = base;
  delete process.env["CLAUDE_DOTFILES_ROOT"];
  delete process.env["DOTFILES_ROOT"];
  mkdirSync(join(base, ".claude", "logs"), { recursive: true });
  __resetDotfilesRootForTests();
});

afterEach(() => {
  __resetDotfilesRootForTests();
  if (prevActiveSessionsDir === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  }
  if (prevHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = prevHome;
  }
  if (prevExplicit === undefined) {
    delete process.env["CLAUDE_DOTFILES_ROOT"];
  } else {
    process.env["CLAUDE_DOTFILES_ROOT"] = prevExplicit;
  }
  if (prevLegacy === undefined) {
    delete process.env["DOTFILES_ROOT"];
  } else {
    process.env["DOTFILES_ROOT"] = prevLegacy;
  }
  try {
    rmSync(join(tmpDir, ".."), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("dotfilesRoot — Bravo B8 4-tier precedence (T1–T5)", () => {
  it("T1: CLAUDE_DOTFILES_ROOT set, sentinel absent, DOTFILES_ROOT absent → tier 1", () => {
    process.env["CLAUDE_DOTFILES_ROOT"] = TIER1_PATH;
    expect(dotfilesRoot(SID)).toBe(TIER1_PATH);
  });

  it("T2: only sentinel-with-path-X present → tier 2", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: TIER2_PATH });
    expect(dotfilesRoot(SID)).toBe(TIER2_PATH);
  });

  it("T3: only DOTFILES_ROOT set → tier 3 + deprecation breadcrumb", () => {
    process.env["DOTFILES_ROOT"] = TIER3_PATH;
    expect(dotfilesRoot(SID)).toBe(TIER3_PATH);

    const events = readPresenceFailures();
    const dep = events.find((e) => e.kind === "deprecation");
    expect(dep).toBeDefined();
    expect(dep?.detail).toContain("DOTFILES_ROOT");
    expect(dep?.detail).toContain("CLAUDE_DOTFILES_ROOT");
  });

  it("T4: all 3 unset → tier 4 (${HOME}/.claude-dotfiles)", () => {
    // dotfilesRoot's tier 4 uses os.homedir() directly (not effectiveHome),
    // so this asserts against the real homedir() value — the production
    // tier-4 fallback is the canonical install location and intentionally
    // ignores HOME mutation per src/shared/dotfiles-root.ts §tier 4.
    expect(dotfilesRoot(SID)).toBe(`${homedir()}/.claude-dotfiles`);
  });

  it("T5: all 3 set → tier 1 wins (precedence)", () => {
    process.env["CLAUDE_DOTFILES_ROOT"] = TIER1_PATH;
    process.env["DOTFILES_ROOT"] = TIER3_PATH;
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: TIER2_PATH });
    expect(dotfilesRoot(SID)).toBe(TIER1_PATH);
  });
});

describe("dotfilesRoot — memoization (T6)", () => {
  it("T6: returns cached value across calls; reset re-resolves", () => {
    process.env["CLAUDE_DOTFILES_ROOT"] = TIER1_PATH;
    expect(dotfilesRoot(SID)).toBe(TIER1_PATH);

    // Mutate env without resetting — cached value should persist.
    process.env["CLAUDE_DOTFILES_ROOT"] = "/changed/path";
    expect(dotfilesRoot(SID)).toBe(TIER1_PATH);

    // After reset, re-resolution picks up the new env value.
    resetDotfilesRoot();
    expect(dotfilesRoot(SID)).toBe("/changed/path");
  });
});

describe("dotfilesRoot — corruption (T7)", () => {
  it("T7: malformed sentinel → falls through + sentinel-corrupt breadcrumb", () => {
    // Pin a sentinel, then corrupt it on disk.
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: TIER2_PATH });
    // Active-sessions canonicalClaudeHomeArtifactId now uses effectiveHome()
    // (process.env.HOME first, then os.homedir()) — match here so the
    // heartbeat path resolves to where setSentinelDotfilesRoot wrote it.
    const home = process.env["HOME"] ?? homedir();
    const artifactId = artifactIdFromPath(join(home, ".claude"));
    const heartbeatFile = join(tmpDir, artifactId, "heartbeats", SID);
    writeFileSync(heartbeatFile, "{not-json", "utf-8");

    // With CLAUDE_DOTFILES_ROOT unset and sentinel corrupted, resolver should
    // fall through to tier 4 (default = os.homedir() + /.claude-dotfiles).
    // Tier 2's read returns null after emitting the sentinel-corrupt
    // breadcrumb.
    expect(dotfilesRoot(SID)).toBe(`${homedir()}/.claude-dotfiles`);

    const events = readPresenceFailures();
    expect(events.find((e) => e.kind === "sentinel-corrupt")).toBeDefined();
  });
});

describe("dotfilesRoot — cross-session isolation (T8)", () => {
  it("T8: sentinel for a DIFFERENT sessionId is ignored", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: TIER2_PATH });
    // Resolving for SID2 (different sid) should NOT see SID's sentinel.
    // With no other tiers populated, falls through to tier 4 — which uses
    // os.homedir() directly (real home).
    expect(dotfilesRoot(SID2)).toBe(`${homedir()}/.claude-dotfiles`);
  });
});

describe("dotfilesRoot — deprecation emit-once (T9)", () => {
  it("T9: deprecation breadcrumb emits ONCE per process even across cache resets", () => {
    process.env["DOTFILES_ROOT"] = TIER3_PATH;

    // First call → breadcrumb emitted.
    expect(dotfilesRoot(SID)).toBe(TIER3_PATH);
    let events = readPresenceFailures();
    let dep = events.filter((e) => e.kind === "deprecation");
    expect(dep.length).toBe(1);

    // Second call → cached; no new breadcrumb.
    expect(dotfilesRoot(SID)).toBe(TIER3_PATH);
    events = readPresenceFailures();
    dep = events.filter((e) => e.kind === "deprecation");
    expect(dep.length).toBe(1);

    // Defensive runtime reset (resetDotfilesRoot) — cache cleared, but
    // deprecation flag preserved per Bravo B8 spec. Re-resolution should
    // NOT re-emit the breadcrumb.
    resetDotfilesRoot();
    expect(dotfilesRoot(SID)).toBe(TIER3_PATH);
    events = readPresenceFailures();
    dep = events.filter((e) => e.kind === "deprecation");
    expect(dep.length).toBe(1);
  });

  it("T9b: __resetDotfilesRootForTests clears the deprecation flag (test-isolation hook)", () => {
    process.env["DOTFILES_ROOT"] = TIER3_PATH;

    expect(dotfilesRoot(SID)).toBe(TIER3_PATH);
    expect(
      readPresenceFailures().filter((e) => e.kind === "deprecation").length,
    ).toBe(1);

    // Test reset clears BOTH cache AND deprecation flag.
    __resetDotfilesRootForTests();
    expect(dotfilesRoot(SID)).toBe(TIER3_PATH);
    expect(
      readPresenceFailures().filter((e) => e.kind === "deprecation").length,
    ).toBe(2);
  });
});
