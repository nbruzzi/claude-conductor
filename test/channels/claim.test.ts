// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `validateIdentityClaim` — the identity-claim shape-validation
 * primitive lifted from `channels-gc-reaper.ts` in Phase 3 Step D.
 *
 * Behavior contract is preserved byte-for-byte from the pre-lift
 * `parseClaim` helper to satisfy the SHA-audit / behavioral-equivalence
 * gate. These tests pin every branch of the validator so a future
 * refactor that changes semantics fails compile-or-test fast.
 */

import { describe, expect, it } from "bun:test";

import { validateIdentityClaim } from "../../src/channels/claim.ts";

describe("validateIdentityClaim", () => {
  it("returns the parsed claim on shape-clean input", () => {
    const raw = JSON.stringify({
      session_id: "11111111-1111-4111-8111-111111111111",
      role: "queue",
      joined_at: "2026-01-01T00:00:00.000Z",
    });
    const result = validateIdentityClaim(raw);
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(result?.role).toBe("queue");
    expect(result?.joined_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("preserves extra fields when JSON contains them (validator is shape-AT-LEAST, not shape-EXACT)", () => {
    // The original `parseClaim` did NOT strip unknown fields — it returned
    // the parsed object as-is once the required fields were validated.
    // This is a behavioral contract that downstream readers may depend on
    // (e.g., a future protocol-version field). Pin it.
    const raw = JSON.stringify({
      session_id: "22222222-2222-4222-8222-222222222222",
      role: "pen",
      joined_at: "2026-01-01T00:00:00.000Z",
      protocol_version: "1.0",
      future_field: { nested: true },
    });
    const result = validateIdentityClaim(raw);
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("22222222-2222-4222-8222-222222222222");
    // Extra fields are not stripped:
    expect((result as Record<string, unknown>)?.["protocol_version"]).toBe(
      "1.0",
    );
  });

  it("returns null on JSON parse failure (malformed input)", () => {
    expect(validateIdentityClaim("{ not json")).toBeNull();
    expect(validateIdentityClaim("")).toBeNull();
    expect(validateIdentityClaim("undefined")).toBeNull();
  });

  it("returns null when JSON parses to non-object primitive", () => {
    expect(validateIdentityClaim("null")).toBeNull();
    expect(validateIdentityClaim('"a string"')).toBeNull();
    expect(validateIdentityClaim("42")).toBeNull();
    expect(validateIdentityClaim("true")).toBeNull();
    expect(validateIdentityClaim("[]")).toBeNull();
    // Note: arrays ARE objects per `typeof` semantics, but they fail the
    // subsequent field checks (session_id, role, joined_at are undefined
    // on a bare array). Pinning the disposition.
  });

  it("returns null when session_id is missing or wrong type", () => {
    const base = {
      role: "queue",
      joined_at: "2026-01-01T00:00:00.000Z",
    };
    expect(validateIdentityClaim(JSON.stringify(base))).toBeNull();
    expect(
      validateIdentityClaim(JSON.stringify({ ...base, session_id: 42 })),
    ).toBeNull();
    expect(
      validateIdentityClaim(JSON.stringify({ ...base, session_id: null })),
    ).toBeNull();
    expect(
      validateIdentityClaim(JSON.stringify({ ...base, session_id: {} })),
    ).toBeNull();
  });

  it("returns null when role is missing or wrong type", () => {
    const base = {
      session_id: "33333333-3333-4333-8333-333333333333",
      joined_at: "2026-01-01T00:00:00.000Z",
    };
    expect(validateIdentityClaim(JSON.stringify(base))).toBeNull();
    expect(
      validateIdentityClaim(JSON.stringify({ ...base, role: 42 })),
    ).toBeNull();
    expect(
      validateIdentityClaim(JSON.stringify({ ...base, role: null })),
    ).toBeNull();
  });

  it("returns null when joined_at is missing or wrong type", () => {
    const base = {
      session_id: "44444444-4444-4444-8444-444444444444",
      role: "pen",
    };
    expect(validateIdentityClaim(JSON.stringify(base))).toBeNull();
    expect(
      validateIdentityClaim(JSON.stringify({ ...base, joined_at: 0 })),
    ).toBeNull();
    expect(
      validateIdentityClaim(JSON.stringify({ ...base, joined_at: null })),
    ).toBeNull();
  });

  it("never throws on adversarial input", () => {
    // Defensive: the validator must NEVER throw — downstream consumers
    // (the reaper) rely on null-as-error rather than try/catch wrapping.
    // Smoke a handful of pathological inputs.
    const adversarial: readonly string[] = [
      "",
      " ",
      "{",
      "{}{}",
      String.fromCharCode(0xfffd),
      // Deeply nested but parse-able — should fail shape check, return null
      JSON.stringify({
        session_id: { not: "a string" },
        role: ["array"],
        joined_at: false,
      }),
    ];
    for (const raw of adversarial) {
      // Spreading inside expect to surface which input asserted-failed:
      expect(() => validateIdentityClaim(raw)).not.toThrow();
      expect(validateIdentityClaim(raw)).toBeNull();
    }
  });

  it("treats role as opaque string — does not validate enum membership (matches pre-lift contract)", () => {
    // The pre-lift parseClaim accepted any string role (validation was
    // only on TYPE, not value). Pinning this — enum validation is the
    // caller's job, not this primitive's. (Cast to `string` bypasses the
    // ChannelRole string-literal-union narrowing on the assertion: the
    // VALIDATOR doesn't enforce the union at runtime, so the runtime
    // value may legitimately be outside the compile-time type's range.)
    const raw = JSON.stringify({
      session_id: "55555555-5555-4555-8555-555555555555",
      role: "not-a-real-channel-role-but-a-string",
      joined_at: "2026-01-01T00:00:00.000Z",
    });
    const result = validateIdentityClaim(raw);
    expect(result).not.toBeNull();
    expect(result?.role as string).toBe("not-a-real-channel-role-but-a-string");
  });
});
