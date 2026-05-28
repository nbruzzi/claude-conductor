<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision-log schema

Within-phase sequencing decisions that don't change architecture, user-facing API, or block subsequent phases are **logged, not surfaced** (per `CONTRIBUTING.md` "Decision-log discipline"). Each phase maintains a decision log at `decisions/phase-<N>.md`; cluster-scoped work uses `decisions/cluster-<N>.md`. Logs are surfaced at end-of-phase as part of the post-phase summary.

This document is the canonical schema referenced by `CONTRIBUTING.md`. Each `decisions/phase-<N>.md` file also restates the schema inline at its top for at-a-glance authoring.

## Per-entry frontmatter

Each decision entry opens with a fenced YAML block:

```yaml
---
ts: <ISO-8601> # when the decision was made
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: <N> # phase number this log belongs to
affects: [<component>, ...] # files / modules / components the decision touches
---
```

### Field semantics

- **`ts`** — ISO-8601 timestamp of when the decision was made.
- **`kind`** — one of:
  - `sequencing` — ordering of work within a phase.
  - `architectural` — structural or design decision.
  - `api-shape` — interface / contract shape.
  - `scope` — what is in or out of scope.
  - `tooling` — build / test / CI infrastructure.
- **`severity`** — `critical` | `major` | `minor`. `major`+ are summarized at end-of-phase; `minor` entries are logged for retrospective lookup only.
- **`phase`** — the phase number (matches the file name `phase-<N>.md`).
- **`affects`** — list of components (file paths, module names) the decision touches.

## Per-entry body

Following the frontmatter, each entry uses this structure:

- **Context:** what was being decided and why it came up.
- **Options considered:** an enumerated list, each with brief pros / cons; mark the chosen option.
- **Chosen:** the decision.
- **Reason:** why this option won over the alternatives.
- **Supersedes / superseded_by:** _(optional)_ cross-link to a related decision this replaces, or that later replaces it.

## Enforcement

PRs that modify substrate primitives are expected to add a corresponding decision-log entry — a **net-new** entry (an added `ts:` frontmatter line), not merely a touch of an existing entry. This is gate-checked at CI by `scripts/check-decision-log.sh` (which detects the added `ts:` field in the PR-scope diff) and prompted by the `## Decision log` section of the pull-request template. See `CONTRIBUTING.md` "INSTRUCTION-vs-ENFORCEMENT boundary (tech-debt ack)" for where this sits relative to other gate-driven vs convention-by-vigilance items.
