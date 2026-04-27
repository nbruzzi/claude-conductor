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

18 cross-session feedback memories bundled in batch 7a per `memories-to-bundle.md` (V2 schema: `cadence`, `scope`, `updated`, `origin: extracted`). Cross-reference graph: clean. CI substrate-leak grep: passes (with documented allowed-in-frontmatter false positives).

- `feedback-confidence-as-verification-output.md` — verification loop produces confidence; no separate "confident-sounding output" pattern.
- `feedback-encode-while-context-fresh.md` — receipt-in-hand framing; encode lessons in the same session that produced them.
- `feedback-plan-mode-for-structural-changes.md` — plan-mode + branching trigger thresholds are intentionally low.
- `feedback-self-apply-ceiling-discipline.md` — autonomous ceiling, not assisted ceiling.
- `feedback-sibling-parity-at-merge-time.md` — diff-vs-base lens misses sibling drift.
- `feedback-design-vs-autonomous-runtime.md` — distinguish artifact creation from autonomous runtime function.
- `feedback-think-holistically-not-reactively.md` — full-architecture mapping upfront for end-to-end systems.
- `feedback-no-known-gaps.md` — never ship code with known limitations and move on.
- `feedback-phased-audit-remediation-arc.md` — terminal full-diff audit catches accumulation hazards per-phase audits miss.
- `feedback-partial-v2-anticipation-primitives.md` — primitives yes, structure no — partial V2 anticipation when a second caller appears.
- `multi-persona-audit-pattern.md` — umbrella; 3-persona adversarial audit + 1–3 round verification + Step 1.5 sibling-symmetry pre-flight.
- `feedback-prefer-single-bash-over-compound.md` — operational workaround for permission-prompt friction on backslash-escaped paths.
- `feedback-memorialize-then-violate-anti-pattern.md` — last-memory-vs-next-action self-check; writing memory ≠ internalizing discipline.
- `feedback-merge-commit-across-instances.md` — prefer merge over rebase when SHAs may be referenced by other instances.
- `feedback-validate-detector-before-behavior.md` — sample raw matches before changing behavior; suspect the detector first.
- `feedback-self-monitoring-is-architectural.md` — self-status disagreement with ground truth is architectural, not housekeeping.
- `feedback-surface-merge-decisions.md` — strategy-level merges to main need a one-sentence check-in first.
- `feedback-convergent-instances.md` — convergent agents replicate principle, not artifacts; counter-case on shared faulty priors.

## Bundled agents (`agents/`)

21 agents bundled in batch 7b per `agents-to-bundle.md`. Auditor registry at `agents/audit/registry.md` (16 expert auditors: 13 cold + 4 familiar + 1 unregistered template).

- `agents/code-simplifier.md` — generic post-implementation cleanup agent.
- `agents/verify-app.md` — generic end-to-end verification agent.
- `agents/audit/registry.md` — auditor registry with selection heuristics + machine-readable TSV index + known-tension pairs.
- `agents/audit/cold/` — 13 domain-pure auditors (accessibility, api, cli-dx, db, marketplace, nextjs, performance, reliability, security, seo-geo, test-architect, typescript, ux).
- `agents/audit/familiar/architecture-integration.md` — plugin integration drift catcher (HEAVY rewrite from upstream).
- `agents/audit/familiar/code-standards.md` — TypeScript convention drift catcher.
- `agents/audit/familiar/knowledge-system.md` — memory + decisions-log convention drift catcher (HEAVY rewrite).
- `agents/audit/familiar/workflow-process.md` — pipeline + branching + commit-gate discipline catcher.
- `agents/audit/familiar/_template.md` — structural template for project-specific familiar auditors (UNREGISTERED).

## Source code (`src/`)

- [src/index.ts](src/index.ts) — public API surface placeholder (populated as extraction progresses).
- [src/shared/paths.ts](src/shared/paths.ts) — per-component path resolvers with 3-layer env precedence (sub-step 0.5).
- [src/memory-loader/index.ts](src/memory-loader/index.ts) — V2-schema memory loader + INDEX.md formatter (sub-step 0.4).
- [src/hooks/bundled-check-names.ts](src/hooks/bundled-check-names.ts) — `BUNDLED_CHECKS_BY_EVENT` source-of-truth + derived `BundledCheckName` literal union + `BUNDLED_CHECK_NAMES` flat array (sub-step 0.7 #10; exported via `./hooks/bundled-check-names`).

## Tests (`test/`)

- [test/smoke.test.ts](test/smoke.test.ts) — initial bun-test scaffolding placeholder.
- [test/shared/paths.test.ts](test/shared/paths.test.ts) — 17 tests covering RE-8 precedence cases + smoke tests.
- [test/memory-loader/index.test.ts](test/memory-loader/index.test.ts) — 14 tests covering parsing, validation, filtering, formatting.
- [test/memory-loader/fixtures/](test/memory-loader/fixtures/) — 7 fixtures (valid + invalid + filtered shapes).
- [test/hooks/bundled-registrations.test.ts](test/hooks/bundled-registrations.test.ts) — meta-test for the 18 bundled discipline checks: build registry, seal, assert (event, name) tuples + count + duplicates + bidirectional set-equality + compile-time narrowing via `@ts-expect-error`. Replaces per-component-stub approach (sub-step 0.7 Decision C).

## CI / GitHub Actions (`.github/workflows/`)

- [.github/workflows/test.yml](.github/workflows/test.yml) — CI workflow cloning `~/.claude-dotfiles/templates/github-ci.yml` shape per sub-step 0.7 Decision D. SHA-pinned actions, `bun install --frozen-lockfile`, `permissions: contents: read`, `timeout-minutes: 10`. Sequential typecheck/format:check/lint/test. `check-generic-paths` deferred to sub-step 0.8 (script doesn't exist yet); actionlint integration deferred per plan-v2.1 fallback (see workflow comment).

## Test infrastructure (`test-utils/`)

Cross-test helpers promoted from `test/helpers/` per sub-step 0.7 Decision A. Top-level home signals first-class plugin component; `package.json` exports map intentionally excludes `./test-utils` (Decision G — internal-to-plugin via relative imports only). No `*.test.ts` files inside `test-utils/`; helper-tests (if needed in future) live in `test/test-utils/<helper>.test.ts`.

- [test-utils/index.ts](test-utils/index.ts) — re-export entry point.
- [test-utils/tmp-repo.ts](test-utils/tmp-repo.ts) — `makeTmpHome` / `makeTmpRepo` / `runDispatcher` helpers for throwaway-repo + dispatcher-subprocess test patterns.
