<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Extraction Manifest

**Phase 0 sub-step 0.2 deliverable.** Enumerates every file in `nbruzzi/claude-dotfiles` (and adjacent canonical paths in `~/.claude/`) with a per-file decision: `bundle-into-plugin` / `keep-in-dotfiles` / `extract-with-shim` / `not-applicable`. Cross-component import edges enumerated for the bundled subset.

**Audit gate:** mini-Architecture audit on this manifest (single persona) before sub-step 0.6 (file extraction) begins. Findings integrated; no circular references between plugin and dotfiles. Approved before Phase 1.

**Status:** DRAFT (awaiting mini-audit).

## Scope filter

The plan's audience is **future-Claude + peer Claudes coordinating via Anthropic's Agent Teams**, not Nick's personal setup. Filter:

- **Bundle-into-plugin:** generalizable to any Claude Code instance using the plugin (substrate primitives, generic discipline hooks, audit/handoff/convention skills, anonymized memories).
- **Extract-with-shim:** generalizable code that the dotfiles substrate currently uses; plugin owns the canonical copy, dotfiles re-exports for backwards compatibility.
- **Keep-in-dotfiles:** Nick-specific (vault paths, dotfiles repo paths, his personal memory layout, his agent loop, his Sentinel jobs).
- **Not-applicable:** out of plugin scope entirely (Firecrawl skills, hindsight tool).

## Per-file decisions — `nbruzzi/claude-dotfiles/src/`

### Core substrate (`active-sessions/`, `channels/`, `todos/`, `shared/`)

| File                                 | Decision          | Rationale                                                                             |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------- |
| `src/active-sessions/index.ts`       | extract-with-shim | Presence registry — generalizable. Plugin owns; dotfiles re-exports.                  |
| `src/active-sessions/index.test.ts`  | extract-with-shim | Tests follow the source.                                                              |
| `src/active-sessions/cli.ts`         | extract-with-shim | `claude-conductor presence` CLI — generalizable.                                      |
| `src/channels/index.ts`              | extract-with-shim | Messaging substrate — generalizable. Plugin owns; dotfiles re-exports.                |
| `src/channels/index.test.ts`         | extract-with-shim | Tests follow.                                                                         |
| `src/channels/cli.ts`                | extract-with-shim | `claude-conductor channel` CLI — generalizable. Phase 1 extends with NATO+role verbs. |
| `src/todos/index.ts`                 | extract-with-shim | Durable todo surface — generalizable.                                                 |
| `src/todos/index.test.ts`            | extract-with-shim | Tests follow.                                                                         |
| `src/todos/cli.ts`                   | extract-with-shim | `claude-conductor todo` CLI — generalizable.                                          |
| `src/shared/presence-failure-log.ts` | extract-with-shim | Used by active-sessions (cross-edge); generalizable failure-log primitive.            |

### Hooks dispatcher + handlers + primitives

| File                                       | Decision          | Rationale                                                                              |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| `src/hooks/dispatcher.ts`                  | extract-with-shim | Generic hook dispatcher entry point — generalizable.                                   |
| `src/hooks/handlers/post-tool-use.ts`      | extract-with-shim | Generic handler — generalizable.                                                       |
| `src/hooks/handlers/pre-tool-use.ts`       | extract-with-shim | Generic handler — generalizable.                                                       |
| `src/hooks/handlers/session-start.ts`      | extract-with-shim | Generic handler — generalizable.                                                       |
| `src/hooks/handlers/stop.ts`               | extract-with-shim | Generic handler — generalizable.                                                       |
| `src/hooks/handlers/user-prompt-submit.ts` | extract-with-shim | Generic handler — generalizable.                                                       |
| `src/hooks/input.ts`                       | extract-with-shim | Generic input parsing.                                                                 |
| `src/hooks/lock.ts`                        | extract-with-shim | `withLock` / `withLockAsync` primitives — generalizable.                               |
| `src/hooks/registry.ts`                    | extract-with-shim | Registry shape generalizable; specific check registrations stay in plugin OR dotfiles. |
| `src/hooks/run-checks.ts`                  | extract-with-shim | Generic check runner.                                                                  |
| `src/hooks/session-id.ts`                  | extract-with-shim | `extractSessionId` / `resolveSessionIdOrNull` — generalizable; cross-edge to channels. |
| `src/hooks/timing.ts`                      | extract-with-shim | Hook-timing instrumentation — generalizable.                                           |
| `src/hooks/types.ts`                       | extract-with-shim | Type definitions — generalizable.                                                      |

### Hooks/checks — generic discipline gates

| File                                              | Decision          | Rationale                                                                                                                  |
| ------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks/checks/auto-format.ts`                 | extract-with-shim | Generic format-on-stop discipline.                                                                                         |
| `src/hooks/checks/branch-enforcement.ts`          | extract-with-shim | Generic branching rule (>3 files = branch first).                                                                          |
| `src/hooks/checks/config-protection.ts`           | extract-with-shim | Generic config-protection. **NEEDS ENHANCEMENT** in plugin (approval-aware mechanism per Phase 0 substrate-gap follow-up). |
| `src/hooks/checks/destructive-cmd.ts`             | extract-with-shim | Generic destructive-command guard.                                                                                         |
| `src/hooks/checks/fact-force.ts`                  | extract-with-shim | Generic fact-forcing gate.                                                                                                 |
| `src/hooks/checks/handoff-latest-guard.ts`        | extract-with-shim | Generic LATEST-symlink protection.                                                                                         |
| `src/hooks/checks/handoff-symlink-write-guard.ts` | extract-with-shim | Generic handoff-symlink write-through protection.                                                                          |
| `src/hooks/checks/no-any.ts`                      | extract-with-shim | Generic TypeScript discipline.                                                                                             |
| `src/hooks/checks/no-enum.ts`                     | extract-with-shim | Generic TypeScript discipline.                                                                                             |
| `src/hooks/checks/pre-commit.ts`                  | extract-with-shim | Generic pre-commit gate orchestrator.                                                                                      |
| `src/hooks/checks/prefer-bun.ts`                  | extract-with-shim | Generic Bun-over-Node guard.                                                                                               |
| `src/hooks/checks/sensitive-files.ts`             | extract-with-shim | Generic sensitive-file guard.                                                                                              |
| `src/hooks/checks/test-gate.ts`                   | extract-with-shim | Generic autonomous-mode test enforcement.                                                                                  |
| `src/hooks/checks/sync-common.ts`                 | extract-with-shim | Cross-sibling primitives (oneLine, appendLogWithRotation, diagnosePushFailure) — generalizable.                            |
| `src/hooks/checks/architecture-coverage.ts`       | extract-with-shim | Generic architecture-as-code coverage check.                                                                               |
| `src/hooks/checks/architecture-drift.ts`          | extract-with-shim | Generic architecture-as-code drift check.                                                                                  |
| `src/hooks/checks/architecture-orphans.ts`        | extract-with-shim | Generic architecture-as-code orphans check.                                                                                |
| `src/hooks/checks/channel-gc.ts`                  | extract-with-shim | Generic channel GC.                                                                                                        |
| `src/hooks/checks/active-channels-load.ts`        | extract-with-shim | Generic active-channels surface at SessionStart.                                                                           |
| `src/hooks/checks/session-collision-gate.ts`      | extract-with-shim | Generic peer-detection PreToolUse — sibling of new Phase 1 identity hook.                                                  |
| `src/hooks/checks/session-presence-register.ts`   | extract-with-shim | Generic SessionStart presence registration.                                                                                |
| `src/hooks/checks/session-presence-unregister.ts` | extract-with-shim | Generic Stop presence cleanup.                                                                                             |

### Hooks/checks — Nick-specific (KEEP)

| File                                                   | Decision         | Rationale                                                                                                                                        |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/hooks/checks/dotfiles-catchup.ts`                 | keep-in-dotfiles | Specific to dotfiles repo auto-sync.                                                                                                             |
| `src/hooks/checks/dotfiles-commit.ts`                  | keep-in-dotfiles | Specific to dotfiles repo auto-sync.                                                                                                             |
| `src/hooks/checks/dotfiles-common.ts`                  | keep-in-dotfiles | Specific to dotfiles repo (manualCommitInFlight is generalizable but cross-trio coupling makes extraction premature; tracked as ARCH-4 backlog). |
| `src/hooks/checks/dotfiles-sync.ts`                    | keep-in-dotfiles | Specific to dotfiles repo auto-sync.                                                                                                             |
| `src/hooks/checks/vault-catchup.ts`                    | keep-in-dotfiles | Specific to Obsidian vault.                                                                                                                      |
| `src/hooks/checks/vault-commit.ts`                     | keep-in-dotfiles | Specific to vault.                                                                                                                               |
| `src/hooks/checks/vault-common.ts`                     | keep-in-dotfiles | Specific to vault.                                                                                                                               |
| `src/hooks/checks/vault-sync.ts`                       | keep-in-dotfiles | Specific to vault.                                                                                                                               |
| `src/hooks/checks/wiki-inject.ts`                      | keep-in-dotfiles | Specific to vault wiki.                                                                                                                          |
| `src/hooks/checks/feedback-events-briefing.ts`         | keep-in-dotfiles | Nick's feedback-events tracking.                                                                                                                 |
| `src/hooks/checks/feedback-minimal-output-detector.ts` | keep-in-dotfiles | Nick's specific detector.                                                                                                                        |
| `src/hooks/checks/feedback-rule-reminder.ts`           | keep-in-dotfiles | Nick's specific reminder.                                                                                                                        |
| `src/hooks/checks/intent-banner.ts`                    | keep-in-dotfiles | Nick's intent system.                                                                                                                            |
| `src/hooks/checks/intent-gate.ts`                      | keep-in-dotfiles | Nick's intent system.                                                                                                                            |
| `src/hooks/checks/intent-parse.ts`                     | keep-in-dotfiles | Nick's intent system.                                                                                                                            |
| `src/hooks/checks/memory-index-sync.ts`                | keep-in-dotfiles | Hardcodes `-Users-nbruzzi/memory`. Plugin gets its own indexer (per KS-2).                                                                       |
| `src/hooks/checks/memory-integrity.ts`                 | keep-in-dotfiles | Tied to Nick's memory layout.                                                                                                                    |
| `src/hooks/checks/memory-scope-filter.ts`              | keep-in-dotfiles | Tied to Nick's memory layout (V2 redesign target).                                                                                               |
| `src/hooks/checks/observer-nominator.ts`               | keep-in-dotfiles | Nick's observer-AI candidate-surfacer.                                                                                                           |
| `src/hooks/checks/pending-threads-briefing.ts`         | keep-in-dotfiles | Nick's vault-specific briefing.                                                                                                                  |
| `src/hooks/checks/read-tracker.ts`                     | keep-in-dotfiles | Nick's read-tracking discipline.                                                                                                                 |
| `src/hooks/checks/run-affected-tests.ts`               | keep-in-dotfiles | Nick's test discipline.                                                                                                                          |
| `src/hooks/checks/session-log-guard.ts`                | keep-in-dotfiles | Nick's session-log-specific guard.                                                                                                               |
| `src/hooks/checks/session-summary.ts`                  | keep-in-dotfiles | Nick's session-summary discipline.                                                                                                               |
| `src/hooks/checks/session-telemetry-tracker.ts`        | keep-in-dotfiles | Nick's session-telemetry-tracker (writes to `~/.claude/sessions/`).                                                                              |
| `src/hooks/checks/backlog-nudge.ts`                    | keep-in-dotfiles | Nick's backlog (vault).                                                                                                                          |

### Other top-level src/

| File                         | Decision         | Rationale                                         |
| ---------------------------- | ---------------- | ------------------------------------------------- |
| `src/agent-loop.ts`          | keep-in-dotfiles | Nick's agent loop wrapper.                        |
| `src/jobs/upstream-check.ts` | keep-in-dotfiles | Sentinel weekly research brief — Nick's only.     |
| `src/hindsight/*` (7 files)  | keep-in-dotfiles | Separate hindsight-review tool, not coordination. |

### Tests

| Path             | Decision                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `src/__tests__/` | mixed — bundled tests follow their source file's decision; Nick-specific tests stay in dotfiles. |

Specific test file decisions tracked at sub-step 0.6 (file extraction) execution time, derived from the per-source decisions above.

## Per-skill decisions — `~/.claude/skills/`

| Skill                             | Decision           | Rationale                                                                             |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `audit/SKILL.md` + `references/`  | bundle-into-plugin | The audit skill is the unique value prop — multi-persona audit + Step 1.5 + Step 5b'. |
| `commit-push-pr/`                 | bundle-into-plugin | Generic commit-push-PR workflow.                                                      |
| `session/handoff/SKILL.md`        | bundle-into-plugin | Handoff system that survives Agent Teams `/resume` limitation — load-bearing.         |
| `session/handoff-resume/SKILL.md` | bundle-into-plugin | Same.                                                                                 |
| `session/channel/SKILL.md`        | bundle-into-plugin | Channel CLI surface.                                                                  |
| `session/presence/SKILL.md`       | bundle-into-plugin | Presence CLI surface.                                                                 |
| `firecrawl-*` (16 variants)       | not-applicable     | Web scraping suite — out of plugin scope entirely.                                    |
| `graphify/`                       | not-applicable     | Knowledge-graph tool — out of scope.                                                  |

Plus skill files actually live at `~/.claude-dotfiles/skills/` (FROM_DIRS, not symlinks per install.sh) — same decisions; extraction copies the canonical from dotfiles.

## Per-agent decisions — `~/.claude/agents/`

| Agent                               | Decision           | Rationale                                                                               |
| ----------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `audit/` (registry + cold/familiar) | bundle-into-plugin | Auditor registry + 17 cold + 5 familiar definitions — load-bearing for the audit skill. |
| `code-simplifier.md`                | bundle-into-plugin | Generic agent; useful in plugin.                                                        |
| `verify-app.md`                     | bundle-into-plugin | Generic agent; useful in plugin.                                                        |

Familiar auditors that reference Nick-specific context-sources need `context_sources` frontmatter rewrite during extraction (per KS-1 anonymization discipline).

## Substrate path decisions — `~/.claude/`

| Path                                        | Decision       | Rationale                                                                          |
| ------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `~/.claude/active-sessions/`                | runtime-path   | Plugin reads/writes here at runtime; not extracted — runtime substrate.            |
| `~/.claude/channels/`                       | runtime-path   | Same.                                                                              |
| `~/.claude/todos/`                          | runtime-path   | Same.                                                                              |
| `~/.claude/handoffs/`                       | runtime-path   | Plugin's handoff system reads/writes; not extracted.                               |
| `~/.claude/projects/-Users-nbruzzi/memory/` | not-applicable | Nick-specific memory pool. Plugin manages its own under `<plugin-root>/memories/`. |
| `~/.claude/plans/`                          | runtime-path   | Plan-mode artifacts; runtime substrate.                                            |
| `~/.claude/sessions/`                       | runtime-path   | Session telemetry; runtime substrate.                                              |

## Cross-component import edges

The bundled subset has these explicit cross-edges (mapped via grep on `import.*from "../"`):

| From                                         | To                                    | Edge type | Resolution                                                                                     |
| -------------------------------------------- | ------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `src/channels/index.ts`                      | `src/hooks/session-id.ts`             | direct    | Both extract-with-shim; plugin owns both. Resolved cleanly.                                    |
| `src/active-sessions/index.ts`               | `src/shared/presence-failure-log.ts`  | direct    | Both extract-with-shim; plugin owns both. Resolved cleanly.                                    |
| `src/hooks/checks/session-collision-gate.ts` | `src/active-sessions/index.ts`        | direct    | Both extract-with-shim; resolved.                                                              |
| `src/hooks/checks/dotfiles-commit.ts`        | `src/active-sessions/index.ts`        | direct    | dotfiles-commit stays; active-sessions extracts. **Dotfiles re-imports from plugin via shim.** |
| `src/hooks/checks/dotfiles-commit.ts`        | `src/hooks/session-id.ts`             | direct    | Same shape — dotfiles re-imports from plugin via shim.                                         |
| `src/hooks/checks/dotfiles-commit.ts`        | `src/hooks/checks/sync-common.ts`     | direct    | Both pulled by extraction; sync-common is extract-with-shim; resolved.                         |
| `src/hooks/checks/vault-commit.ts`           | `src/active-sessions/index.ts`        | direct    | Same as dotfiles-commit pattern.                                                               |
| `src/hooks/checks/vault-commit.ts`           | `src/hooks/checks/dotfiles-common.ts` | direct    | **ARCH-4 cross-trio dependency** — kept in dotfiles per backlog item; not generalized.         |

**No circular references** between plugin and dotfiles after extraction. Dotfiles becomes a downstream consumer of the plugin via shim re-exports for the extract-with-shim files.

## Shim pattern

For each `extract-with-shim` file at path `src/<module>/<file>.ts` in dotfiles:

1. Plugin owns the canonical at `<plugin-root>/src/<module>/<file>.ts` (with generic-paths refactor + SPDX header).
2. Dotfiles' `claude-conductor-extraction` feature branch replaces the original with:

   ```ts
   // SPDX-License-Identifier: Apache-2.0
   // Re-export from claude-conductor plugin.
   export * from "claude-conductor/<module>/<file>";
   ```

3. Dotfiles' `package.json` declares `"claude-conductor": "file:../claude-conductor"` as a dev dependency (or symlink-based local install) on the feature branch.

When/if claude-conductor goes public (Phase 4), the dotfiles shim path becomes `"claude-conductor": "<published-version>"`.

## Audit checklist (mini-Architecture audit gate)

Before file extraction (sub-step 0.6) begins, the manifest gets a single-persona Architecture audit. The auditor verifies:

- [ ] All cross-component import edges enumerated.
- [ ] No circular references introduced by the bundle/keep/shim split.
- [ ] Extract-with-shim subset's import graph closes within itself (no edges out to keep-in-dotfiles files except via shim).
- [ ] Generic-paths refactor scope is correct (every bundled file gets the per-component env-var precedence pattern per ARCH-1).
- [ ] Shim pattern doesn't create silent breakage on dotfiles' 1102-test suite.
- [ ] Test files follow source files (no orphan tests).
- [ ] Skill bundle contents match the parent plan's Layer 1 spec.

## Open questions

- **Familiar auditors with Nick-specific `context_sources`:** the registry references vault paths and Nick's memory files. Anonymization rewrite during extraction (per KS-1) replaces with neutral references or removes context_sources for the bundled copies. Specific decisions tracked at sub-step 0.3.
- **`memory-index-sync.ts` plugin equivalent:** plugin needs its own indexer (per KS-2) not the dotfiles `-Users-nbruzzi`-hardcoded one. Sub-step 0.4 deliverable. Until then, plugin's MEMORY.md namespace is undefined.
- **Hooks/checks/architecture-\* extraction scope:** these are generic but currently read `architecture.yaml` from a specific path in dotfiles. Generic-paths refactor needs an env-var-resolved path. Decision: `$CLAUDE_CONDUCTOR_ARCHITECTURE_FILE` defaults to `<plugin-root>/architecture.yaml` (which doesn't exist yet — populated when plugin grows enough to warrant its own architecture graph; Phase 5+ likely).
