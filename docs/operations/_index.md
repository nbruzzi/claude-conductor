<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Operations runbooks

Operator-facing recovery + observability runbooks. Tier scope is operator-facing — commands to run, errors to triage, breadcrumbs to inspect — distinct from `docs/architecture/` (component contracts, edges, design rationale).

Each runbook is keyed to a phase or feature surface; cross-link from `docs/architecture/` when an architecture decision has an operator consequence.

## Catalog

- [phase-2-hooks.md](phase-2-hooks.md) — Phase 2 hooks operator runbook (4 hooks + 2 CLI verbs + 2 flags + breadcrumb taxonomy + per-hook recovery).
- [phase-3-kill-switch.md](phase-3-kill-switch.md) — Phase 3 Slice 1 dispatcher kill-switch operator runbook (`CLAUDE_CONDUCTOR_DISABLE_HOOKS` env var + composition rules + per-hook recovery + visibility section + cross-event semantics).
- [phase-3-worktrees.md](phase-3-worktrees.md) — Phase 3 Slice 2 per-session dotfiles worktrees runbook (`CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES` env var + 4-tier resolver precedence + 3 hooks (provisioner / gc / cleanup) + 8 verbatim error drafts E-1…E-8 + 10 depth-3 operator scenarios + Operational notes).

## Topic-keyword cross-reference

When the operator knows the topic but not the phase number, find the runbook here:

| Topic                                                                                                                      | Runbook                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Hook firing order matrix                                                                                                   | [phase-2-hooks.md](phase-2-hooks.md) §Hook firing order matrix                                                                   |
| Per-hook recovery (Phase 2 hooks)                                                                                          | [phase-2-hooks.md](phase-2-hooks.md) §Per-hook recovery                                                                          |
| Per-channel substrate layout                                                                                               | [phase-2-hooks.md](phase-2-hooks.md) §Per-channel substrate layout                                                               |
| `forget-cursor` / `show-cursor` verbs                                                                                      | [phase-2-hooks.md](phase-2-hooks.md) §Phase 2 CLI surface                                                                        |
| `--since-mtime` / `--since-cursor` flags                                                                                   | [phase-2-hooks.md](phase-2-hooks.md) §Phase 2 CLI surface                                                                        |
| `clock-skew` breadcrumb kind                                                                                               | [phase-2-hooks.md](phase-2-hooks.md) §Debug breadcrumbs                                                                          |
| `kill-switch` breadcrumb kind                                                                                              | [phase-3-kill-switch.md](phase-3-kill-switch.md) §Debug breadcrumbs                                                              |
| `CLAUDE_CONDUCTOR_DISABLE_HOOKS` env var                                                                                   | [phase-3-kill-switch.md](phase-3-kill-switch.md) (entire runbook)                                                                |
| How to spot a malformed env var                                                                                            | [phase-3-kill-switch.md](phase-3-kill-switch.md) §How to spot a malformed                                                        |
| Composition rule (profile / env / isolation)                                                                               | [phase-3-kill-switch.md](phase-3-kill-switch.md) §Composition rule                                                               |
| Multi-hook wedge recovery                                                                                                  | [phase-3-kill-switch.md](phase-3-kill-switch.md) §Recovery scenarios                                                             |
| Per-hook file kill-switch (`~/.claude/<name>-off`)                                                                         | [phase-2-hooks.md](phase-2-hooks.md) §Per-hook recovery + [phase-3-kill-switch.md](phase-3-kill-switch.md) §Blocking-hook policy |
| `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES` env var                                                                           | [phase-3-worktrees.md](phase-3-worktrees.md) (entire runbook)                                                                    |
| `worktree-{provision-failed,gc-reaped,cleanup-failed,cleanup-incomplete}` / `sentinel-corrupt` / `deprecation` breadcrumbs | [phase-3-worktrees.md](phase-3-worktrees.md) §Where the breadcrumbs land                                                         |
| Forensic-marker escape hatch                                                                                               | [phase-3-worktrees.md](phase-3-worktrees.md) §Runbook scenarios §7 GC-reaped while active                                        |
| Working from a second terminal                                                                                             | [phase-3-worktrees.md](phase-3-worktrees.md) §Runbook scenarios §9                                                               |
| Migrating uncommitted work from worktree → canonical                                                                       | [phase-3-worktrees.md](phase-3-worktrees.md) §Runbook scenarios §4                                                               |
| Soft-ceiling rationale (worktrees)                                                                                         | [phase-3-worktrees.md](phase-3-worktrees.md) §Operational notes §Hard-vs-soft ceiling                                            |
| Time Machine exclusion (worktrees)                                                                                         | [phase-3-worktrees.md](phase-3-worktrees.md) §Operational notes §Time Machine exclusion                                          |
