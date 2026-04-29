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

## 2026-04-29 — Decision F: `releaseIdentity` ordering — metadata write first, sentinel unlink second

```yaml
---
ts: 2026-04-29T16:50:00Z
kind: architectural
severity: minor
phase: 1
affects: [src/channels/identity.ts]
---
```

**Context:** Slice 5 RE-6 surfaced an ordering question for `releaseIdentity` (called by `close-peer` and `set-role` recovery paths). Two writes needed: remove the entry from `metadata.identities` AND unlink the per-letter sentinel file. Either order leaves a different recovery state if the second write fails.

**Options considered:**

- (a) **Sentinel first, metadata second** — unlink sentinel, then remove `metadata.identities[letter]`. Pros: matches "sentinel canonical" framing of Decision B. Cons: if metadata write fails, sentinel is gone but metadata still claims the letter — `claimIdentity` will refuse (sentinel-EEXIST is the gate, but here sentinel is gone so EEXIST is FALSE and the next claim succeeds with a NEW write — but the old metadata entry remains pointing at a stale claim, potentially confusing `whoami`/`peers` for the duration).
- (b) **Metadata first, sentinel second** — remove `metadata.identities[letter]`, then unlink sentinel. On metadata-write failure, abort without unlinking — the claim is still observable in metadata, the sentinel still claims the letter. Operator retries. On sentinel-unlink failure (EACCES, etc.), metadata is consistent but the sentinel is orphaned — Phase 2 GC reaper reconciles. Pros: failure during the window leaves an internally-consistent state (sentinel + metadata both still claim the letter); operator-visible recovery is "retry close-peer". Cons: orphan sentinels accumulate if unlink keeps failing.

**Chosen:** (b) — metadata first, sentinel second.

**Reason:** Internal consistency under partial failure beats sentinel-canonical purity. (a) creates a window where `claimIdentity` from a different session can grab the freshly-vacated letter before the metadata write completes — operator-visible "two sessions claim the same NATO letter" race. (b)'s orphan-sentinel failure mode is a Phase 2 GC concern (already deferred); the immediate window is internally consistent and operator-visible recovery is "retry close-peer". `releaseIdentity`'s implementation in `identity.ts` enforces this via try/catch around the metadata write — on failure, abort without unlinking; on success, attempt the unlink and tolerate failure (logged via `unlinkIdentitySentinelOrLogOrphan`).

**Supersedes:** None.

---

## 2026-04-29 — Decision G: Slice 6 `appendMessage` auto-attaches `identity` + `role` from `metadata.identities`

```yaml
---
ts: 2026-04-29T16:55:00Z
kind: architectural
severity: minor
phase: 1
affects: [src/channels/index.ts, src/channels/cli.ts]
---
```

**Context:** Slice 6 needed `send` to attach the sender's NATO `identity` + `role` to outgoing `ChannelMessage` records so `read`'s renderMessage can display the canonical `<Identity> (<role>): <body>` line per parent plan §311-321. Two implementation locations were considered.

**Options considered:**

- (a) **CLI-layer attach** — `cli.ts` send case reads `metadata.identities[<self>]`, attaches identity + role to the message, then calls `appendMessage`. Pros: keeps `appendMessage` ignorant of identity semantics. Cons: every caller of `appendMessage` (including future Phase 2 hooks) has to remember to attach; legacy callers that don't attach produce un-attributed messages.
- (b) **Library-layer auto-attach** — `appendMessage` in `index.ts` reads `metadata.identities` for the calling session and auto-attaches identity + role if found. Pros: single attribution path; legacy callers automatically benefit; the `<unknown>: <body>` rendering only fires for genuinely-unclaimed sessions. Cons: `appendMessage` reads metadata outside the message-write lock (RE-W2-1 in Wave 2 — TOCTOU on concurrent `set-role`/`close-peer`).

**Chosen:** (b) — library-layer auto-attach in `appendMessage`.

**Reason:** Single attribution path eliminates a class of "forgot to attach" bugs at every Phase 2 hook author's surface. The TOCTOU concern (Wave 2 RE-W2-1) is real but bounded — wrong-attribution under concurrent role-flip is a forensic-confusion failure, not a correctness/security failure. Closing the window requires wrapping `appendMessage` in `withMetadataLock`, which cascades: every caller becomes async-from-async (already true in Phase 1), but the per-message metadata-read+lock+write triples message-append cost. Phase 2 hook layer can revisit if the TOCTOU window matters more than throughput. Legacy reader path (`<unknown>: <body>` rendering) is preserved as the fallback for messages with no `identity` field — backwards-compat with Phase 0 channels.

**Supersedes:** None.

---

## 2026-04-29 — Decision H: Slice 3b dotfiles shim — identity primitives NOT re-exported

```yaml
---
ts: 2026-04-29T17:00:00Z
kind: api-shape
severity: minor
phase: 1
affects: [dotfiles src/channels/index.ts, plugin src/channels/api.ts]
---
```

**Context:** Slice 3b converted dotfiles `src/channels/{index,cli}.ts` to re-export shims pointing at `claude-conductor/channels/{api,cli}`. The dotfiles shim re-exports the curated channels surface (CRUD + heartbeat + read/write/list) but NOT the identity primitives (`claimIdentity`, `setRole`, `releaseIdentity`, `getIdentityForSession`). Surface-curation rationale needed durable record.

**Options considered:**

- (a) **Re-export identity primitives via shim** — make every plugin identity primitive reachable from `claude-conductor` (dotfiles shim) and `claude-conductor/channels/identity` (direct). Pros: one path to find them. Cons: doubles the shim surface; widens dotfiles' nominal export surface beyond its pre-shim shape (which never exposed identity primitives because they didn't exist).
- (b) **Identity primitives via `claude-conductor/channels/identity` direct only** — dotfiles shim does not re-export them. Phase 2 hook consumers import from `claude-conductor/channels/identity` directly. Pros: narrow shim; clear separation between "channels-CRUD canonical surface" (shim re-exports) and "Phase 2 hook integration surface" (direct imports). Cons: requires consumers to know which path to use.

**Chosen:** (b) — direct-only.

**Reason:** Pre-shim dotfiles never exposed identity primitives (Phase 0 channels had no identity layer at all). Re-exporting them via the shim would silently widen the dotfiles surface beyond its historical shape and create two paths to find the same primitives — the kind of surface drift that costs more in Phase 2/3 audit clarity than it saves in convenience. Phase 2 hook consumers are a small audience who can be told "import from `claude-conductor/channels/identity` directly". The shim's JSDoc carries the policy + recovery hint per `feedback-direct-and-advise.md`.

**Supersedes:** None.

---

## Pending decisions (Phase 1 audit cycle)

All Phase 1 pending decisions have been resolved:

- **Async signature cascade across cross-edge consumers** — RESOLVED in Slice 3a: `api.ts` re-exports thread `Promise<...>` types correctly; Slice 3b shim awaits all async primitives. Verified at Slice 3a step 2 (a6b8249) + Slice 3b atomic flip (e1d1ca4).
- **`commitIdentityClaim` non-re-export rationale** — RESOLVED in Slice 8 ARCH-W2-6 closure: api.ts now carries the surface-curation policy comment listing all 8 intentionally-not-re-exported names with the rationale.
