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
6. **Pipeline gates** — typecheck + format + lint + tests all clean. Single-command equivalent: `bun run check` (alias for `bun run verify` — orchestrates typecheck + format:check + lint + the `check-*` gates [generic-paths, import-extensions, dep-rationale, spdx-headers, decision-log, coverage-floor] + `bun test`; the authoritative gate set lives in `verify-manifest.json`).
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

Cut a feature branch before touching code. Branch _existence_ is gate-enforced: the `branch-enforcement` PreToolUse hook on the dotfiles substrate blocks edits on a protected branch (`main`) once the CLAUDE.md threshold is crossed (>3 distinct files OR plan-mode-entered) and directs you to `git checkout -b <feature-name>`; this repo inherits the discipline cross-edge. Branch _naming_ is advisory, not gated — the cohort uses `<nato>/<feature>` (e.g. `bravo/spdx-header-ci-check`) and solo work uses `<feature-name>` (per CLAUDE.md). The earlier `phase-<N>-<name>` encoding is retired: it predates the NATO-cohort + solo workflow and no live process emits or checks it.

## What CONTRIBUTING.md is NOT (anti-positioning Cycle 3b)

Sibling section to README `## What claude-conductor is NOT` (anti-positioning Cycle 3a). The contributor-facing positioning frame:

- **NOT an external-contributor-friendly contribution template.** This repo is currently private/closed (per line 8 above); the document captures internal cohort contribution discipline. External contributors are not accepted at this stage. The document is preserved in-repo as a contract for future Claude instances picking up work in subsequent sessions, NOT as an invitation to drive-by PRs.
- **NOT a general-purpose contribution standard.** The conventions encoded here (multi-persona audit, phase discipline, decision-log convention, audit transcript durability, generic-paths P1/P2/P3 enforcement, slash-command path convention, dotfiles version compatibility via feature-detection) are tuned to the nbruzzi-operator cohort workflow on Claude Code. Other multi-Claude or multi-AI workflows would need to redesign the convention layer; the discipline-as-code patterns can inform but should not be copy-pasted.
- **NOT a substitute for the cohort discipline-thread.** This document is INSTRUCTION; cohort precedent + audit-loop + hook layer provide ENFORCEMENT. A contributor following CONTRIBUTING.md without cohort cycle precedent (cross-pair audit, ratify-clean cascade, preemptive-fold-on-OBS, memorialize-then-violate empirical accrual) would have the rules but not the practice that makes them load-bearing. The document teaches the rules; the cohort cycle teaches the discipline.
- **NOT a complete enforcement spec — but closer than it was.** The Cycle-4 enforcement arc (2026-05-28) moved most conventions to gate-driven: TypeScript discipline, formatting, SPDX headers, generic-paths, import-extensions, dependency rationale, coverage floor, and decision-log presence all fail CI (see §"INSTRUCTION-vs-ENFORCEMENT boundary" below). A few remain convention-by-vigilance, held by cohort precedent (smoke-run gate, audit-transcript durability); multi-persona audit dispatch is checked by a LOCAL pre-merge verb (`audit quorum`) rather than CI, because channel state is operator-local and not CI-visible; and branch _naming_ is intentionally advisory (branch _existence_ is hook-gated). The boundary section enumerates each item's enforced / convention / retired status.
- **NOT a CI/CD pipeline definition.** The CI workflow at `.github/workflows/test.yml` is the technical pipeline gate (typecheck + format:check + lint + the `check-*` gates [generic-paths, import-extensions, dep-rationale, spdx-headers, decision-log, coverage-floor] + test; enumerated in `verify-manifest.json`); CONTRIBUTING.md is the human-readable discipline contract. Both are required; neither substitutes for the other.
- **NOT a static document.** Conventions evolve per cohort empirical (memorialize-then-violate accrual + preemptive-fold-on-OBS at observation surfaces). Updates land via cohort batch-memo cascades to the memory directory (`~/.claude/projects/-Users-nbruzzi/memory/`) + occasional CONTRIBUTING.md edits when the convention layer itself shifts. The cohort-cycle-precedent rhythm IS the document's continuous integration.

## INSTRUCTION-vs-ENFORCEMENT boundary (tech-debt ack)

Per `[[feedback-instructions-vs-enforcement-thesis]]` cohort discipline thread + Bravo R-3 risk-flag (Stage 1 Cycle 3a deferral framing): "INSTRUCTION-not-ENFORCEMENT will fail for AI-written PRs." This section explicitly names which items in CONTRIBUTING.md sit at which layer.

**ENFORCED today (gate-driven):**

- **TypeScript strict mode + no `any` + no non-null-assertion + exhaustive type checks** — ESLint config errors on violation; typecheck via `tsc --noEmit` at CI + pre-push.
- **Prettier formatting** — pre-commit hook on dotfiles (`.husky/pre-commit`) + `bun run format` at CI.
- **Apache-2.0 SPDX header on source files** — `scripts/check-spdx-headers.sh` CI gate greps `SPDX-License-Identifier` within the first 5 lines of every tracked `.ts`/`.sh`/`.js`/`.mjs`/`.cjs` source file; CI fails on absence. (There is NO ESLint SPDX rule — `eslint.config.js` lints `.ts` only and carries no header rule — so the CI gate is the cross-file-type enforcement.)
- **Forbidden patterns** (`eval` / dynamic-code / shell-string-concat) — ESLint custom rules (per CONTRIBUTING line 55); rejected at lint stage.
- **Generic-paths P1/P2/P3** — `scripts/check-generic-paths.sh` runs at CI; CI fails on violation (per CONTRIBUTING line 63-67).
- **Import extension discipline** — `scripts/check-import-extensions.sh` (or equivalent) at CI.
- **Pipeline gates** (typecheck + format + lint + check-generic-paths + check-import-extensions + check-dep-rationale + check-spdx-headers + check-decision-log + test + check-coverage-floor) — CI workflow `.github/workflows/test.yml`; PR cannot merge without green CI per CLAUDE.md After-Every-Push mandate. `verify-manifest.json` is the SSOT for this gate set and `verify:drift` asserts manifest↔CI parity, so this list cannot silently drift from the workflow.
- **Branch-enforcement** (>3 files OR plan-mode-entered → feature branch required) — `branch-enforcement` PreToolUse hook on dotfiles substrate (per CONTRIBUTING line 122); this repo inherits via cross-edge hook layer.
- **Memory-integrity** (broken links / orphans / duplicates / byte-cap / fold issues) — `memory-integrity` Stop hook in dotfiles.
- **Destructive-cmd discipline** — `destructive-cmd` PreToolUse hook in dotfiles (rejects `git reset --hard` / `git push --force` patterns without explicit cohort-discretion override).
- **Audit-verdict schema validation at send-time** — `audit-verdict.ts` parser enforces `LENS_CLASSES` tuple-strict + counts-coherence + three_option_ask required + cross_edge_consumers_verified for substrate-class PRs (per `[[feedback-audit-cohort-missed-cross-edge-shim-consumer]]`).
- **Dependency-rationale coverage** — `scripts/check-dep-rationale.sh` runs at CI (+ in `verify:fold`); CI fails when any `dependencies`/`devDependencies` entry in `package.json` lacks a backtick-wrapped entry in `dependencies-rationale.md` (per the "Dependency policy" section). Static invariant (not a package.json git-diff — no base-ref dependency); error code `CDR-001`.
- **Repo-wide line-coverage floor** — `scripts/check-coverage-floor.sh` runs at CI; CI fails when the aggregate `bun test --coverage` "All files" line coverage drops below the floor (default 84%, env-tunable via `COVERAGE_FLOOR`); error code `CCF-001`. Reframed from the per-phase floors (see line 40): "phase" is a retired single-session build-plan concept with no CI-time signal, so the load-bearing intent — coverage must not regress — is enforced repo-wide rather than per-phase ordinal. (Distinct gate; re-runs the suite with coverage — a v1 tradeoff, foldable into the Test gate later.)
- **Decision-log presence** — `scripts/check-decision-log.sh` runs at CI (+ in `verify:fold`); when a PR changes substrate `src/` source, CI fails unless the same diff adds a `decisions/` entry OR a `Decision-log: none (<reason>)` commit trailer opts out. Diff-based against the origin/main merge-base (needs `fetch-depth: 0`); error code `DLOG-001`. Schema: `docs/conventions/decision-log-schema.md`.

**Convention-by-vigilance today (NOT gate-enforced; cohort-precedent-enforced):**

- **Multi-persona audit dispatch** (CONTRIBUTING line 14 "3 minimum personas, scope-driven scaling, hard cap 5-6") — cohort discipline; the LOCAL `audit quorum` verb (cycle 2026-05-28) checks lens-diversity + auditor-independence per PR, but it is operator/cohort-invoked at pre-merge (channel JSONL is local), NOT CI-auto-enforced
- **Branch naming** (CONTRIBUTING §Branching: `<nato>/<feature>` cohort / `<feature-name>` solo) — intentionally advisory, NOT a gate gap. Branch _existence_ (no feature-work on `main` past the file/plan threshold) IS gate-enforced by the `branch-enforcement` hook; the _name_ is left to convention because the cohort + solo schemas diverge and a name-pattern gate would reject valid branches. The retired `phase-<N>-<name>` encoding is no longer a naming target.
- **Smoke-run gate** (CONTRIBUTING line 18 "run new code in a real test environment to catch sandbox/reality drift") — cohort discipline; no gate validates smoke-run output
- **Audit transcript durability** (CONTRIBUTING line 59 `audits/phase-<N>/<persona>-<round>.md`) — cohort discipline; no gate validates audit-transcript filing

**Cohort-precedent IS the enforcement for convention-only items.**

The cohort discipline-thread (cycle 2026-05-27 empirical: 19 PR merges + 24+ memo deltas across 4 NATOs in 3 stages) demonstrates how cross-pair audit-shadow + ratify-clean cascade + preemptive-fold-on-OBS effectively enforce convention-only items at PR-tier:

- Multi-persona audit: cohort precedent applies multi-NATO cross-pair-shadow + Pair-Internal audit on every substrate PR (4-NATO ratify-clean cascade is the discipline)
- Feature branching: cohort precedent applies feature-branch + worktree-isolate-at-branch-create as cohort default (per `[[feedback-parallel-session-shared-tree-branch-race]]` rule 14); branch _existence_ is additionally hook-gated (see ENFORCED-today)
- Smoke-run gate: cohort precedent applies pre-commit gate suite (typecheck/format/lint/tests) as proxy at audit-shadow time
- Audit transcript durability: cohort channel JSONL + body-ref content-addressed storage provides cohort-shared durability (not the `audits/phase-<N>/` filesystem path specifically; cohort discipline-thread evolved to channel-based)

The cohort-precedent-enforcement-mechanism is empirically effective per cycle 2026-05-27 PRISTINE-or-RECOVERED cycle character. AI-written PRs (Claude sessions modifying conductor) ARE held to convention-by-vigilance via the cohort cycle precedent + cross-pair audit + 4-NATO ratify-clean cascade.

**Cycle-4 enforcement arc — SHIPPED (2026-05-28):**

The R-3 "INSTRUCTION-not-ENFORCEMENT" gap is now structurally closed. The items below were the convention-by-vigilance backlog at Cycle-4 start; all were addressed this cycle — gate-enforced, verb-enforced, or retired as obsolete. Retained as the per-item shipped/retired record:

- **SPDX header CI check** — IMPLEMENTED this cycle as `scripts/check-spdx-headers.sh` (greps `SPDX-License-Identifier` in the first 5 lines of all tracked `.ts`/`.sh`/`.js`/`.mjs`/`.cjs` source files; wired into `verify:fold` + CI + `verify-manifest.json`). Moved to ENFORCED-today above.
- **Decision-log presence CI check** — SHIPPED (this cycle) as `scripts/check-decision-log.sh` (`check-decision-log` gate, error code `DLOG-001`). A PR changing substrate `src/` source must add a `decisions/` entry in the same diff OR carry a `Decision-log: none (<reason>)` opt-out trailer. Implemented diff-based against the origin/main merge-base (needs CI `fetch-depth: 0`) rather than a static invariant, since "did this change carry a decision" is inherently changeset-relative. Also reconstructs the previously-missing `docs/conventions/decision-log-schema.md`. Two documented v1 boundaries: the trigger is all `src/**` non-test source (provisional path-set, cohort-ratify pending), and the gate checks that a `decisions/` file was touched (a forcing-function, cross-pair-review-backstopped) rather than that a net-new entry was added.
- **Per-phase test coverage floor CI check** — SHIPPED (this cycle) as `scripts/check-coverage-floor.sh` (the `check-coverage-floor` gate, error code `CCF-001`), REFRAMED to a repo-wide line-coverage floor (default 84%, `COVERAGE_FLOOR`-tunable): "phase" has no CI-time signal (zero phase-detection constants in src; `smoke:phase-*` are manual), so a literal per-phase-ordinal gate is unbuildable. Enforces the load-bearing intent — coverage must not regress — repo-wide.
- **Dependency rationale check** — SHIPPED (this cycle) as `scripts/check-dep-rationale.sh` (the `check-dep-rationale` gate, error code `CDR-001`). Implemented as a static invariant — every declared `dependencies`/`devDependencies` entry must have a backtick-wrapped entry in `dependencies-rationale.md` — rather than a package.json git-diff, so there is no base-ref dependency and the check runs identically locally and in CI.
- **Multi-persona audit dispatch verification** — SHIPPED as the LOCAL `claude-conductor audit quorum --channel <id> --target-pr <repo>#<n>` verb (cohort cycle 2026-05-28, Pair-B). NOT a CI check: audit-verdicts live in the operator-local channel JSONL (`~/.claude/channels/`, never pushed to the remote), so GitHub CI cannot see them — same premise as the sibling `audit verify` local verb. Quorum is a conjunction: lens-diversity (≥ `--min-lenses` distinct LENS_CLASSES, default 3 per line 14) AND auditor-independence (≥ `--min-auditors` distinct auditor identities, default 2), with self-audits (auditor == target_peer) excluded. Invoked at pre-merge in the cohort audit-loop-closure discipline, not `test.yml`. (Doc-fix: the original "N distinct `target_peer` ... CI workflow + branch-protection rule" framing was wrong — target_peer is the verdict addressee, constant per PR, and CI cannot read local channel state.)
- **Branch name vs phase enforcement** — RETIRED (not implemented; premise obsolete). The `phase-<N>-<name>` convention this would have gated no longer exists (cohort uses `<nato>/<feature>`, solo uses `<feature-name>`); the load-bearing value — feature-work-not-on-`main` — is already enforced by the `branch-enforcement` hook (existence, not name). A name-pattern gate would reject valid cohort/solo branches for ~zero marginal value. See §Branching for the documented convention.

These items were codified this cycle (gate / local-verb / retired); the cohort discipline-thread that previously held them by precedent (cycle 2026-05-27) is now backstopped by the gates themselves. The remaining convention-by-vigilance items (smoke-run, audit-transcript durability) stay cohort-precedent-enforced — candidates for a future arc if they prove worth gating.

— Anti-positioning Cycle 3b S4-D Alpha-pen 2026-05-27 (Pair A; sibling to Cycle 3a Alpha lane 4 README + vault entity V2.1; R-3 risk-addressed via INSTRUCTION-vs-ENFORCEMENT explicit boundary enumeration + cohort-precedent-as-enforcement framing + Cycle 4+ tech-debt forward-reference)
