// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Substrate-class PR detection — repo-based heuristic.
 *
 * A "substrate-class PR" is one that changes wire-shapes, shared
 * primitives, or substrate-export surfaces that downstream consumers
 * MIRROR or RE-EXPORT (dotfiles plugin shim, dashboard adapter, etc.).
 * Audit-verdicts on substrate-class PRs are required to enumerate the
 * cross-edge consumer-edges the auditor verified — per
 * `feedback-audit-cohort-missed-cross-edge-shim-consumer` discipline
 * (cycle 2026-05-25 origin: PR #119 4-instance audit-cohort gap).
 *
 * The detection heuristic is intentionally narrow at v0.1: repo-based
 * only. Future v0.2 may refine via path-set inside the repo (e.g.,
 * conductor/src/{active-sessions,channels,shared}/) if empirical
 * pressure surfaces (e.g., conductor PRs that don't touch substrate
 * paths producing false-positive validation rejects).
 *
 * Mirrors `LENS_CLASSES` tuple convention at `audit-types.ts` —
 * exported as a const set for caller-side enumeration (audit tooling,
 * dashboards, lint rules).
 */

/**
 * Repos whose PRs are treated as substrate-class for cross-edge-
 * consumer-verification enforcement. Single-source-of-truth: extend
 * this set as substrate-precedes-consumer cohorts emerge for new
 * repos.
 *
 * Current membership rationale:
 *   - `nbruzzi/claude-conductor` — plugin substrate; dotfiles shim
 *     mirrors exports, dashboard adapter consumes substrate types
 *     (verified across 7+ cycles of substrate-precedes-consumer
 *     cadence).
 *
 * NOT included (deliberately):
 *   - `nbruzzi/claude-conductor-dashboard` — consumer-side; substrate
 *     IS the cross-edge from consumer perspective. PRs here verify
 *     substrate-import correctness via the existing adapter test
 *     patterns; different cohort-class.
 *   - `nbruzzi/claude-dotfiles` — defaults to non-substrate for
 *     verification purposes. If dotfiles begins shipping substrate
 *     primitives that other consumers mirror, add here.
 */
export const SUBSTRATE_CLASS_REPOS: ReadonlySet<string> = new Set([
  "nbruzzi/claude-conductor",
]);

/**
 * Returns `true` iff `target_pr.repo` is a substrate-class repo per
 * `SUBSTRATE_CLASS_REPOS`. Used by the audit-verdict send-time
 * validator to gate the `cross_edge_consumers_verified` required-field
 * check.
 *
 * Repo-based heuristic at v0.1; see module JSDoc for v0.2 refinement
 * direction. If detection misclassifies in practice, surface via
 * `feedback-audit-cohort-missed-cross-edge-shim-consumer` follow-on
 * before adding an override-flag (YAGNI per plan v0.1 Q4).
 */
export function isSubstrateClassPR(target_pr: {
  repo: string;
  number: number;
}): boolean {
  return SUBSTRATE_CLASS_REPOS.has(target_pr.repo);
}
