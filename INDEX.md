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

## Phase 0 in-progress audit deliverables

- [extraction-manifest.md](extraction-manifest.md) — per-file decisions for extraction (sub-step 0.2; AUDITED 9.0/10).
- [memories-to-bundle.md](memories-to-bundle.md) — anonymization rewrite plan for bundled memories (sub-step 0.3; AUDITED GREEN).
- [agents-to-bundle.md](agents-to-bundle.md) — anonymization rewrite plan for bundled agents (sub-step 0.3b; AUDITED GREEN).

## Architecture Decision Records (`docs/architecture/`)

- [ADR-001 — Extraction strategy](docs/architecture/ADR-001-extraction-strategy.md) — coordinated branches, dotfiles-side vendoring, atomic flip on Phase 5 pass.

## Conventions (`docs/conventions/`)

- _(none yet — convention page extraction from vault is a Phase 0 deliverable; decision-log schema documentation is a Phase 0 deliverable)_

## Operations runbooks (`docs/operations/`)

- _(none yet — Anthropic-overlap-response runbook is a Phase 2 deliverable; phase-rollback-procedure is a Phase 5 deliverable; incident-response is a Phase 4+ deliverable)_

## API reference (`docs/api/`)

- _(none yet — auto-generated from TypeDoc; cli-contracts.md and error-codes.md ship in Phase 1)_

## Decision logs (`decisions/`)

- [phase-0.md](decisions/phase-0.md) — Phase 0 sequencing + design decisions (in progress; 11 entries).

## Audit transcripts (`audits/phase-0/`)

- [knowledge-system-1.md](audits/phase-0/knowledge-system-1.md) — Round 1 KS audit on `memories-to-bundle.md` (6.5/10, 7 findings).
- [knowledge-system-2.md](audits/phase-0/knowledge-system-2.md) — Round 2 verification (GREEN, all 7 ADDRESSED).
- [architecture-1.md](audits/phase-0/architecture-1.md) — Round 1 ARCH audit on `agents-to-bundle.md` (7.5/10, 7 findings).
- [architecture-2.md](audits/phase-0/architecture-2.md) — Round 2 verification (GREEN, all 7 ADDRESSED).
- [typescript-expert-1.md](audits/phase-0/typescript-expert-1.md) — Sub-step 0.4 inline TS Expert review (8.5/10, 7 findings; 5 integrated).

## Bundled memories (`memories/`)

- _(none yet — sub-step 0.6 file extraction populates the directory using `memories-to-bundle.md` as the rewrite spec)_

## Source code (`src/`)

- [src/index.ts](src/index.ts) — public API surface placeholder (populated as extraction progresses).
- [src/shared/paths.ts](src/shared/paths.ts) — per-component path resolvers with 3-layer env precedence (sub-step 0.5).
- [src/memory-loader/index.ts](src/memory-loader/index.ts) — V2-schema memory loader + INDEX.md formatter (sub-step 0.4).

## Tests (`test/`)

- [test/smoke.test.ts](test/smoke.test.ts) — initial bun-test scaffolding placeholder.
- [test/shared/paths.test.ts](test/shared/paths.test.ts) — 17 tests covering RE-8 precedence cases + smoke tests.
- [test/memory-loader/index.test.ts](test/memory-loader/index.test.ts) — 14 tests covering parsing, validation, filtering, formatting.
- [test/memory-loader/fixtures/](test/memory-loader/fixtures/) — 7 fixtures (valid + invalid + filtered shapes).
