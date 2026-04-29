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
