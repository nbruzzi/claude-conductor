<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Master Catalog

Mandatory updating-on-every-change discipline (mirroring the vault `wiki/index.md` pattern). Every shipped knowledge artifact (skill, hook, agent, memory, decision, audit transcript, ADR, runbook, convention page) MUST appear here with a one-line description. Audit gate verifies no shipped artifact is missing from this index.

> **v0.1.0-phase-0 catalog refresh.** Last comprehensive update at sub-step 0.10 Slice 8. Per Decision H discipline; ARCH-S8-1 audit caught accumulated drift across sub-steps 0.6 → 0.10 and prompted this consolidated entry pass.

## Top-level docs

- [README.md](README.md) — value prop, dev install, CLI verbs preview (Phase 1 deferral), status line.
- [CHANGELOG.md](CHANGELOG.md) — Keep-a-Changelog format, semver from v0.0.0.
- [CONTRIBUTING.md](CONTRIBUTING.md) — phase discipline, decision-log schema, code style, testing rigor, dependency policy, generic-paths discipline, slash-command path convention.
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

- [phase-0.md](decisions/phase-0.md) — Phase 0 sequencing + design decisions (33 entries through sub-step 0.10; Decisions A–O ratified, Decision N supersedes J per ARCH-1 audit).

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

## Bundled skills (`skills/`)

- `skills/audit/SKILL.md` — multi-persona audit dispatch skill (vault context references; CLI-4 anonymization deferred to Phase 1 backlog).
- `skills/commit-push-pr/SKILL.md` — pre-commit gate runner + push + PR-creation skill.

## Bundled commands (`commands/`)

Slash commands consumable inside Claude Code. Use `${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}` for cross-edge invocation per Slice 3 / Decision N convention; v0.1.0 ships these as `.md` bodies (Phase 1 introduces standalone CLI verbs).

- `commands/session/handoff.md` — `/handoff` end-of-session handoff writer with Next Steps + decisions trail.
- `commands/session/handoff-resume.md` — `/handoff-resume` resume-from-handoff with Step 1a concurrent-pair detection + parallel-mode context-load.
- `commands/session/channel.md` — `/channel` cross-session channel verbs (create, join, send, read, peers).
- `commands/session/presence.md` — `/presence` active-sessions registry verbs.

## Source code (`src/`)

### Top-level

- [src/index.ts](src/index.ts) — public API surface placeholder (populated as extraction progresses).

### Shared primitives (`src/shared/`)

- [src/shared/paths.ts](src/shared/paths.ts) — per-component path resolvers with 3-layer env precedence (sub-step 0.5; FALLBACK_ROOT_SUFFIX `.claude` per Decision N — 6 components default to canonical, 2 plugin-internal default to `conductor/`).
- [src/shared/home.ts](src/shared/home.ts) — `effectiveHome()` HOME-resolver with HOME-env-respecting + os.homedir() fallback (sub-step 0.8 hoist; canonical source per Decision I).
- [src/shared/presence-failure-log.ts](src/shared/presence-failure-log.ts) — append-only JSONL log for hook gate failures (forensics + telemetry).

### Memory loader (`src/memory-loader/`)

- [src/memory-loader/index.ts](src/memory-loader/index.ts) — V2-schema memory loader + INDEX.md formatter (sub-step 0.4).

### Channels (`src/channels/`)

- [src/channels/index.ts](src/channels/index.ts) — channel CRUD + metadata RMW + heartbeat + appendMessage; routes via `channelsDir()` resolver. Path-parameterized validator split (Slice 4 TS-1 / TS-A6).
- [src/channels/cli.ts](src/channels/cli.ts) — channel CLI bin: from-handoff, create, join, close, send, read, list, meta, heartbeat, peers, body. `requireChannelId()` defense-in-depth via `isValidArtifactId` (Slice 5 RE-2).

### Active sessions (`src/active-sessions/`)

- [src/active-sessions/index.ts](src/active-sessions/index.ts) — session-presence registry with atomic meta + heartbeat + GC + `isValidSessionId` / `isValidArtifactId` predicates.

### Todos (`src/todos/`)

- [src/todos/index.ts](src/todos/index.ts) — durable todo-file rehydration + read-active + count-active.
- [src/todos/cli.ts](src/todos/cli.ts) — todos CLI bin: write, read-active, count-active, exists.

### Hooks substrate (`src/hooks/`)

- [src/hooks/types.ts](src/hooks/types.ts) — `HookEvent`, `HookProfile`, `HookInput`, `HookResult`, `KNOWN_TOOL_NAMES` literal-union (17 tools per Slice 4.5 TS-2 + Slice 8 ARCH-S8-2 widening), `pass()`/`warn()`/`block()` constructors, `assertNever`.
- [src/hooks/input.ts](src/hooks/input.ts) — `parseHookInput()` from stdin JSON.
- [src/hooks/lock.ts](src/hooks/lock.ts) — `withLock`/`withLockAsync`/`acquireLockAsync` mutex primitives.
- [src/hooks/session-id.ts](src/hooks/session-id.ts) — `extractSessionId` + `resolveSessionIdOrNull` with `isValidSessionId` gate.
- [src/hooks/timing.ts](src/hooks/timing.ts) — `recordCheckTiming()` JSONL telemetry; `isValidSessionId` gate per Slice 5 RE-2.
- [src/hooks/registry.ts](src/hooks/registry.ts) — `RegistryBuilder<Name>` + `SealedRegistry<Name>` dual-phase registry + `OrderEntry` (KnownToolName-tightened) + `CheckMeta`.
- [src/hooks/registry-assertion.ts](src/hooks/registry-assertion.ts) — `assertWiringComplete()` boot-time bidirectional check (ORDER ↔ registry).
- [src/hooks/bundled-check-names.ts](src/hooks/bundled-check-names.ts) — `BUNDLED_CHECKS_BY_EVENT` source-of-truth + `BundledCheckName` literal union + `BUNDLED_CHECK_NAMES` flat array (sub-step 0.7 #10).

### Hook checks (`src/hooks/checks/`)

24 individual check implementations bundled per `bundled-registrations.ts`. Categorized:

**Pre-tool-use gates (blocking):**

- `session-collision-gate.ts`, `handoff-symlink-write-guard.ts`, `fact-force.ts` (+ `fact-force-scope-store.ts` + `fact-force-scope-cli.ts`), `branch-enforcement.ts`, `destructive-cmd.ts`, `prefer-bun.ts`, `pre-commit.ts`, `config-protection.ts` (+ `config-protection-store.ts` + `config-protection-cli.ts`), `sensitive-files.ts`.

**Post-tool-use checks (warn/pass):**

- `auto-format.ts`, `no-any.ts`, `no-enum.ts`, `sync-common.ts`.

**SessionStart / Stop hooks (channel-touching):**

- `active-channels-load.ts`, `channel-gc.ts`, `session-presence-register.ts`, `session-presence-unregister.ts`.

**Stop-time auxiliary:**

- `test-gate.ts`, `bundled-registrations.ts` (the registration manifold itself), `handoff-latest-guard.ts`.

## Tests (`test/`)

- [test/smoke.test.ts](test/smoke.test.ts) — initial bun-test scaffolding placeholder.
- [test/shared/paths.test.ts](test/shared/paths.test.ts) — RE-8 precedence cases + Slice 2 namespace-revert assertions.
- [test/shared/home.test.ts](test/shared/home.test.ts) — `effectiveHome()` HOME-env-vs-homedir() resolution cases.
- [test/shared/presence-failure-log.test.ts](test/shared/presence-failure-log.test.ts) — append-only JSONL log invariants.
- [test/memory-loader/index.test.ts](test/memory-loader/index.test.ts) — V2-schema parsing, validation, filtering, formatting.
- [test/memory-loader/fixtures/](test/memory-loader/fixtures/) — 7 fixtures (valid + invalid + filtered shapes).
- [test/channels/index.test.ts](test/channels/index.test.ts) — channel CRUD + metadata RMW + heartbeat lifecycle.
- [test/channels/cli.test.ts](test/channels/cli.test.ts) — CLI verb integration tests.
- [test/active-sessions/](test/active-sessions/) — registry atomicity, heartbeat, GC, peer-info-owner-invariant tests.
- [test/todos/](test/todos/) — todos write/read-active/count-active tests.
- [test/hooks/timing.test.ts](test/hooks/timing.test.ts) — timing-log JSONL append invariants.
- [test/hooks/bundled-registrations.test.ts](test/hooks/bundled-registrations.test.ts) — meta-test for the 18 bundled discipline checks (build registry, seal, assert tuples + count + duplicates + bidirectional set-equality + compile-time `@ts-expect-error`).
- [test/scripts/check-generic-paths.test.ts](test/scripts/check-generic-paths.test.ts) — detector self-tests (P1/P2/P3 classes + Layer 2/3 narration suppression + markdown CLI-1 catch + non-allowlisted-md suppression).
- [test/test-utils/](test/test-utils/) — helper-tests for cross-test fixtures.

## Test infrastructure (`test-utils/`)

Cross-test helpers promoted from `test/helpers/` per sub-step 0.7 Decision A. Top-level home signals first-class plugin component; `package.json` exports map intentionally excludes `./test-utils` (Decision G — internal-to-plugin via relative imports only).

- [test-utils/index.ts](test-utils/index.ts) — re-export entry point.
- [test-utils/tmp-repo.ts](test-utils/tmp-repo.ts) — `makeTmpHome` / `makeTmpRepo` / `runDispatcher` helpers.

## Scripts (`scripts/`)

Static-analysis CI gates. All bash 3.2+ portable, compiler-style `<file>:<line>:<col>: error[<id>]: <msg>` output to stderr, GHA-aware `::error` annotations under `GITHUB_ACTIONS=true`.

- [scripts/check-generic-paths.sh](scripts/check-generic-paths.sh) — P1 (`nbruzzi` substrate-id), P2 (`/Users/<name>/`), P3 (`\.claude/` literal under `src/`) detector with 3-layer allowlist (file pathspec / SPDX header / comment-narration). Per Slice 1 + Slice-1 follow-up.
- [scripts/check-import-extensions.sh](scripts/check-import-extensions.sh) — TS relative imports must end in `.ts` (Slice 7 / TS-A3).
- [scripts/check-bundled-registrations-parity.sh](scripts/check-bundled-registrations-parity.sh) — diff plugin's `bundled-registrations.ts` against dotfiles' canonical via `${CLAUDE_DOTFILES_ROOT}` (Slice 7 / ARCH-2). Pre-strip + prettier-normalize + graceful skip when canonical absent.

## CI / GitHub Actions (`.github/workflows/`)

- [.github/workflows/test.yml](.github/workflows/test.yml) — CI workflow per sub-step 0.7 Decision D shape. SHA-pinned actions, `bun install --frozen-lockfile`, `permissions: contents: read`, `timeout-minutes: 10`. Sequential typecheck → format:check → lint → test → 3 detector scripts (`check-generic-paths`, `check-import-extensions`, `check-bundled-registrations-parity`) → actionlint via `reviewdog/action-actionlint` SHA-pinned (Decision Q in `decisions/phase-0.md` documents the SHA-pin operations runbook + reviewdog wrapper rationale). Local equivalent: `bun run lint:workflows` (see CONTRIBUTING.md).
