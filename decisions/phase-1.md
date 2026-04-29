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

## 2026-04-29 — Decision D: claimIdentity reconcile-on-rejoin closes sentinel/metadata torn-write window

```yaml
---
ts: 2026-04-29T03:50:00Z
kind: architectural
severity: minor
phase: 1
affects: [src/channels/identity.ts]
---
```

**Context:** Slice 2.1 closure verification round (RE-NEW-1) surfaced a torn-write window between `linkSync(tmp, sentinel)` and `commitIdentityClaim`. If a process dies between the two, the sentinel claims the letter but `metadata.identities` remains empty. Slice 5 verbs (`whoami`, `peers`, `read` rendering) read from `metadata.identities` and would see `{}` for that letter indefinitely until the Phase 2 GC reaper runs.

**Options considered:**

- (a) **Wait for Phase 2 GC reaper** — accept the window; Phase 2 hook reconciles. Pros: no Phase 1 work. Cons: Slice 5 verbs see stale data until Phase 2 ships, possibly weeks/months.
- (b) **Reconcile in `findExistingClaim` positive branch** — when a session re-joins and finds its sentinel, idempotently re-commit `metadata.identities[letter] = claim` before returning. Best-effort (failures logged via `appendPresenceFailure`, don't block the rejoin path). Pros: ~10 LOC, closes the window, idempotent. Cons: every rejoin pays one metadata write.
- (c) **Fall back to scanning sentinels in Slice 5 verbs** — when `whoami`/`peers`/`read` see `metadata.identities[letter] === undefined`, scan the sentinel directory directly. Pros: no eager write. Cons: every read pays a `readdirSync` + N file reads; Slice 5 verbs become more complex.

**Chosen:** (b) — reconcile-on-rejoin in `findExistingClaim`'s positive branch.

**Reason:** (a) leaves a stale-data window through Slice 5/6/7/8 — operator-visible failure in the headline `whoami` happy path. (c) makes every read pay for every claim's reconciliation hazard, which inverts the cost. (b) pays the reconciliation cost ONCE per session per channel, and only on the rejoin path; the happy initial-claim path is unchanged. Idempotency is provided by `commitIdentityClaim` (re-writing the same claim is a no-op). Failures don't block the rejoin (logged + continued) — same fail-soft discipline as the rest of the channels module.

**Supersedes:** None.

---

## 2026-04-29 — Decision E: commitIdentityClaim public-surface boundary validation

```yaml
---
ts: 2026-04-29T03:55:00Z
kind: api-shape
severity: minor
phase: 1
affects: [src/channels/index.ts]
---
```

**Context:** Slice 2.1 closure verification round (RE-NEW-2) surfaced that `commitIdentityClaim` is exported from `./channels` (and therefore reachable via the package's public surface) but had no `isValidArtifactId` boundary gate. `claimIdentity` validates upstream, but a direct caller (e.g., a Phase 2 hook reconciling stale claims) would bypass the gate. Decision Q4 explicitly enables direct primitive import for Phase 2 hooks.

**Options considered:**

- (a) **Mark internal-only** — remove from exports; only `claimIdentity` calls it. Pros: single boundary. Cons: Phase 2 GC reaper hooks need to call it directly to fix orphans.
- (b) **Add `isValidArtifactId` boundary gate** — defense-in-depth at the function entry. Pros: every caller protected; sibling-parity with `claimIdentity`'s own gate. Cons: ~3 LOC duplication.

**Chosen:** (b) — add boundary gate.

**Reason:** Sibling-parity discipline says every public-surface entry that takes path-shaped input gets validated. `claimIdentity` already follows this (Slice 2.1 closure RE-W1-2 fix); `commitIdentityClaim` should match. Phase 2 hook reconcilers will benefit. The 3 LOC are justified by the security posture.

**Supersedes:** None.

---

## Pending decisions (Phase 1 audit cycle)

- **Async signature cascade across cross-edge consumers** — `claimIdentity` is now `async` (Slice 2.1 closure). Slice 3a must thread the `Promise<...>` return type through any `api.ts` re-export; Slice 3b shim must `await` `claimIdentity` rather than treating it sync. Forward-reference for Lane D execution.
- **`commitIdentityClaim` non-re-export rationale** — when Slice 3a widens `api.ts`, add a one-line comment noting that `commitIdentityClaim` is intentionally NOT re-exported via the curated public surface (it's an internal-flow primitive of `claimIdentity` that only Phase 2 GC hooks would call directly, and those import from `./channels` directly per Decision Q4). Per ARCH-NEW-2 closure verification.
