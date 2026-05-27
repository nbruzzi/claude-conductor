// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Canonical-JSON serialization (RFC 8785 JCS) for substrate signature
 * scopes.
 *
 * **Spec compliance status on Bun.js v1.x** (verified empirically Cycle 2
 * substrate-debt slice plan body §1; 17 number edge cases via `bun -e`):
 *
 * - RFC 8785 §3.2.2 (Numbers) — **COMPLIANT for all valid JSON numbers.**
 *   Bun's `JSON.stringify` implements ECMAScript `ToString(Number)` per the
 *   language spec across integer boundaries, float precision artifacts,
 *   scientific-notation boundaries at 1e-6/1e-7 + 1e20/1e21, and denormal
 *   limits (Number.MAX_VALUE / Number.MIN_VALUE). RFC 8785 §3.2.2 verbatim:
 *   "adopts the ToString(Number) abstract operation as defined in
 *   ECMAScript 2017".
 * - RFC 8785 §3.2.3 (Object property sorting) — COMPLIANT (recursive
 *   `Object.keys().sort()` per UTF-16 code-unit order per ECMA-262 §7.2.13).
 * - RFC 8785 §3.2.4 (Array preservation) — COMPLIANT (no array sort; index
 *   order preserved per JSON value model).
 * - RFC 8785 §3.2.1 (Strings) — COMPLIANT for valid Unicode. RFC 8785
 *   explicitly EXCLUDES Unicode normalization ("preserve string data as
 *   is"); this impl follows the spec.
 *
 * **NaN/Infinity rejection** (Cycle 2 new contract):
 *
 * `JSON.stringify` silently coerces NaN/Infinity/-Infinity to JSON `"null"`,
 * which is incorrect per RFC 8259 (which excludes non-finite numbers from
 * valid JSON; RFC 8785 inherits this exclusion). This module THROWS on
 * non-finite input to surface caller-side data-validation gaps rather than
 * silently producing wrong output. The recursive guard catches both direct
 * (`canonicalJson(NaN)`) and arbitrarily nested
 * (`canonicalJson({a: [{b: Infinity}]})`) cases.
 *
 * **Cross-runtime determinism** (Cycle 3 Stage 3 S3-B empirical closure):
 *
 * Bun.js v1.x + Node.js V8 produce byte-identical canonical-JSON output for
 * the cross-runtime fixture corpus per
 * `test/channels/canonical-json-cross-runtime.test.ts` (Bun-native call vs
 * Node.js subprocess via `child_process.spawnSync`; SHA-256 hash equality
 * across all fixture cases — number boundaries + scientific-notation
 * boundaries + denormal limits + escape-string edge cases + object key-sort
 * cases including numeric-string keys sorted lexicographically + nested
 * structures + audit-verdict-like realistic shapes). CI canary locks
 * Bun-vs-Node determinism going forward. Both runtimes implement ECMAScript
 * ToString(Number) per V8/JSC; the shared spec is the cross-runtime
 * contract.
 *
 * **Non-V8 runtimes** (Python verifier, alternate JS engines without ToString
 * conformance, etc.) still require their own implementation matching
 * ECMAScript ToString(Number) behavior. Cohort scope remains Bun + Node V8;
 * non-V8 cross-runtime parity is out of substrate scope (deferred to a
 * dedicated verifier impl per language if/when needed).
 *
 * **Why a separate module:** RFC 8785 canonical-JSON is the payload-level
 * serialization-determinism primitive consumed by DSSE PAE
 * (`audit-signature-chain.ts`) + Pair A Layer 2 lineage envelope embedding.
 * Single SSOT for canonical encoding so semantically-identical bodies encode
 * to identical bytes across cohort sessions + cross-edge consumers.
 *
 * **Why hand-rolled vs library:** substrate-clean over library-dep per
 * cohort consensus (PR-A3 paths.ts cohortKeysDir() SSOT precedent). Empirical
 * verification (Cycle 2 substrate-debt slice plan body §1) shows
 * `JSON.stringify` + recursive key-sort produces RFC 8785-compliant output
 * on Bun.js — no library dependency needed for current scope.
 *
 * **Key-sort canonicality:** `Object.keys().sort()` default behavior compares
 * by UTF-16 code units per ECMA-262 §7.2.13 (Abstract Relational Comparison
 * step 3.c.iv `lesser code unit`). RFC 8785 §3.2.3 specifies UTF-16 code-
 * unit order for property name sort. Match.
 */

/**
 * Serialize a value to canonical-JSON-RFC-8785 string.
 *
 * - Recursively sorts object keys by UTF-16 code-unit order
 * - Recurses into arrays preserving index order
 * - Preserves `null` literal
 * - Numbers serialized via ECMAScript ToString (RFC 8785 §3.2.2 compliant
 *   on Bun.js)
 * - Strings + booleans serialized via JSON.stringify default
 * - **Throws on NaN / Infinity / -Infinity** (not valid JSON per RFC 8259;
 *   caller must validate input shape)
 *
 * Pure function (no I/O; no side effects). Caller passes the value as
 * a JS object/array/primitive; this module does not parse JSON itself
 * (caller is responsible for JSON.parse if input is a string).
 *
 * @param value Any JSON-compatible value (object / array / string /
 *              number / boolean / null). Functions + undefined +
 *              symbols are silently elided per JSON.stringify semantics
 *              — caller's responsibility to pre-validate shape.
 * @returns Canonical-JSON-RFC-8785 string (no extra whitespace; object keys
 *          sorted UTF-16-code-unit order).
 * @throws {Error} If input contains NaN / Infinity / -Infinity (direct or
 *                 nested). RFC 8259 excludes non-finite numbers from valid
 *                 JSON; substrate should not produce silent "null" coercion.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValueRecursive(value));
}

/**
 * Recursively rebuild a value with object keys sorted. Pure helper.
 *
 * Per RFC 8785 §3.2.3 (Sorting of Object Properties): object property
 * name sort applies recursively to nested objects; arrays preserve
 * index order (per the JSON value model — no array-sort step).
 *
 * Footgun: `typeof null === "object"` — explicit null-check FIRST per
 * the parent module's discipline (`audit-verdict.ts` parser pattern).
 *
 * NaN/Infinity guard: `Number.isFinite()` rejects non-finite numbers at the
 * primitive branch. The recursion catches arbitrary-depth nested NaN/Infinity
 * inside objects + arrays.
 */
function sortValueRecursive(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(
      `canonicalJson: non-finite number not allowed (RFC 8259/8785 only permit finite numbers; got: ${value})`,
    );
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(sortValueRecursive);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortValueRecursive(obj[key]);
  }
  return sorted;
}
