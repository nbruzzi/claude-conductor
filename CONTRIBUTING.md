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

The bundled session slash commands (`commands/session/*.md`) shell out to dotfiles' channel/todos/active-sessions CLI via `${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}`. Default works for the sibling-clone install layout (`~/claude-conductor` and `~/.claude-dotfiles` as siblings). Non-default installs export `CLAUDE_DOTFILES_ROOT` once. CLI-1 (sub-step 0.10) — see Decision N.

### Dotfiles version compatibility

The plugin pins its dotfiles substrate via `package.json` `file:..` (sibling-clone install layout) — there is no SemVer over the cross-repo edge yet. Instead, each slash command runs a **feature-detection** preflight: it verifies the expected CLI entry-point exists and accepts the verbs the command will call.

Detection happens at slash-command invocation, not at install. The preflight is a single `bun run "${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}/src/<area>/cli.ts" --help` invocation (read-only, no side-effects); a non-zero exit short-circuits the command with a diagnostic naming:

1. The expected CLI path (with `CLAUDE_DOTFILES_ROOT` interpolated)
2. The dotfiles ref the plugin's session commands were authored against (`commit SHA` or `HEAD` if unpinned — see `commands/session/*.md` preflight blocks)
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
