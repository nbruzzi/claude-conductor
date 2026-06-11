// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `audit-ask` message kind — shared body parser + schema type (Tier 1
 * Slice 1 of the schemas-first substrate cohort, ratified 2026-05-19
 * brainstorm).
 *
 * Sibling-pair primitive. Posted by an author requesting an audit on
 * their PR/plan from a target peer. Carries structured body with required
 * fields: `target_pr`, `target_peer`, `tier`, `lens_set_requested`,
 * `audit_class`.
 *
 * **Schema rationale (sibling to `LiveUpdateBody` + `DigestBody`):**
 * structured body shape earns the new kind. Tier-defaults are computed at
 * send-time via `inferAuditAskTier(loc, invariantRich)`; the body carries
 * the FINAL tier (default OR override). `audit-verdict` (Slice 2) consumes
 * this shape to close the audit-loop.
 *
 * **Verification-budget contract for `audit-ask`:** readers trust the
 * SHAPE returned by this parser (validator-enforced) but must primary-
 * source-verify the `target_pr` exists + `target_peer` is a live NATO
 * identity on the channel before acting on the ask. `tier` +
 * `lens_set_requested` + `audit_class` are author-claims; `audit-verdict`
 * shape (Slice 2) carries the actual coverage answer.
 *
 * **Why a new kind vs extending `question`:** audit-ask has structured
 * body (5 typed fields with discriminator-like semantics), whereas
 * `question` is unstructured free-form. Structured shape earns the new
 * kind — same reasoning that earned `digest` + `live-update` their own
 * kinds. Per the walkie-talkie kinds + verification-budget convention.
 *
 * Plan: `~/.claude/plans/slice-1-kind-audit-ask-schema-2026-05-19.md` v0.2.
 */

import {
  isAuditAskTier,
  isAuditClass,
  isLensClassArray,
  parseAuditTarget,
  type AuditAskTier,
  type AuditClass,
  type AuditTarget,
  type LensClass,
} from "./audit-types.ts";

/**
 * Schema for the `audit-ask` kind's body field (JSON-serialized to the
 * JSONL line at write time; parsed on read).
 *
 * `kind_version: 1` matches the digest + live-update schema-version
 * convention. Today's parser accepts only version `1`; mis-versioned
 * bodies return `null`.
 */
export type AuditAskBody = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /**
   * The artifact being audited — a PR or a plan (D2 discriminated union).
   * Canonical field; consumers switch on `target.kind`. The wire carries
   * exactly one of `target_pr` / `target_plan`; the parser normalizes them
   * to this field. Wire serialization goes back through `auditTargetToWire`.
   *
   * N3 disposition: known-repo enumeration is audit-context-fetch concern
   * (deferred Tier 3-D pattern-trace), not schema-layer.
   */
  target: AuditTarget;
  /**
   * The peer being asked to audit. Non-empty (post-trim) string;
   * typically a NATO identity name: `Alpha`, `Bravo`, `Charlie`, `Delta`.
   *
   * N2 disposition: active-NATO-identity validation is audit-routing-
   * layer concern (Slice 3 `audit-queue --for`), not schema-layer.
   * Echo/Foxtrot future-extensibility preserved.
   */
  target_peer: string;
  /**
   * The audit tier requested. Defaults inferred from PR LOC + invariant-
   * rich flag at send-time via `inferAuditAskTier(loc, invariantRich)`;
   * author may override by passing any valid `AuditAskTier` literal.
   */
  tier: AuditAskTier;
  /**
   * The lens-set requested for the audit. Non-empty array of valid
   * `LensClass` values.
   */
  lens_set_requested: readonly LensClass[];
  /**
   * The audit class: where the audit sits in the pair-topology.
   */
  audit_class: AuditClass;
};

/**
 * Parse an `audit-ask` message body into a typed `AuditAskBody`. Returns
 * `null` on any shape mismatch.
 *
 * **F3 disposition: tier-to-lens-set-size invariants are NOT enforced at
 * parse time** — coverage enforcement is audit-verdict territory (Slice
 * 2). A light-touch tier with a 3-lens lens_set_requested is a valid
 * `AuditAskBody`; the verdict shape Slice 2 ships will surface the
 * mismatch at audit-close time. Send-time cross-field validation forces
 * authors to satisfy downstream-only invariants up-front (wrong layer;
 * fragile to invariant evolution).
 *
 * Caller-side error policy: `null` is intentional — callers MUST choose
 * between log-and-skip OR adding a NEW shared parser variant
 * (e.g., `parseAuditAskBodyBestEffort`) co-located in this module.
 * Ad-hoc re-implementation per call site is a known anti-pattern that
 * re-creates the exact drift the SSOT-at-the-convention-layer
 * discipline eliminates (sibling to `parseDigestBody` +
 * `parseLiveUpdateBody`).
 *
 * The parser is intentionally permissive on EXTRA fields (forward-
 * compatible).
 */
export function parseAuditAskBody(body: string): AuditAskBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  if (obj["kind_version"] !== 1) return null;

  // target — exactly one of target_pr / target_plan (D1 additive). parseAuditTarget
  // normalizes to the AuditTarget discriminated union; historical target_pr-only
  // bodies parse unchanged → { kind: "pr" }. Both-absent / both-present → null.
  const target = parseAuditTarget(obj);
  if (target === null) return null;

  // target_peer — required non-empty (post-trim) string.
  const targetPeer = obj["target_peer"];
  if (typeof targetPeer !== "string" || targetPeer.trim().length === 0) {
    return null;
  }

  // tier — required valid AuditAskTier.
  const tier = obj["tier"];
  if (!isAuditAskTier(tier)) return null;

  // lens_set_requested — required non-empty array of valid LensClass.
  const lensSet = obj["lens_set_requested"];
  if (!isLensClassArray(lensSet)) return null;

  // audit_class — required valid AuditClass.
  const auditClass = obj["audit_class"];
  if (!isAuditClass(auditClass)) return null;

  // A1 fold (Bravo post-impl audit 20:27Z): string fields are whitespace-
  // normalized inside parseAuditTarget (+ target_peer below), so the same
  // logical target reads identically downstream; output trim is symmetric
  // with the empty-post-trim validation gates.
  return {
    kind_version: 1,
    target,
    target_peer: targetPeer.trim(),
    tier,
    lens_set_requested: lensSet,
    audit_class: auditClass,
  };
}

/**
 * Compute the default audit-ask tier from PR LOC + invariant-rich flag.
 *
 * Rules (per plan v0.2 §D2):
 *
 *   - `loc < 100 && !invariantRich` → `"light-touch"`
 *   - `100 ≤ loc && loc < 500 && !invariantRich` → `"1-lens-substantive"`
 *   - `loc ≥ 500 || invariantRich` → `"3-lens-convergence"`
 *
 * Author override: callers may pass any valid `AuditAskTier` literal
 * directly at send-time; this function is a CONVENIENCE for the LOC-
 * based default. The body carries the FINAL tier — readers don't see
 * whether it was a default or an override.
 */
export function inferAuditAskTier(
  loc: number,
  invariantRich: boolean,
): AuditAskTier {
  if (invariantRich || loc >= 500) return "3-lens-convergence";
  if (loc >= 100) return "1-lens-substantive";
  return "light-touch";
}
