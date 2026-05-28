<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Contributing

claude-conductor is currently private/closed — external contributions are not accepted at this stage. This document captures the internal contribution discipline so that any Claude instance picking up work in a future session has a clear contract.

## Phase discipline

Work proceeds in phases per the parent plan (`~/.claude/plans/disciplined-multi-agent-coordination-plugin.md`, private). Each phase has:

1. **Pre-phase audit** — multi-persona adversarial review of the plan/sub-plan. 3 minimum personas, scope-driven scaling, hard cap 5–6 (per the audit-skill discipline at `~/.claude/skills/audit/SKILL.md`).
2. **Per-phase implementation** — execute the deliverables enumerated in the parent plan's Phased shipping arc table.
3. **Post-phase audit** — same persona set re-runs against the implementation diff.
4. **Verification round** — each persona verifies only their own findings against the integration. Bounded 1 round by default; up to 3 rounds when integration substantively changed the surface.
5. **Smoke-run gate** — run new code in a real (no-op) test environment to catch sandbox/reality drift.
6. **Pipeline gates** — typecheck + format + lint + tests all clean. Single-command equivalent: `bun run check` (alias for `bun run verify` — orchestrates typecheck + format:check + lint + check-generic-paths + check-import-extensions + `bun test`).
7. **Autonomous merge** — when all gates pass, the implementing Claude merges on the user's behalf without asking.

Any gate failure stops the merge and surfaces the issue.

## Decision-log discipline

Within-phase sequencing decisions that don't change architecture, user-facing API, or block subsequent phases get **logged, not surfaced**. Each phase maintains a decision log at `decisions/phase-<N>.md` with structured per-entry frontmatter (kind / severity / phase / affects). Surfaced at end-of-phase as part of the post-phase summary.

Schema in `docs/conventions/decision-log-schema.md`.

## Code style

- TypeScript strict mode mandatory.
- No implicit-`any`, no typed-as-`any`, no non-null-assertion (eslint configured to error on these).
- Exhaustive type checks via `exhaustiveCheck<T>(x: never): never` on every union switch.
- Prettier enforced via precommit hook.
- Apache-2.0 SPDX header (`// SPDX-License-Identifier: Apache-2.0`) at the top of every new source file.

## Testing rigor

Per-phase test budget enforced. Phase 0 floor: 100% line coverage on extracted/refactored code, plus per-component path-resolution tests. Phase 1 floor: 26-concurrent-assigner stress test (property-based) + 6 unit tests mirroring vault-commit's presence-awareness pattern + ChannelMessage round-trip + migration heuristic test + display-render matrix.

Property-based tests for race surfaces use `fast-check` or equivalent. Integration tests against mocked Agent Teams harness are required for any code touching `TeammateIdle` / `TaskCreated` / `TaskCompleted`.

## Dependency policy

Every new runtime dependency requires an entry in `dependencies-rationale.md` explaining why it's needed and what alternatives were considered. Prefer Bun stdlib + Node stdlib over npm dependencies. No transitive bloat.

## Forbidden patterns

In plugin source code:

- No `eval`.
- No dynamic-code constructors.
- No shell-string concatenation (use `Bun.spawn` argv arrays).
- ESLint custom rules enforce these where automatable.

## Audit transcript durability

Multi-persona audit dispatches and verification rounds are captured at `audits/phase-<N>/<persona>-<round>.md`. These survive across sessions and inform Phase 5 terminal full-diff audit.

## Generic-paths discipline

No `nbruzzi`-specific paths in code outside CONTRIBUTING/CHANGELOG/decisions/audits. CI grep check (`scripts/check-generic-paths.sh`) enforces three rules:

- **P1** — hardcoded `nbruzzi` substrate identifier
- **P2** — hardcoded `/Users/<name>/` absolute paths
- **P3** — `\.claude/` literal under `src/` outside the explicit bypasser allowlist (Decision N: 16 files use `\.claude/` legitimately — kill switches, log dirs, the resolver itself, sensitive-file matchers — new code joins via `paths.ts` resolvers OR adds itself to the allowlist with rationale)

### Path resolution

Plugin path resolvers live in `src/shared/paths.ts`. Per Decision N (sub-step 0.10 ARCH-1 fix), each of the eight components resolves through **three layers**, in priority order:

| Layer | Trigger                                                             | Value                                              |
| ----- | ------------------------------------------------------------------- | -------------------------------------------------- |
| 1     | `CLAUDE_CONDUCTOR_<COMPONENT>_DIR` env set (per-component override) | env value verbatim — caller chose the path         |
| 2     | `CLAUDE_CONDUCTOR_ROOT` env set (root-prefix override)              | `$CLAUDE_CONDUCTOR_ROOT/<component-defaultSuffix>` |
| 3     | Neither set (fallback)                                              | `~/.claude/<component-defaultSuffix>`              |

The eight components split into two **defaultSuffix** classes:

- **6 dotfiles-canonical components** (`channels`, `todos`, `identity`, `active-sessions`, `handoffs`, `memories`) — defaultSuffix is the bare component name. Layer 3 resolves to `~/.claude/X/` matching dotfiles canonical. Layer 2 resolves to `$CLAUDE_CONDUCTOR_ROOT/X/`.
- **2 plugin-internal components** (`audits`, `decision-logs`) — defaultSuffix is `conductor/audits` / `conductor/decisions`. Layer 3 resolves to `~/.claude/conductor/X/`. Layer 2 resolves to `$CLAUDE_CONDUCTOR_ROOT/conductor/X/`. The `conductor/` prefix is embedded in defaultSuffix to avoid colliding with `~/.claude/audits/` (exists with unrelated content) or creating a stray `~/.claude/decisions/`.

**Layer 2 implication:** setting `CLAUDE_CONDUCTOR_ROOT=/opt/foo` gives `/opt/foo/channels/` for the 6 canonical components AND `/opt/foo/conductor/audits/` for `audits` (the conductor prefix from defaultSuffix is preserved). To override the audits/decision-logs path entirely, use the per-component Layer 1 env var (`CLAUDE_CONDUCTOR_AUDITS_DIR=/elsewhere`).

`CLAUDE_CONDUCTOR_*_DIR` env vars and `CLAUDE_CONDUCTOR_ROOT` are NOT defaulted to `~/.claude` — they're either set or unset. The `~/.claude` value enters resolution only at Layer 3 (the `FALLBACK_ROOT_SUFFIX` constant in `paths.ts`).

### Slash-command path convention

Session slash commands (`handoff`, `handoff-resume`, `channel`, `presence`) now live in the dotfiles repo at `${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}/commands/session/*.md` (substrate-refactor 2026-05-27 — user-workflow skills belong to user identity; conductor remains primitive-only). The skills shell out to dotfiles' channel/todos/active-sessions CLI via the same `${CLAUDE_DOTFILES_ROOT}` root for the sibling-clone install layout (`~/claude-conductor` and `~/.claude-dotfiles` as siblings). Non-default installs export `CLAUDE_DOTFILES_ROOT` once. CLI-1 (sub-step 0.10) — see Decision N.

### Dotfiles version compatibility

The plugin pins its dotfiles substrate via `package.json` `file:..` (sibling-clone install layout) — there is no SemVer over the cross-repo edge yet. Instead, each slash command runs a **feature-detection** preflight: it verifies the expected CLI entry-point exists and accepts the verbs the command will call.

Detection happens at slash-command invocation, not at install. The preflight is a single `bun run "${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}/src/<area>/cli.ts" --help` invocation (read-only, no side-effects); a non-zero exit short-circuits the command with a diagnostic naming:

1. The expected CLI path (with `CLAUDE_DOTFILES_ROOT` interpolated)
2. The dotfiles ref the session commands were authored against (`commit SHA` or `HEAD` if unpinned — see `${CLAUDE_DOTFILES_ROOT}/commands/session/*.md` preflight blocks)
3. The remediation: update the dotfiles checkout, or set `CLAUDE_DOTFILES_ROOT` to point at a compatible ref

This is option (c) "feature-detection" from slice 6 plan v2 §B3 FOLD-4 — chosen over (a) freeze a specific dotfiles SHA in this file or (b) version-marker file in dotfiles substrate. Feature-detection has the smallest coupling: no symbol the plugin pins on (just observed CLI shape), no SemVer ceremony, and the failure mode is a specific operator-readable diagnostic instead of `command not found`.

CLI-8 (sub-step 0.10 / slice 6 / B3).

### Local actionlint

CI runs `actionlint` via `reviewdog/action-actionlint` (SHA-pinned per Decision Q). To run the same check locally before pushing:

```bash
brew install actionlint   # macOS — Homebrew
# OR
go install github.com/rhysd/actionlint/cmd/actionlint@latest   # any platform with Go

bun run lint:workflows
```

The `lint:workflows` script in `package.json` calls `actionlint` directly; the CI workflow uses the reviewdog wrapper for inline reporter integration. Both run the same underlying tool; local invocation surfaces violations as compiler-style stderr output, no GitHub-side annotation.

## Branching

Cut a feature branch before touching code: `git checkout -b <feature-name>`. CLAUDE.md branching rule (>3 files OR plan-mode-entered) is enforced by the `branch-enforcement` PreToolUse hook on the dotfiles substrate; this repo inherits the discipline. Phase boundaries map to branches: `phase-0-<name>`, `phase-1-<name>`, etc.

## What CONTRIBUTING.md is NOT (anti-positioning Cycle 3b)

Sibling section to README `## What claude-conductor is NOT` (anti-positioning Cycle 3a). The contributor-facing positioning frame:

- **NOT an external-contributor-friendly contribution template.** This repo is currently private/closed (per line 8 above); the document captures internal cohort contribution discipline. External contributors are not accepted at this stage. The document is preserved in-repo as a contract for future Claude instances picking up work in subsequent sessions, NOT as an invitation to drive-by PRs.
- **NOT a general-purpose contribution standard.** The conventions encoded here (multi-persona audit, phase discipline, decision-log convention, audit transcript durability, generic-paths P1/P2/P3 enforcement, slash-command path convention, dotfiles version compatibility via feature-detection) are tuned to the nbruzzi-operator cohort workflow on Claude Code. Other multi-Claude or multi-AI workflows would need to redesign the convention layer; the discipline-as-code patterns can inform but should not be copy-pasted.
- **NOT a substitute for the cohort discipline-thread.** This document is INSTRUCTION; cohort precedent + audit-loop + hook layer provide ENFORCEMENT. A contributor following CONTRIBUTING.md without cohort cycle precedent (cross-pair audit, ratify-clean cascade, preemptive-fold-on-OBS, memorialize-then-violate empirical accrual) would have the rules but not the practice that makes them load-bearing. The document teaches the rules; the cohort cycle teaches the discipline.
- **NOT a complete enforcement spec.** Some items are convention-by-vigilance not gate-enforced (multi-persona audit dispatch, decision-log entries per phase, phase-boundary branch naming, smoke-run gate, per-phase test coverage floor). See §"INSTRUCTION-vs-ENFORCEMENT boundary (tech-debt ack)" below for explicit enumeration + Cycle 4+ deferred substrate work.
- **NOT a CI/CD pipeline definition.** The CI workflow at `.github/workflows/test.yml` is the technical pipeline gate (typecheck + format:check + lint + check-generic-paths + check-import-extensions + test); CONTRIBUTING.md is the human-readable discipline contract. Both are required; neither substitutes for the other.
- **NOT a static document.** Conventions evolve per cohort empirical (memorialize-then-violate accrual + preemptive-fold-on-OBS at observation surfaces). Updates land via cohort batch-memo cascades to the memory directory (`~/.claude/projects/-Users-nbruzzi/memory/`) + occasional CONTRIBUTING.md edits when the convention layer itself shifts. The cohort-cycle-precedent rhythm IS the document's continuous integration.

## INSTRUCTION-vs-ENFORCEMENT boundary (tech-debt ack)

Per `[[feedback-instructions-vs-enforcement-thesis]]` cohort discipline thread + Bravo R-3 risk-flag (Stage 1 Cycle 3a deferral framing): "INSTRUCTION-not-ENFORCEMENT will fail for AI-written PRs." This section explicitly names which items in CONTRIBUTING.md sit at which layer.

**ENFORCED today (gate-driven):**

- **TypeScript strict mode + no `any` + no non-null-assertion + exhaustive type checks** — ESLint config errors on violation; typecheck via `tsc --noEmit` at CI + pre-push.
- **Prettier formatting** — pre-commit hook on dotfiles (`.husky/pre-commit`) + `bun run format` at CI.
- **Apache-2.0 SPDX header on new source files** — ESLint rule (per CONTRIBUTING line 36 + `eslint.config.js` SPDX rule); rejected at lint stage.
- **Forbidden patterns** (`eval` / dynamic-code / shell-string-concat) — ESLint custom rules (per CONTRIBUTING line 55); rejected at lint stage.
- **Generic-paths P1/P2/P3** — `scripts/check-generic-paths.sh` runs at CI; CI fails on violation (per CONTRIBUTING line 63-67).
- **Import extension discipline** — `scripts/check-import-extensions.sh` (or equivalent) at CI.
- **Pipeline gates** (typecheck + format + lint + check-generic-paths + check-import-extensions + test) — CI workflow `.github/workflows/test.yml`; PR cannot merge without green CI per CLAUDE.md After-Every-Push mandate.
- **Branch-enforcement** (>3 files OR plan-mode-entered → feature branch required) — `branch-enforcement` PreToolUse hook on dotfiles substrate (per CONTRIBUTING line 122); this repo inherits via cross-edge hook layer.
- **Memory-integrity** (broken links / orphans / duplicates / byte-cap / fold issues) — `memory-integrity` Stop hook in dotfiles.
- **Destructive-cmd discipline** — `destructive-cmd` PreToolUse hook in dotfiles (rejects `git reset --hard` / `git push --force` patterns without explicit cohort-discretion override).
- **Audit-verdict schema validation at send-time** — `audit-verdict.ts` parser enforces `LENS_CLASSES` tuple-strict + counts-coherence + three_option_ask required + cross_edge_consumers_verified for substrate-class PRs (per `[[feedback-audit-cohort-missed-cross-edge-shim-consumer]]`).
- **Dependency-rationale coverage** — `scripts/check-dep-rationale.sh` runs at CI (+ in `verify:fold`); CI fails when any `dependencies`/`devDependencies` entry in `package.json` lacks a backtick-wrapped entry in `dependencies-rationale.md` (per the "Dependency policy" section). Static invariant (not a package.json git-diff — no base-ref dependency); error code `CDR-001`.

**Convention-by-vigilance today (NOT gate-enforced; cohort-precedent-enforced):**

- **Multi-persona audit dispatch** (CONTRIBUTING line 14 "3 minimum personas, scope-driven scaling, hard cap 5-6") — cohort discipline; no gate validates persona count or persona diversity on PRs
- **Decision-log entries per phase** (CONTRIBUTING line 26 + `decisions/phase-<N>.md`) — cohort discipline; no gate validates decision-log presence on phase-boundary PRs
- **Phase-boundary branch naming** (CONTRIBUTING line 122 `phase-0-<name>` / `phase-1-<name>`) — cohort discipline; no gate validates branch name against phase
- **Smoke-run gate** (CONTRIBUTING line 18 "run new code in a real test environment to catch sandbox/reality drift") — cohort discipline; no gate validates smoke-run output
- **Audit transcript durability** (CONTRIBUTING line 59 `audits/phase-<N>/<persona>-<round>.md`) — cohort discipline; no gate validates audit-transcript filing
- **Per-phase test coverage floors** (CONTRIBUTING line 40 "Phase 0 floor: 100% line coverage on extracted/refactored code") — cohort discipline; no coverage gate at CI today

**Cohort-precedent IS the enforcement for convention-only items.**

The cohort discipline-thread (cycle 2026-05-27 empirical: 19 PR merges + 24+ memo deltas across 4 NATOs in 3 stages) demonstrates how cross-pair audit-shadow + ratify-clean cascade + preemptive-fold-on-OBS effectively enforce convention-only items at PR-tier:

- Multi-persona audit: cohort precedent applies multi-NATO cross-pair-shadow + Pair-Internal audit on every substrate PR (4-NATO ratify-clean cascade is the discipline)
- Decision-log entries: cohort precedent reviews commit messages + PR bodies for decision-log linkage at audit-shadow time
- Phase-boundary branching: cohort precedent applies feature-branch + worktree-isolate-at-branch-create as cohort default (per `[[feedback-parallel-session-shared-tree-branch-race]]` rule 14)
- Smoke-run gate: cohort precedent applies pre-commit gate suite (typecheck/format/lint/tests) as proxy at audit-shadow time
- Audit transcript durability: cohort channel JSONL + body-ref content-addressed storage provides cohort-shared durability (not the `audits/phase-<N>/` filesystem path specifically; cohort discipline-thread evolved to channel-based)
- Per-phase test coverage floors: cohort precedent surfaces coverage gaps at audit-shadow via test-count delta in pre-push gate output

The cohort-precedent-enforcement-mechanism is empirically effective per cycle 2026-05-27 PRISTINE-or-RECOVERED cycle character. AI-written PRs (Claude sessions modifying conductor) ARE held to convention-by-vigilance via the cohort cycle precedent + cross-pair audit + 4-NATO ratify-clean cascade.

**Tech-debt forward-reference (Cycle 4+ scope):**

Future substrate-fix work that would close the R-3 gap structurally (gate-enforce the convention-by-vigilance items above):

- **SPDX header CI check** — script that greps `SPDX-License-Identifier` in all new source files; CI fails on absence. Substrate-fix scope: ~30 LOC bash script + workflow step.
- **Decision-log presence CI check** — for PRs that modify substrate primitives, validate `decisions/phase-<N>.md` has new entries. Substrate-fix scope: PR-template + CI workflow validating template-section presence.
- **Per-phase test coverage floor CI check** — coverage report at CI; fail on regression below phase floor. Substrate-fix scope: `bun test --coverage` invocation + threshold check.
- **Dependency rationale check** — SHIPPED (this cycle) as `scripts/check-dep-rationale.sh` (the `check-dep-rationale` gate, error code `CDR-001`). Implemented as a static invariant — every declared `dependencies`/`devDependencies` entry must have a backtick-wrapped entry in `dependencies-rationale.md` — rather than a package.json git-diff, so there is no base-ref dependency and the check runs identically locally and in CI.
- **Multi-persona audit dispatch verification** — for substrate-class PRs, validate channel JSONL has N audit-verdict bodies with N distinct `target_peer` values before merge. Substrate-fix scope: channel CLI verb + CI workflow + branch-protection rule.
- **Branch name vs phase enforcement** — branch-enforcement hook could validate `phase-<N>-<name>` pattern + cross-reference to active phase. Substrate-fix scope: hook layer extension.

These deferred items inform the next-cycle scope-decision; cohort discipline-thread has empirically demonstrated all of them via cycle 2026-05-27 cohort precedent but not yet codified as gates.

— Anti-positioning Cycle 3b S4-D Alpha-pen 2026-05-27 (Pair A; sibling to Cycle 3a Alpha lane 4 README + vault entity V2.1; R-3 risk-addressed via INSTRUCTION-vs-ENFORCEMENT explicit boundary enumeration + cohort-precedent-as-enforcement framing + Cycle 4+ tech-debt forward-reference)
