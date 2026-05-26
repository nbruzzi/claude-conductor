// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Canonical-JSON serialization (RFC 8785 JCS subset) for substrate
 * signature scopes (Cycle 1 substrate-core PR-A5; Pair B Charlie-pen per
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §2.6 Migration 003
 * + §4.2 envelope shape).
 *
 * **Why a separate module:** RFC 8785 canonical-JSON is the payload-level
 * serialization-determinism primitive consumed by DSSE PAE (audit-signature-
 * chain.ts) + Pair A Layer 2 lineage envelope embedding. Both layers need a
 * single SSOT for canonical encoding so semantically-identical bodies encode
 * to identical bytes across cohort sessions + cross-edge consumers (Bravo +
 * Delta lens-prep findings 2026-05-26: "JCS solves payload-level
 * serialization-determinism — both load-bearing in v0.3 wrapper" +
 * "canonical-encoding rule must be consistent across both layers").
 *
 * **RFC 8785 subset scope (documented limitations):** This impl ships the
 * core object-key-sort + nested-object recursion needed by the
 * `audit-verdict` schema (integer + UTF-8 string fields only). It does NOT
 * implement RFC 8785 §3.2.2 full number canonicalization (no scientific-
 * notation normalization for large/small floats); not implement §3.2.5 full
 * Unicode normalization (relies on V8/JSC's UTF-16 string repr being stable
 * for our ASCII/Latin-1-dominant cohort identifiers). When the audit-verdict
 * body schema extends to include floats OR non-ASCII strings, this impl
 * needs an extension or library replacement — flagged in test fixtures
 * (`test/channels/canonical-json.test.ts` documents the limitations as
 * empirical fixtures so regressions are caught).
 *
 * **Why hand-rolled vs library:** substrate-clean over library-dep per
 * cohort consensus (PR-A3 pattern: paths.ts cohortKeysDir() SSOT chosen
 * over P3_FILE_ALLOWLIST escape-hatch). Per `[[feedback-substrate-clean-
 * over-escape-hatch-when-cohort-leans]]`. The subset is small (~20 lines);
 * a library would add dep surface for minimal incremental coverage given
 * the current scope.
 *
 * **Key-sort canonicality:** Object.keys().sort() default behavior compares
 * by UTF-16 code units per ECMA-262 §7.2.13 (Abstract Relational Comparison
 * step 3.c.iv `lesser code unit`). RFC 8785 §3.2.3 specifies UTF-16 code-
 * unit order for property name sort. Match.
 */

/**
 * Serialize a value to canonical-JSON-RFC-8785-subset string.
 *
 * - Recursively sorts object keys by UTF-16 code-unit order
 * - Recurses into arrays preserving index order (RFC 8785 §3.2.4)
 * - Preserves `null` literal
 * - Numbers + booleans + strings serialized via JSON.stringify default
 *   (integers + ASCII/Latin-1 strings are stable; non-ASCII strings may
 *   have edge cases per the subset limitations above)
 *
 * Pure function (no I/O; no side effects). Caller passes the value as
 * a JS object/array/primitive; this module does not parse JSON itself
 * (caller is responsible for JSON.parse if input is a string).
 *
 * @param value Any JSON-compatible value (object / array / string /
 *              number / boolean / null). Functions + undefined +
 *              symbols are silently elided per JSON.stringify semantics
 *              — caller's responsibility to pre-validate shape.
 * @returns Canonical-JSON-RFC-8785-subset string (no extra whitespace;
 *          object keys sorted UTF-16-code-unit order).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValueRecursive(value));
}

/**
 * Recursively rebuild a value with object keys sorted. Pure helper.
 *
 * Per RFC 8785 §3.2.3 + §3.2.4: object property name sort applies
 * recursively to nested objects; arrays preserve index order.
 *
 * Footgun: `typeof null === "object"` — explicit null-check FIRST per
 * the parent module's discipline (`audit-verdict.ts` parser pattern).
 */
function sortValueRecursive(value: unknown): unknown {
  if (value === null) return null;
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
