// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the `audit-verdict` message kind's shared parser
 * (`parseAuditVerdictBody`).
 *
 * Coverage organized by Section per plan v0.2 §Test-grid (collapsed
 * Sections 11+12 → 11 post-F1 reframe):
 *
 *   1. Happy path (canonical body parses cleanly + M2 empty-findings SHIP-CLEAN)
 *   2. kind_version
 *   3. target_pr (mirror audit-ask incl. F3 whitespace-normalize)
 *   4. target_peer (mirror audit-ask incl. F3 whitespace-normalize)
 *   5. lens_set_applied (non-empty array of LensClass)
 *   6. audit_class
 *   7. audit_axes (NEW Slice 2; non-empty array of surface/depth/distance)
 *   8. verdict (3 values + missing + unknown)
 *   9. counts (per-severity non-negative integer)
 *   10. findings (array of valid AuditFinding shapes; nested validation)
 *   11. three_option_ask (ALWAYS required; sub-fields nullable when unused)
 *   12. counts-coherence cross-field validation (N1 — counts ≡ findings.filter(severity).length)
 *   13. Forward-compat (extra unknown fields ignored — outer body + finding objects)
 *   14. JSON-root failures
 *
 * Plan: `~/.claude/plans/slice-2-kind-audit-verdict-schema-2026-05-19.md` v0.2.
 */

import { describe, expect, it } from "bun:test";

import {
  parseAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";

/**
 * Canonical reference body — SHIP-WITH-FOLDS with 1 fold + 0 blockers + 0 nits.
 * Used by happy-path tests + as override-base for negative-case construction.
 */
const CANONICAL_AUDIT_VERDICT_BODY: AuditVerdictBody = {
  kind_version: 1,
  target_pr: { repo: "conductor", number: 99 },
  target_peer: "Alpha",
  lens_set_applied: ["RE", "Architecture"],
  audit_class: "inside-pair",
  audit_axes: ["surface", "depth"],
  verdict: "SHIP-WITH-FOLDS",
  counts: { blocker: 0, fold: 1, nit: 0 },
  three_option_ask: {
    a_ratify: "Apply fold then squash on re-audit ratify.",
    b_fold_if_applicable: "Add T3.12 footgun test for typeof null === object.",
    c_reframe_if_applicable: null,
  },
  findings: [
    {
      kind: "FOLD",
      lens: "Architecture",
      title: "audit-types.ts SSOT extraction",
      detail:
        "Slice 2 audit-verdict imports LensClass + AuditClass; substrate-precedes-consumer at type-layer requires extraction to audit-types.ts.",
    },
  ],
};

/**
 * SHIP-CLEAN body for M2 (Bravo plan v0.2 fold) — empty findings + zero
 * counts + nullable b_fold/c_reframe.
 */
const SHIP_CLEAN_BODY: AuditVerdictBody = {
  kind_version: 1,
  target_pr: { repo: "conductor", number: 99 },
  target_peer: "Alpha",
  lens_set_applied: ["RE"],
  audit_class: "inside-pair",
  audit_axes: ["depth"],
  verdict: "SHIP-CLEAN",
  counts: { blocker: 0, fold: 0, nit: 0 },
  three_option_ask: {
    a_ratify: "PR cleared for squash.",
    b_fold_if_applicable: null,
    c_reframe_if_applicable: null,
  },
  findings: [],
};

function bodyWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...CANONICAL_AUDIT_VERDICT_BODY, ...overrides });
}

function bodyWithout(field: keyof AuditVerdictBody): string {
  const copy: Record<string, unknown> = { ...CANONICAL_AUDIT_VERDICT_BODY };
  delete copy[field];
  return JSON.stringify(copy);
}

describe("parseAuditVerdictBody — Section 1: happy path", () => {
  it("T1.1: canonical SHIP-WITH-FOLDS body parses cleanly", () => {
    const parsed = parseAuditVerdictBody(
      JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe("SHIP-WITH-FOLDS");
    expect(parsed?.counts).toEqual({ blocker: 0, fold: 1, nit: 0 });
    expect(parsed?.findings.length).toBe(1);
  });
  it("T1.2 (M2): SHIP-CLEAN body with empty findings + zero counts parses cleanly", () => {
    const parsed = parseAuditVerdictBody(JSON.stringify(SHIP_CLEAN_BODY));
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe("SHIP-CLEAN");
    expect(parsed?.counts).toEqual({ blocker: 0, fold: 0, nit: 0 });
    expect(parsed?.findings).toEqual([]);
    expect(parsed?.three_option_ask.b_fold_if_applicable).toBeNull();
    expect(parsed?.three_option_ask.c_reframe_if_applicable).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 2: kind_version", () => {
  it("T2.1: kind_version=1 accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T2.2: missing kind_version rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("kind_version"))).toBeNull();
  });
  it("T2.3: kind_version=2 (future) rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ kind_version: 2 }))).toBeNull();
  });
  it("T2.4: kind_version='1' (string) rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ kind_version: "1" }))).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 3: target_pr (F3 whitespace-normalize)", () => {
  it("T3.1: valid {repo, number} accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T3.2: missing target_pr rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("target_pr"))).toBeNull();
  });
  it("T3.3: target_pr=null (footgun) rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ target_pr: null }))).toBeNull();
  });
  it("T3.4: target_pr missing repo rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ target_pr: { number: 99 } })),
    ).toBeNull();
  });
  it("T3.5: target_pr missing number rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ target_pr: { repo: "conductor" } })),
    ).toBeNull();
  });
  it("T3.6: target_pr.number=0 rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ target_pr: { repo: "conductor", number: 0 } }),
      ),
    ).toBeNull();
  });
  it("T3.7: target_pr.repo='' empty rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ target_pr: { repo: "", number: 99 } })),
    ).toBeNull();
  });
  it("T3.8: target_pr.repo whitespace-only rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ target_pr: { repo: "   ", number: 99 } }),
      ),
    ).toBeNull();
  });
  it("T3.9 (F3): target_pr.repo whitespace normalized on output", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({ target_pr: { repo: "  conductor  ", number: 99 } }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.target_pr).toEqual({ repo: "conductor", number: 99 });
  });
});

describe("parseAuditVerdictBody — Section 4: target_peer (F3 whitespace-normalize)", () => {
  it("T4.1: 'Alpha' accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T4.2: missing target_peer rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("target_peer"))).toBeNull();
  });
  it("T4.3: empty string rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ target_peer: "" }))).toBeNull();
  });
  it("T4.4: whitespace-only rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ target_peer: "   " }))).toBeNull();
  });
  it("T4.5: number rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ target_peer: 42 }))).toBeNull();
  });
  it("T4.6 (F3): target_peer whitespace normalized on output", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({ target_peer: "  Alpha  " }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.target_peer).toBe("Alpha");
  });
});

describe("parseAuditVerdictBody — Section 5: lens_set_applied", () => {
  it("T5.1: ['RE', 'Architecture'] accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T5.2: missing rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("lens_set_applied"))).toBeNull();
  });
  it("T5.3: empty array rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ lens_set_applied: [] })),
    ).toBeNull();
  });
  it("T5.4: contains-unknown-lens rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ lens_set_applied: ["RE", "InvalidLens"] }),
      ),
    ).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 6: audit_class", () => {
  it("T6.1: 'inside-pair' accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T6.2: 'outside-pair' accepted", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ audit_class: "outside-pair" })),
    ).not.toBeNull();
  });
  it("T6.3: 'cross-pair-shadow' accepted", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ audit_class: "cross-pair-shadow" })),
    ).not.toBeNull();
  });
  it("T6.4: unknown rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ audit_class: "inside-pair-shadow" })),
    ).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 7: audit_axes (NEW Slice 2)", () => {
  it("T7.1: ['surface', 'depth'] accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T7.2: all 3 axes accepted", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ audit_axes: ["surface", "depth", "distance"] }),
      ),
    ).not.toBeNull();
  });
  it("T7.3: missing rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("audit_axes"))).toBeNull();
  });
  it("T7.4: empty array rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ audit_axes: [] }))).toBeNull();
  });
  it("T7.5: contains-unknown-axis rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ audit_axes: ["surface", "breadth"] })),
    ).toBeNull();
  });
  it("T7.6 (N4): duplicates preserved (parser permissive)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({ audit_axes: ["depth", "depth", "surface"] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.audit_axes).toEqual(["depth", "depth", "surface"]);
  });
});

describe("parseAuditVerdictBody — Section 8: verdict", () => {
  it("T8.1: 'SHIP-CLEAN' accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(SHIP_CLEAN_BODY)),
    ).not.toBeNull();
  });
  it("T8.2: 'SHIP-WITH-FOLDS' accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T8.3: 'NEEDS-REWORK' accepted", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          verdict: "NEEDS-REWORK",
          counts: { blocker: 1, fold: 0, nit: 0 },
          findings: [
            {
              kind: "BLOCKER",
              lens: "RE",
              title: "Race condition in iter",
              detail: "Mid-iteration emit can skip downstream clients.",
            },
          ],
        }),
      ),
    ).not.toBeNull();
  });
  it("T8.4: missing rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("verdict"))).toBeNull();
  });
  it("T8.5: case-mismatch 'ship-clean' rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ verdict: "ship-clean" })),
    ).toBeNull();
  });
  it("T8.6: unknown 'SHIP-DIRTY' rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ verdict: "SHIP-DIRTY" })),
    ).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 9: counts", () => {
  it("T9.1: valid non-negative integers accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(CANONICAL_AUDIT_VERDICT_BODY)),
    ).not.toBeNull();
  });
  it("T9.2: missing counts rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("counts"))).toBeNull();
  });
  it("T9.3: counts=null rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ counts: null }))).toBeNull();
  });
  it("T9.4: missing blocker rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ counts: { fold: 1, nit: 0 } })),
    ).toBeNull();
  });
  it("T9.5: negative blocker rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ counts: { blocker: -1, fold: 1, nit: 0 } }),
      ),
    ).toBeNull();
  });
  it("T9.6: non-integer fold rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ counts: { blocker: 0, fold: 1.5, nit: 0 } }),
      ),
    ).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 10: findings", () => {
  it("T10.1: empty findings (with zero counts) accepted", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(SHIP_CLEAN_BODY)),
    ).not.toBeNull();
  });
  it("T10.2: missing findings rejected", () => {
    expect(parseAuditVerdictBody(bodyWithout("findings"))).toBeNull();
  });
  it("T10.3: findings as non-array rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ findings: "not-array" })),
    ).toBeNull();
  });
  it("T10.4: finding with invalid kind rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          counts: { blocker: 0, fold: 1, nit: 0 },
          findings: [{ kind: "MAJOR", lens: "RE", title: "x", detail: "y" }],
        }),
      ),
    ).toBeNull();
  });
  it("T10.5: finding with empty title rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          counts: { blocker: 0, fold: 1, nit: 0 },
          findings: [{ kind: "FOLD", lens: "RE", title: "", detail: "y" }],
        }),
      ),
    ).toBeNull();
  });
  it("T10.6: finding with whitespace-only detail rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          counts: { blocker: 0, fold: 1, nit: 0 },
          findings: [{ kind: "FOLD", lens: "RE", title: "x", detail: "   " }],
        }),
      ),
    ).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 11: three_option_ask (F1 always-required)", () => {
  it("T11.1: three_option_ask present with a_ratify + null sub-fields accepted (SHIP-CLEAN shape)", () => {
    expect(
      parseAuditVerdictBody(JSON.stringify(SHIP_CLEAN_BODY)),
    ).not.toBeNull();
  });
  it("T11.2: three_option_ask present with all 3 sub-fields populated accepted", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          three_option_ask: {
            a_ratify: "ratify",
            b_fold_if_applicable: "fold",
            c_reframe_if_applicable: "reframe",
          },
        }),
      ),
    ).not.toBeNull();
  });
  it("T11.3: missing three_option_ask rejected (always required)", () => {
    expect(parseAuditVerdictBody(bodyWithout("three_option_ask"))).toBeNull();
  });
  it("T11.4: three_option_ask=null rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ three_option_ask: null })),
    ).toBeNull();
  });
  it("T11.5: a_ratify empty rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          three_option_ask: {
            a_ratify: "",
            b_fold_if_applicable: null,
            c_reframe_if_applicable: null,
          },
        }),
      ),
    ).toBeNull();
  });
  it("T11.6: b_fold_if_applicable null OR string accepted", () => {
    const withNull = parseAuditVerdictBody(JSON.stringify(SHIP_CLEAN_BODY));
    expect(withNull?.three_option_ask.b_fold_if_applicable).toBeNull();
  });
  it("T11.7 (B1): b_fold_if_applicable whitespace-only rejected (symmetric trim-check)", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          three_option_ask: {
            a_ratify: "ratify",
            b_fold_if_applicable: "   ",
            c_reframe_if_applicable: null,
          },
        }),
      ),
    ).toBeNull();
  });
  it("T11.8 (B1): c_reframe_if_applicable whitespace-only rejected (symmetric trim-check)", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          three_option_ask: {
            a_ratify: "ratify",
            b_fold_if_applicable: null,
            c_reframe_if_applicable: "   ",
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 12: counts-coherence (N1)", () => {
  it("T12.1: counts.blocker mismatched with findings rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          counts: { blocker: 1, fold: 1, nit: 0 },
          findings: [
            {
              kind: "FOLD",
              lens: "RE",
              title: "x",
              detail: "y",
            },
            // claims 1 BLOCKER but findings has 0
          ],
        }),
      ),
    ).toBeNull();
  });
  it("T12.2: counts.fold mismatched with findings rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          counts: { blocker: 0, fold: 2, nit: 0 },
          findings: [
            { kind: "FOLD", lens: "RE", title: "x", detail: "y" },
            // claims 2 FOLD but findings has 1
          ],
        }),
      ),
    ).toBeNull();
  });
  it("T12.3: counts and findings agree on multi-severity accepted", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          counts: { blocker: 1, fold: 1, nit: 2 },
          findings: [
            { kind: "BLOCKER", lens: "RE", title: "x", detail: "y" },
            { kind: "FOLD", lens: "Architecture", title: "x", detail: "y" },
            { kind: "NIT", lens: "TA", title: "x", detail: "y" },
            { kind: "NIT", lens: "Security", title: "x", detail: "y" },
          ],
        }),
      ),
    ).not.toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 13: forward-compat", () => {
  it("T13.1: extra unknown field on outer body ignored", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ extra_field: "future-extension" })),
    ).not.toBeNull();
  });
  it("T13.2: extra unknown field on finding object ignored (N2 extensibility)", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          counts: { blocker: 0, fold: 1, nit: 0 },
          findings: [
            {
              kind: "FOLD",
              lens: "RE",
              title: "x",
              detail: "y",
              code: "RE-1",
              body_ref: "deadbeef",
            },
          ],
        }),
      ),
    ).not.toBeNull();
  });
});

describe("parseAuditVerdictBody — Section 14: JSON-root failures", () => {
  it("invalid JSON rejected", () => {
    expect(parseAuditVerdictBody("not json")).toBeNull();
  });
  it("non-object root rejected (string)", () => {
    expect(parseAuditVerdictBody(JSON.stringify("string"))).toBeNull();
  });
  it("array root rejected", () => {
    expect(parseAuditVerdictBody(JSON.stringify([1, 2, 3]))).toBeNull();
  });
  it("null root rejected", () => {
    expect(parseAuditVerdictBody("null")).toBeNull();
  });
});

// Cycle 2026-05-25 substrate-evolution slice (Bravo-pen). Backwards-compat
// optional field `cross_edge_consumers_verified?: readonly string[]`.
// Parser accepts absent + present-with-valid-shape; rejects wrong-shape.
// Send-time validation (cli.ts gate) enforces non-empty for substrate-class
// PRs via isSubstrateClassPR(target_pr); that path is exercised via the
// substrate-class.test.ts helper unit tests + integration verified at
// PR-tier (this PR is itself substrate-class — self-dogfood).
describe("parseAuditVerdictBody — Section 15: cross_edge_consumers_verified field", () => {
  it("T15.1: absent field parses as undefined (backwards-compat with kind_version: 1 bodies pre-dating field)", () => {
    const parsed = parseAuditVerdictBody(bodyWith({}));
    expect(parsed).not.toBeNull();
    expect(parsed?.cross_edge_consumers_verified).toBeUndefined();
  });

  it("T15.2: present empty array parses as empty array (caller may include explicitly)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({ cross_edge_consumers_verified: [] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.cross_edge_consumers_verified).toEqual([]);
  });

  it("T15.3: present non-empty string array round-trips (canonical case)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({
        cross_edge_consumers_verified: [
          "~/Repos/claude-conductor-dashboard/src/lib/server/adapters/active-sessions.ts",
          "~/.claude-dotfiles/src/active-sessions/index.ts",
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.cross_edge_consumers_verified).toEqual([
      "~/Repos/claude-conductor-dashboard/src/lib/server/adapters/active-sessions.ts",
      "~/.claude-dotfiles/src/active-sessions/index.ts",
    ]);
  });

  it("T15.4: non-array value rejected (string)", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ cross_edge_consumers_verified: "single-string-not-array" }),
      ),
    ).toBeNull();
  });

  it("T15.5: non-array value rejected (number)", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ cross_edge_consumers_verified: 42 })),
    ).toBeNull();
  });

  it("T15.6: non-array value rejected (object)", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({
          cross_edge_consumers_verified: { not: "an-array" },
        }),
      ),
    ).toBeNull();
  });

  it("T15.7: array with non-string entry rejected (number)", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ cross_edge_consumers_verified: ["valid", 42] }),
      ),
    ).toBeNull();
  });

  it("T15.8: array with empty-string entry rejected (whitespace-only discipline mirrors three_option_ask)", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ cross_edge_consumers_verified: ["valid", ""] }),
      ),
    ).toBeNull();
  });

  it("T15.9: array with whitespace-only entry rejected", () => {
    expect(
      parseAuditVerdictBody(
        bodyWith({ cross_edge_consumers_verified: ["valid", "   "] }),
      ),
    ).toBeNull();
  });

  it("T15.10: null value rejected (explicit-null is not the same as absent)", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ cross_edge_consumers_verified: null })),
    ).toBeNull();
  });
});

// Section 16: v0.2 extension fields (Cycle 1 substrate-core; Pair B Charlie-pen
// per slice plan cycle-1-substrate-core-slice-plan-2026-05-26.md §2.6 Migration 002).
// Three optional fields per HYBRID lock 4-NATO ratify-clean: signed_at +
// prev_audit_body_ref + signer_role. Identity attestation handled by DSSE keyid
// per HYBRID; no in-payload signer_nato.
describe("parseAuditVerdictBody — Section 16: v0.2 extension fields (signed_at + prev_audit_body_ref + signer_role)", () => {
  // signed_at — ISO-8601 timestamp; required when DSSE-signed; optional/absent on legacy

  it("T16.1: signed_at absent parses as undefined (back-compat with legacy v0.1 bodies)", () => {
    const parsed = parseAuditVerdictBody(bodyWith({}));
    expect(parsed).not.toBeNull();
    expect(parsed?.signed_at).toBeUndefined();
  });

  it("T16.2: signed_at null parses as null (explicit-null distinct from undefined)", () => {
    const parsed = parseAuditVerdictBody(bodyWith({ signed_at: null }));
    expect(parsed).not.toBeNull();
    expect(parsed?.signed_at).toBeNull();
  });

  it("T16.3: signed_at valid ISO-8601 string round-trips (canonical case)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({ signed_at: "2026-05-26T13:34:00.000Z" }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.signed_at).toBe("2026-05-26T13:34:00.000Z");
  });

  it("T16.4: signed_at unparseable string rejected (non-ISO-8601)", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ signed_at: "not-a-timestamp" })),
    ).toBeNull();
  });

  it("T16.5: signed_at non-string-non-null rejected (number)", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ signed_at: 1748263240000 })),
    ).toBeNull();
  });

  it("T16.6: signed_at non-string-non-null rejected (boolean)", () => {
    expect(parseAuditVerdictBody(bodyWith({ signed_at: true }))).toBeNull();
  });

  // prev_audit_body_ref — chain pointer; null for bootstrap; absent for legacy

  it("T16.7: prev_audit_body_ref absent parses as undefined (back-compat with legacy bodies)", () => {
    const parsed = parseAuditVerdictBody(bodyWith({}));
    expect(parsed).not.toBeNull();
    expect(parsed?.prev_audit_body_ref).toBeUndefined();
  });

  it("T16.8: prev_audit_body_ref null parses as null (HYBRID write-side canonical for bootstrap message per Charlie Obs-5)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({ prev_audit_body_ref: null }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.prev_audit_body_ref).toBeNull();
  });

  it("T16.9: prev_audit_body_ref valid string round-trips (canonical chain-pointer case)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({
        prev_audit_body_ref:
          "a3f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b0",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.prev_audit_body_ref).toBe(
      "a3f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b0",
    );
  });

  it("T16.10: prev_audit_body_ref empty-post-trim string rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ prev_audit_body_ref: "" })),
    ).toBeNull();
  });

  it("T16.11: prev_audit_body_ref whitespace-only rejected", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ prev_audit_body_ref: "   " })),
    ).toBeNull();
  });

  it("T16.12: prev_audit_body_ref non-string-non-null rejected (number)", () => {
    expect(
      parseAuditVerdictBody(bodyWith({ prev_audit_body_ref: 42 })),
    ).toBeNull();
  });

  // signer_role — sender's role; signature-covered per Obs-3 HYBRID lock

  it("T16.13: signer_role absent parses as undefined (back-compat with legacy bodies)", () => {
    const parsed = parseAuditVerdictBody(bodyWith({}));
    expect(parsed).not.toBeNull();
    expect(parsed?.signer_role).toBeUndefined();
  });

  it("T16.14: signer_role null parses as null (explicit-null distinct from undefined)", () => {
    const parsed = parseAuditVerdictBody(bodyWith({ signer_role: null }));
    expect(parsed).not.toBeNull();
    expect(parsed?.signer_role).toBeNull();
  });

  it("T16.15: signer_role valid string round-trips (canonical cohort case)", () => {
    const parsed = parseAuditVerdictBody(bodyWith({ signer_role: "queue" }));
    expect(parsed).not.toBeNull();
    expect(parsed?.signer_role).toBe("queue");
  });

  it("T16.16: signer_role empty-post-trim string rejected", () => {
    expect(parseAuditVerdictBody(bodyWith({ signer_role: "" }))).toBeNull();
  });

  it("T16.17: signer_role whitespace-only rejected (mirrors target_peer + a_ratify discipline)", () => {
    expect(parseAuditVerdictBody(bodyWith({ signer_role: "   " }))).toBeNull();
  });

  it("T16.18: signer_role non-string-non-null rejected (number)", () => {
    expect(parseAuditVerdictBody(bodyWith({ signer_role: 42 }))).toBeNull();
  });

  // Combined v0.2-signed-ready body round-trip

  it("T16.19: all three v0.2 fields present + valid round-trip (canonical signed-ready body)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({
        signed_at: "2026-05-26T13:34:00.000Z",
        prev_audit_body_ref:
          "a3f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b0",
        signer_role: "queue",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.signed_at).toBe("2026-05-26T13:34:00.000Z");
    expect(parsed?.prev_audit_body_ref).toBe(
      "a3f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b04a5f9c8d2e1b0",
    );
    expect(parsed?.signer_role).toBe("queue");
  });

  it("T16.20: bootstrap message canonical (signed_at + null prev_audit_body_ref + signer_role)", () => {
    const parsed = parseAuditVerdictBody(
      bodyWith({
        signed_at: "2026-05-26T13:34:00.000Z",
        prev_audit_body_ref: null,
        signer_role: "driver",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.signed_at).toBe("2026-05-26T13:34:00.000Z");
    expect(parsed?.prev_audit_body_ref).toBeNull();
    expect(parsed?.signer_role).toBe("driver");
  });
});
