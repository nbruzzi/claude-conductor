// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `live-update` message kind — shared body parser + schema type (L152).
 *
 * Sibling-onboarding primitive. Posted by an active peer within seconds
 * of a sibling's `joined` post in parallel-mode handoff-resume. Carries
 * structured body bridging the long-arc handoff (frozen at write-time)
 * and the live channel (volatile) at sibling-join time — removes the
 * "Nick relays active-peer state across windows" pattern that recurred
 * on every cross-window coordination cycle before today.
 *
 * **Schema rationale (sibling to `DigestBody`):** 4 narrative fields
 * capturing what the active peer is doing right now plus what the
 * joining sibling should pick up and what's hands-off. Free-form
 * strings — the audit-trail value is in the structure (4 keyed
 * sections), not in policed enumerations.
 *
 * **Verification-budget contract for `live-update`:** sibling to `digest`
 * — readers trust the SHAPE returned by this parser (validator-enforced)
 * but must primary-source-verify any specific SHA, PR number, backlog
 * item, or file path cited in the fields. The scope assignment
 * (`your_scope` / `hands_off`) is the load-bearing contract; treat it
 * as authoritative from the active peer.
 *
 * **Why a new kind vs extending `status`:** live-update has structured
 * body shape (4 keyed fields), whereas `status` is unstructured free-
 * form. Structured shape earns the new kind — same reasoning that
 * earned `digest` its own kind in Phase 4 Step A Layer 4. Per the
 * walkie-talkie kinds + verification-budget convention.
 *
 * Backlog: L152 (filed 2026-04-27 by Alpha mid-Alpha-Bravo coordination
 * context). See `docs/conventions/message-kinds-and-verification.md`
 * for the per-kind verification-budget table (to be updated as part of
 * Lane A's skill-body work).
 */

/**
 * Schema for the `live-update` kind's body (JSON-serialized to the JSONL
 * line at write time; parsed on read).
 *
 * `kind_version: 1` matches the digest schema-version convention.
 * Future revisions bump this and parsers branch on the version. Today's
 * parser accepts only version `1`; mis-versioned bodies return `null`
 * so callers can choose between "skip" and "best-effort partial decode"
 * semantics (currently all callers should skip).
 */
export type LiveUpdateBody = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /**
   * Optional — new commits / memories / decisions / scope-shifts since
   * the handoff was written. Free-form narrative; convention is bullet
   * points or short prose. `null` when no relevant updates (the handoff
   * already captured the active-peer's full context). Verify any SHA /
   * PR / backlog-item citation against primary sources before trusting.
   */
  since_handoff: string | null;
  /**
   * Required — what the active peer is doing RIGHT NOW. The joining
   * sibling reads this to know what NOT to step on. Free-form prose;
   * convention is one-to-three short lines.
   */
  current_focus: string;
  /**
   * Required — what the joining sibling should pick up first. Authority
   * for scope assignment lives in the live-update (NOT in the handoff,
   * since at handoff write-time the writer doesn't know which sibling
   * will pick up which slice). Verify by reading any cited
   * backlog/plan entry before starting.
   */
  your_scope: string;
  /**
   * Required — what the joining sibling should NOT touch. Use the
   * literal string `"none"` when nothing is hands-off. Free-form
   * otherwise; convention is bullet points naming files/components/
   * subsystems with brief rationale.
   */
  hands_off: string;
};

/**
 * Parse a `live-update` message body into a typed `LiveUpdateBody`.
 * Returns `null` on:
 *
 *   - Body is not valid JSON.
 *   - Body is not a non-null, non-array object.
 *   - `kind_version` is missing, non-numeric, or not `1`.
 *   - `current_focus` / `your_scope` / `hands_off` is missing or not a
 *     non-empty string.
 *   - `since_handoff` is present but not a string or null.
 *
 * Caller-side error policy: `null` is intentional — callers MUST
 * choose between log-and-skip OR adding a NEW shared parser variant
 * (e.g., `parseLiveUpdateBodyBestEffort`) co-located in this module.
 * Ad-hoc re-implementation per call site is a known anti-pattern that
 * re-creates the exact drift the SSOT-at-the-convention-layer
 * discipline eliminates (sibling to `parseDigestBody`).
 *
 * The parser is intentionally permissive on EXTRA fields (forward-
 * compatible).
 */
export function parseLiveUpdateBody(body: string): LiveUpdateBody | null {
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

  // The three required string fields must be non-empty. An active peer
  // posting an empty `current_focus` or `your_scope` is a bug, not a
  // valid no-op — the sibling needs SOMETHING actionable. Empty bodies
  // get rejected at parse time so consumers don't have to special-case
  // them at every call site.
  const currentFocus = obj["current_focus"];
  if (typeof currentFocus !== "string" || currentFocus.length === 0)
    return null;
  const yourScope = obj["your_scope"];
  if (typeof yourScope !== "string" || yourScope.length === 0) return null;
  const handsOff = obj["hands_off"];
  if (typeof handsOff !== "string" || handsOff.length === 0) return null;

  // `since_handoff` is optional — null OR a non-empty string. (An
  // empty-string since_handoff is a writer bug too; treat same as
  // null.)
  const sinceHandoffRaw = obj["since_handoff"];
  let sinceHandoff: string | null;
  if (sinceHandoffRaw === null || sinceHandoffRaw === undefined) {
    sinceHandoff = null;
  } else if (typeof sinceHandoffRaw === "string") {
    sinceHandoff = sinceHandoffRaw.length === 0 ? null : sinceHandoffRaw;
  } else {
    return null;
  }

  return {
    kind_version: 1,
    since_handoff: sinceHandoff,
    current_focus: currentFocus,
    your_scope: yourScope,
    hands_off: handsOff,
  };
}
