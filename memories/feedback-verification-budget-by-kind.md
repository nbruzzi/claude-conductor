---
name: Verification-budget convention per channel kind
description: Different message kinds warrant different verification budgets — protocol primitives (ack/roger/over/standby/out) trust verbatim, informational kinds (note/status) trust verbatim, question verifies cited claims, handoff verifies SHAs/paths, digest trusts SHAPE but primary-source-verifies any audit-class/SHA citation; misplaced trust scales with consequence so the convention names the right posture per kind to keep readers honest
type: feedback
cadence: stable
scope: global
updated: 2026-05-13
origin: native
---

Phase 4 Step A Layer 4 (PR #B2, plan `eventual-marinating-wall.md` v5 §Phase 3) formalized the verification-budget convention as a stable cross-arc reference. The shape: every message kind in `CHANNEL_KINDS` carries a different expected reader-side verification posture, and the convention names it so readers don't default to one posture across the board.

## The table

| Kind                                         | Reader's verification budget                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `note` / `status`                            | Trust verbatim.                                                                                                                             |
| `ack` / `roger` / `over` / `standby` / `out` | Trust verbatim. Protocol state, not assertions.                                                                                             |
| `question`                                   | Verify any factual claims the question relies on before answering.                                                                          |
| `handoff`                                    | Trust + verify against named SHAs / paths / run-ids before acting on the transfer.                                                          |
| `digest`                                     | Trust the SHAPE (validator-enforced); primary-source-verify any audit-class string, SHA, PR number, or backlog-item ID cited in the fields. |

## Why budgets vary

The cost of misplaced trust scales with the consequence of the kind:

- A `roger`'s commitment is **checked when the commitment lands**. The reader sees the action, not the promise; verifying the `roger` itself adds no signal. Same for `ack` (presence is the assertion) and `out` (the next read of `metadata.identities[<L>].out_posted_at` confirms or refutes; no need to verify the line itself).
- A `note` / `status` is **prose**. Verifying prose against a primary source is a category error; the kind is informational by design.
- A `question` carries **implicit factual claims** the answer must respect. Verifying those claims before answering is what keeps the response from extending the questioner's wrong premise.
- A `handoff` carries **SHA / path / run-id citations** that drive cascade reasoning across files. Wrong SHA → wrong cascade. Verify before acting.
- A `digest` carries **typed structured arc-summary state**. The SHAPE is enforced by `parseDigestBody` (validator-enforced; no shape drift). But the FIELD CONTENTS are convention — `audit_class_paid: ["sibling-shape-miss"]` is the assertion that a specific catch-shape was surfaced; without primary-source verification, downstream memory annotation work cascades on unverified rent.

## How this generalizes

The convention extends the **distinct-lenses-over-repeat-verifications** discipline (see `feedback-distinct-lenses-over-repeat-verifications.md`) to per-kind reading posture:

- **Same-shape verification across all kinds** = uniform low-resolution trust. Either you over-trust (missing the citation-class drift) or over-verify (paying cost for protocol-state primitives that don't carry assertions).
- **Distinct-shape verification per kind** = each kind's actual content shape gets the right matching budget. Citation-bearing kinds get citation-verification; protocol-state kinds get verbatim-trust; structured-data kinds get shape-trust + content-verification.

## Operationalized in

- `docs/conventions/message-kinds-and-verification.md` — operator + developer reference.
- `src/channels/cli.ts` KINDS_HELP — `channels kinds` verb prints the convention inline.
- `src/channels/digest.ts` `parseDigestBody` — enforces the SHAPE half of the contract for `digest`; the CONTENT-verification half is convention.
- `feedback-digest-message-convention.md` — the digest-specific shape-vs-citation contract.

## When to revisit

The convention is stable for the kinds in `CHANNEL_KINDS` today. Future kinds (Phase 4 Step B / Phase 5+) should land with their verification-budget row defined in the same table — the table is the single source of operator-facing verification posture, and an undefined posture for a new kind is a known gap per `feedback-no-known-gaps.md`.

## Cross-references

- `feedback-digest-message-convention.md` — `digest` kind's schema rationale + sole-shared-parser discipline.
- `feedback-walkie-talkie-out-semantics.md` — `out` kind's terminal-until-takeover (protocol-state, not assertion).
- `feedback-distinct-lenses-over-repeat-verifications.md` — the generalization at the audit layer.
- `feedback-audit-recommendations-primary-source-verified.md` — the cousin discipline at the audit-claim layer.
- `docs/conventions/message-kinds-and-verification.md` — operator reference.
- `decisions/phase-4.md` Decision J §Layer 4.
