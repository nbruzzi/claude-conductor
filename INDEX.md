<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Master Catalog

Mandatory updating-on-every-change discipline (mirroring the vault `wiki/index.md` pattern). Every shipped knowledge artifact (skill, hook, agent, memory, decision, audit transcript, ADR, runbook, convention page) MUST appear here with a one-line description. Audit gate verifies no shipped artifact is missing from this index.

## Top-level docs

- [README.md](README.md) — value prop, dev install, CLI verbs preview, status.
- [CHANGELOG.md](CHANGELOG.md) — Keep-a-Changelog format, semver from v0.0.0.
- [CONTRIBUTING.md](CONTRIBUTING.md) — phase discipline, decision-log schema, code style, testing rigor, dependency policy.
- [SECURITY.md](SECURITY.md) — threat model, vulnerability disclosure path.
- [LICENSE](LICENSE) — Apache-2.0 full text.
- [dependencies-rationale.md](dependencies-rationale.md) — runtime-dep allowlist with per-entry rationale.

## Architecture Decision Records (`docs/architecture/`)

- [ADR-001 — Extraction strategy](docs/architecture/ADR-001-extraction-strategy.md) — coordinated branches, dotfiles-side vendoring, atomic flip on Phase 5 pass.

## Conventions (`docs/conventions/`)

- _(none yet — convention page extraction from vault is a Phase 0 deliverable; decision-log schema documentation is a Phase 0 deliverable)_

## Operations runbooks (`docs/operations/`)

- _(none yet — Anthropic-overlap-response runbook is a Phase 2 deliverable; phase-rollback-procedure is a Phase 5 deliverable; incident-response is a Phase 4+ deliverable)_

## API reference (`docs/api/`)

- _(none yet — auto-generated from TypeDoc; cli-contracts.md and error-codes.md ship in Phase 1)_

## Decision logs (`decisions/`)

- [phase-0.md](decisions/phase-0.md) — Phase 0 sequencing decisions (in progress).

## Audit transcripts (`audits/`)

- _(none yet — first transcripts land at end of Phase 0 per the post-phase audit gate)_

## Bundled memories (`memories/`)

- _(none yet — memory anonymization rewrite is a Phase 0 deliverable; populated from `memories-to-bundle.md` audit deliverable)_

## Source code (`src/`)

- _(none yet — file extraction begins after `extraction-manifest.md` is approved by mini-Architecture audit per the Phase 0 sub-plan)_

## Tests (`test/` or `__tests__/`)

- _(none yet — test scaffolding pull is a Phase 0 deliverable)_
