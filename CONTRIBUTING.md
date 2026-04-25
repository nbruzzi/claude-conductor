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
6. **Pipeline gates** — typecheck + format + lint + tests all clean.
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

No `nbruzzi`-specific paths in code outside CONTRIBUTING/CHANGELOG/decisions/audits. CI grep check enforces. Per-component env vars (`CLAUDE_CONDUCTOR_CHANNELS_DIR`, etc.) override the `$CLAUDE_CONDUCTOR_ROOT` default-prefix; `$CLAUDE_CONDUCTOR_ROOT` itself defaults to `~/.claude/conductor` when unset.

## Branching

Cut a feature branch before touching code: `git checkout -b <feature-name>`. CLAUDE.md branching rule (>3 files OR plan-mode-entered) is enforced by the `branch-enforcement` PreToolUse hook on the dotfiles substrate; this repo inherits the discipline. Phase boundaries map to branches: `phase-0-<name>`, `phase-1-<name>`, etc.
