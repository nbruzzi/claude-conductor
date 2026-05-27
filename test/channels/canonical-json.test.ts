// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the RFC 8785 JCS canonical-JSON serializer (`canonicalJson`).
 * Cycle 1 substrate-core PR-A5 baseline; Cycle 2 substrate-debt
 * extension per Delta-pen `cycle-2-substrate-debt-pair-b-canonical-json-2026-05-27.md`.
 *
 * Coverage organized by Section:
 *   1. Primitives (string / number / boolean / null pass-through)
 *   2. Empty containers (object + array)
 *   3. Object key sorting (single-level)
 *   4. Nested object key sorting (recursion)
 *   5. Arrays preserve index order (RFC 8785 §3.2.4)
 *   6. Idempotence (canonicalJson(canonicalJson(x)) ≡ canonicalJson(x))
 *   7. Stability across input orderings (ABCDEF vs FEDCBA → same output)
 *   8. AuditVerdictBody fixture (realistic substrate use case)
 *   9. §3.2.2 number lock fixtures — empirical fixtures locking RFC 8785
 *      number canonicalization behavior on Bun.js (T9.1-T9.2 baseline +
 *      T9.3-T9.9 Cycle 2 substrate-debt extension)
 *  10. NaN/Infinity REJECT contract (Cycle 2 substrate-debt new behavior)
 */

import { describe, expect, it } from "bun:test";

import { canonicalJson } from "../../src/channels/canonical-json.ts";

describe("canonicalJson — Section 1: primitives pass through", () => {
  it("T1.1: string", () => {
    expect(canonicalJson("hello")).toBe('"hello"');
  });
  it("T1.2: number (integer)", () => {
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-1)).toBe("-1");
  });
  it("T1.3: boolean", () => {
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });
  it("T1.4: null", () => {
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("canonicalJson — Section 2: empty containers", () => {
  it("T2.1: empty object → '{}'", () => {
    expect(canonicalJson({})).toBe("{}");
  });
  it("T2.2: empty array → '[]'", () => {
    expect(canonicalJson([])).toBe("[]");
  });
});

describe("canonicalJson — Section 3: object keys sorted UTF-16 code unit order", () => {
  it("T3.1: single-level object keys sorted", () => {
    expect(canonicalJson({ b: 2, a: 1, c: 3 })).toBe('{"a":1,"b":2,"c":3}');
  });
  it("T3.2: object with uppercase + lowercase keys sorts uppercase first (ASCII A=65 < a=97)", () => {
    expect(canonicalJson({ b: 2, A: 1 })).toBe('{"A":1,"b":2}');
  });
  it("T3.3: object with digit keys sorts digits before letters (ASCII 0=48 < A=65)", () => {
    expect(canonicalJson({ a: 2, "0": 1 })).toBe('{"0":1,"a":2}');
  });
});

describe("canonicalJson — Section 4: nested objects recursive sort", () => {
  it("T4.1: nested object keys also sorted", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(
      '{"outer":{"a":2,"z":1}}',
    );
  });
  it("T4.2: deeply nested objects fully sorted", () => {
    const input = { c: { b: { a: 1, z: 2 } }, a: 1 };
    expect(canonicalJson(input)).toBe('{"a":1,"c":{"b":{"a":1,"z":2}}}');
  });
});

describe("canonicalJson — Section 5: arrays preserve index order", () => {
  it("T5.1: array order preserved (no sort)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
  it("T5.2: array of objects — each object key-sorted but array order preserved", () => {
    expect(canonicalJson([{ b: 2, a: 1 }, { z: 1 }])).toBe(
      '[{"a":1,"b":2},{"z":1}]',
    );
  });
});

describe("canonicalJson — Section 6: idempotence", () => {
  it("T6.1: canonicalJson(parsed(canonicalJson(x))) ≡ canonicalJson(x)", () => {
    const x = { c: 3, a: 1, b: { z: 1, y: 2 } };
    const once = canonicalJson(x);
    const twice = canonicalJson(JSON.parse(once));
    expect(twice).toBe(once);
  });
});

describe("canonicalJson — Section 7: input-ordering stability", () => {
  it("T7.1: two semantically-identical inputs with different key insertion orders produce identical canonical output", () => {
    const a = { kind_version: 1, target_pr: { number: 99, repo: "conductor" } };
    const b = { target_pr: { repo: "conductor", number: 99 }, kind_version: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("canonicalJson — Section 8: audit-verdict fixture", () => {
  it("T8.1: realistic AuditVerdictBody-shaped input canonicalizes deterministically", () => {
    const body = {
      kind_version: 1,
      target_pr: { repo: "conductor", number: 99 },
      target_peer: "Alpha",
      lens_set_applied: ["RE", "Architecture"],
      audit_class: "inside-pair",
      audit_axes: ["surface", "depth"],
      verdict: "SHIP-CLEAN",
      counts: { blocker: 0, fold: 0, nit: 0 },
      three_option_ask: {
        a_ratify: "PR cleared",
        b_fold_if_applicable: null,
        c_reframe_if_applicable: null,
      },
      findings: [],
    };
    const out = canonicalJson(body);
    expect(canonicalJson(JSON.parse(out))).toBe(out);
    expect(out.indexOf('"audit_axes"')).toBeLessThan(
      out.indexOf('"audit_class"'),
    );
    expect(out.indexOf('"kind_version"')).toBeLessThan(
      out.indexOf('"lens_set_applied"'),
    );
  });
});

describe("canonicalJson — Section 9: §3.2.2 number lock fixtures", () => {
  it("T9.1: ASCII strings round-trip stably (cohort-relevant case)", () => {
    expect(canonicalJson({ a: "Alpha" })).toBe('{"a":"Alpha"}');
    expect(canonicalJson({ k: "queue" })).toBe('{"k":"queue"}');
  });

  it("T9.2: integers within Number.MAX_SAFE_INTEGER round-trip stably", () => {
    expect(canonicalJson({ n: 42 })).toBe('{"n":42}');
    expect(canonicalJson({ n: 0 })).toBe('{"n":0}');
    expect(canonicalJson({ n: Number.MAX_SAFE_INTEGER })).toBe(
      `{"n":${Number.MAX_SAFE_INTEGER}}`,
    );
  });

  it("T9.3: float precision artifact (0.1 + 0.2)", () => {
    expect(canonicalJson({ n: 0.1 + 0.2 })).toBe('{"n":0.30000000000000004}');
  });

  it("T9.4: scientific-notation boundary 1e-6 (no exponent) vs 1e-7 (exponent)", () => {
    expect(canonicalJson({ n: 1e-6 })).toBe('{"n":0.000001}');
    expect(canonicalJson({ n: 1e-7 })).toBe('{"n":1e-7}');
  });

  it("T9.5: scientific-notation boundary 1e20 (no exponent) vs 1e21 (exponent)", () => {
    expect(canonicalJson({ n: 1e20 })).toBe('{"n":100000000000000000000}');
    expect(canonicalJson({ n: 1e21 })).toBe('{"n":1e+21}');
  });

  it("T9.6: very large float Number.MAX_VALUE", () => {
    expect(canonicalJson({ n: Number.MAX_VALUE })).toBe(
      `{"n":${Number.MAX_VALUE}}`,
    );
  });

  it("T9.7: denormal small float Number.MIN_VALUE", () => {
    expect(canonicalJson({ n: Number.MIN_VALUE })).toBe(
      `{"n":${Number.MIN_VALUE}}`,
    );
  });

  it("T9.8: negative-zero canonicalizes to '0'", () => {
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });

  it("T9.9: extreme denormal 1e-300", () => {
    expect(canonicalJson({ n: 1e-300 })).toBe('{"n":1e-300}');
  });
});

describe("canonicalJson — Section 10: NaN/Infinity REJECT contract", () => {
  it("T10.1: direct NaN throws Error", () => {
    expect(() => canonicalJson(NaN)).toThrow(/non-finite number not allowed/);
  });

  it("T10.2: direct Infinity throws Error", () => {
    expect(() => canonicalJson(Infinity)).toThrow(
      /non-finite number not allowed/,
    );
  });

  it("T10.3: direct -Infinity throws Error", () => {
    expect(() => canonicalJson(-Infinity)).toThrow(
      /non-finite number not allowed/,
    );
  });

  it("T10.4: NaN nested in object throws Error", () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(
      /non-finite number not allowed/,
    );
  });

  it("T10.5: Infinity nested in array throws Error", () => {
    expect(() => canonicalJson([1, 2, Infinity])).toThrow(
      /non-finite number not allowed/,
    );
  });

  it("T10.6: NaN deeply nested (3+ levels) throws Error", () => {
    expect(() => canonicalJson({ a: { b: [NaN] } })).toThrow(
      /non-finite number not allowed/,
    );
  });
});
