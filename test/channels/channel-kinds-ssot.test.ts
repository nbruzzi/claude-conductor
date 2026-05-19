// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SSOT tests for `CHANNEL_KINDS` (Phase 4 Step A — Phase 0 prep within B1).
 *
 * Asserts that:
 *   1. The `CHANNEL_KINDS` tuple is the canonical declaration order for
 *      Phase 1 kinds (note → question → handoff → status).
 *   2. The runtime tuple length matches the literal expected size (catches
 *      accidental membership changes that aren't caught by the type system
 *      because TS preserves the literal tuple via `as const`).
 *   3. The `ChannelKind` type derives from the tuple via index-signature —
 *      a representative `kind` value typechecks AND the runtime
 *      `CHANNEL_KINDS.includes(kind)` is `true` for that value.
 *   4. `renderKindPrefix(kind)` returns `[<kind>]` for every member of the
 *      tuple. The exhaustiveness over `CHANNEL_KINDS` proves that the
 *      Layer 1 hook's kind-aware prefix surface covers ALL current kinds
 *      and (by tuple-derivation) auto-covers any kinds appended later in
 *      Layer 3 (walkie-talkie primitives) or Layer 4 (`digest`).
 *
 * Layer 3+4 kind-addition tests live in `test/channels/index.test.ts`
 * (validator acceptance) and `test/channels/cli-send.test.ts` (CLI
 * `VALID_KINDS` acceptance + role-gate carve-out).
 */

import { describe, expect, it } from "bun:test";

import { CHANNEL_KINDS, type ChannelKind } from "../../src/channels/index.ts";
import { renderKindPrefix } from "../../src/channels/render.ts";

describe("CHANNEL_KINDS (SSOT)", () => {
  it("contains the canonical kind set in declaration order (Phase 1 first, Layer 3 walkie-talkie second, Layer 4 digest, L152 live-update, Tier 1 Slice 1 audit-ask last)", () => {
    expect(CHANNEL_KINDS).toEqual([
      // Phase 1 informational + protocol carriers
      "note",
      "question",
      "handoff",
      "status",
      // Phase 4 Step A Layer 3 walkie-talkie primitives
      "ack",
      "roger",
      "over",
      "standby",
      "out",
      // Phase 4 Step A Layer 4 mental-model-sync
      "digest",
      // L152 sibling-onboarding live-update primitive
      "live-update",
      // Tier 1 Slice 1 cycle 2026-05-19 audit-discipline kind cohort
      "audit-ask",
    ]);
  });

  it("preserves tuple length under `as const` declaration", () => {
    // Catches accidental drop (tuple shrinks) or accidental addition
    // (tuple grows) at the SSOT site. Bumped from 4 → 9 with Layer 3
    // walkie-talkie additions; 9 → 10 with Layer 4 `digest`; 10 → 11
    // with L152 `live-update`; 11 → 12 with Tier 1 Slice 1 `audit-ask`.
    expect(CHANNEL_KINDS.length).toBe(12);
  });

  it("derives `ChannelKind` from the tuple via `(typeof CHANNEL_KINDS)[number]`", () => {
    // The actual derivation guarantee is compile-time: the assignment
    // `const typed: ChannelKind = k` typechecks iff every tuple element
    // satisfies the union, which iff `ChannelKind = (typeof CHANNEL_KINDS)[number]`.
    // If this file typechecks (the suite's runtime invocation IS the
    // typecheck contract), the chain is intact. No runtime tautology
    // (per RE-2 fold on Phase 0).
    for (const k of CHANNEL_KINDS) {
      const _typed: ChannelKind = k;
      void _typed;
    }
    // Sentinel runtime assertion that the suite executed (not the
    // derivation property itself, which is compile-time-asserted above).
    expect(CHANNEL_KINDS.length).toBeGreaterThan(0);
  });
});

describe("renderKindPrefix", () => {
  it("returns exactly `[<kind>]` for every CHANNEL_KINDS member (exhaustive)", () => {
    // Exact-string assertion catches divergence from the `[${kind}]`
    // template — including subtler regressions like `[Note]` (case
    // change), `[ note]` (whitespace), or `[note ]` (trailing space)
    // that the prior pattern-only check (per RE-2 fold) would have
    // silently passed.
    for (const k of CHANNEL_KINDS) {
      expect(renderKindPrefix(k)).toBe(`[${k}]`);
    }
  });
});
