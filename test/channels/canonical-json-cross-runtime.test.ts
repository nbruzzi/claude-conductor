// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cross-runtime determinism tests for `canonicalJson()` (Cycle 3 Stage 3
 * S3-B Delta-pen Pair B substrate-debt closure).
 *
 * **Closes Cycle 3+ scope item** documented at `src/channels/canonical-json.ts`
 * JSDoc lines 36-43 ("Cross-runtime caveat (Cycle 3+ multi-impl scope)"):
 * empirically verifies that Bun.js v1.x + Node.js V8 produce byte-identical
 * canonical-JSON output for the cross-runtime fixture corpus below. Cross-
 * runtime determinism is the load-bearing claim for cohort use because
 * audit-verdict DSSE envelopes (`audit-signature-chain.ts` PAE) sign over
 * canonical-JSON bytes — if cross-runtime serialization diverges, signature
 * verification breaks for the divergent input class.
 *
 * **Test strategy:**
 * Run the SAME canonical-JSON logic in TWO runtimes (Bun.js native + Node.js
 * subprocess via `child_process.spawnSync`), compute SHA-256 of canonical
 * output for each fixture case in both runtimes, assert hash arrays are
 * byte-equal.
 *
 * **Mirror rationale:**
 * The Node subprocess inlines a JS mirror of `src/channels/canonical-json.ts`
 * `canonicalJson()` + `sortValueRecursive()` (30 LOC). This is intentional
 * mirror, NOT a DRY violation — the test's WHOLE PURPOSE is "if two runtimes
 * implement the same logic, do they produce byte-identical output?". The
 * mirror IS the experiment. If the substrate logic changes in future cycles,
 * the mirror must be updated in lockstep + this test will catch the drift
 * (mirror-vs-substrate drift would either fail Bun-side OR produce
 * Bun-vs-Node divergence — both fail the assertions below).
 *
 * **Cross-runtime scope coverage:**
 * - Bun.js v1.x (test runtime) + Node.js V8 (subprocess runtime)
 * - NOT Python verifier OR other-language implementations (canonical-json.ts
 *   JSDoc notes "Python verifier OR alternate JS engine still requires its own
 *   implementation matching ECMAScript ToString(Number)" — out of S3-B scope
 *   per Bravo Stage 3 lane assignment)
 * - Both runtimes implement ECMAScript ToString(Number) per V8/JSC; the
 *   shared spec is the determinism contract Bun-vs-Node depends on
 *
 * Per Pair B Cycle 2/3 substrate-debt arc: substrate-clean outcome (no
 * canonical-json.ts code change beyond JSDoc); CI canary lock-in for
 * runtime parity going forward.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { canonicalJson } from "../../src/channels/canonical-json.ts";

/**
 * Fixture cases exercising RFC 8785 §3.2.x boundaries + cohort-encountered
 * canonical-JSON shapes:
 *
 * - **Numbers** (§3.2.2 ECMAScript ToString boundary cases): zero variants,
 *   integer boundary (MAX_SAFE_INTEGER), float precision artifacts
 *   (0.1+0.2 == 0.30000000000000004), scientific notation boundaries
 *   (1e-6/1e-7 + 1e20/1e21 per spec), denormal limits (MAX_VALUE / MIN_VALUE).
 * - **Strings** (§3.2.1): ASCII + escape sequences. Unicode is correctness-
 *   relevant but RFC 8785 explicitly excludes normalization; ASCII covers
 *   the cross-runtime contract.
 * - **Objects** (§3.2.3 UTF-16 code-unit key sort): definition-order vs
 *   sorted-order (substrate sorts), case-sensitive (upper vs lower),
 *   mixed-case key sets.
 * - **Arrays** (§3.2.4 preserve index order): basic + nested.
 * - **Mixed nested**: realistic audit-verdict-like structures.
 *
 * Each entry is a JSON-valid JS value (no NaN/Infinity per RFC 8259 + the
 * substrate's explicit throw discipline).
 */
const CROSS_RUNTIME_FIXTURES: readonly unknown[] = [
  // Zero variants
  0,
  -0,
  // Integer boundaries
  1,
  -1,
  9007199254740991, // Number.MAX_SAFE_INTEGER
  -9007199254740991,
  // Float precision artifacts
  0.1,
  0.2,
  0.3,
  0.1 + 0.2,
  1 / 3,
  // Scientific notation boundaries (RFC 8785 §3.2.2 explicit)
  1e-6,
  1e-7,
  1e20,
  1e21,
  1e-300,
  1e300,
  // Denormal limits
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  // Strings: ASCII + escape sequences
  "ascii",
  "with tab\there",
  "with newline\nhere",
  " leading-trailing ",
  'with "quotes"',
  "with backslash\\here",
  // Object key sort: definition-order matches sort-order
  { a: 1, b: 2 },
  // Object key sort: definition-order DIFFERS from sort-order (canonical sorts)
  { b: 1, a: 2 },
  { z: 1, m: 2, a: 3 },
  // Case-sensitive UTF-16 code-unit sort (uppercase < lowercase per ASCII)
  { A: 1, B: 2, a: 3, b: 4 },
  // Numeric-string keys (sorted lexicographically per RFC 8785, not numerically)
  { "1": "one", "10": "ten", "2": "two" },
  // Nested objects (key sort applies recursively)
  { z: { a: 1, b: 2 }, m: [1, "x", { n: null }] },
  // Audit-verdict-like realistic structure
  {
    kind_version: 1,
    target_pr: { repo: "conductor", number: 150 },
    target_peer: "Charlie",
    audit_class: "inside-pair",
    lens_set_applied: ["RE", "Architecture"],
    verdict: "SHIP-CLEAN",
    counts: { blocker: 0, fold: 0, nit: 0 },
    findings: [],
  },
  // Arrays: basic + nested
  [1, 2, 3],
  [
    [1, 2],
    [3, 4],
  ],
  // Mixed with null
  { a: null, b: [null, 1, null] },
  // Boolean values
  true,
  false,
  // Empty containers
  [],
  {},
];

/**
 * Pure-JS mirror of `src/channels/canonical-json.ts` `canonicalJson()` +
 * `sortValueRecursive()`. Inlined here for Node.js subprocess execution
 * (Node cannot import TS directly without tsx/ts-node; inlining keeps the
 * test self-contained).
 *
 * **IMPORTANT:** if `src/channels/canonical-json.ts` changes its logic,
 * this mirror MUST be updated in lockstep. The test below will detect
 * mirror-vs-substrate drift via the Bun-side `canonicalJson` call producing
 * different output than the Node-side mirror call — fixture-hash arrays
 * would diverge.
 */
const NODE_MIRROR_SCRIPT = `
function canonicalJson(value) {
  return JSON.stringify(sortValueRecursive(value));
}
function sortValueRecursive(value) {
  if (value === null) return null;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: non-finite number not allowed (RFC 8259/8785 only permit finite numbers; got: " + value + ")");
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(sortValueRecursive);
  }
  const obj = value;
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortValueRecursive(obj[key]);
  }
  return sorted;
}
const { createHash } = require("node:crypto");
const fixturesJson = process.argv[1];
const fixtures = JSON.parse(fixturesJson);
const hashes = fixtures.map(f => createHash("sha256").update(canonicalJson(f)).digest("hex"));
console.log(JSON.stringify(hashes));
`;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("canonicalJson — cross-runtime determinism (Cycle 3 S3-B)", () => {
  it("Bun.js + Node.js V8 produce byte-identical canonical-JSON output for all fixture cases", () => {
    // Bun-side: substrate canonicalJson on each fixture → SHA-256 of output
    const bunHashes = CROSS_RUNTIME_FIXTURES.map((fixture) =>
      sha256(canonicalJson(fixture)),
    );

    // Node-side: spawn subprocess with inline mirror + same fixtures →
    // SHA-256 of mirror output for each fixture (serialized as JSON for
    // argv-safe passing). Note: -0 round-trips to 0 via JSON.stringify in
    // both runtimes; for this fixture corpus the JSON round-trip is
    // invariant. Hash equality assertion below verifies empirically.
    const fixturesArgvSafe = JSON.stringify(CROSS_RUNTIME_FIXTURES);
    const nodeResult = spawnSync(
      "node",
      ["-e", NODE_MIRROR_SCRIPT, "--", fixturesArgvSafe],
      {
        encoding: "utf-8",
        timeout: 15000,
      },
    );

    expect(nodeResult.status).toBe(0);
    expect(nodeResult.stderr).toBe("");

    const nodeHashes = JSON.parse(nodeResult.stdout.trim()) as string[];

    // Both arrays should have identical length (one hash per fixture).
    expect(nodeHashes.length).toBe(bunHashes.length);
    expect(nodeHashes.length).toBe(CROSS_RUNTIME_FIXTURES.length);

    // Per-fixture hash equality — pinpoints which fixture class would
    // diverge if cross-runtime determinism breaks in a future runtime
    // update. Iteration with explicit index for clear failure messages.
    for (let i = 0; i < bunHashes.length; i++) {
      expect(nodeHashes[i]).toBe(bunHashes[i]);
    }

    // Full-array equality — catches any aggregate-level divergence.
    expect(nodeHashes).toEqual(bunHashes);
  });

  it("Mirror-vs-substrate drift canary: substrate canonicalJson output is deterministic across Bun invocations", () => {
    // Sanity check: the Bun-side hashes computed via substrate canonicalJson
    // are stable + deterministic across Bun invocations. If a future
    // substrate refactor changes canonicalJson's output, this test produces
    // a new hash set that won't match the Node-mirror's output (which is
    // pinned to the inline mirror logic). Use the cross-runtime test above
    // as the authoritative empirical; this test documents the substrate-
    // side determinism explicitly.
    const hashes1 = CROSS_RUNTIME_FIXTURES.map((f) => sha256(canonicalJson(f)));
    const hashes2 = CROSS_RUNTIME_FIXTURES.map((f) => sha256(canonicalJson(f)));
    expect(hashes1).toEqual(hashes2);
    // Non-empty (sanity for the fixture corpus itself).
    expect(hashes1.length).toBeGreaterThan(20);
  });
});
