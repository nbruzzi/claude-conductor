<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Operations runbooks

Operator-facing recovery + observability runbooks. Tier scope is operator-facing — commands to run, errors to triage, breadcrumbs to inspect — distinct from `docs/architecture/` (component contracts, edges, design rationale).

Each runbook is keyed to a phase or feature surface; cross-link from `docs/architecture/` when an architecture decision has an operator consequence.

## Catalog

- [phase-2-hooks.md](phase-2-hooks.md) — Phase 2 hooks operator runbook (4 hooks + 2 CLI verbs + 2 flags + breadcrumb taxonomy + per-hook recovery).
