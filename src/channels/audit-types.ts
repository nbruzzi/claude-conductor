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

/**
 * Audit-coverage axes per `feedback-audit-convergence-three-axes`. A
 * verdict body declares which axes the auditor actually applied. The
 * convergence-check at audit-loop-close uses axis-coverage (not lens-set
 * parity) to determine whether the PR is converged.
 *
 *   - `surface` — cross-edge invariants (caps alignment, type-shape
 *                 preservation, API stability)
 *   - `depth`   — invariant-rich logic (state-machine transitions,
 *                 race classes, parser correctness)
 *   - `distance` — independent context (outside-pair, cross-pair,
 *                 fresh-eyes)
 *
 * Slice 2 introduction.
 */
export const AUDIT_AXES = ["surface", "depth", "distance"] as const;
export type AuditAxis = (typeof AUDIT_AXES)[number];

/**
 * Audit verdict outcomes. Closes the audit-loop initiated by `audit-ask`.
 * Each value defines a discrete next-action for the author per amended
 * `feedback-audit-loop-closure-3-option-ask`:
 *
 *   - `SHIP-CLEAN`       — no folds + no blockers; PR cleared for squash
 *   - `SHIP-WITH-FOLDS`  — folds proposed; author absorbs + re-audits
 *                          (or squashes if folds are forward-discipline-only)
 *   - `NEEDS-REWORK`     — blocker-class issues; PR must NOT squash
 *                          until reframed
 *
 * Slice 2 introduction.
 */
export const AUDIT_VERDICTS = [
  "SHIP-CLEAN",
  "SHIP-WITH-FOLDS",
  "NEEDS-REWORK",
] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

/**
 * Finding severity within an audit verdict. UPPERCASE matches AuditVerdict
 * for cohort-internal consistency (per Slice 2 N3 — cohort-consistency
 * beats JSON-idiomatic-lowercase). Slice 3 audit-queue may filter on this
 * (e.g., "show me all BLOCKER findings across the cycle").
 *
 *   - `BLOCKER` — PR must not ship until resolved
 *   - `FOLD`    — author should absorb before squash (or in follow-up)
 *   - `NIT`     — flag-only; author-judgement whether to address
 *
 * Slice 2 introduction.
 */
export const FINDING_SEVERITIES = ["BLOCKER", "FOLD", "NIT"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * Type-guard: `v` is one of the valid `AuditAxis` literals.
 */
export function isAuditAxis(v: unknown): v is AuditAxis {
  return typeof v === "string" && (AUDIT_AXES as readonly string[]).includes(v);
}

/**
 * Type-guard: `v` is a NON-EMPTY array of valid `AuditAxis` literals.
 * Non-empty by design — a verdict without any axis-coverage claim is a
 * semantic bug (auditor must claim at least one axis to make the
 * convergence check meaningful). Parser preserves order + duplicates
 * (per N4); reader-side consumers may sort/dedup.
 */
export function isAuditAxisArray(v: unknown): v is readonly AuditAxis[] {
  return Array.isArray(v) && v.length > 0 && v.every(isAuditAxis);
}

/**
 * Type-guard: `v` is one of the valid `AuditVerdict` literals.
 */
export function isAuditVerdict(v: unknown): v is AuditVerdict {
  return (
    typeof v === "string" && (AUDIT_VERDICTS as readonly string[]).includes(v)
  );
}

/**
 * Type-guard: `v` is one of the valid `FindingSeverity` literals.
 */
export function isFindingSeverity(v: unknown): v is FindingSeverity {
  return (
    typeof v === "string" &&
    (FINDING_SEVERITIES as readonly string[]).includes(v)
  );
}

/**
 * Bandwidth states (Slice 3 of Tier 1 schemas+coord substrate). The
 * composite state derived from artifact-inputs (msg density + audits
 * delivered + heartbeat freshness + open audit-asks) per Bravo's round-2
 * + Charlie's correction in the 2026-05-19 brainstorm.
 *
 * Self-declared bandwidth selects for performance-of-availability; derive
 * from artifacts. Anchor memory: `feedback-bandwidth-state-inferred-not-declared`.
 *
 *   - `SATURATED`       — busy authoring OR audit-queue overflow (≥3 open
 *                          asks targeting identity); NEW asks should route
 *                          elsewhere when an alternative is available.
 *   - `ACTIVE`          — engaged; messages flowing + recent audit delivery.
 *   - `IDLE-AVAILABLE`  — heartbeat fresh + low msg density + no open asks
 *                          targeting; available for routing.
 *   - `STALE`           — no heartbeat OR heartbeat older than
 *                          `BANDWIDTH_STALE_AGE_MS` (30min); peer effectively
 *                          offline.
 *
 * UPPERCASE matches `AuditVerdict` + `FindingSeverity` cohort-internal
 * consistency (per Slice 2 N3 disposition — cohort-consistency beats
 * JSON-idiomatic-lowercase).
 *
 * Slice 3 introduction. Threshold constants live in
 * `src/bandwidth/inference.ts` adjacent to the decision logic; this
 * module owns only the vocabulary types.
 */
export const BANDWIDTH_STATES = [
  "SATURATED",
  "ACTIVE",
  "IDLE-AVAILABLE",
  "STALE",
] as const;
export type BandwidthState = (typeof BANDWIDTH_STATES)[number];

/**
 * Artifact-derived inputs to bandwidth inference. Computed at query time
 * by reading the channel state (NOT serialized to the channel; pure
 * transient computation per Q5 disposition — `kind=bandwidth-snapshot`
 * publish deferred until dashboard render latency proves it needed).
 *
 * Field meanings:
 *
 *   - `msg_density_30min`     — count of messages from `target_identity`
 *                                with `ts` within the last 30 minutes.
 *   - `audits_delivered_90min` — count of `kind=audit-verdict` messages
 *                                from `target_identity` with `ts` within
 *                                the last 90 minutes.
 *   - `heartbeat_age_ms`      — milliseconds since the identity's
 *                                heartbeat sentinel was last touched.
 *                                `null` when no heartbeat exists for the
 *                                identity (e.g., identity name has no
 *                                sentinel on this channel).
 *   - `open_audit_asks`       — count of `kind=audit-ask` messages with
 *                                `target_peer === target_identity` that
 *                                lack a matching `kind=audit-verdict`
 *                                response. Unbounded (per Q3 disposition).
 */
export type BandwidthInputs = {
  msg_density_30min: number;
  audits_delivered_90min: number;
  heartbeat_age_ms: number | null;
  open_audit_asks: number;
};

/**
 * Type-guard: `v` is one of the valid `BandwidthState` literals.
 */
export function isBandwidthState(v: unknown): v is BandwidthState {
  return (
    typeof v === "string" && (BANDWIDTH_STATES as readonly string[]).includes(v)
  );
}

// ─── Audit target (PR | plan) ────────────────────────────────────────
//
// b2 audit-target generalization (Golf design `audit-target-generalization-
// design.md`, right-sized additive cut). `audit-ask` / `audit-verdict` can
// target a GitHub PR OR a design/plan doc. The discriminated union lets
// consumers switch on a single `kind` discriminant rather than branch on which
// optional wire field (`target_pr` / `target_plan`) is set.

/**
 * The artifact an audit targets. Discriminated union (D2):
 *   - `pr`   — a GitHub PR: free-string `repo` (non-empty) + positive-integer `number`.
 *   - `plan` — a plan/design doc, keyed by `ref` = the plan filename BASENAME
 *              (D3; stable across the cohort's shared `~/.claude/plans/`,
 *              human-readable, unique — not a machine-coupled full path).
 */
export type AuditTarget =
  | { readonly kind: "pr"; readonly repo: string; readonly number: number }
  | { readonly kind: "plan"; readonly ref: string };

/**
 * Parse the wire-level target of an audit body into a normalized
 * {@link AuditTarget} (D1: additive, backwards-compatible). The caller passes
 * the already-JSON-parsed body object.
 *
 * Exactly ONE of `target_pr` / `target_plan` must be present:
 *   - `target_pr: { repo, number }` (historical wire shape) → `{ kind: "pr" }`
 *   - `target_plan: { ref }`                                → `{ kind: "plan" }`
 *   - both-absent OR both-present                           → `null`
 *
 * Historical `target_pr`-only bodies satisfy exactly-one → parse unchanged
 * (kind_version stays 1; purely additive). Whitespace on string fields is
 * trimmed on output (A1-fold parity with the prior `target_pr` parser).
 */
export function parseAuditTarget(
  obj: Record<string, unknown>,
): AuditTarget | null {
  const prRaw = obj["target_pr"];
  const planRaw = obj["target_plan"];
  const hasPr = prRaw !== undefined;
  const hasPlan = planRaw !== undefined;
  // Exactly-one: both-absent or both-present is invalid.
  if (hasPr === hasPlan) return null;

  if (hasPr) {
    if (prRaw === null || typeof prRaw !== "object" || Array.isArray(prRaw)) {
      return null;
    }
    const pr = prRaw as Record<string, unknown>;
    const repo = pr["repo"];
    if (typeof repo !== "string" || repo.trim().length === 0) return null;
    const number = pr["number"];
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0
    ) {
      return null;
    }
    return { kind: "pr", repo: repo.trim(), number };
  }

  // plan
  if (
    planRaw === null ||
    typeof planRaw !== "object" ||
    Array.isArray(planRaw)
  ) {
    return null;
  }
  const plan = planRaw as Record<string, unknown>;
  const ref = plan["ref"];
  if (typeof ref !== "string" || ref.trim().length === 0) return null;
  return { kind: "plan", ref: ref.trim() };
}

/**
 * Serialize an {@link AuditTarget} back to its wire field(s) — the inverse of
 * {@link parseAuditTarget}. Returns an object carrying exactly one of
 * `target_pr` / `target_plan` to spread into a body at construction time.
 */
export function auditTargetToWire(
  target: AuditTarget,
): Record<string, unknown> {
  if (target.kind === "pr") {
    return { target_pr: { repo: target.repo, number: target.number } };
  }
  return { target_plan: { ref: target.ref } };
}

/**
 * Pairing predicate (D4): do two targets refer to the same audited artifact?
 * `pr`↔`pr` match on repo+number; `plan`↔`plan` match on ref; mismatched
 * kind → never. Replaces the inline `target_pr.repo===… && .number===…`
 * pairing in the audit-loop consumers.
 */
export function sameTarget(a: AuditTarget, b: AuditTarget): boolean {
  if (a.kind === "pr" && b.kind === "pr") {
    return a.repo === b.repo && a.number === b.number;
  }
  if (a.kind === "plan" && b.kind === "plan") return a.ref === b.ref;
  return false;
}

/**
 * Stable string key for an {@link AuditTarget} (D4): `pr:<repo>#<number>` for a
 * PR, `plan:<ref>` for a plan. Used to count independent verdicts per target
 * (quorum) without branching on `kind` at every call site.
 */
export function auditTargetKey(target: AuditTarget): string {
  return target.kind === "pr"
    ? `pr:${target.repo}#${target.number}`
    : `plan:${target.ref}`;
}
