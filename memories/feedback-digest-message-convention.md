---
name: `digest` message kind — schema rationale + sole-shared-parser discipline
description: Phase 4 Step A Layer 4 introduced `digest` as the mental-model-sync kind with a typed body (`DigestBody`) parsed by a single shared `parseDigestBody`; the schema captures shipped/verified/audit-class-paid/next-pickable/blockers/budget-ms; every reader uses the shared parser rather than re-implementing JSON-parse to prevent the same drift the SSOT pattern eliminates at the kind-set layer
type: feedback
cadence: stable
scope: global
updated: 2026-05-13
origin: native
---

Phase 4 Step A Layer 4 (PR #B2, plan `eventual-marinating-wall.md` v5 §Phase 3) introduced `digest` as the 10th channel message kind — the "mental-model-sync" primitive. Where the four Phase 1 kinds carry free-form prose and the five Layer 3 walkie-talkie kinds carry low-bandwidth protocol signals, `digest` carries **structured arc-summary state** suitable for a session to emit to peers or to its future self as a handoff anchor.

## Schema (`DigestBody`)

Defined in `src/channels/digest.ts`. Six required fields:

- `kind_version: 1` — schema version tag. Future revisions bump this and parsers branch on the version. Today's `parseDigestBody` accepts only version `1`; mis-versioned bodies return `null`.
- `what_shipped: readonly string[]` — what landed in the prior work increment. Free-form convention `"PR #N at <SHA>"` or `"Commit <SHA> on <branch>"`.
- `what_verified: readonly string[]` — which gates ran clean. Free-form convention `"typecheck"`, `"test"`, `"lint"`, `"audit:CLI-DX"`, `"smoke:phase-2"`, etc.
- `audit_class_paid: readonly string[]` — audit-class "rent payments" this work paid down (`"sibling-shape-miss"`, `"prompt-injection-surface"`, etc.).
- `next_pickable: string` — what the next session / sibling picks up first; names a backlog entry, plan step, or deferred follow-up.
- `blockers: readonly string[]` — what blocks the work (empty array when nothing).
- `verification_budget_consumed_ms: number` — wall-clock verification cost (finite non-negative).

## Sole-shared-parser discipline

Every reader consuming `digest` messages MUST use `parseDigestBody` from `src/channels/digest.ts` (re-exported via `claude-conductor/channels/api` for cross-edge callers) rather than re-implementing JSON-parse + shape-check.

**Why:** the SSOT pattern at the kind-set layer (`CHANNEL_KINDS` tuple at `src/channels/index.ts`) eliminated 3 sync points (type / validator / CLI VALID_KINDS) that would otherwise drift. The shared parser extends the same discipline to the convention layer: in-tree readers (operator tools, future Phase 4 Step B reaper, dotfiles cross-edge consumers, future analysis tooling) all go through one validator. A future schema change ships in one place; all callers pick it up via type-flow.

**Validator policy:** the parser is permissive on EXTRA fields (forward-compatible — a future v2 schema with additional fields can layer cleanly) but strict on REQUIRED fields. Missing-field / non-string-array / non-numeric-budget / NaN / negative / infinite all return `null`. Callers MUST choose between log-and-skip OR adding a NEW shared parser variant (e.g., `parseDigestBodyBestEffort`) co-located in `src/channels/digest.ts` — ad-hoc re-implementation per call site is a known anti-pattern that re-creates the drift the SSOT-at-the-convention-layer discipline eliminates (once one ad-hoc fallback ships, the next caller copies it and the shared-parser invariant erodes).

## Verification posture (paired with `feedback-verification-budget-by-kind.md`)

For `digest`: trust the SHAPE returned by `parseDigestBody` (validator-enforced); primary-source-verify any specific audit-class string, SHA, PR number, or backlog-item ID cited in the fields. A `digest` body's `audit_class_paid: ["sibling-shape-miss"]` tells you what catch-shape was claimed — verify against the actual audit-line that surfaced it before crediting the rent payment in cross-arc memory work. A `what_shipped: ["PR #N at <SHA>"]` cite is verifiable via `git log` / `gh pr view`; don't cascade-reason on it without that lookup.

## Why structured-summary-as-message-kind

The alternative shape — operators / scripts parsing a free-form `status` or `handoff` body for arc-summary state — is the drift-bait shape we're already avoiding at the kind-set layer. A typed schema + shared parser:

1. **Operator tooling can build on it.** A future `channels digest-summary <channel-id>` verb that aggregates `digest` messages into a cross-session timeline is a small script over typed objects, not a regex over prose.
2. **Memory annotation work has anchor.** When mining channel history for recurrence patterns, `audit_class_paid` arrays across digests are a structured signal; prose-mining is fuzzy.
3. **Sibling-coordination cost drops.** A digest is the shape we'd write in prose anyway; encoding the structure means the receiving session doesn't re-parse it heuristically.

## Cross-references

- `feedback-verification-budget-by-kind.md` — the verification-posture convention per kind, including the `digest`-specific shape-vs-citation contract.
- `feedback-walkie-talkie-out-semantics.md` — sibling Layer 3 convention; `out`'s terminal-until-takeover is the structural-state analog of `digest`'s shape-trust.
- `docs/conventions/message-kinds-and-verification.md` — operator-facing reference for all 10 kinds + the verification table.
- `decisions/phase-4.md` Decision J §Layer 4 — the design rationale for choosing typed-shared-parser over ad-hoc-prose for the mental-model-sync surface.
