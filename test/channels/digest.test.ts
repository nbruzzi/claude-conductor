// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the `digest` message kind's shared parser
 * (`parseDigestBody`, Phase 4 Step A Layer 4).
 *
 * Coverage:
 *   - Happy path: valid JSON conforming to `DigestBody` → typed object.
 *   - Round-trip: `JSON.stringify` + `parseDigestBody` yields a body
 *     that equals the original by field (drift catch for any future
 *     serialization-vs-parse asymmetry).
 *   - Parse failures: invalid JSON; non-object root; array root;
 *     wrong `kind_version`; missing field; non-string array element;
 *     non-numeric / NaN / negative / infinite budget; non-string
 *     `next_pickable`.
 *   - Forward-compat: extra unknown fields in the body do NOT break
 *     parsing of the v1 subset (parser ignores them; future v2 schema
 *     can layer cleanly).
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 §Phase 3.
 */

import { describe, expect, it } from "bun:test";

import { parseDigestBody, type DigestBody } from "../../src/channels/digest.ts";

function validBody(overrides: Partial<DigestBody> = {}): DigestBody {
  return {
    kind_version: 1,
    what_shipped: ["PR #41 at 3e1ab3d"],
    what_verified: ["typecheck", "test", "audit:CLI-DX"],
    audit_class_paid: ["sibling-shape-miss"],
    next_pickable: "backlog-item-42",
    blockers: [],
    verification_budget_consumed_ms: 12000,
    ...overrides,
  };
}

describe("parseDigestBody — happy path", () => {
  it("parses a valid digest body into a typed DigestBody", () => {
    const body = JSON.stringify(validBody());
    const parsed = parseDigestBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind_version).toBe(1);
    expect(parsed?.what_shipped).toEqual(["PR #41 at 3e1ab3d"]);
    expect(parsed?.what_verified).toEqual([
      "typecheck",
      "test",
      "audit:CLI-DX",
    ]);
    expect(parsed?.audit_class_paid).toEqual(["sibling-shape-miss"]);
    expect(parsed?.next_pickable).toBe("backlog-item-42");
    expect(parsed?.blockers).toEqual([]);
    expect(parsed?.verification_budget_consumed_ms).toBe(12000);
  });

  it("accepts empty string-arrays (no shipped / no verified / no audit-class / no blockers)", () => {
    const body = JSON.stringify(
      validBody({
        what_shipped: [],
        what_verified: [],
        audit_class_paid: [],
        blockers: [],
      }),
    );
    const parsed = parseDigestBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.what_shipped).toEqual([]);
    expect(parsed?.blockers).toEqual([]);
  });

  it("accepts a zero verification budget", () => {
    const body = JSON.stringify(
      validBody({ verification_budget_consumed_ms: 0 }),
    );
    expect(parseDigestBody(body)?.verification_budget_consumed_ms).toBe(0);
  });

  it("round-trips through JSON.stringify + parseDigestBody (no drift)", () => {
    const original = validBody({
      what_shipped: [
        "PR #41 at 3e1ab3d",
        "Commit b9e277e on phase-4-step-a-b1-layer-3",
      ],
      audit_class_paid: ["sibling-shape-miss", "prompt-injection-surface"],
      blockers: ["PR #41 awaiting Nick review"],
      verification_budget_consumed_ms: 47500,
    });
    const serialized = JSON.stringify(original);
    const parsed = parseDigestBody(serialized);
    expect(parsed).toEqual(original);
  });
});

describe("parseDigestBody — parse failures", () => {
  it("returns null for invalid JSON", () => {
    expect(parseDigestBody("not json")).toBeNull();
    expect(parseDigestBody("{")).toBeNull();
    expect(parseDigestBody("")).toBeNull();
  });

  it("returns null for non-object roots", () => {
    expect(parseDigestBody("null")).toBeNull();
    expect(parseDigestBody('"string"')).toBeNull();
    expect(parseDigestBody("42")).toBeNull();
    expect(parseDigestBody("true")).toBeNull();
  });

  it("returns null for an array root", () => {
    expect(parseDigestBody("[]")).toBeNull();
    expect(parseDigestBody('[1, "two"]')).toBeNull();
  });

  it("returns null when kind_version is missing", () => {
    const body = validBody() as unknown as Record<string, unknown>;
    delete body["kind_version"];
    expect(parseDigestBody(JSON.stringify(body))).toBeNull();
  });

  it("returns null when kind_version is not 1", () => {
    expect(
      parseDigestBody(JSON.stringify({ ...validBody(), kind_version: 2 })),
    ).toBeNull();
    expect(
      parseDigestBody(JSON.stringify({ ...validBody(), kind_version: "1" })),
    ).toBeNull();
  });

  it("returns null when any required string-array field is missing", () => {
    for (const field of [
      "what_shipped",
      "what_verified",
      "audit_class_paid",
      "blockers",
    ] as const) {
      const body = validBody() as unknown as Record<string, unknown>;
      delete body[field];
      expect(parseDigestBody(JSON.stringify(body))).toBeNull();
    }
  });

  it("returns null when a string-array field contains a non-string", () => {
    expect(
      parseDigestBody(
        JSON.stringify({ ...validBody(), what_shipped: ["valid", 42] }),
      ),
    ).toBeNull();
    expect(
      parseDigestBody(
        JSON.stringify({ ...validBody(), audit_class_paid: [null] }),
      ),
    ).toBeNull();
  });

  it("returns null when a string-array field is not an array", () => {
    expect(
      parseDigestBody(
        JSON.stringify({ ...validBody(), blockers: "not-an-array" }),
      ),
    ).toBeNull();
  });

  it("returns null when next_pickable is missing or non-string", () => {
    const missing = validBody() as unknown as Record<string, unknown>;
    delete missing["next_pickable"];
    expect(parseDigestBody(JSON.stringify(missing))).toBeNull();

    expect(
      parseDigestBody(JSON.stringify({ ...validBody(), next_pickable: 42 })),
    ).toBeNull();
  });

  it("returns null when verification_budget_consumed_ms is missing, non-numeric, NaN, negative, or non-finite", () => {
    const missing = validBody() as unknown as Record<string, unknown>;
    delete missing["verification_budget_consumed_ms"];
    expect(parseDigestBody(JSON.stringify(missing))).toBeNull();

    expect(
      parseDigestBody(
        JSON.stringify({
          ...validBody(),
          verification_budget_consumed_ms: "12000",
        }),
      ),
    ).toBeNull();
    expect(
      parseDigestBody(
        JSON.stringify({
          ...validBody(),
          verification_budget_consumed_ms: -1,
        }),
      ),
    ).toBeNull();
    // JSON.stringify serializes NaN / Infinity as null; if a hand-built
    // JSON string smuggles `null` into the budget field, the parser
    // must still reject. (Same path covers NaN/Infinity post-parse.)
    expect(
      parseDigestBody(
        '{"kind_version":1,"what_shipped":[],"what_verified":[],"audit_class_paid":[],"next_pickable":"x","blockers":[],"verification_budget_consumed_ms":null}',
      ),
    ).toBeNull();
  });
});

describe("parseDigestBody — forward-compat", () => {
  it("accepts extra unknown fields on the v1 schema (ignores them)", () => {
    const body = JSON.stringify({
      ...validBody(),
      extra_field_for_v2: "should-not-break-v1-parse",
      another_extra: { nested: true },
    });
    const parsed = parseDigestBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind_version).toBe(1);
    // Extra fields not exposed on the returned `DigestBody` shape.
    expect(parsed && "extra_field_for_v2" in parsed).toBe(false);
  });
});
