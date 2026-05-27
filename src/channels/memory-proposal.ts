// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `memory-proposal` message kind — shared body parser + schema type (Tier 2
 * Verb 2 of the schemas-first substrate, ratified 2026-05-19 brainstorm +
 * plan v0.2 LOCKED 2026-05-20T00:45Z).
 *
 * Sibling-to-Nick primitive. Posted by a peer surfacing a memorialization
 * candidate for Nick's batch yes/no decision. Substrate does NOT auto-file
 * memories per `feedback-memory-authoring-surface-dont-auto-file` — this
 * kind structures the surface; a separate Tier-2 ratification verb (out of
 * scope for this slice) consumes ratified proposals and writes the file.
 *
 * **Schema rationale (sibling to `LiveUpdateBody` + `DigestBody` +
 * `AuditAskBody` + `AuditVerdictBody`):** structured body shape earns the
 * new kind. Carries enough metadata for Nick to make a yes/no decision
 * without context-switching to the proposer's session (candidate_name +
 * memory_type + reason + proposed_body + description + optional
 * amends_existing pointer).
 *
 * **`MemoryType` inline (D2 (a)):** the 4-value enum (`user | feedback |
 * project | reference`) lives in THIS module today per YAGNI. If Tier-3
 * T3-E memory-attention-scoring or other Tier-3 memory primitives pull
 * into a current cohort, extract `MEMORY_TYPES` + `MemoryType` +
 * `isMemoryType` to a shared module then (cost ~30 LOC refactor;
 * well-amortized).
 *
 * **Symmetric trim discipline (Bravo F1 fold on V2 v0.1 audit):** all
 * five string fields (`candidate_name`, `description`, `reason`,
 * `proposed_body`, `amends_existing` when non-null) accept non-empty
 * post-trim strings; whitespace-only is rejected. Internal whitespace is
 * preserved on output (only leading/trailing trim is canonicalized).
 * Mirrors Slice 1 A1 + Slice 2 B1 carry-over discipline.
 *
 * **Verification-budget contract for `memory-proposal`:** readers trust
 * the SHAPE returned by this parser (validator-enforced) but must
 * primary-source-verify (a) the `candidate_name` slug does not collide
 * with an existing memory in `~/.claude/projects/-Users-nbruzzi/memory/`
 * when `amends_existing` is null (writer claim — substrate can't enforce
 * disk state); (b) the `amends_existing` slug exists on disk when
 * non-null (writer claim — same reasoning). The proposer's CLAIM is
 * authoritative for the proposal's content; ratification-side verifies
 * the on-disk substance.
 *
 * **Why a new kind vs extending `note` or piggybacking on `status`:**
 * memory-proposal has heavily structured body (6 typed fields with
 * discriminator semantics on `memory_type` + nullable `amends_existing`)
 * + a downstream consumer contract (the deferred Tier-2 ratification
 * verb). Per the walkie-talkie kinds + verification-budget convention.
 *
 * Plan: `~/.claude/plans/slice-T2V2-memory-proposal-schema-2026-05-20.md`
 * v0.2.
 */

/**
 * Memory-file type per CLAUDE.md §Memory Conventions + auto-memory
 * frontmatter spec. Determines which namespace prefix the memory file
 * uses on disk (`user-`, `feedback-`, `project-`, `reference-`) and
 * affects how reader-side surfaces filter / route the entry.
 *
 * Per D2 (a) of plan v0.2: inline here for v1; extract to a shared module
 * when a 2nd consumer surfaces. **Extracted 2026-05-26 (PR-A6 trigger)**
 * to `./memory-type.ts` per the predicted plan; this module re-exports
 * the shared surface so the public api.ts re-export path remains stable.
 * PR-A6 (`memory-frontmatter-parser.ts`) is the 2nd consumer.
 */
import { MEMORY_TYPES, isMemoryType } from "./memory-type.ts";
import type { MemoryType } from "./memory-type.ts";

// Preserve the original public surface (api.ts re-exports MEMORY_TYPES +
// isMemoryType via this module; downstream consumers may also import
// directly from `./memory-proposal.ts`). Per
// `feedback-type-only-exports-erase-at-runtime`: separate value-side and
// type-side re-exports so values keep their runtime bindings.
export { MEMORY_TYPES, isMemoryType };
export type { MemoryType };

/**
 * Schema for the `memory-proposal` kind's body field (JSON-serialized to
 * the JSONL line at write time; parsed on read).
 *
 * `kind_version: 1` matches the digest + live-update + audit-ask +
 * audit-verdict schema-version convention. Today's parser accepts only
 * version `1`; mis-versioned bodies return `null`.
 */
export type MemoryProposalBody = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /**
   * Slug for the proposed memory (e.g., `feedback-auto-sync-recurrence`).
   * Non-empty post-trim. Whitespace-normalized on output. Slug-form
   * convention (`^[a-z][a-z0-9-]*$`-ish) is writer-side discipline;
   * the parser does NOT validate slug shape (forward-compat for new
   * naming patterns; reader-side surfaces may stricter-check).
   */
  candidate_name: string;
  /**
   * Memory namespace per CLAUDE.md §Memory Conventions. Determines the
   * file-name prefix at ratification time.
   */
  memory_type: MemoryType;
  /**
   * One-line summary used for the memory frontmatter `description` field
   * + `MEMORY.md` TOC line. Non-empty post-trim; whitespace-normalized
   * on output. Multi-line `description` is preserved but the
   * convention is single-line; readers may collapse on display.
   */
  description: string;
  /**
   * Why this memorialization — what trigger surfaced it, what a future
   * reader would gain. Non-empty post-trim; whitespace-normalized on
   * output. May be multi-paragraph.
   */
  reason: string;
  /**
   * The actual memory body content WITHOUT frontmatter (substrate adds
   * frontmatter at ratify time from candidate_name + memory_type +
   * description). Non-empty post-trim; whitespace-normalized on output
   * (leading/trailing only; internal whitespace incl. markdown is
   * preserved verbatim). Typically multi-paragraph markdown.
   */
  proposed_body: string;
  /**
   * Optional pointer to an existing memory's `name` slug when this
   * proposal is an AMENDMENT to an existing memory (e.g., add a
   * recurrence-fact section to an existing pattern). `null` when
   * net-new. When non-null: non-empty post-trim string; whitespace-
   * normalized on output (per F1 symmetric trim discipline).
   *
   * Merge-strategy (append vs section-replace vs frontmatter-extend) is
   * ratify-verb territory; the proposal carries only the pointer.
   */
  amends_existing: string | null;
};

/**
 * Parse a `memory-proposal` message body into a typed
 * `MemoryProposalBody`. Returns `null` on any shape mismatch:
 *
 *   - Body is not valid JSON.
 *   - Body is not a non-null, non-array object.
 *   - `kind_version` is missing or not `1`.
 *   - Any required string field is missing / non-string / empty post-trim.
 *   - `memory_type` is missing or not a valid `MemoryType` literal.
 *   - `amends_existing` is present but neither `null` nor a non-empty
 *     post-trim string.
 *
 * **F1 symmetric trim discipline:** every string field rejects whitespace-
 * only values (parse-time null) AND normalizes leading/trailing whitespace
 * on output. Mirrors Slice 1 A1 + Slice 2 B1 carry-over. Internal
 * whitespace (incl. markdown formatting) is preserved verbatim.
 *
 * Caller-side error policy: `null` is intentional — callers MUST choose
 * between log-and-skip OR adding a NEW shared parser variant
 * (e.g., `parseMemoryProposalBodyBestEffort`) co-located in this module.
 * Ad-hoc re-implementation per call site is the known anti-pattern the
 * SSOT-at-the-convention-layer discipline eliminates (sibling to
 * `parseDigestBody` + `parseLiveUpdateBody` + `parseAuditAskBody` +
 * `parseAuditVerdictBody`).
 *
 * The parser is intentionally permissive on EXTRA fields (forward-
 * compatible). Author may include additional fields (e.g., `body_ref`
 * for deep-link pointers; `linked_memories` for `[[name]]` cross-refs
 * intent) without breaking forward parse.
 */
export function parseMemoryProposalBody(
  body: string,
): MemoryProposalBody | null {
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

  // candidate_name — required non-empty (post-trim) string.
  const candidateNameRaw = obj["candidate_name"];
  if (
    typeof candidateNameRaw !== "string" ||
    candidateNameRaw.trim().length === 0
  ) {
    return null;
  }

  // memory_type — required valid MemoryType.
  const memoryType = obj["memory_type"];
  if (!isMemoryType(memoryType)) return null;

  // description — required non-empty (post-trim) string.
  const descriptionRaw = obj["description"];
  if (
    typeof descriptionRaw !== "string" ||
    descriptionRaw.trim().length === 0
  ) {
    return null;
  }

  // reason — required non-empty (post-trim) string.
  const reasonRaw = obj["reason"];
  if (typeof reasonRaw !== "string" || reasonRaw.trim().length === 0) {
    return null;
  }

  // proposed_body — required non-empty (post-trim) string.
  const proposedBodyRaw = obj["proposed_body"];
  if (
    typeof proposedBodyRaw !== "string" ||
    proposedBodyRaw.trim().length === 0
  ) {
    return null;
  }

  // amends_existing — optional pointer. null OR non-empty (post-trim) string.
  // F1 symmetric trim: whitespace-only rejected (mirrors three_option_ask
  // b_fold/c_reframe discipline from Slice 2 B1 fold).
  const amendsExistingRaw = obj["amends_existing"];
  let amendsExisting: string | null;
  if (amendsExistingRaw === null || amendsExistingRaw === undefined) {
    amendsExisting = null;
  } else if (
    typeof amendsExistingRaw === "string" &&
    amendsExistingRaw.trim().length > 0
  ) {
    amendsExisting = amendsExistingRaw.trim();
  } else {
    return null;
  }

  // F1 / Slice 1 A1 carry-over: normalize leading/trailing whitespace on
  // output for all string fields. Cross-pair audit-routing + frontmatter
  // generation require canonical (no leading/trailing whitespace) input;
  // validation already rejects empty post-trim. Internal whitespace
  // (including markdown structure) is preserved verbatim.
  return {
    kind_version: 1,
    candidate_name: candidateNameRaw.trim(),
    memory_type: memoryType,
    description: descriptionRaw.trim(),
    reason: reasonRaw.trim(),
    proposed_body: proposedBodyRaw.trim(),
    amends_existing: amendsExisting,
  };
}
