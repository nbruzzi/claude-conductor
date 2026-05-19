// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared types for audit-discipline message kinds (Slice 1 + Slice 2 of
 * Tier 1 plan v0.2). SSOT for `AuditAskTier`, `AuditClass`, `LensClass`
 * + their `as const` tuples + type-guards.
 *
 * **Why a sibling-shared module:** substrate-precedes-consumer at type
 * layer. Both `audit-ask.ts` (Slice 1) and the future `audit-verdict.ts`
 * (Slice 2) need these types. If they lived in audit-ask.ts, Slice 2's
 * schema file would have a backward-arrow dependency on a sibling schema
 * file. Co-locating in audit-types.ts gives forward-arrows-only design.
 *
 * Plan: `~/.claude/plans/slice-1-kind-audit-ask-schema-2026-05-19.md`
 * v0.2 §D3 (Bravo F1 fold) + `~/.claude/plans/claude-conductor-development-plan-2026-05-19.md`.
 */

/**
 * Audit-ask tier classification. Determines convergence-check posture +
 * whether the 3-option close fires per amended
 * `feedback-audit-loop-closure-3-option-ask`.
 *
 * Defaults inferred from PR LOC + invariant-rich flag via
 * `inferAuditAskTier` in `audit-ask.ts`. Author may override.
 */
export const AUDIT_ASK_TIERS = [
  "light-touch",
  "1-lens-substantive",
  "3-lens-convergence",
] as const;
export type AuditAskTier = (typeof AUDIT_ASK_TIERS)[number];

/**
 * Audit class — where the audit sits in pair-topology. Per Charlie's
 * brainstorm-§C-category extension surfaced 2026-05-19.
 */
export const AUDIT_CLASSES = [
  "inside-pair",
  "outside-pair",
  "cross-pair-shadow",
] as const;
export type AuditClass = (typeof AUDIT_CLASSES)[number];

/**
 * Lens classes available for audit coverage. The taxonomy is extensible
 * via the lens-vocabulary-extension discipline (peers can collectively
 * introduce a new lens-class mid-cycle when an audit-cluster forms; see
 * `feedback-lens-vocabulary-extension`). Today's locked set:
 *
 *   - RE          — Reliability / failure-mode analysis
 *   - Architecture — Module placement + invariants + cross-edge contracts
 *   - TA          — Test Adequacy (coverage + boundary cases)
 *   - Security    — Security surface + attack/threat-model
 *   - Contract    — Contract-surface lens (per Charlie 2026-05-19 PR #18 audit
 *                   introduction; cross-edge invariants + type-shape stability)
 */
export const LENS_CLASSES = [
  "RE",
  "Architecture",
  "TA",
  "Security",
  "Contract",
] as const;
export type LensClass = (typeof LENS_CLASSES)[number];

/**
 * Type-guard: `v` is one of the valid `AuditAskTier` literals.
 */
export function isAuditAskTier(v: unknown): v is AuditAskTier {
  return (
    typeof v === "string" && (AUDIT_ASK_TIERS as readonly string[]).includes(v)
  );
}

/**
 * Type-guard: `v` is one of the valid `AuditClass` literals.
 */
export function isAuditClass(v: unknown): v is AuditClass {
  return (
    typeof v === "string" && (AUDIT_CLASSES as readonly string[]).includes(v)
  );
}

/**
 * Type-guard: `v` is one of the valid `LensClass` literals.
 */
export function isLensClass(v: unknown): v is LensClass {
  return (
    typeof v === "string" && (LENS_CLASSES as readonly string[]).includes(v)
  );
}

/**
 * Type-guard: `v` is a NON-EMPTY array of valid `LensClass` literals.
 * Non-empty by design — an audit-ask without any requested lens is a
 * semantic bug (the author must request at least one lens for coverage
 * to be meaningful).
 */
export function isLensClassArray(v: unknown): v is readonly LensClass[] {
  return Array.isArray(v) && v.length > 0 && v.every(isLensClass);
}
