// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `digest` message kind — shared body parser + schema type
 * (Phase 4 Step A Layer 4).
 *
 * Layer 4 of the inter-sibling communication arc introduces `digest` as
 * the **mental-model-sync** message kind: a structured summary one
 * session emits to peers (or to its future self) capturing "what
 * shipped + what's verified + what audit-classes were paid + what's
 * pickable next + what's blocking". The convention-layer here is the
 * `DigestBody` shape; substrate stays kind-blind (validator accepts
 * `digest` via the SSOT tuple at `src/channels/index.ts`).
 *
 * **Why a shared parser:** any reader consuming `digest` messages
 * should use this single parser rather than re-implementing JSON-parse
 * + shape-check per call site. Drift between in-tree readers (operator
 * tools, cross-edge dotfiles consumers, future Phase 4 Step B reaper,
 * future analysis tooling) is exactly the bait the SSOT pattern
 * eliminates one layer up; `parseDigestBody` extends that discipline
 * to the convention layer.
 *
 * **Verification-budget contract for `digest`:** per the verification-
 * budget convention (`docs/conventions/message-kinds-and-verification.md`),
 * readers trust the SHAPE returned by this parser (validator-enforced)
 * but must primary-source-verify any specific audit-class string, SHA,
 * PR number, or backlog item cited in the fields. See
 * `feedback-verification-budget-by-kind.md` for the rationale and
 * `feedback-digest-message-convention.md` for the schema rationale.
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 §Phase 3.
 */

/**
 * Schema for the `digest` kind's body field (JSON-serialized to the
 * JSONL line at write time; parsed on read).
 *
 * `kind_version: 1` is the schema version tag — future revisions bump
 * this and parsers branch on the version. Today's parser accepts only
 * version `1`; mis-versioned bodies return `null` so callers can
 * choose between "skip" and "best-effort partial decode" semantics.
 *
 * All array fields are arrays of strings (free-form by convention) so
 * the schema is permissive enough for diverse digest authoring
 * shapes — the audit-trail value is in the structure (these five
 * arrays + one numeric budget), not in policed enumerations.
 */
export type DigestBody = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /**
   * What landed in the prior work increment that this digest summarizes.
   * Free-form strings; convention is `"PR #N at <SHA>"` or
   * `"Commit <SHA> on <branch>"`. Verify references against
   * git/GH primary sources before trusting them in cascade reasoning.
   */
  what_shipped: readonly string[];
  /**
   * Which verification gates ran clean for the work in `what_shipped`.
   * Free-form strings; convention is `"typecheck"`, `"test"`, `"lint"`,
   * `"audit:CLI-DX"`, `"audit:Reliability"`, `"smoke:phase-2"`, etc.
   * Verify by re-running the gate at the cited SHA before trusting in
   * downstream automation.
   */
  what_verified: readonly string[];
  /**
   * Audit-class "rent payments" this work paid down. Free-form strings
   * naming the catch-shape (e.g., `"sibling-shape-miss"`,
   * `"prompt-injection-surface"`). Useful for cross-arc memory work
   * looking for recurrence patterns. Verify against the specific
   * audit-line that surfaced the catch.
   */
  audit_class_paid: readonly string[];
  /**
   * What the next session / sibling should pick up first. Free-form
   * string naming a backlog entry, a plan step, or a deferred follow-
   * up. Verify by reading the cited backlog/plan entry.
   */
  next_pickable: string;
  /**
   * What this work cannot proceed without. Free-form strings naming
   * the blocker (e.g., `"PR #N awaiting Nick review"`, `"upstream
   * Claude Code feature ask"`, `"backlog item #42"`). Empty array
   * when nothing blocks.
   */
  blockers: readonly string[];
  /**
   * Wall-clock verification budget spent on the work in `what_shipped`
   * (milliseconds). Useful for tracking the cost of the audit-fold
   * cadence over arcs. Validate as a finite non-negative number.
   */
  verification_budget_consumed_ms: number;
};

/**
 * Parse a `digest` message body into a typed `DigestBody`. Returns
 * `null` on:
 *
 *   - Body is not valid JSON.
 *   - Body is not an object.
 *   - `kind_version` is missing, non-numeric, or not `1`.
 *   - Any required string-array field is missing or contains non-string
 *     elements.
 *   - `next_pickable` is missing or not a string.
 *   - `verification_budget_consumed_ms` is missing, non-numeric, NaN,
 *     negative, or non-finite.
 *
 * Caller-side error policy: `null` is intentional — callers MUST
 * choose between log-and-skip OR adding a NEW shared parser variant
 * (e.g., `parseDigestBodyBestEffort`) co-located in this module. Ad-hoc
 * re-implementation per call site is a known anti-pattern that
 * re-creates the exact drift the SSOT-at-the-convention-layer
 * discipline eliminates; once one ad-hoc fallback ships, the next
 * caller copies it and the shared-parser invariant erodes.
 *
 * The parser is intentionally permissive on EXTRA fields (forward-
 * compatible — a future schema version 2 with additional fields can
 * still parse the v1 subset cleanly when explicitly downgraded).
 */
export function parseDigestBody(body: string): DigestBody | null {
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

  if (!isStringArray(obj["what_shipped"])) return null;
  if (!isStringArray(obj["what_verified"])) return null;
  if (!isStringArray(obj["audit_class_paid"])) return null;
  if (!isStringArray(obj["blockers"])) return null;

  if (typeof obj["next_pickable"] !== "string") return null;

  const budget = obj["verification_budget_consumed_ms"];
  // `Number.isFinite(NaN)` is already `false`, so the NaN case is
  // covered by `!Number.isFinite(budget)`. No separate `Number.isNaN`
  // clause needed (Alpha MINOR-3 fold per sibling cross-audit).
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
    return null;
  }

  return {
    kind_version: 1,
    what_shipped: obj["what_shipped"] as readonly string[],
    what_verified: obj["what_verified"] as readonly string[],
    audit_class_paid: obj["audit_class_paid"] as readonly string[],
    next_pickable: obj["next_pickable"],
    blockers: obj["blockers"] as readonly string[],
    verification_budget_consumed_ms: budget,
  };
}

function isStringArray(v: unknown): v is readonly string[] {
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (typeof item !== "string") return false;
  }
  return true;
}
