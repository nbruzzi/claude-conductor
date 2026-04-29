// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Meta-test — anti-drift assertions for the 20 bundled discipline checks
 * (Phase 1: 18; Phase 2 Slice 5 added identity-injector → 19; Phase 2
 * Slice 6 added task-coordinator → 20).
 *
 * Replaces the per-component-stub approach (one stub per check) with a single
 * iteration over `BUNDLED_CHECKS_BY_EVENT` that builds a fresh
 * `RegistryBuilder<BundledCheckName>`, calls `registerBundled`, seals, and
 * asserts (event, name) tuples + count + duplicates + bidirectional set
 * equality. Single source of truth; automatic on bundle changes.
 *
 * Imports are relative — `BUNDLED_CHECKS_BY_EVENT` is exported from plugin's
 * `package.json` exports map (`./hooks/bundled-check-names`) for external
 * consumers (dotfiles will compose AllCheckNames at reconciliation time),
 * but in-plugin code uses relative paths.
 *
 * --- Deferred-copy semantics (cross-repo drift) ---
 *
 * Plugin's `src/hooks/checks/bundled-registrations.ts` is currently a COPY of
 * the dotfiles canonical at `~/.claude-dotfiles/src/hooks/checks/
 * bundled-registrations.ts`. The cross-edge to `active-sessions/index.ts`
 * blocks shimming the registrations file in batch 5 (memory
 * `feedback-cross-edge-module-state-audit.md`).
 *
 * This meta-test pins drift WITHIN the plugin copy (typo in plugin's
 * registration → fails in plugin's CI). It does NOT catch dotfiles canonical
 * adding a 19th bundled check while plugin's copy stays at 18 (cross-repo
 * divergence; plugin self-consistent but stale).
 *
 * The cross-repo assertion below (commented out) is the durable fix; it
 * activates when plugin's `bundled-registrations.ts` becomes the canonical
 * via active-sessions cluster shim closure.
 *
 * TODO(0.8 / batch-5-closure): uncomment the cross-repo assertion block once
 * plugin canonical-flips for `bundled-registrations.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  BUNDLED_CHECKS_BY_EVENT,
  BUNDLED_CHECK_NAMES,
  type BundledCheckName,
} from "../../src/hooks/bundled-check-names.ts";
import { RegistryBuilder } from "../../src/hooks/registry.ts";
import { registerBundled } from "../../src/hooks/checks/bundled-registrations.ts";
import { pass } from "../../src/hooks/types.ts";
import type { HookEvent } from "../../src/hooks/types.ts";

const EXPECTED_COUNT = 22;

describe("bundled-registrations meta-test", () => {
  it("BUNDLED_CHECK_NAMES has exactly 22 entries", () => {
    expect(BUNDLED_CHECK_NAMES.length).toBe(EXPECTED_COUNT);
  });

  it("BUNDLED_CHECK_NAMES has no duplicates", () => {
    expect(new Set(BUNDLED_CHECK_NAMES).size).toBe(EXPECTED_COUNT);
  });

  it("BUNDLED_CHECK_NAMES is the flattened concatenation of BUNDLED_CHECKS_BY_EVENT", () => {
    const flatFromMap = Object.values(BUNDLED_CHECKS_BY_EVENT).flat();
    expect(BUNDLED_CHECK_NAMES.length).toBe(flatFromMap.length);
    expect(new Set(BUNDLED_CHECK_NAMES)).toEqual(new Set(flatFromMap));
  });

  it("registerBundled produces a sealed registry whose (event, name) tuples match BUNDLED_CHECKS_BY_EVENT", () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    registerBundled(builder);
    const sealed = builder.seal();

    for (const [event, expectedNames] of Object.entries(
      BUNDLED_CHECKS_BY_EVENT,
    )) {
      const registeredAtEvent = sealed.checksFor(event as HookEvent);
      const actualNames = [...registeredAtEvent.values()].map((r) => r.name);
      expect(new Set(actualNames)).toEqual(new Set(expectedNames));
      expect(actualNames.length).toBe(expectedNames.length);
    }
  });

  it("registerBundled total count equals BUNDLED_CHECK_NAMES.length", () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    registerBundled(builder);
    const sealed = builder.seal();

    let totalRegistered = 0;
    for (const event of Object.keys(BUNDLED_CHECKS_BY_EVENT) as HookEvent[]) {
      totalRegistered += sealed.checksFor(event).size;
    }
    expect(totalRegistered).toBe(EXPECTED_COUNT);
  });

  it("registerBundled produces no duplicate names across all events (bidirectional set equality)", () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    registerBundled(builder);
    const sealed = builder.seal();

    const allRegisteredNames: string[] = [];
    for (const event of Object.keys(BUNDLED_CHECKS_BY_EVENT) as HookEvent[]) {
      for (const reg of sealed.checksFor(event).values()) {
        allRegisteredNames.push(reg.name);
      }
    }

    expect(new Set(allRegisteredNames).size).toBe(allRegisteredNames.length);
    expect(new Set(allRegisteredNames)).toEqual(new Set(BUNDLED_CHECK_NAMES));
  });

  // TA-3 PARTIAL fix — pin narrowing at compile time, not just runtime.
  // These blocks verify the type-level guarantees of
  // `RegistryBuilder<BundledCheckName>`. They ride along as runtime no-ops;
  // the assertion is at typecheck time via @ts-expect-error.
  it("type-test — RegistryBuilder<BundledCheckName> rejects non-bundled names at compile time", async () => {
    const builder = new RegistryBuilder<BundledCheckName>();
    const noopFn = async () => pass();

    // Positive: registering a known bundled name compiles.
    builder.register("pre-tool-use", {
      name: "fact-force",
      fn: noopFn,
      description: "test",
      canBlock: false,
      profiles: ["standard"],
    });

    // Negative: typo'd name fails at compile time.
    builder.register("pre-tool-use", {
      // @ts-expect-error - typo'd name "fact-forcce" is not in BundledCheckName
      name: "fact-forcce",
      fn: noopFn,
      description: "test",
      canBlock: false,
      profiles: ["standard"],
    });

    // Negative: non-bundled name fails at compile time (e.g., a dotfiles-only
    // name like "intent-gate").
    builder.register("pre-tool-use", {
      // @ts-expect-error - "intent-gate" is dotfiles-only, not bundled
      name: "intent-gate",
      fn: noopFn,
      description: "test",
      canBlock: false,
      profiles: ["standard"],
    });

    // Runtime sanity — at least the positive registration landed.
    expect(builder.seal().checksFor("pre-tool-use").size).toBeGreaterThan(0);
  });

  // TODO(0.8 / batch-5-closure): cross-repo assertion — uncomment once
  // plugin's bundled-registrations.ts becomes the canonical (currently a
  // copy; dotfiles holds canonical due to active-sessions cross-edge).
  //
  // The assertion below would import dotfiles' check-names.ts
  // ALL_CHECK_NAMES, filter to the bundled-18 subset (lines 13-35 of that
  // file's ALL_CHECK_NAMES `as const` array), and assert set-equality with
  // plugin's BUNDLED_CHECK_NAMES. Cross-repo coupling is intentional at
  // closure time — the goal is plugin's BUNDLED_CHECK_NAMES being the
  // single source of truth, with dotfiles importing it.
  //
  // it("BUNDLED_CHECK_NAMES matches dotfiles canonical bundled-18 subset", () => {
  //   import { ALL_CHECK_NAMES } from "<dotfiles>/src/hooks/check-names.ts";
  //   const dotfilesBundled = ALL_CHECK_NAMES.slice(0, 18); // first 18 are bundled by convention
  //   expect(new Set(BUNDLED_CHECK_NAMES)).toEqual(new Set(dotfilesBundled));
  // });
});
