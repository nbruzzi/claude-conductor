// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `wind-down-checkin` message kind — shared body parser + schema type (Tier 2
 * Verb 1 of the schemas-first substrate, ratified 2026-05-19 brainstorm +
 * plan v0.1 SHIP-CLEAN LOCKED 2026-05-20T01:09Z).
 *
 * Cycle-end primitive. Posted by a peer at wind-down time to broadcast
 * structured cycle-close state: what's next, what was decided, what failed,
 * what memorialization candidates surfaced, and what shape the cycle had.
 * Substrate-mediates the wind-down summary — today's channel-prose `kind=status`
 * wind-down checkin becomes a typed body downstream consumers can parse.
 *
 * Sibling-pair primitive to `audit-ask` + `audit-verdict` (Slice 1+2) +
 * `memory-proposal` (V2). Closes the "cycle wind-down is a substrate
 * primitive, not just a checklist convention" gap per [[feedback-wind-down-ordering]]
 * + CLAUDE.md §Wind-down sequencing.
 *
 * **Schema rationale (sibling to `LiveUpdateBody` + `DigestBody` +
 * `AuditAskBody` + `AuditVerdictBody` + `MemoryProposalBody`):** structured
 * body shape earns the new kind. Carries enough metadata for downstream
 * Tier-3 consumers (T3-F cycle-character classifier; T3-G reciprocation
 * ledger) to derive cycle state without regex-scraping handoff prose.
 *
 * **`CycleCharacter` inline (D2 (a)):** the 5-value rubric (`PRISTINE` /
 * `RECOVERED` / `INCIDENT-DRIVEN` / `COHORT-PASS` / `STALLED`) lives in THIS
 * module today per YAGNI — symmetric to V2 D2(a) MemoryType disposition.
 * If Tier-3 T3-F cycle-character classifier or T3-G reciprocation ledger
 * pulls into a current cohort, extract `CYCLE_CHARACTERS` + `CycleCharacter`
 * + `isCycleCharacter` to a shared module then (cost ~30 LOC refactor;
 * well-amortized).
 *
 * **Symmetric trim discipline (Slice 2 B1 + V2 F1 preemptive carry-over):**
 * every array element across all 4 string-array fields (`next_steps`,
 * `decisions_logged`, `failed_approaches`, `memory_candidates`) must be a
 * non-empty post-trim string. Whitespace-only entries are rejected.
 * Internal whitespace is preserved on output (only leading/trailing trim
 * is canonicalized). Mirrors Slice 1 A1 + Slice 2 B1 + V2 F1 discipline.
 *
 * **Min-count invariants (Q3 disposition):** `next_steps` and
 * `decisions_logged` require minimum 1 entry each — cycle close without
 * an explicit next-step or decision is incoherent semantically (even
 * "no next-steps queued; standing by" or "no new decisions this cycle"
 * is a 1-entry array). `failed_approaches` and `memory_candidates` accept
 * empty arrays (pristine cycles legitimately have neither).
 *
 * **Verification-budget contract for `wind-down-checkin`:** readers trust
 * the SHAPE returned by this parser (validator-enforced) but must primary-
 * source-verify (a) `cycle_character` claim against actual cycle artifacts
 * (PR squashes / CI conclusions / failed-approach captures) and (b)
 * `memory_candidates` slug names against the memory directory before
 * acting on the queue. The poster's CLAIM is authoritative for the
 * cycle-close shape; downstream consumers verify the substance.
 *
 * **Why a new kind vs piggybacking on `status` or `handoff`:** wind-down
 * has heavily structured body (6 typed fields with cycle-state discriminator
 * + downstream Tier-3 consumer contract). `status` is unstructured prose;
 * `handoff` is a transfer-of-state event with file-pointer semantics, not
 * a structured summary. Per the walkie-talkie kinds + verification-budget
 * convention.
 *
 * Plan: `~/.claude/plans/slice-T2V1-wind-down-checkin-schema-2026-05-20.md`
 * v0.1 (SHIP-CLEAN LOCKED).
 */

/**
 * Cycle-character rubric per the Bravo Tier 3 T3-F classifier framework.
 * 5 mutually-exclusive values characterize how the cycle ran:
 *
 *   - `PRISTINE` — plan-LOCK → build → CI green → audit-RATIFY without
 *     a fold-required cycle; cleanest shape.
 *   - `RECOVERED` — a critical bug or failed approach surfaced mid-cycle
 *     but was caught + fixed before squash; convergence-by-divergence or
 *     similar discipline rescued the cycle.
 *   - `INCIDENT-DRIVEN` — cycle work was scoped reactively in response
 *     to an incident or live-bug; not pre-planned.
 *   - `COHORT-PASS` — multi-slice cohort shipped together with shared
 *     pattern-reuse; not a single substantive PR but a tight bundle.
 *   - `STALLED` — cycle did not produce a substantive squash; blocked
 *     on external dependency, ambiguity, or unresolved disagreement.
 *
 * Per D2 (a) of plan v0.1: inline here for v1; extract to a shared module
 * when a 2nd consumer surfaces (T3-F classifier or T3-G reciprocation
 * ledger are current candidates).
 */
export const CYCLE_CHARACTERS = [
  "PRISTINE",
  "RECOVERED",
  "INCIDENT-DRIVEN",
  "COHORT-PASS",
  "STALLED",
] as const;
export type CycleCharacter = (typeof CYCLE_CHARACTERS)[number];

/**
 * Type-guard: `v` is one of the valid `CycleCharacter` literals.
 */
export function isCycleCharacter(v: unknown): v is CycleCharacter {
  return (
    typeof v === "string" && (CYCLE_CHARACTERS as readonly string[]).includes(v)
  );
}

/**
 * Fire-phase rubric for `wind-down-checkin` messages — distinguishes when
 * in the cycle this checkin fired:
 *
 *   - `"mid"` — a mid-cycle snapshot (e.g., arm-fire between slices);
 *     the cycle is ongoing. NOT the authoritative cycle-close ledger.
 *   - `"terminal"` — the terminal cycle-close checkin; this IS the
 *     authoritative cycle-close ledger entry.
 *
 * **Reader contract (absent⇒unspecified, NEVER terminal):** a
 * terminal-gated action MUST require `fire_phase === "terminal"` EXPLICITLY.
 * An absent `fire_phase` OR `fire_phase === "mid"` MUST be treated as
 * NOT-terminal. `absent` is the legacy/back-compat shape — every existing
 * v1 body without this field is valid and means "unspecified", not
 * "terminal". New posts SHOULD set it explicitly.
 *
 * **Closed-set rationale:** `mid|terminal` exhausts "when in the cycle did
 * this fire"; it is a CLOSED set. A 3rd value (if ever needed) is a
 * deliberate schema migration with `kind_version` bump, not a forward-compat
 * additive — so strict-reject on present-invalid gives send-time typo-catch
 * at the cost of negligible future-value hazard (explicitly accepted per
 * 1c of the W1b spec, 2026-06-12).
 */
export const FIRE_PHASES = ["mid", "terminal"] as const;
export type FirePhase = (typeof FIRE_PHASES)[number];

/**
 * Type-guard: `v` is one of the valid `FirePhase` literals.
 */
export function isFirePhase(v: unknown): v is FirePhase {
  return (
    typeof v === "string" && (FIRE_PHASES as readonly string[]).includes(v)
  );
}

/**
 * Schema for the `wind-down-checkin` kind's body field (JSON-serialized to
 * the JSONL line at write time; parsed on read).
 *
 * `kind_version: 1` matches the digest + live-update + audit-ask +
 * audit-verdict + memory-proposal schema-version convention. Today's
 * parser accepts only version `1`; mis-versioned bodies return `null`.
 */
export type WindDownCheckinBody = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /**
   * Action items the poster is leaving for the next-cycle resume. Min 1
   * entry required (Q3 disposition: cycle-close without an explicit
   * next-step is incoherent; even "no next-steps queued; standing by"
   * is a 1-entry array). Each entry: non-empty post-trim string;
   * whitespace-normalized on output (per F1 symmetric trim discipline).
   */
  next_steps: readonly string[];
  /**
   * Decisions logged this cycle — substantive design / process / scope
   * calls that shape the future. Min 1 entry required (Q3 disposition).
   * Same shape as next_steps (non-empty post-trim; whitespace-normalize-
   * on-output).
   */
  decisions_logged: readonly string[];
  /**
   * Approaches that were tried and rejected this cycle, with brief why.
   * CAN be an empty array (pristine cycles legitimately have no failed
   * approaches). Each entry (when present): non-empty post-trim string;
   * whitespace-normalized on output (per F1 symmetric trim discipline).
   */
  failed_approaches: readonly string[];
  /**
   * Memorialization candidates surfaced this cycle — slug-form names that
   * Nick will batch yes/no into `memory-proposal` kind messages or directly
   * to disk (per `feedback-memory-authoring-surface-dont-auto-file`). CAN
   * be empty. Each entry (when present): non-empty post-trim string.
   */
  memory_candidates: readonly string[];
  /**
   * Cycle-character classification per the T3-F rubric. Required typed
   * enum. See `CYCLE_CHARACTERS` for the 5 valid values + semantics.
   */
  cycle_character: CycleCharacter;
  /**
   * Optional cycle-fire phase. Absent ⇒ UNSPECIFIED (legacy/back-compat);
   * a terminal-gated reader MUST require fire_phase==="terminal" explicitly
   * — absent or "mid" ⇒ NOT terminal. New posts SHOULD set it.
   * See FIRE_PHASES.
   */
  fire_phase?: FirePhase;
};

/**
 * Parse a `wind-down-checkin` message body into a typed
 * `WindDownCheckinBody`. Returns `null` on any shape mismatch:
 *
 *   - Body is not valid JSON.
 *   - Body is not a non-null, non-array object.
 *   - `kind_version` is missing or not `1`.
 *   - `next_steps` is missing, not an array, has 0 entries, or any entry
 *     is non-string / empty / whitespace-only post-trim.
 *   - `decisions_logged` — same rules as `next_steps` (min 1 + trim).
 *   - `failed_approaches` — required array (CAN be empty); each entry
 *     when present must be non-empty post-trim string.
 *   - `memory_candidates` — same rules as `failed_approaches` (CAN be
 *     empty; each entry non-empty post-trim).
 *   - `cycle_character` is missing or not a valid `CycleCharacter` literal.
 *   - `fire_phase` present but not a valid `FirePhase` literal → null;
 *     absent → omitted, body valid.
 *
 * **F1 symmetric trim discipline:** every string-array element rejects
 * whitespace-only values (parse-time null) AND normalizes leading/trailing
 * whitespace on output. Mirrors Slice 1 A1 + Slice 2 B1 + V2 F1 carry-over.
 * Internal whitespace (incl. markdown formatting in multi-line entries)
 * is preserved verbatim.
 *
 * Caller-side error policy: `null` is intentional — callers MUST choose
 * between log-and-skip OR adding a NEW shared parser variant
 * (e.g., `parseWindDownCheckinBodyBestEffort`) co-located in this module.
 * Ad-hoc re-implementation per call site is the known anti-pattern the
 * SSOT-at-the-convention-layer discipline eliminates (sibling to
 * `parseDigestBody` + `parseLiveUpdateBody` + `parseAuditAskBody` +
 * `parseAuditVerdictBody` + `parseMemoryProposalBody`).
 *
 * The parser is intentionally permissive on EXTRA fields (forward-
 * compatible). Author may include additional fields (e.g., `cycle_id`
 * for handoff-naming-convention links — Q4 deferred from v0.1; or
 * `nick_intervention_count` for cycle-coordination-quality metrics)
 * without breaking forward parse.
 */
export function parseWindDownCheckinBody(
  body: string,
): WindDownCheckinBody | null {
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

  const nextSteps = parseRequiredStringArray(obj["next_steps"], {
    minLength: 1,
  });
  if (nextSteps === null) return null;

  const decisionsLogged = parseRequiredStringArray(obj["decisions_logged"], {
    minLength: 1,
  });
  if (decisionsLogged === null) return null;

  const failedApproaches = parseRequiredStringArray(obj["failed_approaches"], {
    minLength: 0,
  });
  if (failedApproaches === null) return null;

  const memoryCandidates = parseRequiredStringArray(obj["memory_candidates"], {
    minLength: 0,
  });
  if (memoryCandidates === null) return null;

  const cycleCharacter = obj["cycle_character"];
  if (!isCycleCharacter(cycleCharacter)) return null;

  const firePhaseRaw = obj["fire_phase"];
  let firePhase: FirePhase | undefined;
  if (firePhaseRaw !== undefined) {
    if (!isFirePhase(firePhaseRaw)) return null; // present-invalid ⇒ reject whole body (1c)
    firePhase = firePhaseRaw;
  }

  return {
    kind_version: 1,
    next_steps: nextSteps,
    decisions_logged: decisionsLogged,
    failed_approaches: failedApproaches,
    memory_candidates: memoryCandidates,
    cycle_character: cycleCharacter,
    ...(firePhase !== undefined ? { fire_phase: firePhase } : {}),
  };
}

/**
 * Internal helper: validate `raw` is an array of non-empty post-trim
 * strings (each whitespace-normalized on output). Returns null on any
 * shape mismatch. `minLength` enforces required cardinality (0 for
 * empty-allowed; 1 for required-min-one per Q3).
 */
function parseRequiredStringArray(
  raw: unknown,
  opts: { minLength: number },
): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < opts.minLength) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    if (entry.trim().length === 0) return null;
    out.push(entry.trim());
  }
  return out;
}
