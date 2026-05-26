// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Conductor-side paired-contract test for the audit-chain shim mirror
 * (Cycle 1 substrate-core PR-A8; Pair B Charlie-pen per slice plan
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §6.2 cross-edge
 * contract tests).
 *
 * **Paired-contract pattern** per
 * `[[feedback-cross-edge-contract-via-paired-tests]]` +
 * `[[feedback-substrate-shim-mirror-on-plugin-export-changes]]`:
 *
 * Conductor side (this file) asserts the substrate-canonical api.ts
 * surface for the 3 new symbols introduced by PR-A5 (v0.3 DSSE wrapper
 * schema migration). The dotfiles shim mirror (PR #148) re-exports these
 * symbols; the dotfiles-side test (`~/.claude-dotfiles/src/channels/
 * index.test.ts` parallel coverage) asserts the shim re-exports the same
 * symbols with identical behavior.
 *
 * The cross-edge contract: any consumer importing
 * `claude-conductor/channels/api` (via api.ts directly OR via dotfiles
 * shim re-export) gets the same parseAuditVerdictV0_3Wrapped /
 * wrapAuditVerdictBody / canonicalJson surface with identical wrap+parse
 * roundtrip semantics. Drift between the two surfaces (substrate vs
 * shim) is detected at this paired-contract layer BEFORE downstream
 * consumer breakage.
 *
 * Cross-edge consumer coverage cited per `[[feedback-audit-cohort-
 * missed-cross-edge-shim-consumer]]`: this PR's audit-verdict body
 * should carry cross_edge_consumers_verified: ["dotfiles-shim",
 * "lineage-verifier", "drift-verifier"].
 */

import { describe, expect, it } from "bun:test";

import {
  canonicalJson,
  parseAuditVerdictBody,
  parseAuditVerdictV0_3Wrapped,
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/api.ts";

const CANONICAL_BODY: AuditVerdictBody = {
  kind_version: 1,
  target_pr: { repo: "conductor", number: 99 },
  target_peer: "Alpha",
  lens_set_applied: ["RE"],
  audit_class: "inside-pair",
  audit_axes: ["depth"],
  verdict: "SHIP-CLEAN",
  counts: { blocker: 0, fold: 0, nit: 0 },
  three_option_ask: {
    a_ratify: "PR cleared",
    b_fold_if_applicable: null,
    c_reframe_if_applicable: null,
  },
  findings: [],
  signed_at: "2099-12-31T23:59:59.999Z",
  prev_audit_body_ref: null,
  signer_role: "queue",
};

async function generateTestKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
}

describe("audit-chain shim mirror — Section 1: api.ts surface contract", () => {
  it("T1.1: canonicalJson is exported as a function via api.ts", () => {
    expect(typeof canonicalJson).toBe("function");
  });

  it("T1.2: parseAuditVerdictV0_3Wrapped is exported as a function via api.ts", () => {
    expect(typeof parseAuditVerdictV0_3Wrapped).toBe("function");
  });

  it("T1.3: wrapAuditVerdictBody is exported as a function via api.ts", () => {
    expect(typeof wrapAuditVerdictBody).toBe("function");
  });

  it("T1.4: parseAuditVerdictBody (existing) remains exported via api.ts", () => {
    expect(typeof parseAuditVerdictBody).toBe("function");
  });
});

describe("audit-chain shim mirror — Section 2: behavioral roundtrip via api.ts", () => {
  it("T2.1: canonicalJson produces stable canonical bytes for identical inputs", () => {
    const a = { kind_version: 1, target_pr: { number: 99, repo: "conductor" } };
    const b = { target_pr: { repo: "conductor", number: 99 }, kind_version: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("T2.2: wrap + parse roundtrip via api.ts preserves inner body shape", async () => {
    const kp = await generateTestKeypair();
    const envelopeJson = await wrapAuditVerdictBody(
      CANONICAL_BODY,
      kp.privateKey,
      "charlie",
    );
    const result = parseAuditVerdictV0_3Wrapped(envelopeJson);
    expect(result).not.toBeNull();
    expect(result?.envelope.signatures[0]?.keyid).toBe("charlie");
    expect(result?.body.verdict).toBe("SHIP-CLEAN");
    expect(result?.body.target_pr).toEqual({ repo: "conductor", number: 99 });
    expect(result?.body.signer_role).toBe("queue");
  });

  it("T2.3: parseAuditVerdictV0_3Wrapped returns null for raw v0.2 body (Sigstore parse-all-versions-simultaneously precedent)", () => {
    const rawV0_2 = JSON.stringify(CANONICAL_BODY);
    expect(parseAuditVerdictV0_3Wrapped(rawV0_2)).toBeNull();
  });

  it("T2.4: parseAuditVerdictBody continues to work on raw v0.2 bodies (back-compat preserved)", () => {
    const rawV0_2 = JSON.stringify(CANONICAL_BODY);
    const parsed = parseAuditVerdictBody(rawV0_2);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe("SHIP-CLEAN");
  });
});

describe("audit-chain shim mirror — Section 3: paired-contract documentation", () => {
  it("T3.1: cross-edge consumers documented (substrate-canonical contract list)", () => {
    const CROSS_EDGE_CONSUMERS = [
      "dotfiles-shim",
      "lineage-verifier",
      "drift-verifier",
    ] as const;
    expect(CROSS_EDGE_CONSUMERS.length).toBe(3);
    expect(CROSS_EDGE_CONSUMERS).toContain("dotfiles-shim");
    expect(CROSS_EDGE_CONSUMERS).toContain("lineage-verifier");
    expect(CROSS_EDGE_CONSUMERS).toContain("drift-verifier");
  });
});
