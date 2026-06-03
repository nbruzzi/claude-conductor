// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the `audit-ask` message kind's shared parser
 * (`parseAuditAskBody`) and tier-default helper (`inferAuditAskTier`).
 *
 * Coverage organized by Section per plan v0.2 §Test-grid:
 *
 *   1. Happy path (canonical body parses cleanly)
 *   2. kind_version (missing / wrong / non-numeric)
 *   3. target_pr (12 cases including F2-added T3.9-T3.12)
 *   4. target_peer (missing / empty / whitespace / non-string)
 *   5. tier (valid values + case-mismatch + unknown + missing)
 *   6. lens_set_requested (non-empty array of valid lenses; rejections)
 *   7. audit_class (3 valid values + missing + unknown)
 *   8. Forward-compat (extra unknown fields ignored)
 *   9. inferAuditAskTier boundary cases (99/100/499/500 + invariantRich)
 *   10. Tier override (author override accepted at parse time)
 *   11. JSON-root failures (invalid JSON / non-object / array / null root)
 *
 * Plan: `~/.claude/plans/slice-1-kind-audit-ask-schema-2026-05-19.md`
 * v0.2 §Test-grid + §Files-to-create #4 (N4 canonical fixture).
 */

import { describe, expect, it } from "bun:test";

import {
  inferAuditAskTier,
  parseAuditAskBody,
  type AuditAskBody,
} from "../../src/channels/audit-ask.ts";

/**
 * N4 fold — canonical reference body used by the happy-path test + as
 * the override-base for negative-case construction. Future maintainers
 * see THE SHAPE in one glance.
 */
const CANONICAL_AUDIT_ASK_BODY: AuditAskBody = {
  kind_version: 1,
  target: { kind: "pr", repo: "conductor", number: 95 },
  target_pr: { repo: "conductor", number: 95 },
  target_peer: "Bravo",
  tier: "light-touch",
  lens_set_requested: ["RE"],
  audit_class: "inside-pair",
};

/**
 * Construct a JSON-serialized body from the canonical with overrides
 * applied via spread.
 */
function bodyWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...CANONICAL_AUDIT_ASK_BODY, ...overrides });
}

/**
 * Construct a JSON-serialized body with a single field omitted.
 */
function bodyWithout(field: keyof AuditAskBody): string {
  const copy: Record<string, unknown> = { ...CANONICAL_AUDIT_ASK_BODY };
  delete copy[field];
  return JSON.stringify(copy);
}

describe("parseAuditAskBody — Section 1: happy path", () => {
  it("T1.1: canonical body parses cleanly into typed AuditAskBody", () => {
    const parsed = parseAuditAskBody(JSON.stringify(CANONICAL_AUDIT_ASK_BODY));
    expect(parsed).not.toBeNull();
    expect(parsed?.kind_version).toBe(1);
    expect(parsed?.target_pr).toEqual({ repo: "conductor", number: 95 });
    expect(parsed?.target_peer).toBe("Bravo");
    expect(parsed?.tier).toBe("light-touch");
    expect(parsed?.lens_set_requested).toEqual(["RE"]);
    expect(parsed?.audit_class).toBe("inside-pair");
  });
});

describe("parseAuditAskBody — Section 2: kind_version", () => {
  it("T2.1: kind_version=1 accepted", () => {
    expect(
      parseAuditAskBody(JSON.stringify(CANONICAL_AUDIT_ASK_BODY)),
    ).not.toBeNull();
  });
  it("T2.2: missing kind_version rejected", () => {
    expect(parseAuditAskBody(bodyWithout("kind_version"))).toBeNull();
  });
  it("T2.3: kind_version=2 (future) rejected", () => {
    expect(parseAuditAskBody(bodyWith({ kind_version: 2 }))).toBeNull();
  });
  it("T2.4: kind_version='1' (string) rejected", () => {
    expect(parseAuditAskBody(bodyWith({ kind_version: "1" }))).toBeNull();
  });
  it("T2.5: kind_version=0 rejected", () => {
    expect(parseAuditAskBody(bodyWith({ kind_version: 0 }))).toBeNull();
  });
});

describe("parseAuditAskBody — Section 3: target_pr (F2 expanded)", () => {
  it("T3.1: valid {repo, number} accepted", () => {
    expect(
      parseAuditAskBody(JSON.stringify(CANONICAL_AUDIT_ASK_BODY)),
    ).not.toBeNull();
  });
  it("T3.2: missing target_pr rejected", () => {
    expect(parseAuditAskBody(bodyWithout("target_pr"))).toBeNull();
  });
  it("T3.3: target_pr as string rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ target_pr: "conductor#95" })),
    ).toBeNull();
  });
  it("T3.4: target_pr missing repo rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ target_pr: { number: 95 } })),
    ).toBeNull();
  });
  it("T3.5: target_pr missing number rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ target_pr: { repo: "conductor" } })),
    ).toBeNull();
  });
  it("T3.6: target_pr.number=0 rejected", () => {
    expect(
      parseAuditAskBody(
        bodyWith({ target_pr: { repo: "conductor", number: 0 } }),
      ),
    ).toBeNull();
  });
  it("T3.7: target_pr.number=-1 rejected", () => {
    expect(
      parseAuditAskBody(
        bodyWith({ target_pr: { repo: "conductor", number: -1 } }),
      ),
    ).toBeNull();
  });
  it("T3.8: target_pr.number=1.5 (non-integer) rejected", () => {
    expect(
      parseAuditAskBody(
        bodyWith({ target_pr: { repo: "conductor", number: 1.5 } }),
      ),
    ).toBeNull();
  });
  it("T3.9 (F2): target_pr.repo='' empty rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ target_pr: { repo: "", number: 95 } })),
    ).toBeNull();
  });
  it("T3.10 (F2): target_pr.repo='   ' whitespace-only rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ target_pr: { repo: "   ", number: 95 } })),
    ).toBeNull();
  });
  it("T3.11 (F2): target_pr.repo non-string rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ target_pr: { repo: 42, number: 95 } })),
    ).toBeNull();
  });
  it("T3.12 (F2): target_pr=null (typeof null === 'object' footgun) rejected", () => {
    expect(parseAuditAskBody(bodyWith({ target_pr: null }))).toBeNull();
  });
  it("T3.13 (A1): target_pr.repo whitespace normalized on output", () => {
    // Bravo post-impl audit A1 fold: ` conductor ` and `conductor` must
    // produce the SAME typed body so cross-pair audit-routing sees a
    // canonical discriminator. Empty post-trim is rejected by T3.9/T3.10.
    const parsed = parseAuditAskBody(
      bodyWith({ target_pr: { repo: "  conductor  ", number: 95 } }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.target_pr).toEqual({ repo: "conductor", number: 95 });
  });
});

describe("parseAuditAskBody — Section 4: target_peer", () => {
  it("T4.1: 'Bravo' accepted", () => {
    expect(
      parseAuditAskBody(JSON.stringify(CANONICAL_AUDIT_ASK_BODY)),
    ).not.toBeNull();
  });
  it("T4.2: missing target_peer rejected", () => {
    expect(parseAuditAskBody(bodyWithout("target_peer"))).toBeNull();
  });
  it("T4.3: empty string rejected", () => {
    expect(parseAuditAskBody(bodyWith({ target_peer: "" }))).toBeNull();
  });
  it("T4.4: whitespace-only rejected", () => {
    expect(parseAuditAskBody(bodyWith({ target_peer: "   " }))).toBeNull();
  });
  it("T4.5: number rejected", () => {
    expect(parseAuditAskBody(bodyWith({ target_peer: 42 }))).toBeNull();
  });
  it("T4.6 (A1): target_peer whitespace normalized on output", () => {
    // Bravo post-impl audit A1 fold: ` Bravo ` and `Bravo` must produce
    // the SAME typed body so cross-pair audit-routing sees a canonical
    // discriminator. Empty post-trim is rejected by T4.3/T4.4.
    const parsed = parseAuditAskBody(bodyWith({ target_peer: "  Bravo  " }));
    expect(parsed).not.toBeNull();
    expect(parsed?.target_peer).toBe("Bravo");
  });
});

describe("parseAuditAskBody — Section 5: tier", () => {
  it("T5.1: 'light-touch' accepted", () => {
    expect(
      parseAuditAskBody(JSON.stringify(CANONICAL_AUDIT_ASK_BODY)),
    ).not.toBeNull();
  });
  it("T5.2: '1-lens-substantive' accepted", () => {
    expect(
      parseAuditAskBody(bodyWith({ tier: "1-lens-substantive" })),
    ).not.toBeNull();
  });
  it("T5.3: '3-lens-convergence' accepted", () => {
    expect(
      parseAuditAskBody(bodyWith({ tier: "3-lens-convergence" })),
    ).not.toBeNull();
  });
  it("T5.4: missing tier rejected", () => {
    expect(parseAuditAskBody(bodyWithout("tier"))).toBeNull();
  });
  it("T5.5: 'Light-Touch' case-mismatch rejected", () => {
    expect(parseAuditAskBody(bodyWith({ tier: "Light-Touch" }))).toBeNull();
  });
  it("T5.6: 'huge' unknown rejected", () => {
    expect(parseAuditAskBody(bodyWith({ tier: "huge" }))).toBeNull();
  });
});

describe("parseAuditAskBody — Section 6: lens_set_requested", () => {
  it("T6.1: ['RE', 'Architecture'] accepted", () => {
    expect(
      parseAuditAskBody(
        bodyWith({ lens_set_requested: ["RE", "Architecture"] }),
      ),
    ).not.toBeNull();
  });
  it("T6.2: missing rejected", () => {
    expect(parseAuditAskBody(bodyWithout("lens_set_requested"))).toBeNull();
  });
  it("T6.3: [] empty rejected", () => {
    expect(parseAuditAskBody(bodyWith({ lens_set_requested: [] }))).toBeNull();
  });
  it("T6.4: not-array (string) rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ lens_set_requested: "RE" })),
    ).toBeNull();
  });
  it("T6.5: contains-unknown-lens rejected", () => {
    expect(
      parseAuditAskBody(
        bodyWith({ lens_set_requested: ["RE", "InvalidLens"] }),
      ),
    ).toBeNull();
  });
  it("T6.6: contains-non-string rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ lens_set_requested: ["RE", 42] })),
    ).toBeNull();
  });
});

describe("parseAuditAskBody — Section 7: audit_class", () => {
  it("T7.1: 'inside-pair' accepted", () => {
    expect(
      parseAuditAskBody(JSON.stringify(CANONICAL_AUDIT_ASK_BODY)),
    ).not.toBeNull();
  });
  it("T7.2: 'outside-pair' accepted", () => {
    expect(
      parseAuditAskBody(bodyWith({ audit_class: "outside-pair" })),
    ).not.toBeNull();
  });
  it("T7.3: 'cross-pair-shadow' accepted", () => {
    expect(
      parseAuditAskBody(bodyWith({ audit_class: "cross-pair-shadow" })),
    ).not.toBeNull();
  });
  it("T7.4: missing rejected", () => {
    expect(parseAuditAskBody(bodyWithout("audit_class"))).toBeNull();
  });
  it("T7.5: 'inside-pair-shadow' unknown rejected", () => {
    expect(
      parseAuditAskBody(bodyWith({ audit_class: "inside-pair-shadow" })),
    ).toBeNull();
  });
});

describe("parseAuditAskBody — Section 8: forward-compat", () => {
  it("T8.1: extra unknown field ignored (parser permissive)", () => {
    expect(
      parseAuditAskBody(bodyWith({ extra_field: "future-extension" })),
    ).not.toBeNull();
  });
});

describe("inferAuditAskTier — Section 9: boundary cases", () => {
  it("T9.1: (99, false) → light-touch", () => {
    expect(inferAuditAskTier(99, false)).toBe("light-touch");
  });
  it("T9.2: (100, false) → 1-lens-substantive", () => {
    expect(inferAuditAskTier(100, false)).toBe("1-lens-substantive");
  });
  it("T9.3: (499, false) → 1-lens-substantive", () => {
    expect(inferAuditAskTier(499, false)).toBe("1-lens-substantive");
  });
  it("T9.4: (500, false) → 3-lens-convergence", () => {
    expect(inferAuditAskTier(500, false)).toBe("3-lens-convergence");
  });
  it("T9.5: (50, true) → 3-lens-convergence (invariantRich overrides small LOC)", () => {
    expect(inferAuditAskTier(50, true)).toBe("3-lens-convergence");
  });
  it("T9.6: (0, false) → light-touch", () => {
    expect(inferAuditAskTier(0, false)).toBe("light-touch");
  });
  it("T9.7: (1000000, true) → 3-lens-convergence (max-bound + invariantRich)", () => {
    expect(inferAuditAskTier(1000000, true)).toBe("3-lens-convergence");
  });
});

describe("parseAuditAskBody — Section 10: tier override (F3 codified)", () => {
  it("T10.1: author may pass any valid tier; parser doesn't enforce default-match", () => {
    const overrideBody = bodyWith({ tier: "3-lens-convergence" });
    expect(parseAuditAskBody(overrideBody)).not.toBeNull();
  });
});

describe("parseAuditAskBody — Section 11: JSON-root failures", () => {
  it("invalid JSON rejected", () => {
    expect(parseAuditAskBody("not json")).toBeNull();
  });
  it("non-object root rejected (string)", () => {
    expect(parseAuditAskBody(JSON.stringify("string"))).toBeNull();
  });
  it("array root rejected", () => {
    expect(parseAuditAskBody(JSON.stringify([1, 2, 3]))).toBeNull();
  });
  it("null root rejected", () => {
    expect(parseAuditAskBody("null")).toBeNull();
  });
});

describe("parseAuditAskBody — Section 3b: target_plan plan-target (Item #3b)", () => {
  const PLAN_ASK_WIRE: Record<string, unknown> = {
    kind_version: 1,
    target_plan: { ref: "my-plan-2026-06-03.md" },
    target_peer: "Bravo",
    tier: "light-touch",
    lens_set_requested: ["RE"],
    audit_class: "inside-pair",
  };
  it("T3b.1: plan-only wire parses -> target.kind='plan' + target_pr undefined", () => {
    const parsed = parseAuditAskBody(JSON.stringify(PLAN_ASK_WIRE));
    expect(parsed).not.toBeNull();
    expect(parsed?.target).toEqual({
      kind: "plan",
      ref: "my-plan-2026-06-03.md",
    });
    expect(parsed?.target_pr).toBeUndefined();
  });
  it("T3b.2: BOTH target_pr + target_plan present rejected (exactly-one)", () => {
    const both = {
      ...PLAN_ASK_WIRE,
      target_pr: { repo: "conductor", number: 95 },
    };
    expect(parseAuditAskBody(JSON.stringify(both))).toBeNull();
  });
  it("T3b.3: parsed plan body re-serializes WITH target_plan -> roundtrips", () => {
    const parsed = parseAuditAskBody(JSON.stringify(PLAN_ASK_WIRE));
    expect(parsed).not.toBeNull();
    const reparsed = parseAuditAskBody(JSON.stringify(parsed));
    expect(reparsed?.target).toEqual({
      kind: "plan",
      ref: "my-plan-2026-06-03.md",
    });
  });
});
