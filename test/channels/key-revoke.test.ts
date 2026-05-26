// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, it } from "bun:test";
import {
  isKeyRevokeBody,
  isRevocationReason,
  parseKeyRevokeBody,
  type KeyRevokeBody,
} from "../../src/channels/key-revoke.ts";

/**
 * Canonical reference body — rotation case with explicit replacement
 * fingerprint + 2-NATO co-signing. Mirrors the canonical-reference
 * pattern from audit-verdict.test.ts.
 */
const CANONICAL_KEY_REVOKE_BODY: KeyRevokeBody = {
  kind_version: 1,
  revoked_nato: "Alpha",
  revoked_fingerprint:
    "a3f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b0",
  revoked_at: "2026-05-26T18:00:00.000Z",
  reason: "rotation",
  replacement_fingerprint:
    "b4c0d9e3f2c15b6a0d9e3f2c15b6a0d9e3f2c15b6a0d9e3f2c15b6a0d9e3f2c1",
  signed_by: ["Alpha", "Bravo"],
};

function makeBody(overrides: Partial<KeyRevokeBody> = {}): KeyRevokeBody {
  return { ...CANONICAL_KEY_REVOKE_BODY, ...overrides };
}

function bodyWithout(field: keyof KeyRevokeBody): string {
  const copy: Record<string, unknown> = { ...CANONICAL_KEY_REVOKE_BODY };
  delete copy[field];
  return JSON.stringify(copy);
}

describe("isRevocationReason — Section 1: 3-class union type guard", () => {
  it("T1.1: accepts each LOCKED variant", () => {
    expect(isRevocationReason("compromise")).toBe(true);
    expect(isRevocationReason("rotation")).toBe(true);
    expect(isRevocationReason("operator-departure")).toBe(true);
  });

  it("T1.2: rejects unknown reason strings", () => {
    expect(isRevocationReason("revoked")).toBe(false);
    expect(isRevocationReason("expired")).toBe(false);
    expect(isRevocationReason("")).toBe(false);
    expect(isRevocationReason("COMPROMISE")).toBe(false);
  });

  it("T1.3: rejects non-string inputs", () => {
    expect(isRevocationReason(null)).toBe(false);
    expect(isRevocationReason(undefined)).toBe(false);
    expect(isRevocationReason(42)).toBe(false);
    expect(isRevocationReason({})).toBe(false);
    expect(isRevocationReason(["compromise"])).toBe(false);
  });
});

describe("parseKeyRevokeBody — Section 2: canonical reference roundtrip", () => {
  it("T2.1: canonical rotation body parses cleanly", () => {
    const result = parseKeyRevokeBody(
      JSON.stringify(CANONICAL_KEY_REVOKE_BODY),
    );
    expect(result).not.toBeNull();
    expect(result?.kind_version).toBe(1);
    expect(result?.revoked_nato).toBe("Alpha");
    expect(result?.revoked_fingerprint).toBe(
      CANONICAL_KEY_REVOKE_BODY.revoked_fingerprint,
    );
    expect(result?.revoked_at).toBe("2026-05-26T18:00:00.000Z");
    expect(result?.reason).toBe("rotation");
    expect(result?.replacement_fingerprint).toBe(
      CANONICAL_KEY_REVOKE_BODY.replacement_fingerprint,
    );
    expect(result?.signed_by).toEqual(["Alpha", "Bravo"]);
  });

  it("T2.2: compromise reason with null replacement_fingerprint", () => {
    const body = makeBody({
      reason: "compromise",
      replacement_fingerprint: null,
      signed_by: ["Alpha", "Bravo", "Charlie", "Delta"],
    });
    const result = parseKeyRevokeBody(JSON.stringify(body));
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("compromise");
    expect(result?.replacement_fingerprint).toBeNull();
    expect(result?.signed_by).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("T2.3: operator-departure reason with null replacement + single signer", () => {
    const body = makeBody({
      reason: "operator-departure",
      replacement_fingerprint: null,
      signed_by: ["Alpha"],
    });
    const result = parseKeyRevokeBody(JSON.stringify(body));
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("operator-departure");
    expect(result?.replacement_fingerprint).toBeNull();
    expect(result?.signed_by).toEqual(["Alpha"]);
  });
});

describe("parseKeyRevokeBody — Section 3: shape negatives", () => {
  it("T3.1: rejects non-JSON input", () => {
    expect(parseKeyRevokeBody("not-json")).toBeNull();
    expect(parseKeyRevokeBody("")).toBeNull();
    expect(parseKeyRevokeBody("{")).toBeNull();
  });

  it("T3.2: rejects valid JSON that isn't an object", () => {
    expect(parseKeyRevokeBody('"string"')).toBeNull();
    expect(parseKeyRevokeBody("42")).toBeNull();
    expect(parseKeyRevokeBody("null")).toBeNull();
    expect(parseKeyRevokeBody("[]")).toBeNull();
  });

  it("T3.3: rejects wrong kind_version (skip-other-versions semantics)", () => {
    const bad = { ...CANONICAL_KEY_REVOKE_BODY, kind_version: 2 };
    expect(parseKeyRevokeBody(JSON.stringify(bad))).toBeNull();
  });

  it("T3.4: rejects missing kind_version", () => {
    expect(parseKeyRevokeBody(bodyWithout("kind_version"))).toBeNull();
  });
});

describe("parseKeyRevokeBody — Section 4: field-level validation", () => {
  it("T4.1: rejects missing revoked_nato", () => {
    expect(parseKeyRevokeBody(bodyWithout("revoked_nato"))).toBeNull();
  });

  it("T4.2: rejects empty-post-trim revoked_nato", () => {
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ revoked_nato: "" }))),
    ).toBeNull();
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ revoked_nato: "   " }))),
    ).toBeNull();
  });

  it("T4.3: rejects non-string revoked_nato", () => {
    const bad = JSON.stringify({
      ...CANONICAL_KEY_REVOKE_BODY,
      revoked_nato: 42,
    });
    expect(parseKeyRevokeBody(bad)).toBeNull();
  });

  it("T4.4: rejects missing revoked_fingerprint", () => {
    expect(parseKeyRevokeBody(bodyWithout("revoked_fingerprint"))).toBeNull();
  });

  it("T4.5: rejects empty-post-trim revoked_fingerprint", () => {
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ revoked_fingerprint: "" }))),
    ).toBeNull();
    expect(
      parseKeyRevokeBody(
        JSON.stringify(makeBody({ revoked_fingerprint: "   " })),
      ),
    ).toBeNull();
  });

  it("T4.6: rejects missing revoked_at", () => {
    expect(parseKeyRevokeBody(bodyWithout("revoked_at"))).toBeNull();
  });

  it("T4.7: rejects empty revoked_at", () => {
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ revoked_at: "" }))),
    ).toBeNull();
  });

  it("T4.8: rejects non-Date.parse-able revoked_at", () => {
    expect(
      parseKeyRevokeBody(
        JSON.stringify(makeBody({ revoked_at: "not-a-timestamp" })),
      ),
    ).toBeNull();
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ revoked_at: "abc-def" }))),
    ).toBeNull();
  });

  it("T4.9: accepts various Date.parse-valid ISO-8601 formats", () => {
    const withMillis = parseKeyRevokeBody(
      JSON.stringify(makeBody({ revoked_at: "2026-05-26T18:00:00.000Z" })),
    );
    expect(withMillis).not.toBeNull();
    const withoutMillis = parseKeyRevokeBody(
      JSON.stringify(makeBody({ revoked_at: "2026-05-26T18:00:00Z" })),
    );
    expect(withoutMillis).not.toBeNull();
    const withOffset = parseKeyRevokeBody(
      JSON.stringify(makeBody({ revoked_at: "2026-05-26T14:00:00-04:00" })),
    );
    expect(withOffset).not.toBeNull();
  });

  it("T4.10: rejects missing reason", () => {
    expect(parseKeyRevokeBody(bodyWithout("reason"))).toBeNull();
  });

  it("T4.11: rejects invalid reason value (off-3-class)", () => {
    const bad = JSON.stringify({
      ...CANONICAL_KEY_REVOKE_BODY,
      reason: "expired",
    });
    expect(parseKeyRevokeBody(bad)).toBeNull();
  });
});

describe("parseKeyRevokeBody — Section 5: replacement_fingerprint explicit-null discipline", () => {
  it("T5.1: rejects undefined replacement_fingerprint (must be explicit per HYBRID write-side)", () => {
    expect(
      parseKeyRevokeBody(bodyWithout("replacement_fingerprint")),
    ).toBeNull();
  });

  it("T5.2: accepts null replacement_fingerprint", () => {
    const result = parseKeyRevokeBody(
      JSON.stringify(makeBody({ replacement_fingerprint: null })),
    );
    expect(result).not.toBeNull();
    expect(result?.replacement_fingerprint).toBeNull();
  });

  it("T5.3: accepts non-empty string replacement_fingerprint", () => {
    const result = parseKeyRevokeBody(
      JSON.stringify(
        makeBody({
          replacement_fingerprint:
            "deadbeefcafef00d1234567890abcdef0123456789abcdef0123456789abcdef",
        }),
      ),
    );
    expect(result).not.toBeNull();
    expect(result?.replacement_fingerprint).toBe(
      "deadbeefcafef00d1234567890abcdef0123456789abcdef0123456789abcdef",
    );
  });

  it("T5.4: rejects empty-post-trim string replacement_fingerprint", () => {
    expect(
      parseKeyRevokeBody(
        JSON.stringify(makeBody({ replacement_fingerprint: "" })),
      ),
    ).toBeNull();
    expect(
      parseKeyRevokeBody(
        JSON.stringify(makeBody({ replacement_fingerprint: "   " })),
      ),
    ).toBeNull();
  });

  it("T5.5: rejects non-string-non-null replacement_fingerprint", () => {
    const bad = JSON.stringify({
      ...CANONICAL_KEY_REVOKE_BODY,
      replacement_fingerprint: 42,
    });
    expect(parseKeyRevokeBody(bad)).toBeNull();
  });
});

describe("parseKeyRevokeBody — Section 6: signed_by[] min-1 invariant", () => {
  it("T6.1: rejects missing signed_by", () => {
    expect(parseKeyRevokeBody(bodyWithout("signed_by"))).toBeNull();
  });

  it("T6.2: rejects empty signed_by array (min-1 invariant)", () => {
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ signed_by: [] }))),
    ).toBeNull();
  });

  it("T6.3: rejects non-array signed_by", () => {
    const bad = JSON.stringify({
      ...CANONICAL_KEY_REVOKE_BODY,
      signed_by: "Alpha",
    });
    expect(parseKeyRevokeBody(bad)).toBeNull();
  });

  it("T6.4: rejects empty-post-trim entries in signed_by", () => {
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ signed_by: [""] }))),
    ).toBeNull();
    expect(
      parseKeyRevokeBody(JSON.stringify(makeBody({ signed_by: ["   "] }))),
    ).toBeNull();
    expect(
      parseKeyRevokeBody(
        JSON.stringify(makeBody({ signed_by: ["Alpha", "", "Charlie"] })),
      ),
    ).toBeNull();
  });

  it("T6.5: rejects non-string entries in signed_by", () => {
    const bad = JSON.stringify({
      ...CANONICAL_KEY_REVOKE_BODY,
      signed_by: ["Alpha", 42],
    });
    expect(parseKeyRevokeBody(bad)).toBeNull();
  });

  it("T6.6: trims entries in signed_by on output", () => {
    const result = parseKeyRevokeBody(
      JSON.stringify(makeBody({ signed_by: ["  Alpha  ", "Bravo  "] })),
    );
    expect(result?.signed_by).toEqual(["Alpha", "Bravo"]);
  });

  it("T6.7: accepts large N-of-cohort co-sign set (4-NATO compromise scenario)", () => {
    const result = parseKeyRevokeBody(
      JSON.stringify(
        makeBody({
          reason: "compromise",
          replacement_fingerprint: null,
          signed_by: ["Alpha", "Bravo", "Charlie", "Delta"],
        }),
      ),
    );
    expect(result).not.toBeNull();
    expect(result?.signed_by.length).toBe(4);
  });
});

describe("parseKeyRevokeBody — Section 7: forward-compat + trim discipline", () => {
  it("T7.1: permissive on extra fields (forward-compat)", () => {
    const withExtras = {
      ...CANONICAL_KEY_REVOKE_BODY,
      detail: "Periodic rotation per cohort hygiene policy",
      co_signing_thread_ref: "channel-2026-05-26-thread-12",
    };
    const result = parseKeyRevokeBody(JSON.stringify(withExtras));
    expect(result).not.toBeNull();
    expect(result).toEqual(CANONICAL_KEY_REVOKE_BODY);
  });

  it("T7.2: trims revoked_nato on output", () => {
    const result = parseKeyRevokeBody(
      JSON.stringify(makeBody({ revoked_nato: "  Alpha  " })),
    );
    expect(result?.revoked_nato).toBe("Alpha");
  });

  it("T7.3: trims revoked_fingerprint on output", () => {
    const result = parseKeyRevokeBody(
      JSON.stringify(
        makeBody({
          revoked_fingerprint:
            "  a3f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b0  ",
        }),
      ),
    );
    expect(result?.revoked_fingerprint).toBe(
      "a3f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b0",
    );
  });
});

describe("isKeyRevokeBody — Section 8: type guard", () => {
  it("T8.1: accepts canonical reference body via object input", () => {
    expect(isKeyRevokeBody(CANONICAL_KEY_REVOKE_BODY)).toBe(true);
  });

  it("T8.2: rejects shape-invalid object", () => {
    expect(
      isKeyRevokeBody({
        ...CANONICAL_KEY_REVOKE_BODY,
        reason: "expired",
      }),
    ).toBe(false);
  });

  it("T8.3: rejects null + undefined + arrays + primitives", () => {
    expect(isKeyRevokeBody(null)).toBe(false);
    expect(isKeyRevokeBody(undefined)).toBe(false);
    expect(isKeyRevokeBody([])).toBe(false);
    expect(isKeyRevokeBody("string")).toBe(false);
    expect(isKeyRevokeBody(42)).toBe(false);
  });

  it("T8.4: accepts the 3 reason variants × null/non-null replacement matrix", () => {
    for (const reason of [
      "compromise",
      "rotation",
      "operator-departure",
    ] as const) {
      for (const replacement of [
        null,
        "deadbeefcafef00d1234567890abcdef0123456789abcdef0123456789abcdef",
      ]) {
        const body: KeyRevokeBody = {
          ...CANONICAL_KEY_REVOKE_BODY,
          reason,
          replacement_fingerprint: replacement,
        };
        expect(isKeyRevokeBody(body)).toBe(true);
      }
    }
  });
});
