<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision Log — Phase 1

Per-entry schema (same as `phase-0.md`):

```yaml
---
ts: <ISO-8601>
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: 1
affects: [list of components]
---
```

Followed by:

- **Context:** what was being decided
- **Options considered:** list with brief pros/cons
- **Chosen:** the decision
- **Reason:** why this option won
- **Supersedes / superseded_by:** cross-link if relevant

---

## 2026-04-29 — Decision A: MCP Agent Mail integration shape

```yaml
---
ts: 2026-04-29T03:30:00Z
kind: scope
severity: minor
phase: 1
affects: [src/channels, decisions]
---
```

**Context:** Parent plan §170 (`disciplined-multi-agent-coordination-plugin.md`) deferred the MCP Agent Mail integration shape decision to Phase 1 audit when the channels-CLI surface is being touched. Phase 1 v2 plan §"Wave 0 dispatch" listed this as a required output of the Wave 0 audit.

**Options considered:**

- (a) **Optional dependency** — depend on `@anthropic/mcp-agent-mail` (or equivalent) at the plugin level. Pros: native integration, zero-config for users with Mail set up. Cons: hard runtime coupling; users without Mail face install pain; cross-plugin compat surface widens.
- (b) **Separate plugin** — ship `claude-conductor-agent-mail` as a sibling plugin that bridges `channels` ↔ Mail. Pros: clean separation; users opt in; no hard-couple. Cons: duplicate scaffolding; coordination problems between two plugins.
- (c) **No integration this phase** — defer entirely; channels remain self-contained. Pros: smallest surface; Phase 1 ships the convention layer without speculative features. Cons: leaves the parent plan's open question still open.

**Chosen:** (c) — defer. Phase 1 ships the NATO+role convention layer; MCP Agent Mail integration is not a Phase 1 deliverable and not a Phase 2 deliverable per the reduced private scope (`project-claude-conductor.md`: "Phase 2 (Agent Teams integration hooks) + Phase 3 (handoff system surviving /resume) only").

**Reason:** No concrete consumer demand for Mail integration today; the channels substrate is already meeting the parallel-coordination need without it. (a) would couple the plugin to an external runtime users may not have. (b) is plausible but premature — wait for actual demand before splitting effort. The parent plan §170 said "decision deferred to Phase 1 audit when channels-CLI surface is being touched"; the Phase 1 audit cycle has now happened and the answer is "not yet." Re-open at Phase 2 hooks layer if Agent Teams integration surfaces a Mail crossover need.

**Supersedes:** None.

---

## 2026-04-29 — Decision B: claimIdentity commit-after-claim ordering — sentinel canonical, metadata.identities materialized cache

```yaml
---
ts: 2026-04-29T03:35:00Z
kind: architectural
severity: critical
phase: 1
affects: [src/channels/identity.ts, src/channels/index.ts]
---
```

**Context:** Phase 1 v2 plan §122 specified that `claimIdentity` writes the per-letter sentinel file (atomic via `linkSync` create-only) AND commits the claim into `metadata.identities` so downstream verbs (`whoami`, `set-role`, `peers`, `read` rendering) can read from the materialized cache. Slice 2 implemented only the sentinel write; Wave 1 ARCH-1 surfaced the gap.

**Options considered:**

- (a) **Single source of truth: sentinels only** — drop `metadata.identities` entirely; downstream verbs scan the `identities/` directory on every read. Pros: no consistency concern. Cons: `O(N)` scan per `whoami` call; metadata.json becomes incomplete; existing schema work in Slice 1 wasted.
- (b) **Single source of truth: metadata.identities only** — drop sentinels; rely on `withMetadataLock` for race-free claim. Pros: simpler schema. Cons: lock-steal-after-30s window allows concurrent renames to clobber claims (Wave 0 ARCH-CRIT-3 finding); no atomic create-only primitive.
- (c) **Sentinel canonical + metadata cache (commit-after-claim)** — `linkSync(tmp, sentinel)` is the atomic decision point; on success, `withMetadataLock` materializes the claim into `metadata.identities`. Pros: race-free decision via POSIX EEXIST + fast read via metadata cache. Cons: dual-write needs reconciliation logic if metadata commit fails after sentinel succeeds.

**Chosen:** (c) — sentinel canonical, metadata.identities materialized cache.

**Reason:** Plan v2 §D2 + §122 explicitly chose this design. (a) loses the schema work; (b) doesn't survive lock-steal as Wave 0 ARCH-CRIT-3 surfaced. (c) is the dual-write pattern with sibling-parity precedent — `active-sessions/index.ts:writeMetaIfMissing` is the same model. Reconciliation: if metadata commit fails after sentinel succeeds, the next `claimIdentity` call's `findExistingClaim` scan finds the orphan sentinel and idempotently re-commits via Phase 2 GC (deferred). For now the failure is loud (write error propagates to caller); Phase 2 hook adds the reaper. Slice 2.1 closure ships the missing commit step.

**Supersedes:** None (this is the Slice 2 design's intended completion, not a course-change).

---

## 2026-04-29 — Decision C: top-level dispatcher scope — `channels` + `todos` only this phase, `presence` deferred

```yaml
---
ts: 2026-04-29T03:40:00Z
kind: scope
severity: minor
phase: 1
affects: [src/cli/dispatcher.ts, bin/claude-conductor]
---
```

**Context:** Phase 1 v2 plan Slice 0 ships the top-level `claude-conductor` binary. Plan §92 mentioned routing `presence <verb>` to active-sessions CLI as a possible subcommand. Slice 0 (Bravo's `phase-1-lane-b-binary` @ `29c102c`) shipped routing for `channels` + `todos` only; `presence` was silently deferred. Wave 1 ARCH-3 surfaced the unrecorded scope narrowing.

**Options considered:**

- (a) **Add `presence` routing in Slice 0 follow-up** — port active-sessions CLI to plugin; wire dispatcher route. Pros: matches plan §92 verbatim. Cons: active-sessions has not been shimmed to plugin yet (task #4/#5 backlog) — would require lifting `src/active-sessions/` into the plugin first; outside Phase 1 scope.
- (b) **Defer `presence` routing to Phase 2** — when active-sessions module is shimmed (task #5 follow-up) AND Phase 2 hooks layer needs it, add the dispatcher route at that time. Pros: scope-bounded; matches the reduced private-scope arc (Phase 2 = Agent Teams integration hooks). Cons: dispatcher's `--help` lists only 2 of 3 expected subcommands during Phase 1.

**Chosen:** (b) — defer.

**Reason:** active-sessions canonical lives in dotfiles (per task #4/#5 batch-5 deferral); shimming to plugin requires its own multi-persona audit cycle (per `feedback-cross-edge-module-state-audit.md`) which is out of Phase 1 scope. Adding a stub `presence` route that errors with "not yet implemented" would be operator-confusing without delivering value. Dispatcher `--help` text already includes "presence" with a "deferred to Phase 2" note (truth-in-advertising per Slice 0 design). Reopen at Phase 2 hooks layer when active-sessions shimming is the natural sibling work.

**Supersedes:** None.

---

## Pending decisions (Phase 1 audit cycle)

- None at this time. Wave 0 + Wave 1 audits both complete; Slice 2.1 closure addresses critical findings inline. Wave 2 (post-Slice-6, before Slice 8 tag) may surface additional decisions.
