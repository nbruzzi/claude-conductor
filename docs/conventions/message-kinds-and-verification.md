<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Channel message kinds + verification-budget convention

**Scope:** operator + developer reference for the 12 message kinds the
`claude-conductor channels send` verb accepts, with the verification
posture readers should apply per kind. First inhabitant of
`docs/conventions/`.

Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 (Phase 4 Step A
Layer 3 + Layer 4).

## Kinds by phase

Kinds are stored as a single tuple in `src/channels/index.ts`
(`CHANNEL_KINDS`), with the type-level union `ChannelKind` derived from
it. Validator (`isChannelMessage`) and CLI acceptance (`VALID_KINDS`)
both read from the same tuple — single edit point, no drift.

### Phase 1 — informational + protocol carriers (4 kinds)

| Kind       | Semantic                                             | Recommended body                                                                   |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `note`     | Informational; no reply expected.                    | Free-form prose.                                                                   |
| `question` | Expects a reply; sender awaits.                      | The question + any context the reader needs.                                       |
| `handoff`  | Full state transfer between sessions.                | Structured handoff (sections like "What shipped", "Next steps", "Open questions"). |
| `status`   | State-change announcement (posture / phase / ready). | One-line current state + any relevant SHA / run-id.                                |

### Phase 4 Step A Layer 3 — walkie-talkie protocol primitives (5 kinds)

These are low-bandwidth turn-taking signals between sibling sessions
coordinating via a channel. Each is intentionally short.

| Kind      | Semantic                                              | Recommended body                                                                |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ack`     | Receipt only — "I see your message"; no commitment.   | `received` or `ack` (1–10 chars).                                               |
| `roger`   | Receipt + commitment — "understood, will act."        | 1-line commitment (e.g. `will fold MAJOR-1 by next prompt`).                    |
| `over`    | Sender hint — "I posted, expecting reply."            | 1-line hint of expected reply (e.g. `your turn on L3`).                         |
| `standby` | Sender hint — "heard you, working, hold the channel." | 1-line reason (e.g. `running tests; ~5 min`).                                   |
| `out`     | Peer terminates this channel (additive).              | Reason for departure (e.g. `session ended` or `role transitioned to observer`). |

**Send-role-gate carve-out:** when a session's claimed `role === "out"`,
the CLI blocks every kind EXCEPT `kind=out`. The `out` kind is the one
allowed departure announcement from an already-departed peer.

**Terminal-until-takeover (RE-7):** once `metadata.identities[<L>].out_posted_at`
is set for an identity letter, the predicate `explicitlyOutPeers` continues
returning that letter on every read until a `claim --force` takeover replaces
the entire claim record. A departed peer does not auto-resurrect when its
session comes back; the next session (or an operator) must explicitly displace
the stale claim.

### Phase 4 Step A Layer 4 — mental-model-sync (1 kind)

| Kind     | Semantic                                                             | Recommended body                                                |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `digest` | Structured summary one session emits to peers or to its future self. | JSON conforming to `DigestBody` (see `src/channels/digest.ts`). |

The `digest` schema captures **what shipped + what was verified + what
audit-classes were paid + what's pickable next + what's blocking +
verification budget consumed**. The shared parser is `parseDigestBody`
(`src/channels/digest.ts`); any consumer reading `digest` messages
should use the shared parser rather than re-implementing JSON-parse +
shape-check.

### Tier 1 Slice 1 cycle 2026-05-19 — audit-discipline (1 kind)

| Kind        | Semantic                                                                                                | Recommended body                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audit-ask` | Author requests an audit on their PR or plan from a target peer; carries tier + lens-set + audit-class. | JSON conforming to `AuditAskBody` (see `src/channels/audit-ask.ts`). Required fields: `target_pr` (`{repo, number}`), `target_peer`, `tier` (light-touch / 1-lens-substantive / 3-lens-convergence), `lens_set_requested` (non-empty array of RE / Architecture / TA / Security / Contract), `audit_class` (inside-pair / outside-pair / cross-pair-shadow). |

The `audit-ask` schema unblocks the audit-discipline kind cohort
ratified in the 2026-05-19 brainstorm. Tier defaults are inferred from
PR LOC + invariant-rich flag at send-time via `inferAuditAskTier(loc,
invariantRich)`; the body carries the FINAL tier (default OR override).
`audit-verdict` (Slice 2) consumes this shape to close the audit-loop.
The shared parser is `parseAuditAskBody` (`src/channels/audit-ask.ts`);
shared types + as-const tuples + type-guards live in
`src/channels/audit-types.ts` (Slice 2 also consumes them).

### Tier 2 Verb 2 cycle 2026-05-20 — memory-proposal surface (1 kind)

| Kind              | Semantic                                                                                                                          | Recommended body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-proposal` | Peer surfaces a memorialization candidate to the channel; carries proposed memory content for Nick's batch yes/no decision queue. | JSON conforming to `MemoryProposalBody` (see `src/channels/memory-proposal.ts`). Required fields: `kind_version=1`, `candidate_name` (non-empty post-trim string; slug-form preferred), `memory_type` (`user` / `feedback` / `project` / `reference`), `description` (non-empty post-trim string; one-line summary used for memory frontmatter + `MEMORY.md` TOC line), `reason` (non-empty post-trim string; why this memorialization), `proposed_body` (non-empty post-trim string; the memory body content WITHOUT frontmatter). Optional: `amends_existing` (null OR non-empty post-trim string; pointer to existing memory's `name` slug for amendments). |

The `memory-proposal` schema structures the surface for Nick's batch
yes/no memorialization decision per
`feedback-memory-authoring-surface-dont-auto-file`. Substrate does NOT
auto-file memories — a deferred Tier-2 ratification verb consumes
ratified proposals and writes the file (substrate computes frontmatter
from `candidate_name` + `memory_type` + `description`; body is the
proposed_body verbatim). When `amends_existing` is non-null the
ratify-verb merges into the existing memory file (merge-strategy is
ratify-verb scope; the proposal carries only the pointer). The shared
parser is `parseMemoryProposalBody` (`src/channels/memory-proposal.ts`);
inline `MEMORY_TYPES` + `MemoryType` + `isMemoryType` live in the same
module (D2 (a) of plan v0.2 — extract to shared module when 2nd
consumer surfaces; T3-E memory-attention-scoring is the candidate).

### Tier 2 Verb 1 cycle 2026-05-20 — wind-down-checkin (1 kind)

| Kind                | Semantic                                                                                                                                                  | Recommended body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wind-down-checkin` | Peer broadcasts structured cycle-close state at wind-down time; carries next-steps + decisions + failed-approaches + memory-candidates + cycle-character. | JSON conforming to `WindDownCheckinBody` (see `src/channels/wind-down-checkin.ts`). Required fields: `kind_version=1`, `next_steps` (non-empty array of non-empty post-trim strings; min 1 entry per Q3), `decisions_logged` (same shape; min 1 entry), `failed_approaches` (array; CAN be empty; each entry non-empty post-trim per F1 symmetric trim), `memory_candidates` (array; CAN be empty; same per-entry shape), `cycle_character` (one of `PRISTINE` / `RECOVERED` / `INCIDENT-DRIVEN` / `COHORT-PASS` / `STALLED` per the T3-F rubric). |

The `wind-down-checkin` schema substrate-mediates the wind-down summary
per [[feedback-wind-down-ordering]] + CLAUDE.md §Wind-down sequencing.
Today's channel-prose `kind=status` checkin becomes a typed body
downstream Tier-3 consumers (T3-F cycle-character classifier; T3-G
reciprocation ledger) can parse without regex-scraping handoff prose.
The shared parser is `parseWindDownCheckinBody`
(`src/channels/wind-down-checkin.ts`); inline `CYCLE_CHARACTERS` +
`CycleCharacter` + `isCycleCharacter` live in the same module (D2 (a)
of plan v0.1 — extract to shared module when 2nd consumer surfaces;
T3-F classifier or T3-G ledger are the candidates).

## Verification-budget convention per kind

The verification a reader should apply varies by kind. The contract:

| Kind                                         | Reader's verification budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `note` / `status`                            | Trust verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ack` / `roger` / `over` / `standby` / `out` | Trust verbatim. Protocol state, not assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `question`                                   | Verify any factual claims the question relies on before answering.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `handoff`                                    | Trust + verify against named SHAs / paths / run-ids before acting on the transfer.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `live-update`                                | Trust the SHAPE (validator-enforced); primary-source-verify any SHA / PR / backlog-item citation. The scope assignment (`your_scope` / `hands_off`) is the load-bearing contract; treat as authoritative from the active peer.                                                                                                                                                                                                                                                                     |
| `digest`                                     | Trust the SHAPE (validator-enforced); primary-source-verify any audit-class string, SHA, PR number, or backlog-item ID cited in the fields before reasoning forward.                                                                                                                                                                                                                                                                                                                               |
| `audit-ask`                                  | Trust the SHAPE (validator-enforced); primary-source-verify the `target_pr` exists + `target_peer` is a live NATO identity on the channel before acting on the ask. `tier` + `lens_set_requested` + `audit_class` are author-claims; `audit-verdict` (Slice 2) is the actual coverage answer.                                                                                                                                                                                                      |
| `audit-verdict`                              | Trust the SHAPE (validator-enforced including counts-coherence cross-field); primary-source-verify the verdict's `lens_set_applied` + `findings` + `audit_axes` claims against the actual diff. The auditor's claim is authoritative for the close-shape; the reader verifies the substance.                                                                                                                                                                                                       |
| `memory-proposal`                            | Trust the SHAPE (validator-enforced; F1 symmetric trim discipline across all 5 string fields). Primary-source-verify (a) slug uniqueness vs existing memories in `~/.claude/projects/-Users-nbruzzi/memory/` when `amends_existing` is null, and (b) the `amends_existing` slug exists on disk when non-null. The proposer's claim is authoritative for the proposal's CONTENT; ratification-side verifies on-disk substance.                                                                      |
| `wind-down-checkin`                          | Trust the SHAPE (validator-enforced; F1 symmetric trim across 4 string-array fields; min-1 invariants on `next_steps` + `decisions_logged`). Primary-source-verify (a) `cycle_character` claim against actual cycle artifacts (PR squashes / CI conclusions / failed-approach captures), and (b) `memory_candidates` slug names against the memory directory before acting on the queue. The poster's CLAIM is authoritative for the cycle-close shape; downstream consumers verify the substance. |

**Display-time sanitization hazard for `digest` field contents.** `parseDigestBody` enforces the SHAPE (six required fields, correct types, finite non-negative budget), but the parser is content-blind: `what_shipped[i]`, `audit_class_paid[i]`, `next_pickable`, and other string fields pass through unmodified. Any reader that renders `digest` field contents directly into an LLM system-reminder surface (cross-edge dotfiles consumers, future Phase 4 Step B reaper, analysis tooling) MUST sanitize at display time using the same defense Layer 1 `peer-message-deliverer` applies to peer-body content (UUID-nonce fence + platform-control-marker strip + bare-`<` escape — see `src/hooks/checks/peer-message-deliverer.ts` once Alpha lands A1). The shape-validation gate does NOT replace the display-time sanitization gate; readers writing digest field contents into LLM context surfaces are responsible for the second gate. Alpha sibling cross-audit MINOR-1 fold on the B2 staged diff.

**Why kind-specific verification:** the cost of misplaced trust scales
with the consequence. A `roger`'s commitment is checked when the
commitment lands (the reader sees the action, not the promise). A
`handoff`'s SHA citation drives cascade reasoning across files — wrong
SHA, wrong cascade. A `digest`'s `audit_class_paid` array tells the
reader what catch-shape was surfaced — wrong claim, wrong rent
accounting.

The convention applies to **automated readers** (cross-edge dotfiles
consumers, future Phase 4 Step B reaper, analysis tooling) as much as
to operators. Anywhere in the codebase that pattern-matches on a `digest`
body, `parseDigestBody` is the gate that enforces the shape; the
audit-class-string / SHA verification is the reader's responsibility per
this convention.

## Cross-references

- `src/channels/index.ts` — `CHANNEL_KINDS` SSOT tuple + `ChannelKind`
  type + validator.
- `src/channels/digest.ts` — `parseDigestBody` shared parser +
  `DigestBody` schema type.
- `src/channels/audit-ask.ts` — `parseAuditAskBody` shared parser +
  `AuditAskBody` schema type + `inferAuditAskTier` LOC-based tier
  default helper.
- `src/channels/audit-verdict.ts` — `parseAuditVerdictBody` shared
  parser + `AuditVerdictBody` schema type + nested `AuditFinding` +
  `ThreeOptionAsk` types. Counts-coherence cross-field validation
  enforced at parse time.
- `src/channels/audit-types.ts` — shared audit-discipline types
  (`AuditAskTier`, `AuditClass`, `LensClass`, `AuditAxis`,
  `AuditVerdict`, `FindingSeverity`) + as-const tuples + type-guards
  (consumed by Slice 1 audit-ask + Slice 2 audit-verdict + Slice 3
  audit-queue when shipped).
- `src/channels/memory-proposal.ts` — `parseMemoryProposalBody` shared
  parser + `MemoryProposalBody` schema type + inline `MemoryType`
  as-const tuple + `isMemoryType` type-guard. Surfaces memorialization
  candidates for Nick's batch yes/no decision queue per
  `feedback-memory-authoring-surface-dont-auto-file`. Substrate does
  NOT auto-file; deferred Tier-2 ratification verb consumes ratified
  proposals and writes the file.
- `src/channels/wind-down-checkin.ts` — `parseWindDownCheckinBody`
  shared parser + `WindDownCheckinBody` schema type + inline
  `CycleCharacter` as-const tuple + `isCycleCharacter` type-guard.
  Substrate-mediates the cycle-close wind-down summary per
  `feedback-wind-down-ordering` + CLAUDE.md §Wind-down sequencing.
  Future Tier-3 consumers (T3-F cycle-character classifier; T3-G
  reciprocation ledger) parse the typed body without regex-scraping
  handoff prose.
- `src/reciprocation/cli.ts` + `src/reciprocation/graph.ts` — Tier 2
  Verb 3 first-class substrate CONSUMER of `audit-verdict` bodies.
  Queries channel for verdicts in window; emits directional graph
  (auditor → target) + per-peer audit-debt + canonical pairwise
  reciprocation balance. Replaces the hand-tallied cycle-end ledger
  surfaced in handoff bodies. Auditor identity resolution is
  message-time-stamped (uses `ChannelMessage.identity`); fallback to
  current `metadata.identities` lookup for legacy messages without
  the structured field.
- `src/channels/cli.ts` — `channels kinds` verb prints the per-kind
  help; `channels send` role-gate carve-out for `kind=out`.
- `memories/feedback-walkie-talkie-out-semantics.md` — `out` kind's
  terminal-until-takeover semantics + sole-writer rationale.
- `memories/feedback-digest-message-convention.md` — `digest` kind's
  schema rationale + sole-shared-parser discipline.
- `memories/feedback-verification-budget-by-kind.md` — this convention
  expressed as a stable cross-arc reference.
- `decisions/phase-4.md` Decision I §Layer 3 + Decision J §Layer 4 —
  design rationale for both layers' substrate.
