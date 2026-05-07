<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Extraction Manifest

**Phase 0 sub-step 0.2 deliverable.** Enumerates every file in `nbruzzi/claude-dotfiles` (and adjacent canonical paths in `~/.claude/`) with a per-file decision: `bundle-into-plugin` / `keep-in-dotfiles` / `extract-with-shim` / `not-applicable`. Cross-component import edges enumerated for the bundled subset.

**Audit gate:** mini-Architecture audit on this manifest (single persona) before sub-step 0.6 (file extraction) begins. Findings integrated; no circular references between plugin and dotfiles. Approved before Phase 1.

**Status:** AUDITED 2026-04-25 (mini-Architecture audit + verification round; 6/6 findings addressed; score 9.0/10; ship verdict). Audit transcripts at `audits/phase-0/architecture-r1.md` + `audits/phase-0/architecture-r2-verification.md` (filed at sub-step 0.10 audit-transcript-durability deliverable).

**Sub-step 0.6 progress:**

- Batch 3a (active-sessions + channels + todos primitives) — landed.
- Batch 3b (dispatcher refactor) — landed at dotfiles `fec3849`.
- Batch 3c (cross-repo file:-link substrate) — landed at dotfiles `543803d` + plugin `d52399c`.
- Batch 4 (25-file plugin staging) — landed at plugin `588b922`.
- Batch 4b (atomic 8-file dotfiles flip — registry + 4 helpers shimmed) — landed at dotfiles `8ea7686` + plugin `67c5e02`. 7-day soak verification scheduled 2026-05-04.
- Batch 6 — LANDED. 2 skills (audit, commit-push-pr) + 4 session commands + first plugin.json manifest, plus dotfiles install.sh rewire and dotfiles-sync resolver fix.
- Batch 5 — LANDED partial (17 of 19 hooks/checks shimmed; 3 deferred: session-collision-gate, session-presence-register, bundled-registrations — pending active-sessions extraction).
- Batch 7a — LANDED. 18 cross-session feedback memories extracted to `memories/` with anonymization rewrites per `memories-to-bundle.md`. Resolves cross-reference graph dependency for batch 7b familiar auditor `context_sources.memory` blocks.
- **Batch 7b (this commit) — 21 agents** extracted to `agents/` per `agents-to-bundle.md`. 13 cold + 2 generic bundle as-is; 4 familiar auditors anonymized; 1 (`domain-business`) dropped; NEW `familiar/_template.md` ships unregistered. Plugin Step 1 done; dotfiles flip (Step 2 — install.sh DIRS rewire + dotfiles-sync resolver agents/\* skip + primitive-lift refactor) lands separately.

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

| File                                                        | Decision                                                  | Rationale                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.claude-dotfiles/src/hooks/checks/auto-format.ts`        | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `~/.claude-dotfiles/src/hooks/checks/branch-enforcement.ts` | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1. (Cluster 3 of INVERSIONS arc 2026-05-07 reverted the temporary cross-edge import to `./fact-force.ts` local-relative when fact-force itself moved substrate-canonical.) |
| `src/hooks/checks/config-protection.ts`                     | extract-with-shim                                         | Generic config-protection. **NEEDS ENHANCEMENT** in plugin (approval-aware mechanism per Phase 0 substrate-gap follow-up).                                                                                                               |
| `~/.claude-dotfiles/src/hooks/checks/destructive-cmd.ts`    | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `src/hooks/checks/handoff-latest-guard.ts`                  | extract-with-shim                                         | Generic LATEST-symlink protection.                                                                                                                                                                                                       |
| `src/hooks/checks/handoff-symlink-write-guard.ts`           | extract-with-shim                                         | Generic handoff-symlink write-through protection.                                                                                                                                                                                        |
| `~/.claude-dotfiles/src/hooks/checks/no-any.ts`             | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `~/.claude-dotfiles/src/hooks/checks/no-enum.ts`            | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `~/.claude-dotfiles/src/hooks/checks/pre-commit.ts`         | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `~/.claude-dotfiles/src/hooks/checks/prefer-bun.ts`         | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `~/.claude-dotfiles/src/hooks/checks/sensitive-files.ts`    | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `~/.claude-dotfiles/src/hooks/checks/test-gate.ts`          | substrate-canonical (Cluster 1 INVERSIONS arc 2026-05-07) | Universal coding-discipline; substrate-canonical post-Cluster-1.                                                                                                                                                                         |
| `src/hooks/checks/sync-common.ts`                           | extract-with-shim                                         | Cross-sibling primitives (oneLine, appendLogWithRotation, diagnosePushFailure) — generalizable.                                                                                                                                          |
| `src/hooks/checks/architecture-coverage.ts`                 | keep-in-dotfiles                                          | Per ARCH-2 audit finding: reads dotfiles' `architecture.yaml`; bundling creates a silent-no-op trap when default resolves to non-existent plugin file. Extract engine only when plugin grows its own architecture graph (Phase 5+).      |
| `src/hooks/checks/architecture-drift.ts`                    | keep-in-dotfiles                                          | Same — reads dotfiles' yaml.                                                                                                                                                                                                             |
| `src/hooks/checks/architecture-orphans.ts`                  | keep-in-dotfiles                                          | Same — reads dotfiles' yaml.                                                                                                                                                                                                             |
| `src/hooks/checks/channel-gc.ts`                            | extract-with-shim                                         | Generic channel GC.                                                                                                                                                                                                                      |
| `src/hooks/checks/active-channels-load.ts`                  | extract-with-shim                                         | Generic active-channels surface at SessionStart.                                                                                                                                                                                         |
| `src/hooks/checks/session-collision-gate.ts`                | extract-with-shim                                         | Generic peer-detection PreToolUse — sibling of new Phase 1 identity hook.                                                                                                                                                                |
| `src/hooks/checks/session-presence-register.ts`             | extract-with-shim                                         | Generic SessionStart presence registration.                                                                                                                                                                                              |
| `src/hooks/checks/session-presence-unregister.ts`           | extract-with-shim                                         | Generic Stop presence cleanup.                                                                                                                                                                                                           |

### Hooks/checks — CI verification protocol (substrate-canonical Cluster 2 INVERSIONS arc 2026-05-07)

| File                                                                  | Decision                                                  | Rationale                                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.claude-dotfiles/src/hooks/checks/ci-verification-auth-warn.ts`    | substrate-canonical (Cluster 2 INVERSIONS arc 2026-05-07) | TIER-3a CI verification protocol; single-session gh-auth advisory at session-start. Substrate-canonical post-Cluster-2.                  |
| `~/.claude-dotfiles/src/hooks/checks/ci-verification-gate.ts`         | substrate-canonical (Cluster 2 INVERSIONS arc 2026-05-07) | TIER-2 CI verification protocol; block on shipped/merged claims without CI evidence. Substrate-canonical post-Cluster-2.                 |
| `~/.claude-dotfiles/src/hooks/checks/ci-verification-pre-push-arm.ts` | substrate-canonical (Cluster 2 INVERSIONS arc 2026-05-07) | TIER-4 CI verification protocol; sentinel writer for git push, per-session push tracking. Substrate-canonical post-Cluster-2.            |
| `~/.claude-dotfiles/src/hooks/checks/ci-verification-reminder.ts`     | substrate-canonical (Cluster 2 INVERSIONS arc 2026-05-07) | TIER-1 CI verification protocol; reminder after git push, advisory message in this session's stderr. Substrate-canonical post-Cluster-2. |

### Hooks/checks — fact-force gate (substrate-canonical Cluster 3 INVERSIONS arc 2026-05-07)

| File                                                            | Decision                                                  | Rationale                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `~/.claude-dotfiles/src/hooks/checks/fact-force.ts`             | substrate-canonical (Cluster 3 INVERSIONS arc 2026-05-07) | Read-before-write fact-forcing gate; within-session state per session_id (HOME-derived path). Substrate-canonical post-Cluster-3. |
| `~/.claude-dotfiles/src/hooks/checks/fact-force-scope-cli.ts`   | substrate-canonical (Cluster 3 INVERSIONS arc 2026-05-07) | CLI for fact-force scope-approval markers; executable via `/fact-force-scope` slash command. Substrate-canonical post-Cluster-3.  |
| `~/.claude-dotfiles/src/hooks/checks/fact-force-scope-store.ts` | substrate-canonical (Cluster 3 INVERSIONS arc 2026-05-07) | Scope-approval marker storage primitives consumed by fact-force.ts + fact-force-scope-cli.ts. Substrate-canonical post-Cluster-3. |

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

**Full enumeration:** `grep -rEn 'from "\.\./' nbruzzi/claude-dotfiles/src --include="*.ts" | grep -v test` returns **191 edges** across the substrate. The vast majority are mundane: `checks/*.ts` files importing types/helpers from `hooks/types.ts`, `hooks/lock.ts`, `hooks/session-id.ts`, `hooks/checks/sync-common.ts`. Those resolve cleanly because the importer and importee carry the same decision (extract-with-shim → extract-with-shim, or keep-in-dotfiles → extract-with-shim via re-export shim).

**Per ARCH-5 audit finding:** the 8 edges originally listed below are spot-checks, NOT a full enumeration. The full grep enumeration runs at sub-step 0.6 entry as a checklist — every edge categorized (mundane shim-resolved / non-obvious / blocked-by-cycle), and the manifest appendix below grows with the categorized output before extraction begins.

### Cross-decision edges (the load-bearing subset)

The non-obvious edges — where the importer and importee carry different decisions, or where extraction creates a new constraint — are:

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

**Additional non-obvious edge surfaced by the full grep:** `src/hooks/session-id.ts` imports `isValidSessionId` from `src/active-sessions/index.ts` — both extract-with-shim, but this means the channels module's transitive dependency on `active-sessions/index.ts` is two hops (channels → session-id → active-sessions). Resolves cleanly within the extract-with-shim subset. No cycle.

## Dual-registry contract (per ARCH-1 audit finding)

The audit caught that `hooks/registry.ts` "specific check registrations stay in plugin OR dotfiles" was hand-waving. Resolved:

**Plugin owns the `RegistryBuilder` / `SealedRegistry` types** plus a `registerBundled` sibling module covering the discipline-as-code surface (auto-format, branch-enforcement, config-protection, destructive-cmd, fact-force, handoff guards, no-any, no-enum, pre-commit, prefer-bun, sensitive-files, test-gate, sync-common-derived helpers, channel-gc, active-channels-load, session-collision-gate, presence register/unregister). The constructor is import-free; bundled registrations live in their own `bundled-registrations.ts` so `registry.ts` is a single-file move in batch 4 (per the ARCH-2 audit finding).

**Dotfiles' bootstrap** (`src/hooks/dispatcher.ts` on the `claude-conductor-extraction` feature branch — current sub-step 0.6 batch 3b state) calls all 9 register modules. Post-batch-4, `registerBundled` and `RegistryBuilder` move to the plugin and the plugin's dispatcher owns the `registerBundled` call; this dotfiles dispatcher drops to 8 register modules.

```ts
import { RegistryBuilder } from "./registry.ts"; // → "claude-conductor/hooks/registry" post-batch-4
import { assertWiringComplete } from "./registry-assertion.ts";
import { registerBundled } from "./checks/bundled-registrations.ts"; // moves to plugin in batch 4
import { registerVaultTrio } from "./checks/vault-trio-registrations.ts";
import { registerDotfilesTrio } from "./checks/dotfiles-trio-registrations.ts";
import { registerIntent } from "./checks/intent-registrations.ts";
import { registerMemorySystem } from "./checks/memory-system-registrations.ts";
import { registerFeedback } from "./checks/feedback-registrations.ts";
import { registerArchitecture } from "./checks/architecture-registrations.ts";
import { registerSessionDiscipline } from "./checks/session-discipline-registrations.ts"; // 8th sibling — covers stragglers (read-tracker, run-affected-tests, session-telemetry-tracker, session-log-guard, session-summary, observer-nominator, pending-threads-briefing, backlog-nudge) per ARCH-1/ARCH-6
import { registerHindsight } from "./checks/hindsight-registrations.ts";

const builder = new RegistryBuilder();
registerBundled(builder);
registerVaultTrio(builder);
registerDotfilesTrio(builder);
registerIntent(builder);
registerMemorySystem(builder);
registerFeedback(builder);
registerArchitecture(builder);
registerSessionDiscipline(builder);
registerHindsight(builder);
const registry = builder.seal();
assertWiringComplete(registry); // exits 2 if any blocking check is registered-but-unwired in ORDER, or any ORDER entry references an unregistered check
```

**Sub-step 0.6 verification:** every keep-in-dotfiles `checks/*.ts` is registered through one of the 8 dotfiles-side `*-registrations.ts` sibling modules (vault-trio, dotfiles-trio, intent, memory-system, feedback, architecture, session-discipline, hindsight). No silent-stop-firing of Nick's intent/vault/dotfiles/memory checks post-extraction. The bidirectional `assertWiringComplete` runs at boot and accumulates ALL errors before exiting, catching both registered-but-unwired and wired-but-unregistered drift in one pass.

## Shim symmetry checklist (per ARCH-3 audit finding)

The audit caught that the shim pattern doesn't enumerate per-file shim files left behind on the dotfiles side. Resolved: **every** extract-with-shim file MUST have a verified shim file at the original dotfiles path post-extraction.

Sub-step 0.6 maintains a checklist as files move:

```
[ ] src/active-sessions/index.ts → plugin: src/active-sessions/index.ts; dotfiles shim: src/active-sessions/index.ts re-exports from plugin ✓
[ ] src/active-sessions/cli.ts → plugin: ...; dotfiles shim: ... ✓
[ ] src/channels/index.ts → ... ✓
... (one row per extract-with-shim file, ~30+ rows)
[ ] src/shared/presence-failure-log.ts → ... ✓ (load-bearing — imported by both active-sessions and dotfiles-commit)
```

Verification: after sub-step 0.6 completes, run dotfiles' 1102-test suite. If any test fails with `Cannot find module 'claude-conductor/...'` or similar resolution error, the shim file is missing or malformed. Rollback per Phase rollback contract.

## Dotfiles-side `install.sh` + `dotfiles-sync.ts` allowlist deltas (per ARCH-6 audit finding)

The audit caught that the manifest didn't carry forward parent plan ARCH-5 deliverable. Resolved:

**`nbruzzi/claude-dotfiles/install.sh` updates** (on `claude-conductor-extraction` feature branch):

- DIRS array: every directory containing only extract-with-shim files becomes a stub re-export directory pointing at the plugin. Specifically: `src/active-sessions/` → all 3 files become re-export shims; `src/channels/` → same; `src/todos/` → same; `src/shared/` → same; `src/hooks/handlers/` → all 5 files; `src/hooks/lock.ts` `session-id.ts` `timing.ts` `types.ts` `input.ts` `run-checks.ts` `dispatcher.ts` `registry.ts` → all become re-export shims.
- `skills/audit/`, `skills/commit-push-pr/`, `skills/session/*` (handoff/handoff-resume/channel/presence) → moved to plugin; install.sh DIRS gets stubs OR removes the entries (decided at sub-step 0.9).
- `agents/audit/` → same.

**`nbruzzi/claude-dotfiles/src/hooks/checks/dotfiles-sync.ts` allowlist updates** (same feature branch):

- Allowlist patterns for the moved files updated so the auto-sync hook tracks the SHIM files (which are tiny re-export markers) rather than the originals (which no longer exist).
- Specifically: any pattern that matched `src/active-sessions/**/*.ts` previously now matches the shim paths only.

**Verification:** fresh-machine `git clone nbruzzi/claude-dotfiles && ./install.sh && bun test` on the `claude-conductor-extraction` feature branch should restore the post-extraction state and pass all 1102 tests. Sub-step 0.9 includes this smoke-run as a success criterion.

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

- **Familiar auditor `context_sources` anonymization (per ARCH-4 audit finding):** carved out as **sub-step 0.3b** (separate from sub-step 0.3 memory rewrite). Different deliverable file: `agents-to-bundle.md`. Different review criteria: agent frontmatter rewrite, removing or neutralizing references to vault paths, Nick's memory files, dotfiles-specific paths. The 5 familiar auditors (architecture-integration, code-standards, domain-business, knowledge-system, workflow-process) get individual frontmatter rewrites + canonical-context-source replacements.
- **`memory-index-sync.ts` plugin equivalent:** plugin needs its own indexer (per KS-2) not the dotfiles `-Users-nbruzzi`-hardcoded one. Sub-step 0.4 deliverable. Plugin's indexer scopes to `<plugin-root>/memories/` only and uses a namespaced prefix (`[claude-conductor]`) in surfacing. Coexistence with dotfiles' indexer on Nick's machine: both run; both write to MEMORY.md but with different prefixes. Collision test in sub-step 0.4.
- **Hooks/checks/architecture-\* extraction scope (resolved via ARCH-2 audit finding):** flipped to `keep-in-dotfiles`. Plugin extracts the engine (`src/architecture/engine.ts` for parsing + walk) only when plugin grows its own architecture graph (Phase 5+). Until then, dotfiles' architecture-as-code discipline stays whole.
- **Manifest enumeration completeness (per ARCH-5 audit finding):** the cross-component edges section above lists 8 spot-checks. Sub-step 0.6 entry runs the full grep enumeration over `nbruzzi/claude-dotfiles/src/`, categorizes the 191 total edges into mundane / non-obvious / blocked, and appends the categorized list as a new section before extraction begins.
