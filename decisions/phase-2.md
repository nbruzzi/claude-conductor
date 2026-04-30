<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision Log — Phase 2

Per-entry schema (same as `phase-1.md`):

```yaml
---
ts: <ISO-8601>
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: 2
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

## 2026-04-29 — Decision A: Wave 1 mid-phase audit verdict on Slice 4

```yaml
---
ts: 2026-04-29T22:55:00Z
kind: architectural
severity: minor
phase: 2
affects: [src/hooks/checks/channels-gc-reaper.ts, src/channels, decisions]
---
```

**Context:** Slice 4 (`channels-gc-reaper`) merged to plugin main `2e75d6b` and dotfiles main `436e1ad`. Per plan `~/.claude/plans/prismatic-orbiting-mesh.md` REV 2.2 §Audit cadence + implementation plan `~/.claude/plans/lovely-dreaming-willow.md` REV 1.2 §Wave 1 audit, the Wave 1 mid-phase audit (Reliability + Architecture personas, scope = reaper-as-shipped-in-Slice-4) dispatched immediately after merge.

**Audit results:**

| Lens         | Score    | Verdict                             |
| ------------ | -------- | ----------------------------------- |
| Reliability  | 8.4 / 10 | HEALTHY — fold findings into Wave 2 |
| Architecture | 8.4 / 10 | HEALTHY — fold findings into Wave 2 |

Both clear the SHIP threshold (≥ 8 / 10 each lens). No CRITICAL findings; no HOTFIX or REVERT. Bounded integration loop NOT triggered (cap was 3 rounds; 0 rounds needed).

**Findings folded into Slice 10 Wave 2 batch:**

- **RE-1 [major]** — `listChannels()` silently filters channels with corrupt/unreadable metadata; orphan sentinels in such channels are unreachable to the reaper. Fix: top-level `readdirSync` walk fallback OR extend `listChannels` to return placeholder for unreadable dirs.
- **RE-2 [major]** — Duplicate breadcrumbs from `unlinkIdentitySentinelOrLogOrphan` inner primitive + reaper's outer `appendPresenceFailure`. Up to ~2,016 duplicate entries per stuck orphan over the 7-day suppression marker TTL. Fix: caller-provided `suppressLog` flag on the primitive OR check `.reaper-acked` freshness inside the primitive.
- **RE-3 [medium]** — Race-detection breadcrumb tmp file leak ≤ 30 s on killed reaper process. Acceptable as-is; bounded by `LOCK_STALE_MS` cutoff in `sweepStaleTmpFiles`. Documented + accepted.
- **RE-4 [medium]** — Long-paused (>90 s) claimer can violate own-sentinel-before-unlink discipline. Documented in source; gate is a soft probabilistic bound. Wave 2 enhancement: cross-check `markedClaim.session_id` against active-sessions registry as stronger liveness signal.
- **RE-5 [minor]** — Test coverage gap on EACCES/EBUSY/EROFS/ENOSPC paths (deferred to live verification per plan REV 1.2). Fix: add `bun:test` cases that monkeypatch `INTERNAL.unlinkSentinel` to throw + assert recovery hint + marker creation + repeat-suppression.
- **RE-6 [minor]** — `parseClaim` accepts unknown extra fields silently. Forward-compat acceptable; backlog post-Phase-2.
- **ARCH-1 [major]** — Plugin `bundled-check-names.ts` and `bundled-registrations.ts` JSDoc count comments said "19" while actual array length is 21 (5 session-start + 10 pre-tool-use + 3 post-tool-use + 3 stop). Dotfiles `check-names.ts` said "Bundled (18)". Reinforces case for closing deferred sibling-parity meta-test (vault `wiki/backlog.md` c7a5738) NOW. Both miscounts fixed in post-Wave-1 cleanup commit; sibling-parity meta-test still deferred to Wave 2 / Slice 10.
- **ARCH-2 [minor]** — `parseClaim` (channels-gc-reaper.ts:434) reimplements claim shape validation that `findExistingClaim` (identity.ts:564) also does ad-hoc. No shared `validateIdentityClaim` primitive. Lift into shared module before Slice 7 lands or this becomes a 4-reader problem.
- **ARCH-3 [minor]** — Cursor at `<channel-dir>/gc-reap/cursor` is a single file, while sibling per-sid cursors live at `identity-emit/<sid>.json` (Slice 5) and `last-seen/<sid>.json` (Slice 8). Defensible per-channel rate-gate scope, but pattern divergence may confuse future maintainer. Add inline comment in source.
- **ARCH-4 [minor]** — Reconcile breadcrumb omits heartbeat-age signal needed for permanent-orphan operator triage when `permanent-metadata-orphan-reap` (deferred backlog item) graduates. Wave 2 fold-in: extend reconcile-candidate breadcrumb with `heartbeat_age_ms` derived from active-sessions registry.

**Strengths verified:**

- 90-s mtime gate (3 × `LOCK_STALE_MS`) correctly threaded through both phases.
- Sweep-phase three-way invariant re-check (metadata absence + metadata mtime + sentinel content equality) all present and ordered correctly.
- `mkdirSync(..., { recursive: true })` closes EEXIST race for cursor dir creation (RE-8 closure).
- `sweepStaleTmpFiles` closes RE-10 (claimIdentity + reaper tmp leak recovery).
- Lock-acquire failures caught at both phase boundaries; routed to presence-failure-log without bubbling.
- `.reaper-acked` marker fresh-check fires BEFORE unlink (preserves stuck-orphan suppression).
- Atomic-wiring discipline confirmed symmetric across plugin (4 atomic + tests + 2 export-additions) and dotfiles (5 atomic). Plugin merge `2e75d6b` (22:50:36 -0400) + dotfiles merge `436e1ad` (22:50:48 -0400) — 12-second window, well inside the 60-s safety margin.
- ARCH-3 closure: lock-domain inline comments are reciprocal (channels-gc-reaper.ts module docstring + channels/index.ts:289 export-site warning).
- Profile choice `["standard", "strict"]` matches identity-injector precedent. `channel-gc`'s `["minimal", "standard", "strict"]` is a deliberate divergence (channel-gc has zero substrate-mutation risk; reaper unlinks files).
- Live verification: planted orphan in `/tmp/test-live-2688/test-ch/identities/Foxtrot` (mtime 2 days old) → reaper unlinked + emitted `[channels-gc-reaper] reaped channel=test-ch letter=Foxtrot` + cursor file written under `gc-reap/`. End-to-end working in production substrate.

**Chosen:** Phase 2 mid-phase health declared HEALTHY. Slice 4 ships as-is on plugin main + dotfiles main; ARCH-1 cleanup committed post-Wave-1; remaining 9 findings routed to Slice 10 Wave 2 audit batch.

**Reason:** Both audit lenses scored ≥ 8 / 10 with no findings classified as CRITICAL or HOTFIX. The shipped code is correct on the happy path and on every documented race; the open findings are quality / observability / forward-compat improvements, not correctness gaps. Concentrating their resolution in Slice 10's full-Phase-2 audit batch (Wave 2) avoids slice-level audit churn and lets Slice 7 + Slice 8 land independently.

**Supersedes / superseded_by:** N/A.

---

## 2026-04-29 — Decision B: Atomic-wiring memory amendment caught stale during Slice 4 audit (ARCH-1 round 1)

```yaml
---
ts: 2026-04-29T22:30:00Z
kind: tooling
severity: minor
phase: 2
affects:
  [
    memory/-Users-nbruzzi/feedback-atomic-wiring-discipline.md,
    ~/.claude/plans/prismatic-orbiting-mesh.md,
  ]
---
```

**Context:** Earlier in this session (pre-Slice-4 plan), `feedback-atomic-wiring-discipline.md` was amended to add `package.json:exports` map as an explicit step in plugin-side wiring (recurrence guard against the 2nd missed exports-map miss this phase). The amendment also expanded the dotfiles-side wiring list to 6 files, naming `src/hooks/registry.ts` as the 5th file ("+1 entry to the static PRE_TOOL_USE / POST_TOOL_USE / SESSION_START / etc. metadata array").

The ARCH-1 finding of the Slice 4 plan-mode audit caught that this amendment was wrong: dotfiles `src/hooks/registry.ts` is a 40-LOC shim with no static metadata array (the substrate moved to runtime registration via `RegistryBuilder.seal()`). The correct dotfiles wiring count is 5 files, not 6.

**Options considered:**

- (a) **Fix only the plan §Slice 4 §Files inline** — narrowest scope; leaves the memory wrong.
- (b) **Fix the memory + plan §Slice 4 §Files + plan §Slice 7 §Files (Bravo's lane)** — corrects both the source (memory) and the consumer (plans) before either Slice 4 or Slice 7 implementer reads stale state.
- (c) **Plus fix dotfiles `check-names.ts` JSDoc count drift** — extends scope to the broader pre-existing drift that ARCH-1 also surfaced (Slices 5 + 6 didn't update the count comment).

**Chosen:** (b) for the memory + plans (post-ExitPlanMode cleanup, completed before plugin branch was cut); (c) deferred to a small post-Wave-1 cleanup commit on top of Slice 4 merges.

**Reason:** The memory + plan amendments must precede any branch work so that Bravo's Slice 7 implementation reads the corrected canonical wiring list. The dotfiles `check-names.ts` JSDoc drift is pre-existing (Slices 5 + 6 introduced it) and the dotfiles RegistryBuilder is not narrowing-typed against `CheckName`, so the staleness has been silent and behaviorally inert. Folding the comment-fix into Wave 1 cleanup is cheap and removes the misleading map without re-scoping the broader `Bundled (21) vs Bundled (19)` drift, which the deferred sibling-parity meta-test (vault c7a5738) is the load-bearing detector for.

**Supersedes / superseded_by:** Memory amendment supersedes the prior REV 1 of `feedback-atomic-wiring-discipline.md` (REV 2 with corrected count + recurrence-log entry).

---

## 2026-04-29 — Decision C: Wave 2 terminal audit verdict + finding dispositions

```yaml
---
ts: 2026-04-29T23:30:00Z
kind: architectural
severity: major
phase: 2
affects:
  [
    src/channels,
    src/hooks/checks,
    docs/architecture,
    docs/operations,
    scripts/check-bundled-registrations-parity.sh,
    CHANGELOG.md,
  ]
---
```

**Context:** Per `~/.claude/plans/lovely-dreaming-willow.md` REV 2.1 §10.A, the Wave 2 terminal audit dispatched 3 personas (Reliability + Architecture + CLI DX) on the full Phase 2 diff `v0.1.0-phase-1.5..main` (plugin) plus the corresponding dotfiles diff. Input set per ARCH-6 closure: (a) Phase 1 Wave 2 carryovers from `[0.1.0-phase-1.5]`; (b) Phase 2 Wave 0 plan-time findings; (c) Phase 2 Wave 1 deferrals from Decision A; (d) Phase 2 Slice 8 round-2 deferrals from `gilded-sweeping-cormorant.md` REV 1.2.

**Audit results (Round 1):**

| Lens         | Score    | Verdict                                                       |
| ------------ | -------- | ------------------------------------------------------------- |
| Reliability  | 8.2 / 10 | FOLD — 1 HIGH + 4 MAJOR; no CRITICAL                          |
| Architecture | 8.0 / 10 | FOLD — 3 MAJOR + 1 MEDIUM; no CRITICAL                        |
| CLI DX       | 7.6 / 10 | FOLD with HOTFIX gate — 1 CRITICAL doc-lie + 2 HIGH + 1 MAJOR |

CLI DX score under SHIP threshold (≥ 8 / 10) but verdict is FOLD-with-HOTFIX-gate per CLI DX persona's own classification: the CRITICAL is a documentation-vs-implementation gap (CLAUDE_CONDUCTOR_DISABLE_HOOKS), not a correctness regression. Round-3 CRITICAL exhaust matrix path (b) "CRITICAL architectural — HALT tag + escalate to Nick" NOT triggered: the CRITICAL is fixable as a doc strike + per-hook recovery hint (Option B per Nick 2026-04-29 sign-off), not as architectural rework.

**Round 2 NOT triggered.** Threshold-not-met findings are all fold-now-eligible per §10.B disposition criteria; integration round resolves them. Per parent plan §Audit cadence + §10.C cap: bounded loop closes after a single round when remaining gaps fold cleanly.

**Disposition table** (CLI-9 closure schema — `Finding ID | Source (Persona / Round / Wave) | Disposition | Rationale | Fold-now SHA OR Backlog ref`):

| ID                | Source (Persona / Round / Wave) | Disposition                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fold-now SHA OR Backlog ref                                    |
| ----------------- | ------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| RE-W2-1           | Reliability / R1 / Wave 2       | deferred Phase 3                             | listChannels silently drops corrupt-metadata channels; orphan sentinels in such channels are unreachable to the reaper. Continuation of Wave 1 RE-1. Substrate-amendment — listChannels is a primitive consumed by 5+ Phase 2 hooks; broadening its return contract risks behavior change in identity-context, channel-gc, identity-injector mid-closure-slice. Fold to Phase 3 first slice as part of `unreachable-channels-substrate` work.                                | wiki/backlog.md `unreachable-channels-substrate`               |
| RE-W2-2           | Reliability / R1 / Wave 2       | accepted-as-documented                       | Heartbeat-clock-skew breadcrumb checks heartbeat freshness via mtime, but the gate is bounded by `LOCK_STALE_MS`. Documented in source. Fold would require time-source-of-truth refactor (substrate-amendment, > 30 LOC). Backlog Phase 3.                                                                                                                                                                                                                                   | wiki/backlog.md `clock-skew-tsot`                              |
| RE-W2-3           | Reliability / R1 / Wave 2       | fold-now                                     | Duplicate breadcrumbs from `unlinkIdentitySentinelOrLogOrphan` inner primitive + reaper outer `appendPresenceFailure`. Continuation of Wave 1 RE-2. Fix: caller-provided `suppressLog` flag on the primitive. ~15 LOC.                                                                                                                                                                                                                                                       | `[INTEGRATION-SHA]`                                            |
| RE-W2-4           | Reliability / R1 / Wave 2       | deferred Phase 3 (consolidates ARCH-W2-2)    | parseClaim 4-reader (channels-gc-reaper.ts + identity.ts + 2 sites in identity-injector). Lift `validateIdentityClaim` primitive into `src/channels/claim.ts`. ~40 LOC across 4 files; behavioral equivalence (literal extraction). Defer to Phase 3 first slice as part of `claim-validation-primitive-lift` — closure-slice should minimize behavior-changing refactors even when behaviorally equivalent, since 4 readers + new module surface = non-trivial test impact. | wiki/backlog.md `claim-validation-primitive-lift`              |
| RE-W2-5           | Reliability / R1 / Wave 2       | accepted-as-documented                       | Cross-slice race rate-gate: SessionStart hook reaper sweep + cursor TTL prune share metadata-lock domain. Empirically documented in Wave 1; behavior bounded by `LOCK_STALE_MS`. Fold would re-architect lock-domain composition. Backlog Phase 3.                                                                                                                                                                                                                           | wiki/backlog.md `lock-domain-composition`                      |
| ARCH-W2-1         | Architecture / R1 / Wave 2      | fold-now                                     | (a) Bundled count drift recurrence detector miss — bundled-check-names.ts JSDoc says (21) but parity script doesn't enforce. (b) identity-context source name lie — emits `source: "channels-identity"` but check is `identity-injector`. ~10 LOC.                                                                                                                                                                                                                           | `[INTEGRATION-SHA]`                                            |
| ARCH-W2-2         | Architecture / R1 / Wave 2      | deferred Phase 3 (consolidated with RE-W2-4) | parseClaim 3-reader — same finding as RE-W2-4 from a different lens. Routed to the same `claim-validation-primitive-lift` Phase 3 backlog item.                                                                                                                                                                                                                                                                                                                              | wiki/backlog.md `claim-validation-primitive-lift`              |
| ARCH-W2-3         | Architecture / R1 / Wave 2      | fold-now                                     | check-bundled-registrations-parity.sh doesn't cover (1) bundled-check-names.ts symmetry, (2) dotfiles `<event>.order.ts` ORDER constants, (3) cross-edge count agreement, (4) JSDoc count freshness. Extend script. ~30 LOC.                                                                                                                                                                                                                                                 | `[INTEGRATION-SHA]`                                            |
| ARCH-W2-4         | Architecture / R1 / Wave 2      | fold-now                                     | Substrate subdir naming inconsistency (`gc-reap` vs `last-seen` vs `identity-emit`) + idle-emit/ subdir undocumented. Fix: documented in `phase-2-hooks.md` runbook substrate table (Slice 10.F). Naming rename deferred Phase 3.                                                                                                                                                                                                                                            | `[RUNBOOK-SHA]` + wiki backlog `substrate-rename`              |
| CLI-W2-1          | CLI DX / R1 / Wave 2 (CRITICAL) | fold-now                                     | `CLAUDE_CONDUCTOR_DISABLE_HOOKS` documented in `docs/architecture/hooks-layer.md` but NOT IMPLEMENTED — `grep -rn` returns zero hits in src/. Per Nick 2026-04-29 sign-off (Option B): strike doc claim + per-hook recovery hints in runbook. ~5 LOC doc + per-hook hints land in Slice 10.F runbook. Universal kill-switch = Phase 3 first slice.                                                                                                                           | `[INTEGRATION-SHA]` + Phase 3 backlog `dispatcher-kill-switch` |
| CLI-W2-2          | CLI DX / R1 / Wave 2 (HIGH)     | fold-now                                     | `forget-cursor` + `show-cursor` Slice 8 verbs added to channels CLI but missing from `TOP_LEVEL_HELP`. ~5 LOC.                                                                                                                                                                                                                                                                                                                                                               | `[INTEGRATION-SHA]`                                            |
| CLI-W2-7a         | CLI DX / R1 / Wave 2 (HIGH)     | fold-now                                     | `docs/architecture/hooks-layer.md` says breadcrumb path is `~/.claude/.presence-failure-log` but `presence-failure-log.ts` writes to `~/.claude/logs/.presence-gate-failures.log`. Operator-runbook-load-bearing — wrong path = wrong tail. ~3 LOC.                                                                                                                                                                                                                          | `[INTEGRATION-SHA]`                                            |
| CLI-W2-3          | CLI DX / R1 / Wave 2            | fold-now                                     | Hooks don't reference own off-switch in error messages or breadcrumbs. Closed by Slice 10.F runbook per-hook recovery hints (verified by Bravo).                                                                                                                                                                                                                                                                                                                             | `[RUNBOOK-SHA]`                                                |
| Slice-8 RE-13     | Slice 8 R2 carryover / Wave 2   | fold-now (CHANGELOG)                         | tag-message placeholder leak protection. Pre-cap script grep covers BOTH `CHANGELOG.md` AND `tag-message-draft.txt`. Already integrated into Slice 10 plan REV 2.1; verified at cap-commit time.                                                                                                                                                                                                                                                                             | `[CAP-COMMIT-SHA]`                                             |
| Slice-8 RE-14     | Slice 8 R2 carryover / Wave 2   | fold-now (smoke)                             | smoke-common.sh extraction validation. Pre-extraction reference output captured; post-extraction must be identical + `bash -n` parse-check on all three smoke scripts. Closed in Slice 10.E.                                                                                                                                                                                                                                                                                 | `[SMOKE-COMMIT-SHA]`                                           |
| Slice-8 RE-15     | Slice 8 R2 carryover / Wave 2   | fold-now (tag)                               | Push-main vs tag-merge race. Closed by Step 4.5 re-verify origin/main == HEAD immediately before tag in Slice 10.G procedure.                                                                                                                                                                                                                                                                                                                                                | `[TAG-PROC-SHA]`                                               |
| Phase-1 W2-1      | Phase 1 carryover / Wave 2      | accepted-as-documented                       | Wave 2 carryover RE-W2-1 from `[0.1.0-phase-1.5]` — already folded in Phase 2 Slice 0/1+2/3 surfaces. Verified closed.                                                                                                                                                                                                                                                                                                                                                       | Closed pre-Wave-2                                              |
| Phase-1 W2-2      | Phase 1 carryover / Wave 2      | accepted-as-documented                       | Wave 2 carryover RE-W2-2 — folded into Phase 2 Slice 0 DieContext threading. Verified closed.                                                                                                                                                                                                                                                                                                                                                                                | Closed pre-Wave-2                                              |
| Phase-1 W2-3      | Phase 1 carryover / Wave 2      | accepted-as-documented                       | Wave 2 carryover RE-W2-3 — partial closure via Slice 0; full closure depends on Wave 2 RE-W2-3 fold-now (above).                                                                                                                                                                                                                                                                                                                                                             | `[INTEGRATION-SHA]`                                            |
| Phase-1 W2-4      | Phase 1 carryover / Wave 2      | accepted-as-documented                       | Wave 2 carryover RE-W2-4 — folded into Phase 2 Slice 1+2 reaper substrate. Verified closed.                                                                                                                                                                                                                                                                                                                                                                                  | Closed pre-Wave-2                                              |
| Phase-1 ARCH-W2-7 | Phase 1 carryover / Wave 2      | accepted-as-documented                       | Wave 2 carryover ARCH-W2-7 — folded into Phase 2 Slice 3 NATO identity primitive. Verified closed.                                                                                                                                                                                                                                                                                                                                                                           | Closed pre-Wave-2                                              |
| Phase-1 CLI-W2-4  | Phase 1 carryover / Wave 2      | deferred Phase 4+                            | Slash-command path convention — public-launch boundary concern. Deferred per `[0.1.0-phase-1.5]` rationale. Not relevant to Phase 2 closure.                                                                                                                                                                                                                                                                                                                                 | wiki/backlog.md `slash-cmd-path-convention`                    |

**Bravo verification round (Slice 10.D):** `[PENDING — channel signal at integration-commit-SHA + 30-min ack timeout]`. Per RE-3 closure, Bravo's findings will be appended here as `Verified by Bravo (channel ts: <ts>)` rows. If Bravo unavailable: HALT-not-proceed; options per RE-3 (wait / re-dispatch subagent / escalate).

**Chosen:** Phase 2 terminal audit verdict = SHIP-AFTER-INTEGRATION. 11 fold-now items consolidate to ~80 LOC across ~6 commits on `phase-2-slice-10-wave-2-integration` branch. 2 deferred-Phase-3 (RE-W2-1, RE-W2-4 + ARCH-W2-2 consolidated) routed to Phase 3 first-slice backlog. 2 accepted-as-documented (RE-W2-2, RE-W2-5) routed to Phase 3 backlog. 1 deferred-Phase-4+ (Phase-1 CLI-W2-4). 5 Phase-1 carryovers verified closed pre-Wave-2.

**Reason:** All 3 lenses cleared the integration-fold path (no CRITICAL architectural blockers; the 1 CLI DX CRITICAL is a doc-vs-implementation gap with a sub-30-LOC recovery-hint fix). The deferred-Phase-3 findings are substrate-touching primitives whose extension or refactor risks behavior change in a closure slice — Phase 3 starts immediately after the tag with these as focused first slices. The accepted-as-documented findings are larger substrate amendments. The fold-now batch fits cleanly into Slice 10's tractable scope while resolving the substantive Wave 2 quality gaps. Decision C is finalized after Bravo verification + integration-commit SHAs land.

**Supersedes / superseded_by:** Closes the Wave 1 deferrals enumerated in Decision A (RE-1, RE-2, ARCH-2, ARCH-3, ARCH-4 routed to fold-now or backlog per disposition table above).

---
