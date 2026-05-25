// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, test } from "bun:test";

import { isValidArtifactId } from "../../src/shared/artifact-id.ts";

// Cycle 2026-05-25 Phase 6.6 paired-contract slice (Delta-pen).
//
// Conductor-side paired-contract FENCE mirroring the dashboard's
// `test/lib/types/live-route-substrate-contract.test.ts` at exact fixture
// parity. Per `feedback-cross-edge-contract-via-paired-tests.md`:
// substrate-side and consumer-side BOTH assert the same accept/reject
// behavior so cross-edge regex drift is detected at conductor-tier verify
// BEFORE downstream dashboard tests would catch via cross-edge integration
// (CI sequencing: conductor verify gates dashboard CI which depends on
// conductor file:.. pin).
//
// Coverage relationship:
//   - This file: EXACT-MIRROR-DISCIPLINE for the paired-contract; same
//     9 accept + 9 reject + 4 non-string fixtures as dashboard side.
//   - `test/shared/artifact-id.test.ts` (existing; cycle 2026-05-23):
//     SUPERSET behavioral coverage (15 accept + 15 reject + 4 non-string)
//     including VALID_ID_REGEX shape assertion. Do NOT remove that test
//     assuming this paired one covers everything — the SUPERSET test is
//     the conductor-internal behavior fence; this paired test is the
//     cross-edge contract with the dashboard consumer.
//
// v0.2 lock-step trigger (per L2-O3 plan-tier fold):
//   IF Charlie's §6.5 dashboard-side cross-edge-contract-tests slice
//   expands the dashboard ACCEPT_CORPUS or REJECT_CORPUS, v0.2 of this
//   file MUST land in the SAME cycle as that 6.5 ship (no cycle-straddle).
//   Trigger ensures the paired contract stays in exact-fixture-mirror
//   shape across cycles.
//
// Sibling patterns:
//   - `feedback-cross-edge-contract-via-paired-tests` (the discipline)
//   - `feedback-substrate-shim-mirror-on-plugin-export-changes` (parallel
//     pattern for value-exports)
//   - `feedback-audit-cohort-missed-cross-edge-shim-consumer` (cycle
//     2026-05-25 origin; this paired-test is the test-substrate analog of
//     the wire-schema `cross_edge_consumers_verified` discipline shipped
//     in PR #120)

type CorpusEntry = { readonly id: string; readonly expected: boolean };

const ACCEPT_CORPUS: readonly CorpusEntry[] = [
  { id: "alpha", expected: true },
  { id: "Charlie", expected: true },
  { id: "2026-05-22_pair-cd", expected: true },
  { id: "A4", expected: true },
  { id: "AW1", expected: true },
  { id: "node_v1.2.3", expected: true },
  { id: "T4-X1", expected: true },
  { id: "x", expected: true },
  { id: "alpha.", expected: true },
];

const REJECT_CORPUS: readonly CorpusEntry[] = [
  { id: "", expected: false },
  { id: ".alpha", expected: false },
  { id: "..", expected: false },
  { id: "/", expected: false },
  { id: "alpha/beta", expected: false },
  { id: "alpha bar", expected: false },
  { id: "föö", expected: false },
  { id: "alpha%2Fbar", expected: false },
  { id: "x".repeat(129), expected: false },
];

describe("dashboard paired-contract FENCE — accept corpus", () => {
  for (const { id, expected } of ACCEPT_CORPUS) {
    test(`${JSON.stringify(id)} → ${expected}`, () => {
      expect(isValidArtifactId(id)).toBe(expected);
    });
  }
});

describe("dashboard paired-contract FENCE — reject corpus", () => {
  for (const { id, expected } of REJECT_CORPUS) {
    test(`${JSON.stringify(id)} → ${expected}`, () => {
      expect(isValidArtifactId(id)).toBe(expected);
    });
  }
});

describe("dashboard paired-contract FENCE — non-string inputs reject", () => {
  test("undefined → false (type-guard narrows)", () => {
    expect(isValidArtifactId(undefined)).toBe(false);
  });

  test("null → false", () => {
    expect(isValidArtifactId(null)).toBe(false);
  });

  test("number 87 → false", () => {
    expect(isValidArtifactId(87)).toBe(false);
  });

  test("object → false", () => {
    expect(isValidArtifactId({ id: "alpha" })).toBe(false);
  });
});
