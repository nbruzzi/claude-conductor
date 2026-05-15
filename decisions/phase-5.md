<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision Log — Phase 5

Per-entry schema (same as `phase-4.md`):

```yaml
---
ts: <ISO-8601>
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: 5
affects: [list of components]
---
```

Followed by:

- **Context:** what was being decided
- **Options considered:** list with brief pros/cons
- **Chosen:** the decision
- **Reason:** why this option won
- **Supersedes / superseded_by:** cross-link if relevant

Phase 5 scope: bundle wind-down discipline memories + embed rules into `commands/session/handoff.md` skill body + sibling-parity Constraints additions to `presence.md` + `channel.md` + INDEX.md catalog updates. Plan: `~/.claude/plans/transient-plotting-crescent.md` v2.1 (audit-folded). Multi-persona audit history: 4-persona on plan v1 (KS+ARCH+WP+CLI-DX → FOLD-RE-PLAN); 2-persona Bravo cross-audit on plan v2 (KS+ARCH → SHIP-WITH-FOLDS, 12 folds applied for v2.1); 2-persona Bravo delta-pass on plan v2.1 (KS+ARCH → PASS-WITH-MINOR-FOLDS, 5 deltas applied).

---

## 2026-05-06 — Decision A: skill-body embedding of wind-down discipline into `commands/session/handoff.md`

```yaml
---
ts: 2026-05-06T23:30:00Z
kind: api-shape
severity: major
phase: 5
affects: [commands/session/handoff.md]
---
```

**Context:** the `/handoff` slash-command skill currently has zero wind-down discipline content — when invoked, it generates the handoff document via Steps 1–8 without enforcing any pre-handoff discipline (tier selection, checklist, backlog scan, ordering rules, infrastructure teardown gate). All wind-down logic lived only in 4 user-pool memory files which require pre-load to be operational. Future sessions without those memories pre-loaded run bare `/handoff`. CLAUDE.md `### Wind-down sequencing` (3 lines, points to one memory only) is incomplete summary.

**Options considered:**

1. **Embed discipline rules into skill body, with bundled-memory cross-refs for deeper rationale (CHOSEN)** — skill becomes operational source of truth at handoff time; memories remain canonical for deep rationale; bidirectional skill ↔ memory navigation.
2. Keep memories canonical; expand CLAUDE.md `### Wind-down sequencing` only — fails when memories aren't pre-loaded; CLAUDE.md auto-loads but isn't the operational invocation surface; doesn't address bare `/handoff` failure mode at the right layer.
3. Drop discipline entirely from skill; rely on operator memorization — already failing.

**Chosen:** Option 1.

**Reason:** the skill IS the operational surface invoked at wind-down time. Discipline encoded at the procedural surface fires automatically; discipline encoded only in memory requires successful pre-load. The skill as operational SoT pattern matches `audit/SKILL.md` (372 lines, embedded discipline logic). Bundled memories (Decision B) preserve the canonical anchors for deeper rationale.

**Q1-Q7 design rationale** (from plan v2.1 §Design recommendations):

- Q1: Top-level sections before Step 1 — discipline governs whether/when Steps run; preamble, not a step. Implementation per CLI-1 fold: "Wind-down rules" callout block (3 meta-rules) + Step 0 (tier action) + Step 0.5 (backlog action) + Step 0.6 (guard).
- Q2: Mixed inlining — operational rules inline (~120 lines); deeper rationale via cross-ref to bundled memories. Skill self-sufficient at wind-down time; memories primary on rationale.
- Q3: Tier as inline first action (Step 0). Compressed to 4-line decision rule (default FULL) per CLI-2 fold.
- Q4: Backlog scan as Step 0.5 (FULL tier only) with explicit Quick-tier skip note.
- Q5: Pre-flight + Step 8 imperative + Constraints repeat — highest cost-of-violation rule warrants 3-place repetition.
- Q6: Inline cross-refs at each rule + end-of-skill "See also" list.
- Q7: Manual smoke only this slice — structural test deferred to unified-skill-content-test slice (deadline 2026-05-20).

---

## 2026-05-06 — Decision B: bundle 4 wind-down memories under `memories/` with V2 frontmatter

```yaml
---
ts: 2026-05-06T23:31:00Z
kind: scope
severity: major
phase: 5
affects:
  [
    memories/feedback-signoff-checklist.md,
    memories/feedback-wind-down-ordering.md,
    memories/feedback-tiered-wind-down.md,
    memories/feedback-wind-down-backlog-consolidation.md,
    memories-to-bundle.md,
    INDEX.md,
  ]
---
```

**Context:** Decision A requires bundled-memory cross-refs from skill body. The 4 source wind-down memories live only in user-pool (`~/.claude/projects/-Users-{user}/memory/`); `<plugin-root>/memories/` does not contain any of them. `commands/session/handoff.md` referencing memories that don't ship would create dead links for any operator installing the plugin.

**Options considered:**

1. **Bundle 4 memories anonymized + V2 frontmatter (CHOSEN)** — skill cross-refs resolve; plugin self-contained; future operators get the discipline.
2. Drop "See also" + skill cross-refs entirely — skill is self-sufficient but operators lose navigability to deeper rationale.
3. Reference user-pool paths directly (`~/.claude/projects/.../memory/feedback-X.md`) — works for the original capturing user only, breaks for any other installation.

**Chosen:** Option 1.

**Reason:** plugin-bundled discipline benefits all future plugin operators (the multi-instance coordination audience, per the plugin's marquee feature). Anonymization rules (a)-(f) per plan §Memory bundling preserve operational substance:

- (a) "Nick" / pronouns → "the operating user" (per `memories-to-bundle.md:104` canonical wording)
- (b) session-specific incident anchors (rtk-ingest 2026-05-03) → generic peer-coordination reframe
- (c) tooling/path references (`wiki/backlog.md`, `dotfiles \`.session-summary\``) → "project's backlog artifact (whichever tracks debt)" / "host substrate's commit-summary surface"
- (d) operational core (rule wording, decision criteria, sequence steps) preserved verbatim
- (e) `originSessionId:` frontmatter stripped per `memories-to-bundle.md:96`
- (f) intra-bundle cross-refs use bare relative paths `memories/feedback-X.md`; refs to dropped memories (`feedback-self-sufficient-notes.md` in backlog-consolidation; `feedback-efficiency-without-compromise.md` in wind-down-ordering) inline-summarized.

**Per-memory cross-ref triage results** (rule (f) application):

| Bundled memory                                | Cross-refs preserved                                                                                                                 | Cross-refs inline-summarized                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedback-signoff-checklist.md`               | Pairs-with: ordering, tiered, backlog-consolidation                                                                                  | (none — original had no Pairs-with section)                                                                                                                                 |
| `feedback-wind-down-ordering.md`              | Pairs-with: signoff, tiered, backlog-consolidation                                                                                   | `feedback-efficiency-without-compromise.md` (DROPPED) → "the efficiency-without-compromise principle (optimize aggressively, but never at the cost of having to undo work)" |
| `feedback-tiered-wind-down.md`                | Pairs-with: backlog-consolidation, ordering, signoff, encode-while-context-fresh; in-body: feedback-plan-mode-for-structural-changes | (none)                                                                                                                                                                      |
| `feedback-wind-down-backlog-consolidation.md` | Pairs-with: signoff, ordering, tiered                                                                                                | `feedback-self-sufficient-notes.md` (DROPPED) → "the self-sufficient-notes principle (durable backlog entries must be stand-alone — pickup-with-zero-research)"             |

**Verification:** `bash scripts/check-generic-paths.sh` against the 4 new memories returns 0 violations. Canonical rg per `memories-to-bundle.md:266-273` matches "feedbac" substring only (known FP class — prefix of word "feedback"; same FP fires on existing 18 bundled memories, including `feedback-encode-while-context-fresh.md`). Real anonymization-leak surface: empty.

**INDEX.md update text strings** (drafted at plan time; written in Phase 2c commit):

- Line 65 batch header: "18 cross-session feedback memories bundled in batch 7a" → "22 cross-session feedback memories — 18 in batch 7a + 4 in wind-down batch (per `decisions/phase-5.md` Decision B)"
- Line 110 `/handoff` description: refreshed to "Wind-down rules preflight (tier selection + backlog scan + ordering + teardown gate) before capturing Next Steps + decisions trail"
- 4 new bundled-memory entries under §"Bundled memories" — one-liner per memory matching the Bundled memories convention

**Supersedes:** `memories-to-bundle.md:39-40` (pre-Phase-2b commit `0a5698b` line numbers) drop entries for `feedback-signoff-checklist.md` + `feedback-wind-down-ordering.md`. See Decision C.

---

## 2026-05-06 — Decision C: Phase 0 reversal of `memories-to-bundle.md:39-40` drop decision

```yaml
---
ts: 2026-05-06T23:32:00Z
kind: scope
severity: major
phase: 5
affects: [memories-to-bundle.md]
---
```

**Context:** `memories-to-bundle.md` Phase 0 audit (AUDITED-GREEN) explicitly dropped `feedback-signoff-checklist.md` + `feedback-wind-down-ordering.md` at lines 39-40 with rationale "original-user wind-down ritual" (project-scoped, doesn't generalize). Decision A + B requires bundling these memories. Reopening the Phase 0 decision is a scope action that needs explicit triage and provenance.

**Options considered:**

1. **Reverse the Phase 0 drops on broader-context grounds (CHOSEN)** — discipline is demonstrably generic; original-user anchors are writing artifact; anonymization preserves operational substance.
2. Keep Phase 0 drops; embed discipline content inline in skill body without bundled-memory cross-refs — fails the "skill self-sufficient + memories canonical for rationale" pattern of Decision A.
3. Defer Decision A to a separate slice that triages Phase 0 reversals as Phase 5 prerequisite — fragments related work; same audit cycles run twice.

**Chosen:** Option 1.

**Reason:** Phase 0 audit at the time it ran considered only 2 of the 4 wind-down memories (signoff-checklist + wind-down-ordering); the family was less mature. The other 2 memories (`feedback-tiered-wind-down`, `feedback-wind-down-backlog-consolidation`) post-date Phase 0 by weeks and were never triaged. Bravo's Knowledge System cross-audit on plan v2 demonstrated the discipline is generic Claude Code workflow (tier selection, ordering rules, teardown gating, backlog scan all generalize across operators). Bravo's verbatim observation: "discipline IS generic; Nick-anchoring is a writing artifact." Pattern matches the Phase 0 KS-1 reversal that restored 5 multi-instance memories on identical "drop reasoning was inverted" grounds (`memories-to-bundle.md:77`).

**Operationalized:** `memories-to-bundle.md:39-40` drop entries removed in Phase 2b commit. In-scope table (lines 53-78) +4 rows added for the 4 wind-down memories. Total bundled count updated 18 → 22. New paragraph at lines 79-83 documents the reversal inline for retrospective lookup.

**Supersedes:** `memories-to-bundle.md:39-40` (pre-Phase-2b commit `0a5698b` line numbers) drop entries (signoff-checklist + wind-down-ordering as "original-user wind-down ritual").

---

## 2026-05-06 — Decision D: sibling-parity Constraints additions to `presence.md` + `channel.md`

```yaml
---
ts: 2026-05-06T23:33:00Z
kind: architectural
severity: minor
phase: 5
affects: [commands/session/presence.md, commands/session/channel.md]
---
```

**Context:** Decision A introduces Wind-down rules Rule 3 (no infrastructure teardown before explicit stop signal). Sibling skills `presence.md` (`/presence reset|clear`) and `channel.md` (`/channel close`) expose teardown verbs that Rule 3 governs. Without sibling-parity cross-refs, an operator invoking `/channel close` mid-wind-down has no skill-level signal of Rule 3 violation. `feedback-sibling-parity-at-merge-time.md` (plugin-bundled) catches exactly this pattern.

**Options considered:**

1. **Add 2-line Constraints cross-refs to presence.md + channel.md in same slice (CHOSEN)** — atomic land of teardown-gate semantics across all sibling skills.
2. Defer sibling-parity additions to follow-on slice — drift window where handoff.md claims authority while siblings carry no awareness of the rule. Bravo audit verbatim: "defer rationale buys nothing."
3. Duplicate Rule 3 wording into presence.md + channel.md instead of cross-ref — drift surface (3 places carry same rule body); single SoT pattern violated.

**Chosen:** Option 1.

**Reason:** 2-line Constraints addition × 2 siblings = 4 lines net, atomic with main skill change. Cross-ref to handoff.md Wind-down rules preserves single source of truth for the principle. `commit-push-pr` skill EXCLUDED — see Decision E.

**Operationalized:** `presence.md` Constraints +3 lines (do not call `/presence reset|clear` proactively during wind-down — Rule 3). `channel.md` Constraints +3 lines (`/channel close` is destructive and gated on explicit user stop signal — Rule 3). Both committed in Phase 2e (`c0bc85e`).

---

## 2026-05-06 — Decision E: `commit-push-pr` skill exclusion from Rule 3 cross-ref

```yaml
---
ts: 2026-05-06T23:34:00Z
kind: architectural
severity: minor
phase: 5
affects: [skills/commit-push-pr/SKILL.md]
---
```

**Context:** Decision D adds Rule 3 cross-refs to sibling skills exposing teardown verbs. The plugin's other skill — `skills/commit-push-pr/SKILL.md` — also operates at wind-down time. Sibling-parity audit must determine whether commit-push-pr needs the same cross-ref.

**Options considered:**

1. **Exclude commit-push-pr from Rule 3 cross-ref (CHOSEN)** — durable-action-only skill; commit/push/PR are work-output, not session-infrastructure; no teardown-gate semantics apply.
2. Include cross-ref defensively — adds noise without preserving any failure-mode the rule guards against; risk of confusion (operators reading "Rule 3 applies" might wonder which action is the teardown).

**Chosen:** Option 1.

**Reason:** Rule 3 distinguishes work-output (committed files, pushed branches, sent messages) from session-infrastructure (Monitors, channels, watchers). `commit-push-pr` produces pure work-output. Including the cross-ref would over-broaden Rule 3's domain.

**Operationalized:** No edit to `skills/commit-push-pr/SKILL.md` in this slice. Decision logged for future sibling-parity audits to verify exclusion is correct.

---

## 2026-05-06 — Decision F: skill-body "See also" section as new convention (vs memory-internal "Pairs with")

```yaml
---
ts: 2026-05-06T23:35:00Z
kind: tooling
severity: minor
phase: 5
affects: [commands/session/handoff.md]
---
```

**Context:** Decision A's skill body adds an end-of-skill cross-reference list to bundled memories. Memory-internal convention uses "Pairs with"; skill-doc convention is undecided. Bravo cross-audit verified zero "See also" or "Pairs with" matches across existing `commands/`, `skills/`, OR `memories/` — neither convention has skill-doc precedent.

**Options considered:**

1. **Use "See also" as a new skill-doc convention (CHOSEN)** — distinguishes skill cross-refs from memory cross-refs; broader skill-doc precedent (matches `audit/SKILL.md` final references); future skills follow.
2. Mirror "Pairs with" from memories — co-opts memory-internal convention; muddies the surface (which convention applies where?).
3. Drop the cross-reference list entirely; rely on inline cross-refs only — loses one-list discoverability.

**Chosen:** Option 1.

**Reason:** "See also" is a broader documentation convention familiar to operators outside the plugin's memory ecosystem. Establishing it as the skill-doc convention now (with this slice as precedent) avoids future drift between skills using "Pairs with" vs "See also" inconsistently. Distinction documented: bundled memories continue to use "Pairs with" (memory-internal convention); skills use "See also" (skill-doc convention).

**Operationalized:** `commands/session/handoff.md` ends with "## See also" listing 5 bundled-memory cross-refs (4 wind-down + 1 encode-while-context-fresh). Future skill cross-reference sections should follow this pattern. Logged for sibling-skill audits.

---

_Phase 5 SHIPPED 2026-05-07:_

- Plugin PR #22 (bundle wind-down memories + embed rules into session:handoff skill + sibling parity) MERGED `2eb3ccf` over branch `wind-down-rules-bundle-and-embed`
- Pre-merge CI: runs 25468218202 + 25468233949 (both `c9ceadc1`) conclusion: success
- Post-merge CI: run 25468321938 (`2eb3ccf`) conclusion: success
- 6-cycle audit history:
  - Plan v1: 4-persona /audit (KS+ARCH+WP+CLI-DX) → FOLD-RE-PLAN (KS-1 critical: 4 memories not bundled, 2 of 4 dropped at Phase 0)
  - Plan v2: Bravo direct dispatch KS+ARCH → SHIP-WITH-FOLDS (12 folds applied for v2.1)
  - Plan v2.1: Bravo delta-pass KS+ARCH → PASS-WITH-MINOR-FOLDS (5 deltas applied)
  - Diff Phase 5c: Bravo direct dispatch KS+ARCH+CLI-DX → SHIP-WITH-FOLDS (KS 9.0 / ARCH 8.5 / CLI DX 8.0; 11 folds applied as commit c9ceadc)
  - Total: 4 + 2 + 2 + 3 = 11 lens-runs across plan + delta + diff cycles
- 10 files changed, 587 insertions / 26 deletions; 6 commits squashed atomically
- Plan: ~/.claude/plans/transient-plotting-crescent.md v2.1

---

## 2026-05-15 — Decision G: substrate gates consult channel-coordination state via shared read-only primitives

```yaml
---
ts: 2026-05-15T15:05:00Z
kind: architectural
severity: major
phase: 5
affects:
  - src/channels/identity-context.ts
  - src/channels/peer-recent-message.ts
  - src/hooks/checks/teammate-idle-reminder.ts
  - dotfiles src/hooks/checks/session-collision-gate.ts (parallel-by-design per INVERSIONS B5 ARCH-3 deferral)
---
```

**Context:** Two substrate gates fire on legitimate channel-coordinated sibling work because the gate's input model is incomplete. `session-collision-gate` (PreToolUse Edit/Write) sees a peer's heartbeat on a shared artifact and BLOCKs with 30-min cooldown — but when both sessions are participants in an open channel coordinating on that artifact, the BLOCK is operator-noise, not protection. `teammate-idle-reminder` (UserPromptSubmit) treats stale-heartbeat (>5 min) as a recovery-required signal — but when a peer's most-recent channel message is a deliberate-standby kind (`standby` / `roger` / `out` / `digest`), the stale heartbeat is by-design, not by-crash.

Per `feedback-self-monitoring-is-architectural.md`: when a substrate-gate's input model is wrong on legitimate work, the fix belongs in the substrate (sharpen the input model), not at the operator layer (instruct users to dismiss false-fires). Lived evidence 2026-05-15 cycle: 5+ false-fires across both gates during a single triage day, each requiring operator attention to evaluate-and-dismiss.

**Options considered:**

1. **Substrate gates consult channel-coordination state via shared read-only primitives (CHOSEN)** — add `isPeerCoordinatedWithSelf` (extension of `channels/identity-context.ts`) and `getMostRecentPeerKind` (new `channels/peer-recent-message.ts`) as read-only substrate primitives, then thread them into the two consuming gates. Failure-mode preserved: any helper throw is caught internally; gates fall back to their pre-coordination behavior.
2. Operator-side bypass — document the false-fire pattern in operator runbook and instruct dismissal. Lower implementation cost; preserves the operational tax (~5 false-fires/cycle per lived evidence). Loses substrate-discipline.
3. Per-gate ad-hoc channel inspection — each gate independently reads channel metadata + `messages.jsonl`. Duplicates read-shape across gates; risks divergence; no shared validation surface.
4. Wider redesign of session-presence as channel-anchored rather than artifact-anchored — large blast radius; out-of-scope for L161 + L146 bundle; would also pull in active-sessions module-state canonicalization (deferred per INVERSIONS B5 ARCH-3).

**Chosen:** Option 1.

**Reason:** Shared substrate primitives — `isPeerCoordinatedWithSelf` (artifact-collision lens) + `getMostRecentPeerKind` (idle-state lens) — let both gates consult channel-coordination state without duplicating read-shape or owning channel-metadata semantics. The primitives are read-only (zero locks, zero writes), safe to call inside the gates' existing lock contexts. Helper throw is caught internally + breadcrumb'd via `appendPresenceFailure` — gates fall back to their pre-coordination behavior under any helper fault, preserving conservative-by-default failure mode. Option 2 (operator bypass) was the prior state and is what generated the lived false-fire evidence; the substrate is the load-bearing fix surface.

**Operationalized:**

- `src/channels/identity-context.ts` — new named export `isPeerCoordinatedWithSelf(selfSessionId, peerSessionId) → { coordinated: boolean; channelIds: readonly string[] }`. 4-line scan over `getIdentityContextForSession(self).peers[].session_id`. Returns `channelIds` so callers can surface the coordinating channel id in their formatted messages.
- `src/channels/peer-recent-message.ts` (NEW) — tail-reads peer's most-recent message on a channel, bounded by `MAX_TAIL_BYTES = 256 KB` and `MAX_TAIL_LINES = 500` (RE-2 fold — observed line lengths reach ~3 KB; a 100-line window can exceed 64 KB). Drops partial first line if byte-cap cut mid-record; drops trailing line without `\n` (potentially mid-append). Re-uses canonical `isChannelMessage` validator. Returns `{ kind, ts } | null`.
- `package.json` — new exports entry `./channels/peer-recent-message`. `./channels/identity-context` entry already present (Lane A.1 is additive within the same module).
- `src/hooks/checks/teammate-idle-reminder.ts` — standby-state gate inserted after clock-skew, before rate-limit. `STANDBY_KINDS = {standby, roger, out, digest}` per RE-5 fold (NOT `done` — non-canonical; NOT `over` — transient mid-message). Suppression emits `kind: "standby-suppressed"` `PresenceFailureKind` breadcrumb (new union member) + bypasses the rate-limit cursor write so subsequent non-standby kinds fire immediately.
- Dotfiles `src/hooks/checks/session-collision-gate.ts` (parallel-by-design canonical) — downgrades BLOCK → warn when ALL collision-peers are channel-coordinated. Mixed-peer collisions retain BLOCK with per-peer `(channel-coordinated)` / `(uncoordinated)` annotation in the formatted message body (ARCH-2 fold). Plugin-side mirror retained in lock-step for the eventual `active-sessions` canonicalization commit.

**Cross-edge note:** `session-collision-gate` is dotfiles-LOCAL canonical per INVERSIONS B5 ARCH-3 deferral — the active-sessions module-state canonicalization remains deferred. Bundled-registrations dispatcher routes Edit/Write PreToolUse to the dotfiles file. `teammate-idle-reminder` is plugin canonical (per bundled-registrations cross-edge import from `claude-conductor/hooks/checks/teammate-idle-reminder`).

**Failure-mode preservation:** both gates retain conservative fail-open / fail-closed semantics per their existing contracts. `isPeerCoordinatedWithSelf` returns `{ coordinated: false, channelIds: [] }` on any read failure; `getMostRecentPeerKind` returns null. Either result preserves the pre-coordination behavior (BLOCK on collision; fire on idle). New behavior is purely additive: the substrate gate has a coordinated-work-is-legitimate path it didn't have before.

**Audit cadence:** Plan v1 multi-lens (Architecture + Reliability + Knowledge System; 8 MAJOR + 9 MINOR folded into v2) → Plan v2 sibling cross-audit (Bravo; RATIFIED with 4 nice-to-haves noted) → V3 fold caught at execution (session-collision-gate is dotfiles-local canonical; added Lane B' mirror) → Round 3 cross-audit on staged full diff (CONVERGENT-CLEAN). Plan: `~/.claude/plans/sibling-coord-gate-awareness.md` v2.

**Supersedes / superseded_by:** Decision G is additive — no prior Phase-5 decision is superseded. References Phase 5's substrate-discipline thesis (per the Phase 5 SHIPPED 2026-05-07 closure above) and the active-sessions canonicalization (INVERSIONS B5 ARCH-3) which remains deferred.
