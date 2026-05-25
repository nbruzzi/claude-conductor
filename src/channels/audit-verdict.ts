// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `audit-verdict` message kind — shared body parser + schema type (Tier 1
 * Slice 2 of the schemas-first substrate cohort, ratified 2026-05-19
 * brainstorm + plan v0.2 LOCKED 21:19Z).
 *
 * Closes the audit-loop initiated by `kind=audit-ask` (Slice 1, shipped
 * 2026-05-19 at squash `1214da0`). Posted by an auditor reporting their
 * verdict on a PR/plan. Carries the 3-axis audit-coverage answer
 * (surface/depth/distance per `feedback-audit-convergence-three-axes`)
 * + verdict outcome + findings + canonical 3-option close-ask.
 *
 * **Schema rationale (sibling to `LiveUpdateBody` + `DigestBody` +
 * `AuditAskBody`):** structured body shape earns the new kind. Verdict
 * binds to the originating audit-ask via `target_pr + target_peer +
 * channel-thread` (read-side join), NOT via duplicating `tier` in this
 * body (per Bravo F1 reframe — avoids dual-source-of-truth drift).
 *
 * **three_option_ask is ALWAYS REQUIRED.** Sub-fields nullable when
 * unused (b_fold_if_applicable null when no folds; c_reframe_if_applicable
 * null when no reframe). Canonical close-shape per amended
 * `feedback-audit-loop-closure-3-option-ask`.
 *
 * **Counts coherence enforced at parse-time** (N1) — `counts.blocker`
 * must equal `findings.filter(f => f.kind === "BLOCKER").length`; same
 * for fold + nit. Catches author tally errors cheaply. Future v2 schema
 * revision may drop in favor of computed-on-read at consumer (Slice 3
 * audit-queue may compute these directly from findings).
 *
 * **Verification-budget contract for `audit-verdict`:** readers trust
 * the SHAPE returned by this parser (validator-enforced) but must
 * primary-source-verify the verdict's claims (lens-set actually applied;
 * findings actually surfaced; counts match the body the auditor read).
 * The auditor's claim is authoritative for the close-shape; readers
 * verify the substance.
 *
 * **Why a new kind vs extending `note`:** audit-verdict has heavily
 * structured body (9 typed fields incl. nested AuditFinding + ThreeOptionAsk)
 * with discriminator-like semantics. Per the walkie-talkie kinds +
 * verification-budget convention.
 *
 * Plan: `~/.claude/plans/slice-2-kind-audit-verdict-schema-2026-05-19.md` v0.2.
 */

import {
  isAuditAxisArray,
  isAuditClass,
  isAuditVerdict,
  isFindingSeverity,
  isLensClass,
  isLensClassArray,
  type AuditAxis,
  type AuditClass,
  type AuditVerdict,
  type FindingSeverity,
  type LensClass,
} from "./audit-types.ts";

/**
 * A single audit finding. The minimal 4-field shape covers the
 * cycle-common verdict shape; authors may include additional fields
 * (e.g., `code` for machine-parseable error codes, `body_ref` for
 * deeper analysis pointer) via the parser's forward-compatible
 * permissive-on-extra-fields discipline (per N2).
 */
export type AuditFinding = {
  /** Severity discriminator. UPPERCASE per cohort-internal consistency. */
  kind: FindingSeverity;
  /** Which lens surfaced this finding. */
  lens: LensClass;
  /** Short — what failed. Non-empty post-trim. */
  title: string;
  /** Long — why + suggested action. Non-empty post-trim. */
  detail: string;
};

/**
 * Canonical 3-option close-ask per amended
 * `feedback-audit-loop-closure-3-option-ask`. ALWAYS REQUIRED on
 * `audit-verdict` bodies (no tier-coupled skip — Bravo F1 reframe).
 *
 *   - `a_ratify` — always non-empty; describes the ratify outcome
 *     (e.g., "PR cleared for squash post-distance-lens")
 *   - `b_fold_if_applicable` — null when no folds proposed; otherwise
 *     describes the fold path the author should take
 *   - `c_reframe_if_applicable` — null when no reframe proposed; otherwise
 *     describes the reframe argument (verdict's question is wrong shape)
 */
export type ThreeOptionAsk = {
  a_ratify: string;
  b_fold_if_applicable: string | null;
  c_reframe_if_applicable: string | null;
};

/**
 * Schema for the `audit-verdict` kind's body field (JSON-serialized to
 * the JSONL line at write time; parsed on read).
 *
 * `kind_version: 1` matches the digest + live-update + audit-ask schema-
 * version convention. Today's parser accepts only version `1`; mis-
 * versioned bodies return `null`.
 */
export type AuditVerdictBody = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /**
   * The PR being audited. Mirror of audit-ask's `target_pr`.
   * Whitespace-normalized on output (F3 carry-over from Slice 1 A1).
   */
  target_pr: { repo: string; number: number };
  /**
   * The peer the verdict is ADDRESSED to (the original audit-ask
   * author). Mirror of audit-ask's `target_peer`. Whitespace-normalized
   * on output (F3 carry-over).
   */
  target_peer: string;
  /**
   * The lens-set the AUDITOR actually applied (vs audit-ask's
   * `lens_set_requested` which is what the author REQUESTED). Field
   * name explicitly `applied` for paired-kind reader-side clarity
   * (F2 fold).
   */
  lens_set_applied: readonly LensClass[];
  /**
   * The audit class — where the verdict sits in pair-topology.
   */
  audit_class: AuditClass;
  /**
   * The axes the auditor actually covered (surface/depth/distance per
   * `feedback-audit-convergence-three-axes`). Non-empty array. Parser
   * preserves order + duplicates (per N4); reader-side consumers may
   * sort/dedup.
   */
  audit_axes: readonly AuditAxis[];
  /**
   * The verdict outcome — SHIP-CLEAN / SHIP-WITH-FOLDS / NEEDS-REWORK.
   */
  verdict: AuditVerdict;
  /**
   * Per-severity tally. `counts.blocker` MUST equal the number of
   * findings with `kind === "BLOCKER"`; same for `fold` + `nit`.
   * Coherence enforced at parse-time (N1).
   *
   * Future v2 schema revision may drop in favor of computed-on-read
   * at consumer (Slice 3 audit-queue may compute these directly).
   */
  counts: { blocker: number; fold: number; nit: number };
  /**
   * Canonical 3-option close-ask. ALWAYS REQUIRED; sub-fields nullable
   * when unused (per F1 reframe).
   */
  three_option_ask: ThreeOptionAsk;
  /**
   * Array of structured findings. May be empty when verdict=SHIP-CLEAN
   * (no folds, no blockers, no nits — counts all zero). Tested via M2
   * (Bravo plan v0.2 audit).
   */
  findings: readonly AuditFinding[];
  /**
   * Cross-edge consumer-edges the auditor explicitly verified. Each
   * entry is a path or symbolic reference to a consumer site (e.g.,
   * dotfiles shim, dashboard adapter) whose mirror invariant was
   * checked against this PR's substrate changes.
   *
   * Optional at the type level for backwards-compat (`kind_version: 1`
   * bodies without the field still parse). Send-time validation in
   * `cli.ts` REJECTS substrate-class PRs (per
   * `isSubstrateClassPR(target_pr)` from `./substrate-class.ts`) whose
   * audit-verdict body lacks a non-empty array — operationalizing
   * the discipline from cycle 2026-05-25 PR #119 4-instance audit-
   * cohort gap (see
   * `feedback-audit-cohort-missed-cross-edge-shim-consumer`).
   *
   * Parser tolerates absent field (treated as undefined); rejects
   * present-but-wrong-shape (not an array OR contains non-string
   * entries).
   */
  cross_edge_consumers_verified?: readonly string[];
};

/**
 * Parse an `audit-verdict` message body into a typed `AuditVerdictBody`.
 * Returns `null` on any shape mismatch including counts-coherence
 * failure.
 *
 * **F3 disposition: target_pr.repo + target_peer are whitespace-
 * normalized on OUTPUT** (mirror of Slice 1 A1 fold) — `" conductor "`
 * and `"conductor"` produce the SAME typed body for downstream cross-
 * pair audit-routing canonicalization.
 *
 * Caller-side error policy: `null` is intentional — callers MUST choose
 * between log-and-skip OR adding a NEW shared parser variant
 * (e.g., `parseAuditVerdictBodyBestEffort`) co-located in this module.
 * SSOT discipline (sibling to `parseDigestBody` + `parseLiveUpdateBody`
 * + `parseAuditAskBody`).
 *
 * The parser is intentionally permissive on EXTRA fields (forward-
 * compatible). Author may include additional fields on the outer body
 * OR on individual `findings[i]` objects (e.g., `code`, `body_ref`).
 */
export function parseAuditVerdictBody(body: string): AuditVerdictBody | null {
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

  // target_pr — required object with non-empty string repo + positive integer number.
  // (Footgun: typeof null === "object" — explicit null-check first.)
  const targetPrRaw = obj["target_pr"];
  if (
    targetPrRaw === null ||
    typeof targetPrRaw !== "object" ||
    Array.isArray(targetPrRaw)
  ) {
    return null;
  }
  const targetPr = targetPrRaw as Record<string, unknown>;
  const repoRaw = targetPr["repo"];
  if (typeof repoRaw !== "string" || repoRaw.trim().length === 0) {
    return null;
  }
  const numberRaw = targetPr["number"];
  if (
    typeof numberRaw !== "number" ||
    !Number.isInteger(numberRaw) ||
    numberRaw <= 0
  ) {
    return null;
  }

  // target_peer — required non-empty (post-trim) string.
  const targetPeer = obj["target_peer"];
  if (typeof targetPeer !== "string" || targetPeer.trim().length === 0) {
    return null;
  }

  // lens_set_applied — required non-empty array of valid LensClass.
  const lensSet = obj["lens_set_applied"];
  if (!isLensClassArray(lensSet)) return null;

  // audit_class — required valid AuditClass.
  const auditClass = obj["audit_class"];
  if (!isAuditClass(auditClass)) return null;

  // audit_axes — required non-empty array of valid AuditAxis.
  const auditAxes = obj["audit_axes"];
  if (!isAuditAxisArray(auditAxes)) return null;

  // verdict — required valid AuditVerdict.
  const verdict = obj["verdict"];
  if (!isAuditVerdict(verdict)) return null;

  // counts — required object with non-negative integer blocker/fold/nit.
  const countsRaw = obj["counts"];
  if (
    countsRaw === null ||
    typeof countsRaw !== "object" ||
    Array.isArray(countsRaw)
  ) {
    return null;
  }
  const counts = countsRaw as Record<string, unknown>;
  const blocker = counts["blocker"];
  const fold = counts["fold"];
  const nit = counts["nit"];
  if (
    typeof blocker !== "number" ||
    !Number.isInteger(blocker) ||
    blocker < 0
  ) {
    return null;
  }
  if (typeof fold !== "number" || !Number.isInteger(fold) || fold < 0) {
    return null;
  }
  if (typeof nit !== "number" || !Number.isInteger(nit) || nit < 0) {
    return null;
  }

  // three_option_ask — REQUIRED object (per F1 reframe; no tier-skip).
  const askRaw = obj["three_option_ask"];
  if (askRaw === null || typeof askRaw !== "object" || Array.isArray(askRaw)) {
    return null;
  }
  const ask = askRaw as Record<string, unknown>;
  const aRatify = ask["a_ratify"];
  if (typeof aRatify !== "string" || aRatify.trim().length === 0) {
    return null;
  }
  // B1 fold (Bravo post-impl audit 22:19Z): symmetric trim-check
  // discipline. a_ratify rejects whitespace-only; b_fold + c_reframe
  // must match for consistency. Writer posting whitespace-only sub-field
  // is a bug class — reject as null shape mismatch (mirrors
  // parseLiveUpdateBody empty-string normalization).
  const bFold = ask["b_fold_if_applicable"];
  if (
    bFold !== null &&
    (typeof bFold !== "string" || bFold.trim().length === 0)
  ) {
    return null;
  }
  const cReframe = ask["c_reframe_if_applicable"];
  if (
    cReframe !== null &&
    (typeof cReframe !== "string" || cReframe.trim().length === 0)
  ) {
    return null;
  }

  // findings — required array of valid AuditFinding shapes.
  // May be empty (SHIP-CLEAN with zero counts — N1 coherence allows it).
  const findingsRaw = obj["findings"];
  if (!Array.isArray(findingsRaw)) return null;
  const findings: AuditFinding[] = [];
  for (const f of findingsRaw) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) return null;
    const fo = f as Record<string, unknown>;
    if (!isFindingSeverity(fo["kind"])) return null;
    if (!isLensClass(fo["lens"])) return null;
    const title = fo["title"];
    if (typeof title !== "string" || title.trim().length === 0) return null;
    const detail = fo["detail"];
    if (typeof detail !== "string" || detail.trim().length === 0) return null;
    findings.push({
      kind: fo["kind"],
      lens: fo["lens"],
      title,
      detail,
    });
  }

  // N1 counts-coherence cross-validation: counts must equal severity-grouped
  // findings length. Catches author tally errors at parse-time.
  const blockerActual = findings.filter((f) => f.kind === "BLOCKER").length;
  const foldActual = findings.filter((f) => f.kind === "FOLD").length;
  const nitActual = findings.filter((f) => f.kind === "NIT").length;
  if (blocker !== blockerActual || fold !== foldActual || nit !== nitActual) {
    return null;
  }

  // cross_edge_consumers_verified — optional readonly string[]. Backwards-
  // compat with kind_version: 1 bodies pre-dating the field. Parser
  // tolerates absent (treated as undefined); rejects present-but-wrong-
  // shape. Send-time validation in cli.ts enforces non-empty for
  // substrate-class PRs per isSubstrateClassPR(target_pr).
  const crossEdgeRaw = obj["cross_edge_consumers_verified"];
  let crossEdgeConsumersVerified: readonly string[] | undefined;
  if (crossEdgeRaw === undefined) {
    crossEdgeConsumersVerified = undefined;
  } else if (!Array.isArray(crossEdgeRaw)) {
    return null;
  } else {
    for (const entry of crossEdgeRaw) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        return null;
      }
    }
    crossEdgeConsumersVerified = crossEdgeRaw as readonly string[];
  }

  return {
    kind_version: 1,
    target_pr: { repo: repoRaw.trim(), number: numberRaw },
    target_peer: targetPeer.trim(),
    lens_set_applied: lensSet,
    audit_class: auditClass,
    audit_axes: auditAxes,
    verdict,
    counts: { blocker, fold, nit },
    three_option_ask: {
      a_ratify: aRatify,
      b_fold_if_applicable: bFold,
      c_reframe_if_applicable: cReframe,
    },
    findings,
    ...(crossEdgeConsumersVerified !== undefined
      ? { cross_edge_consumers_verified: crossEdgeConsumersVerified }
      : {}),
  };
}
