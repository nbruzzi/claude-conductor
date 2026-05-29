// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `poll` message kind — shared body parser + schema type (Cycle 6 item-2,
 * Sundry-P1; agetor steal-list A-P1-4 "structured-card answers").
 *
 * A structured question carrying discrete `options` for a structured answer
 * — radio/checkbox/textarea-style choice on the channel, peer-to-peer (the
 * `AskUserQuestion` shape applied to cohort coordination). Use cases: cohort
 * decisions, votes, structured approvals (composes with the bernstein
 * structured-approval pattern).
 *
 * **Why a NEW kind vs extending `question`:** `question` is intentionally
 * unstructured free-form (see `audit-ask.ts` § "Why a new kind vs extending
 * question"). Structured shape earns a new kind — the same reasoning that
 * gave `digest`, `live-update`, and `audit-ask` their own kinds. A `poll`
 * carries a typed body (question + validated options); `question` stays
 * free-form for unstructured asks. The roadmap A-P1-4 framing ("add
 * `options` to kind=question") is superseded by this established convention.
 *
 * **Answer convention (v1):** responders answer by referencing an option
 * `id` in a reply (`note`/`ack` body). A dedicated `poll-answer` kind +
 * tally is a documented follow-up; v1 ships the structured question (the
 * "card") only.
 *
 * **Verification-budget contract:** readers trust the SHAPE returned by this
 * parser (validator-enforced). The option SET is an author-claim — the
 * parser validates only structural well-formedness (>= 2 options; unique
 * non-empty `id`s + non-empty `label`s), NOT option semantics. Sibling to
 * `parseAuditAskBody` + `parseDigestBody` + `parseLiveUpdateBody`.
 *
 * Plan: `~/.claude/plans/cycle-6-item-2-poll-kind-slice-plan-2026-05-29.md`.
 */

/**
 * A single selectable option on a `poll`.
 */
export type PollOption = {
  /**
   * Stable identifier used to reference this option in an answer. Non-empty
   * (post-trim); unique within the poll.
   */
  id: string;
  /** Human-readable choice text. Non-empty (post-trim). */
  label: string;
  /** Optional longer explanation of what choosing this option means. */
  description?: string;
};

/**
 * Schema for the `poll` kind's body field (JSON-serialized to the JSONL
 * line at write time; parsed on read). `kind_version: 1` matches the digest
 * + live-update + audit-ask schema-version convention; today's parser
 * accepts only version `1`, mis-versioned bodies return `null`.
 */
export type PollBody = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /** The question / prompt being asked. Non-empty (post-trim). */
  question: string;
  /**
   * The discrete options offered. At least 2; each carries a unique
   * non-empty `id` + non-empty `label`.
   */
  options: readonly PollOption[];
  /** Whether responders may select more than one option. Defaults to `false`. */
  multi_select: boolean;
  /** Whether a free-text answer is accepted alongside the options. Defaults to `false`. */
  free_text: boolean;
};

/**
 * Parse a `poll` message body into a typed `PollBody`. Returns `null` on any
 * shape mismatch.
 *
 * The parser is permissive on EXTRA fields (forward-compatible). Output is
 * whitespace-normalized (trimmed) on `question` + each option's
 * `id`/`label`/`description`, symmetric with the empty-post-trim rejection
 * gate (sibling to the audit-ask A1 fold).
 *
 * Caller-side error policy: `null` is intentional — callers MUST choose
 * log-and-skip OR add a NEW shared parser variant co-located in this module;
 * ad-hoc re-implementation per call site is the known anti-pattern this
 * SSOT-at-the-convention-layer discipline eliminates.
 */
export function parsePollBody(body: string): PollBody | null {
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

  // question — required non-empty (post-trim) string.
  const questionRaw = obj["question"];
  if (typeof questionRaw !== "string" || questionRaw.trim().length === 0) {
    return null;
  }

  // options — required array of length >= 2; each option validated + normalized.
  const optionsRaw = obj["options"];
  if (!Array.isArray(optionsRaw) || optionsRaw.length < 2) return null;

  const seenIds = new Set<string>();
  const options: PollOption[] = [];
  for (const optRaw of optionsRaw) {
    // T3.12 footgun: typeof null === "object", so the explicit null-check matters.
    if (
      optRaw === null ||
      typeof optRaw !== "object" ||
      Array.isArray(optRaw)
    ) {
      return null;
    }
    const opt = optRaw as Record<string, unknown>;

    const idRaw = opt["id"];
    if (typeof idRaw !== "string" || idRaw.trim().length === 0) return null;
    const id = idRaw.trim();
    if (seenIds.has(id)) return null; // duplicate option id
    seenIds.add(id);

    const labelRaw = opt["label"];
    if (typeof labelRaw !== "string" || labelRaw.trim().length === 0) {
      return null;
    }

    const descRaw = opt["description"];
    let description: string | undefined;
    if (descRaw !== undefined) {
      if (typeof descRaw !== "string") return null;
      description = descRaw.trim();
    }

    const option: PollOption =
      description === undefined
        ? { id, label: labelRaw.trim() }
        : { id, label: labelRaw.trim(), description };
    options.push(option);
  }

  // multi_select — optional boolean, defaults to false.
  let multiSelect = false;
  const multiSelectRaw = obj["multi_select"];
  if (multiSelectRaw !== undefined) {
    if (typeof multiSelectRaw !== "boolean") return null;
    multiSelect = multiSelectRaw;
  }

  // free_text — optional boolean, defaults to false.
  let freeText = false;
  const freeTextRaw = obj["free_text"];
  if (freeTextRaw !== undefined) {
    if (typeof freeTextRaw !== "boolean") return null;
    freeText = freeTextRaw;
  }

  return {
    kind_version: 1,
    question: questionRaw.trim(),
    options,
    multi_select: multiSelect,
    free_text: freeText,
  };
}
