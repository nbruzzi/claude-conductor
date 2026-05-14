<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision Log — Phase 4

Per-entry schema (same as `phase-3.md`):

```yaml
---
ts: <ISO-8601>
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: 4
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

## 2026-05-01 — Decision A: retire `bundled-registrations` parity script

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: architectural
severity: major
phase: 4
affects:
  [
    scripts/check-bundled-registrations-parity.sh,
    package.json,
    .github/workflows/test.yml,
    test/hooks/exports-map-coverage.test.ts,
    dotfiles/src/__tests__/hooks/cross-edge-imports.test.ts,
    dotfiles/src/__tests__/hooks/check-names-superset.test.ts,
  ]
---
```

**Context:** with the dotfiles shim layer dropped (Phase 4) and bundled checks consumed cross-edge from plugin canonical, the existing `check-bundled-registrations-parity.sh` script — which compared dotfiles' bundled-registrations parallel block against plugin's — has nothing parallel to compare. Its invariants (#1-4) are now either obsolete (no parallel block) or migrated to other enforcement.

**Options considered:**

1. **Retire the script + replace via paired structural tests on each repo edge** (chosen) — plugin-side `exports-map-coverage.test.ts` asserts every `BUNDLED_CHECK_NAMES` entry has an exports-map entry; dotfiles-side `cross-edge-imports.test.ts` + `check-names-superset.test.ts` assert their half. Both run as normal tests, not a separate parity script.
2. Repurpose the script as a logical-block diff — marginal value; the parallel block doesn't exist anymore so what is being compared?
3. Keep with relaxed assertions — unclear what it would assert; degrades to a no-op.

**Chosen:** Option 1.

**Reason:** Imperative parity scripts live OUTSIDE the contract they enforce — they go stale, get bypassed, get retired without replacement. Tests live NEXT to the contract, run as part of normal test suites, cover BOTH sides because each side has its own test on its own surface. This pattern generalizes — see Decision H. Plugin retirement landed in Bravo Lane #6 PR #8 at `6b961bc`.

**Supersedes / superseded_by:** none.

---

## 2026-05-01 — Decision B: retain dotfiles `bundled-registrations.ts` as composition layer

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: architectural
severity: minor
phase: 4
affects:
  [
    dotfiles/src/hooks/checks/bundled-registrations.ts,
    dotfiles/src/hooks/dispatcher.ts,
  ]
---
```

**Context:** with all 25 bundled checks now imported cross-edge, does dotfiles still need `bundled-registrations.ts`, or could the dispatcher call plugin's `registerBundled` directly?

**Options considered:**

1. **Retain it as a thin dotfiles-side composition layer** (chosen) — it imports plugin canonicals + calls `RegistryBuilder.add` + applies any dotfiles-side wrap-when-needed (per Decision C). One indirection level, but a load-bearing one if dotfiles ever needs to inject observability/config around a plugin check.
2. Drop it entirely + dispatcher calls `claude-conductor/hooks/checks/bundled-registrations.registerBundled` — minimal. Cons: forecloses the wrap-when-needed seam without a clear trigger to reverse.

**Chosen:** Option 1, with an explicit **trigger for re-evaluation:** if Phase 5 lifts the B2 candidates (compound-bash-detector + run-affected-tests) AND `bundled-registrations.ts` adds zero local register() calls in the process, drop the file in Phase 6 and have dispatcher call plugin's `registerBundled` directly. Make the decision falsifiable.

**Reason:** dotfiles-side composition is cheap to keep (~10 LOC + JSDoc), and the wrap-when-needed seam (Decision C) lives THROUGH this layer. Premature drop forecloses that seam without a tested replacement. The trigger keeps it falsifiable — drop happens automatically when justified.

---

## 2026-05-01 — Decision C: wrap-when-needed pattern for dotfiles-side observability/config

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: api-shape
severity: minor
phase: 4
affects: [dotfiles/src/hooks/checks/]
---
```

**Context:** if a future scenario requires wrapping a plugin canonical check with dotfiles-side observability, config, kill-switch overlay, or rate-limiting — what's the playbook?

**Options considered:**

1. **Re-introduce a local file at `dotfiles/src/hooks/checks/<name>.ts` that imports from `claude-conductor/hooks/checks/<name>`, wraps the check, exports under the same name, and have `bundled-registrations.ts` import from local instead of cross-edge for that one name** (chosen) — minimal surface, no architectural foreclosure.
2. Add a wrap-mechanism to plugin's `registerBundled` (e.g., per-name middleware) — over-engineered for the rare case.
3. Wait for the scenario to arise and design then — reactive; risk of inventing under pressure when the problem is concrete.

**Chosen:** Option 1.

**Reason:** Cheap to add later (no architectural foreclosure); the playbook is canonized so it's not invented under pressure. The retained `bundled-registrations.ts` (Decision B) is the composition layer that makes per-name wrap a one-line edit.

---

## 2026-05-01 — Decision D: SPDX coverage via dotfiles umbrella LICENSE for deleted files

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: tooling
severity: minor
phase: 4
affects: [dotfiles/LICENSE, dotfiles/src/hooks/checks/]
---
```

**Context:** Phase 4 deletes 28 dotfiles shim files that carried per-file SPDX headers. Does this leave an attribution gap?

**Options considered:**

1. **Rely on dotfiles repo's umbrella `LICENSE` (Apache-2.0) to cover the dotfiles tree as a whole** (chosen) — per-file SPDX headers are not load-bearing for license clarity. Plugin canonical files (consumed via `node_modules/claude-conductor/...`) carry their own SPDX headers in their source-of-truth location.
2. Mass-edit per-file SPDX headers across the deletions (no-op since files are gone).
3. Add an explicit "deleted in Phase 4" attribution log somewhere — over-engineered.

**Chosen:** Option 1.

**Reason:** Dotfiles repo's umbrella LICENSE is the right granularity for repo-wide attribution. Source-of-truth files (plugin canonicals) carry their own SPDX. No attribution gap.

---

## 2026-05-01 — Decision E: accept Slice 2 soak-time risk on 3 worktree-substrate hooks

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: scope
severity: major
phase: 4
affects:
  [
    plugin/src/hooks/checks/dotfiles-worktree-cleanup.ts,
    plugin/src/hooks/checks/dotfiles-worktree-gc.ts,
    plugin/src/hooks/checks/dotfiles-worktree-provisioner.ts,
  ]
---
```

**Context:** Phase 4 deletes 3 dotfiles shims for hooks that shipped only 24 hours ago in Phase 3 Slice 2 (`dotfiles-worktree-{cleanup,gc,provisioner}`). If a latent bug surfaces in plugin canonical for any of these post-P4, the dotfiles shim — which would have been a fail-safe during the 24h soak — no longer exists.

**Options considered:**

1. **Accept the soak-time risk explicitly + rely on the wrap-when-needed seam (Decision C) for recovery** (chosen) — Slice 2 was 3-lens-audited at SHIP (RE 9.0 / ARCH 8.0 / Bravo 9.0) and passed cross-instance verification. The 3-lens audit + soak-period rigor justifies the confidence.
2. Defer those 3 to a P4.5 post-soak slice — doubles atomic-wiring transactions and increases coordination overhead. The accept-the-risk choice is simpler and the audit trail justifies the confidence.

**Chosen:** Option 1.

**Reason:** Slice 2's 3-lens audit + Bravo verification were rigorous; the wrap-when-needed pattern (Decision C) provides a recovery seam if a latent bug surfaces. Splitting P4 doubles coordination overhead for marginal risk reduction.

---

## 2026-05-01 — Decision F: defer `session-collision-gate` + `session-presence-register` from delete-list (REV-1.8 course correction)

```yaml
---
ts: 2026-05-01T12:35:00Z
kind: scope
severity: major
phase: 4
affects:
  [
    dotfiles/src/hooks/checks/session-collision-gate.ts,
    dotfiles/src/hooks/checks/session-presence-register.ts,
    dotfiles/src/hooks/checks/bundled-registrations.ts,
    dotfiles/src/active-sessions/cli.ts,
    dotfiles/src/__tests__/hooks/session-collision-gate.test.ts,
    dotfiles/src/__tests__/hooks/session-presence-register.test.ts,
    dotfiles/src/__tests__/hooks/session-presence-unregister.test.ts,
    dotfiles/src/__tests__/shared/fail-open-symmetry.test.ts,
  ]
---
```

**Context:** mid-Phase-v test gate surfaced 11 failing tests in `session-collision-gate.test.ts` + `session-presence-register.test.ts`. Tests configure dotfiles' `active-sessions` module-level state via `setCoordinationRootsForTesting`; plugin's check-fn (post cross-edge flip) reads PLUGIN's `active-sessions` module — different instances, state mismatch. Two B5-drift files were originally slated for deletion in REV 3 + REV-1.7; the test failures revealed the deferred ARCH-3 conflict.

**Options considered:**

1. **Revert these 2 from delete-list; defer to ARCH-3 flip-on slice when active-sessions canonicalization happens** (chosen) — preserves Phase 4's other 28 deletions, doesn't expand scope to active-sessions.
2. Add active-sessions canonicalization to Phase 4 scope — significantly expands Phase 4; conflicts with REV 3 §3 which explicitly deferred active-sessions to flip-on slice.
3. Delete the affected tests (lose coverage) — coverage loss; tests are valuable; rejected.
4. Plugin canonicalize JUST the test setup helpers (e.g., `setCoordinationRootsForTesting`) without full active-sessions migration — partial migration, fragile, leaves state-sharing concerns lurking.

**Chosen:** Option 1.

**Reason:** ARCH-3 active-sessions canonicalization is already filed as flip-on dependency-blocker. Deferring these 2 files cleanly aligns with that work — when ARCH-3 lands and active-sessions is unified across repos, these 2 files can be deleted then. Net P4 reduces from 30 deletions to 28 with no architectural cost. The course correction was caught by Phase v test gate (the safe-sequencing checkpoint did its job).

**Supersedes / superseded_by:** scoped under ARCH-3 follow-up (flip-on slice).

---

## 2026-05-01 — Decision G: Safe Edit Sequencing pattern for refactors touching the dispatcher's eager-import graph

```yaml
---
ts: 2026-05-01T12:00:00Z
kind: tooling
severity: major
phase: 4
affects:
  [dotfiles/src/hooks/dispatcher.ts, dotfiles/RECOVERY.md, future-refactors]
---
```

**Context:** Phase 4 RE-2 audit pre-validation (deliberate-broken-import smoke) confirmed Slice 1's `CLAUDE_CONDUCTOR_DISABLE_HOOKS=*` bailout does NOT rescue mid-flight import-resolve failures — Bun resolves dispatcher.ts:42 imports BEFORE env var is read at line 564. This breaks the assumed "safe to delete shims first, then flip imports" pattern: a partial-delete state would wedge the dispatcher with no recovery.

**Options considered:**

1. **Flip imports FIRST while shims still on disk → typecheck checkpoint → only then delete shims** (chosen) — both `./<name>.ts` and `claude-conductor/hooks/checks/<name>` resolve to the same module via the shim re-export. Dispatcher stays functional throughout the transaction window. Typecheck checkpoint catches any flip typo before any deletion.
2. Run the atomic transaction as a single sed/script — same effect for the import flip, but doesn't add the typecheck checkpoint between flip and delete.
3. Defer the entire refactor pending dispatcher hardening — too conservative; Safe Edit Sequencing is sufficient.

**Chosen:** Option 1.

**Reason:** Eliminates mid-flight wedge risk for THIS atomic transaction. The flip-then-typecheck-then-delete sequence preserves both-paths-resolve invariant during the transaction's edit window; if a flip is wrong, typecheck fails BEFORE any shim is deleted, so revert is clean. Documented in RECOVERY.md and `feedback-dispatcher-bailout-precedes-imports.md` for future refactors.

**Follow-up backlog:** dispatcher hardening — wrapper script (`dispatcher.sh`) reading `CLAUDE_CONDUCTOR_DISABLE_HOOKS=*` and exiting clean BEFORE invoking `bun run dispatcher.ts`, OR top-level dynamic `import()` gated on env var. Either path bullet-proofs bailout for ANY future broken-import scenario, generalizing beyond the Safe Edit Sequencing per-refactor discipline.

---

## 2026-05-01 — Decision H: cross-edge contracts use paired structural tests, not parity scripts (generalized rule)

```yaml
---
ts: 2026-05-01T13:30:00Z
kind: architectural
severity: major
phase: 4
affects: [all-future-cross-edge-work]
---
```

**Context:** Decision A retired the bundled-registrations parity script in favor of paired structural tests. Question — is this a one-off Phase-4-specific approach, or a generalizable principle for all cross-edge contracts (cross-repo, cross-package, plugin-host, SDK ↔ application, RPC schemas)?

**Options considered:**

1. **Apply the pattern as a generalized rule for all future cross-edge work** (chosen) — whenever you encounter or design a cross-edge contract, replace imperative parity scripts with paired structural tests on each side.
2. Keep it Phase-4-specific; revisit per case — risks reinvention each cycle, which the parity-script-comes-back failure mode shows is real.

**Chosen:** Option 1.

**Reason:** The parity-script-vs-paired-tests tradeoff is structural, not Phase-4-specific. Imperative parity scripts live OUTSIDE the contract; tests live NEXT to it. Drift on either side fails the suite — there's no single point of failure. This applies to package boundaries, repo boundaries, microservice boundaries, plugin-host contracts, RPC schemas, SDK ↔ application contracts. Any cross-edge contract should be enforced via paired tests, not a comparison script.

**Operationalized as:** `feedback-cross-edge-contract-via-paired-tests.md` in dotfiles memory (surfaces on every session-start to apply the rule by default for future ANY refactor).

---

_Phase 4 SHIPPED 2026-05-01:_

- Plugin PR #7 (exports-map-coverage test) MERGED `c448898`
- Plugin PR #8 (parity-script retirement) MERGED `6b961bc`
- Dotfiles PR #56 (atomic — 28 deletions + 31 import flips + 14 retargets + 2 new tests + RECOVERY.md) MERGED `c68850d` over commit `b18ca59`
- Pre-merge dotfiles CI: runs 25215169453 + 25215170545 conclusion: success
- Plugin Lane #6 CI: runs 25214969349 + 25214803801 conclusion: success
- Post-merge dotfiles CI: run 25215256785 conclusion: success
- 4-lens audit: REV 3 (RE 7.0 / ARCH 7.5 / CS 7.5 / Bravo 8.5) → REV-1 ops audit (RE 6.5 / ARCH 7.5 / Workflow 7.0) → REV-1.5 verification loop (8.57/10) → REV-1.6/1.7 amendments → REV-1.8 course correction → Subagent (RE) Nick-lens 7.5/10 → Bravo Lane (4) cross-instance 8.5/10

---

## 2026-05-14 — Decision K: Phase 4 Step A Layer 1 — `peer-message-deliverer` hook with two-phase cursor commit + defense-in-depth body fencing

```yaml
status: chosen
severity: load-bearing
phase: 4
affects: [hook-substrate, channels-substrate, package-exports]
```

**Context:** Layer 1 of Phase 4 Step A (inter-sibling communication arc) closes the "no cross-window delivery" gap — before this hook, peer messages were only seen via manual `channels read --since-cursor` poll or `SessionStart` fire (which only runs at `/resume`, not mid-session). Nick's 2026-04-25 caveat ("I was still required for your communication to work") stood until this layer landed. Three design questions emerged during the arc:

1. **Cursor mechanics** — how to advance the per-(channel, session) emission cursor such that a session crash between emit + cursor-write cannot silently lose messages.
2. **Body trust** — peer body is free-form text from another Claude session; how to defend against accidentally-or-deliberately-injected platform-control markup without breaking legitimate markdown content (multibyte UTF-8 punctuation, emoji, etc.).
3. **Emission volume** — a session offline for a week could see thousands of pending messages on first prompt; how to bound surface noise without losing the cursor advance.

**Options considered for cursor mechanics (Q1):**

1. **Single-write committed cursor** — write cursor at emit time, advance atomically via tmp+rename. Simple; but a crash between write + operator-consumes-output leaves the cursor advanced beyond what was delivered → silent message-loss on next session.
2. **Two-phase commit with `.pending` sidecar** (chosen) — emit-turn writes `<sid>.json.pending`; next `UserPromptSubmit` fire promotes pending → committed via atomic rename. Recovery: if session crashes between emit and promote, next session sees stale pending + still-old committed and re-emits. Silent loss is impossible because cursor advance is gated on the operator reaching the next prompt (the prompt-fire IS the evidence the prior emission was consumed).
3. **Append-only emit-log with replay** — write each emission as a JSONL entry; on session-start, replay un-acked entries. Robust but heavyweight; new substrate file per channel; reaping is its own design.

**Options considered for body trust (Q2):**

1. **No sanitization** — surface body verbatim. Vulnerable to prompt-injection — a body containing `system-reminder` tags / `function_calls` traces / role-confusion strings corrupts the receiving Claude's prompt structure.
2. **Structural escape only** — replace bare `<` with `&lt;`. Catches markdown-significant injections but leaves named patterns (`<system-reminder>`) intact.
3. **Strip high-byte content** — replace any byte > 0x7E. Defends against nothing the targeted-strip doesn't already handle, AND breaks legitimate prose (em-dashes, smart quotes, emoji, ellipsis are all multibyte UTF-8). This was the v3 plan; folded out at v4 per Bravo MINOR-3.
4. **Defense-in-depth: targeted-pattern strip + bare-`<` escape + per-emission UUID-nonce fence + 200-char truncate + body_ref overflow** (chosen). Pass (a): strip `<system-reminder>` open/close + `<function_calls>` open/close + `<*>` namespace tags + fence-marker `[peer-body-<hex>]` + bare `</` close-sequence; replace each with `[redacted-platform-marker]`. Pass (b): escape any remaining bare `<` via `&lt;`. Wrap sanitized body in `[peer-body-<8hex-nonce>] ... [/peer-body-<8hex-nonce>]` per emission (nonce uniqueness defends against collision even though pass (a) strips the fence marker). Truncate at 200 chars; longer bodies → `body_ref` note with recovery hint pointing at `channels read --since-cursor`. **Multibyte UTF-8 preserved verbatim per Bravo MINOR-3 fold.**

**Options considered for emission volume (Q3):**

1. **No cap** — surface every new message every prompt. Operator-hostile on long-offline returns.
2. **Per-channel cap with discard** — drop messages past cap. Loses data; cursor advance ambiguous.
3. **Aggregate 50/prompt cap with per-channel summary mode** (chosen) — across all channels with new messages, surface up to 50 individual messages; channels that exceed remaining budget switch to summary mode (one block: "N new messages — M suppressed by 50-message cap"). Cursor still advances to newest-suppressed mtime → full batch readable via `channels read --since-cursor`. No data loss; bounded operator surface.

**Chosen:** Option 2 for Q1; Option 4 for Q2; Option 3 for Q3.

**Reason — cursor mechanics (Q1):** the two-phase commit pattern leverages the operator-reaches-prompt event as the natural consumption signal. Mirrors POSIX-rename atomicity (the same primitive the substrate uses for `identitiesDir` sentinel claims + metadata RMW). Sibling-shape to `LastSeenCursor` keeps the schema discoverable; distinct cursor dir (`peer-message-emit-cursors/`) avoids racing the CLI `read --since-cursor` reader. Recovery is data-preserving (re-emit on crash) — the worst-case operator-visible outcome is a duplicate emission, not silent loss.

**Reason — body trust (Q2):** the MAJOR-1 prompt-injection finding came from Bravo's sibling cross-audit on plan v2 — the 4-persona pre-audit (RE + Architecture + CLI DX + KS) missed it entirely. Distinct lens (`feedback-distinct-lenses-over-repeat-verifications.md`) caught what shared-pipeline review couldn't see. The MINOR-3 refinement (Bravo, plan v3 → v4) further tightened — high-byte strip was both insufficient (named injections still pass) and over-aggressive (breaks legitimate Unicode prose); defense-in-depth via four orthogonal layers is the lowest-cost-and-highest-correctness shape.

**Reason — emission volume (Q3):** the 50/prompt aggregate-with-per-channel-summary preserves data integrity (cursor advances, full batch readable) while bounding surface area. Most-common case (1-10 messages per turn) is unaffected; long-offline edge case degrades gracefully.

**Operationalized as:**

- `src/hooks/checks/peer-message-deliverer.ts` (NEW, ~265 LOC) — the hook itself. `user-prompt-submit` event, position 1 (per plan v5 §Phase 1 §Order placement; fires BEFORE `teammate-idle-reminder`). `canBlock: false`. Fail-open + breadcrumb outer catch.
- `src/channels/peer-message-cursors.ts` (already shipped at `d44fa14`, 440 LOC; 47 tests) — substrate helpers: `readPeerMessageCursor`, `readPendingPeerMessageCursor`, `writePendingPeerMessageCursor`, `promotePendingPeerMessageCursor`, `clearPeerMessageCursor`, `sanitizePeerBody`, `fencePeerBody`, `resolvePeerMessageEmitDir`, `resolvePeerMessageEmitCursorPath`, `resolvePendingPeerMessageEmitCursorPath`, `MAX_INLINE_BODY_CHARS`.
- `src/channels/render.ts` — cherry-picked `renderKindPrefix(kind: ChannelKind): string` from B1's branch (file-edit-disjoint per MAJOR-2 fold; trivial squash-merge reconcile when B1 lands).
- `src/channels/cli.ts` — two new CLI verbs (`show-message-cursor` + `forget-message-cursor`) sibling-pattern to `show-cursor` + `forget-cursor`. `VERB_HELP` + `TOP_LEVEL_HELP` updated.
- `src/hooks/bundled-check-names.ts:71` — `"peer-message-deliverer"` added to `user-prompt-submit` array at position 1.
- `src/hooks/checks/bundled-registrations.ts` — import + `register` call.
- `src/hooks/lock-domain.ts` — new row under `user-prompt-submit`: `domains: ["per-channel-cursor", "presence-failure-log"]`.
- `test/hooks/bundled-registrations.test.ts:77` — `EXPECTED_COUNT` 11 → 12.
- `package.json` exports map — two new entries (`./channels/peer-message-cursors` + `./hooks/checks/peer-message-deliverer`).
- `test/hooks/checks/peer-message-deliverer.test.ts` (NEW, ~580 LOC after formatter) — 25 tests covering plan v5 §Phase 1 §Tests matrix (happy paths × 5, cursor 2PC × 6, message discovery × 4, body fencing × 3, input validation × 3, failure handling × 4). All green; full-suite 810 pass / 1 skip / 1 todo / 0 fail across 60 files.
- `docs/architecture/inter-sibling-communication-layers.md` (NEW, ~120 LOC) — 4-layer model permanent home.
- `docs/operations/phase-2-hooks.md` — extended with `peer-message-deliverer` user-prompt-submit firing-order entry + catalog entry + Symptom/Diagnose/Recover/Verify section.

**Cross-references:**

- Memory `feedback-distinct-lenses-over-repeat-verifications.md` — Bravo cross-audit MAJOR-1 prompt-injection catch is the ur-example.
- Memory `feedback-atomic-wiring-discipline.md` — `bundled-check-names.ts` + `bundled-registrations.ts` + `lock-domain.ts` + `EXPECTED_COUNT` + exports map land in one atomic commit.
- Memory `feedback-cross-edge-deletion-substrate-import-first.md` (applied in reverse — substrate-first, consumer-second) — substrate (`peer-message-cursors.ts`) shipped at `d44fa14` BEFORE this consumer (the hook) per Bravo's pre-flight sequencing.
- Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 §Phase 1 — the design SoT (5 audit cycles + Bravo sibling cross-audit cycles validated this shape).
- Decision I (Layer 3) + Decision J (Layer 4) — co-arc decisions ship in B1 + B2 respectively; Decision K (this one) is the Layer 1 sibling.
- Post-arc memory candidates (Bravo lane): `feedback-peer-content-prompt-injection-defense.md` (plugin-bundled; born from MAJOR-1) — Bravo authors per lane-split.

**Letter note:** plan v5 §Phase 1 names this "Decision E (umbrella) §Layer 1", but Decision E is already taken in this file by the 2026-05-01 Slice 2 soak-time entry (line 147). Following Bravo's precedent on Decision I — narrowly-scoped per layer with the next-available letter. B1 = I (Layer 3), B2 = J (Layer 4); A1 = K (Layer 1, this entry). Final on-main order after all three merge: A–H, I (Layer 3 — B1), J (Layer 4 — B2), K (Layer 1 — A1, this entry).

---

## 2026-05-13 — Decision I: Phase 4 Step A Layer 3 — out-kind atomicity via `extraMetadataMutator` + manual-`send out` as sole `out_posted_at` writer

```yaml
status: chosen
severity: load-bearing
phase: 4
affects: [channels-substrate, hook-substrate-deferred-to-step-b]
```

**Context:** Layer 3 of Phase 4 Step A (inter-sibling communication arc) introduces `kind=out` as one of five walkie-talkie protocol primitives, AND a metadata cache (`metadata.identities[<L>].out_posted_at`) so peers can filter departed sessions via `explicitlyOutPeers` without scanning the message log. Two design questions emerged during the arc:

1. **How to land the JSONL audit line AND the metadata cache update atomically** — separate writes risk a race window where `explicitlyOutPeers` reads stale-no, and a partial-write window where the cache lies indefinitely after one write fails.
2. **Who writes `out_posted_at` — manual `channels send <id> out` only, OR a Stop-hook auto-poster on every channel a session claims?**

**Options considered for atomicity (Q1):**

1. **Separate writes with explicitlyOutPeers fallback** — predicate cross-checks the message log if the cache doesn't show `out`. Eliminates the race but destroys the O(1) lookup the cache exists for; adds latency to every predicate call.
2. **Two-phase commit with a `.pending` sidecar** — sibling to Layer 1's cursor pattern. Heavier; multiple file writes per send.
3. **Atomic mutation under one lock via `appendMessage` extension** (chosen) — add an optional `extraMetadataMutator?: (meta) => ChannelMetadata` parameter that runs inside the existing `withMetadataLock` callback. Caller-supplied mutator returns the post-state metadata; the lock callback validates the output then writes both the JSONL line AND the metadata under one lock acquisition. Reference-equality return signals "no metadata change"; mis-shaped output throws before either write lands.

**Options considered for the writer (Q2):**

1. **Stop-hook auto-poster** (v4 design) — extend `session-presence-unregister` to iterate every channel the session has a claim on and post `kind=out` + set `out_posted_at`. Fires on Stop event.
2. **Manual send-out only** (chosen, v5 rework) — the operator (or operator-controlled session) runs `channels send <id> out` to announce departure; the CLI send-role-gate carve-out from the Layer 3 commit lets `kind=out` through; `makeSendOutMutator(sessionId)` is passed as the `extraMetadataMutator`. No automatic posting.
3. **SessionStart-driven reaper** — deferred to Phase 4 Step B. On the next session-start after the prior session ends, scan channels for stale heartbeats and auto-post `out` for departed peers. Mirrors the `dotfiles-worktree-gc` SessionStart-reaper pattern (cycle-3 fix on `bundled-registrations.ts:71-78`).

**Chosen for Q1:** Option 3 (atomic mutator under one lock).
**Chosen for Q2:** Option 2 (manual send-out only); Option 3 deferred to Phase 4 Step B as a new backlog candidate.

**Reason — atomicity (Q1):** the mutator pattern is the lowest-cost-and-highest-correctness shape. One lock acquisition; readers see either the pre-state (transaction not started or rolled back) or the post-state (transaction completed). The `appendMessage` API is now permissively composable — Layer 4 digest-related metadata work can land via the same parameter without further substrate change. Pre-fold ordering was metadata-first; the v5 fold (RE-2) reordered to JSONL-first because the durable audit trail is the right anchor: on metadata-write failure post-JSONL, the log preserves the evidence and recovery is external (operator `claim --force`) — whereas the opposite ordering would leave a permanently lying cache if the JSONL append failed.

**Reason — writer (Q2):** Stop fires per-turn, not session-end. The codebase already has a removed example of this exact bug shape — `dotfiles-worktree-cleanup` was deleted on 2026-05-08 because the Stop-hook had no session-end discrimination and destroyed the worktree after the first turn-end. The v4 auto-out design replayed this defect: on every turn-end, the session would have marked itself as departed on every channel it had a claim on. The staged-diff Reliability audit caught this pre-push by citing the codebase comment at `bundled-registrations.ts:71-78` — **substrate-precedent caught a plan-level defect that two prior audit cycles missed** (the 4-persona pre-fold + the Bravo plan v3 cross-audit). The fold: drop auto-out entirely, keep substrate primitives, defer the structurally-correct reaper to Phase 4 Step B where SessionStart is the right firing point.

**Operationalized as:**

- `src/channels/index.ts` — `IdentityClaim.out_posted_at?: string` (additive optional); `appendMessage` `extraMetadataMutator?: (meta) => ChannelMetadata` parameter (JSONL-first ordering per RE-2); `makeSendOutMutator(sessionId, postedAt?)` helper.
- `src/channels/explicitly-out-peers.ts` — new predicate; re-exported via `api.ts`.
- `src/channels/cli.ts` — send-verb wires `makeSendOutMutator` when `kind === "out"`.
- `src/channels/api.ts` — `CHANNEL_KINDS`, `renderKindPrefix`, `explicitlyOutPeers`, `makeSendOutMutator` on curated surface (24 value names).
- `memories/feedback-walkie-talkie-out-semantics.md` — plugin-bundled; documents sole-writer + per-turn-Stop rationale + terminal-until-takeover.
- `src/hooks/checks/session-presence-unregister.ts` — header comment cites the auto-out drop + the precedent + the Phase 4 Step B deferral.

**Cross-references:**

- Memory `feedback-cross-artifact-fold-propagation.md` — applied on the v5 ARCH-2/3 docstring sweeps + plan-body sweeps.
- Memory `feedback-distinct-lenses-over-repeat-verifications.md` — the v0 → v5 audit lineage paid five rent payments (1 plan-level catch via Bravo cross-audit on plan v2 → v3; 1 plan-level catch via staged-diff Reliability on v4 → v5; 3 cross-audit MAJORs on each commit).
- Memory candidate (post-arc): `substrate-precedent-as-design-rescue` — RE-1 catch citing `bundled-registrations.ts:71-78` is the canonical example.
- Phase 4 Step B backlog: SessionStart-driven reaper for departed-peer auto-out (deferred from this arc).

**Letter note:** plan v5 §B1 names this "Decision E §Layer 3", but Decision E is already taken in this file by the 2026-05-01 Slice 2 soak-time entry (line 147). Using next-available letter I.

## 2026-05-13 — Decision J: Phase 4 Step A Layer 4 — `digest` kind via shared `parseDigestBody` + per-kind verification-budget convention

```yaml
status: chosen
severity: load-bearing
phase: 4
affects: [channels-substrate, channel-protocol-conventions]
```

**Context:** Layer 4 of Phase 4 Step A (inter-sibling communication arc) introduces `digest` as the "mental-model-sync" kind — a structured arc-summary one session emits to peers or to its future self capturing shipped/verified/audit-class-paid/next-pickable/blockers/budget-ms state. Two design questions:

1. **Schema design** — typed shared parser vs free-form prose body parsed ad-hoc per consumer?
2. **Reader verification budget** — uniform "trust verbatim" across all kinds OR per-kind verification posture that names the right shape for each kind's content?

**Options considered for schema (Q1):**

1. **Free-form prose body** — readers parse with regex / heuristics per consumer. Lowest substrate cost; highest drift cost (every reader re-invents the parse; arc-summary state isn't queryable without text-mining).
2. **JSON-schema-validated body** with a single shared parser (chosen) — `DigestBody` type at `src/channels/digest.ts` + `parseDigestBody` re-exported via `api.ts`. Six required fields (`kind_version` + 4 string-arrays + 1 string + 1 number). Permissive on extra fields (forward-compatible); strict on required fields (`null` return on mis-shape).
3. **Stronger schema** (e.g., enums on `audit_class_paid` values) — over-constrains; the schema-validation value is in the structure (which fields exist) not in policed enumerations (which strings appear in `audit_class_paid`). Convention layer can name the canonical strings; substrate doesn't enforce.

**Options considered for verification budget (Q2):**

1. **Uniform "trust verbatim"** across all kinds — under-verifies citation-bearing kinds (`question` / `handoff` / `digest`); operator + automated readers cascade on unverified claims.
2. **Uniform "verify all"** — over-verifies protocol-state primitives (`ack` / `roger` / `over` / `standby` / `out` / `note` / `status` carry no factual claims requiring re-verification); operational cost without operational benefit.
3. **Per-kind verification posture** (chosen) — name the right verification budget for each kind's content shape. Protocol primitives + `note`/`status` trust verbatim; `question` verifies claims it relies on; `handoff` verifies SHA/path/run-id citations; `digest` trusts SHAPE (validator-enforced via `parseDigestBody`) but primary-source-verifies any audit-class-string / SHA / PR-number / backlog-ID cited in field contents.

**Chosen for Q1:** Option 2 (JSON-schema-validated + single shared parser).
**Chosen for Q2:** Option 3 (per-kind verification posture).

**Reason — schema (Q1):** the SSOT pattern established in Phase 0 (`CHANNEL_KINDS` tuple) eliminated 3 sync points at the kind-set layer; the shared parser extends the same discipline to the convention layer. Without a shared parser, in-tree readers (operator tools, future Phase 4 Step B reaper, dotfiles cross-edge consumers, future analysis tooling) each re-implement JSON-parse + shape-check — same drift surface, one layer down. The parser is permissive on extra fields so future schema bumps don't break the v1 subset reader; strict on required fields so partial-decode cascades don't operate on incomplete data silently.

**Reason — verification budget (Q2):** the cost of misplaced trust scales with the consequence of the kind. A `roger`'s commitment is checked when the commitment lands (the action follows the promise); verifying the `roger` itself adds no signal. A `digest`'s `audit_class_paid` array tells the reader what catch-shape was claimed; without primary-source verification, downstream memory annotation work cascades on unverified rent. Naming the per-kind posture in `docs/conventions/message-kinds-and-verification.md` + the paired memory `feedback-verification-budget-by-kind.md` keeps readers (operators + automated tooling) from defaulting to one wrong-shape verification across all kinds.

**Operationalized as:**

- `src/channels/index.ts` — `CHANNEL_KINDS` extended with `"digest"` (1-line edit via SSOT).
- `src/channels/digest.ts` — `DigestBody` type + `parseDigestBody` shared parser (~170 LOC including JSDoc).
- `src/channels/api.ts` — re-export `parseDigestBody` (value) + `DigestBody` (type) on the curated surface (25 value names; 8 type names).
- `src/channels/cli.ts` KINDS_HELP — `digest` entry with SHAPE-vs-citation verification contract.
- `docs/conventions/message-kinds-and-verification.md` — first inhabitant of `docs/conventions/`; operator + developer reference for all 10 kinds + the per-kind verification budget table.
- `memories/feedback-digest-message-convention.md` — schema rationale + sole-shared-parser discipline.
- `memories/feedback-verification-budget-by-kind.md` — per-kind verification posture as a stable cross-arc memory.
- `test/channels/digest.test.ts` — 15 parser cases (happy / round-trip / parse failures × 9 / forward-compat).
- `INDEX.md` — catalog entries for `digest.ts`, the docs/conventions/ inhabitant, and the two new bundled memories.

**Cross-references:**

- Memory `feedback-distinct-lenses-over-repeat-verifications.md` — the per-kind verification budget extends this discipline from audit-lens-shape to read-time-budget-shape.
- Memory `feedback-cross-edge-contract-via-paired-tests.md` — shared parser + paired structural tests = the convention-layer analog of the cross-edge-contract pattern.
- Memory `feedback-no-known-gaps.md` — adding a new kind without a verification-budget row is a known gap; the convention table in `docs/conventions/message-kinds-and-verification.md` is the single source of operator-facing verification posture, and future kind additions land their posture in the same place.
- Decision I §Layer 3 — sibling design rationale for the Layer 3 walkie-talkie kinds + `out`-kind atomicity primitives that this layer builds on.

**Letter note:** plan v5 §B2 names this "Decision E §Layer 4", but Decisions E + I are already taken (2026-05-01 Slice 2 soak-time + this session's Layer 3 entry respectively). Using next-available letter J.
