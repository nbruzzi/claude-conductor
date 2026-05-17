---
name: feedback-audit-findings-prefix-distinguishes-mode
description: Audit findings need prefix conventions that distinguish mode-2 (challenge the frame) from mode-1 (verify the work). Current MINOR-X / MAJOR-X / CRITICAL-X is severity-only and mixes both modes. Add PREMISE-X / REFRAME-X / SCOPE-X / DEFAULT-X for mode-2 findings; they trigger different disposition processes (replan vs adjust) and must not be folded with mode-1 tactical adjustments.
type: feedback
cadence: stable
scope: global
updated: a referenced date
origin: extracted
---

Audit findings carry two orthogonal axes: **severity** (MINOR / MAJOR / CRITICAL) and **mode** (downstream verification / upstream challenge). Current convention only marks severity. Mixing modes under one prefix family causes mode-2 findings to be folded with mode-1 tactical adjustments — the severity reads matched, the disposition process doesn't. See [[feedback-audit-upstream-vs-downstream-posture]] for the framework; this memory is the prefix convention.

## The prefix table

### Mode-1 findings (downstream verification — verify the work)

| Prefix              | Severity | Trigger                                      | Disposition                    |
| ------------------- | -------- | -------------------------------------------- | ------------------------------ |
| `MINOR-<LENS>-N`    | minor    | small adjustment within accepted frame       | PR-author-time fold            |
| `MAJOR-<LENS>-N`    | major    | substantial adjustment within accepted frame | v2 fold OR PR-author-time fold |
| `CRITICAL-<LENS>-N` | critical | implementation flaw blocking ship            | BLOCK + fix                    |

`<LENS>` is one of `RE` / `ARCH` / `DX` / `WF` (domain lens). Severity follows existing convention.

### Mode-2 findings (upstream challenge — challenge the frame)

| Prefix       | Targets                                                         | Disposition                                    |
| ------------ | --------------------------------------------------------------- | ---------------------------------------------- |
| `PREMISE-N`  | challenges an assumption baked into the plan                    | accept → replan; defer → next-cycle backlog    |
| `REFRAME-N`  | proposes a different design shape                               | accept → v2 reauthoring; defer → backlog       |
| `SCOPE-N`    | proposes bundle composition change (add / cut / swap)           | accept → bundle recomposition; defer → backlog |
| `DEFAULT-N`  | proposes a different default action / behavior                  | accept → behavior change; defer → backlog      |
| `SEQUENCE-N` | proposes a different ordering (this before X, or X before this) | accept → reschedule; defer → backlog           |

### Catastrophic class (rare; cuts across modes)

| Prefix                 | Trigger                                                    | Disposition              |
| ---------------------- | ---------------------------------------------------------- | ------------------------ |
| `BLOCK-CATASTROPHIC-N` | data loss / security / irreversible damage discovered late | halt cycle + renegotiate |

`BLOCK-CATASTROPHIC` is the only mode-2 finding allowed at per-PR / pre-merge stages — by definition, framing flaws that surface this late and have catastrophic blast radius can't wait.

### Disposition-default-per-kind table (Session A DEFAULT-1 fold a referenced date)

Each mode-2 kind has a different cost-of-carrying-wrong and therefore a different default disposition when accepted. Knowing the default avoids a "what now?" lap when the finding lands. Override when the specific case warrants it.

| Kind         | Default disposition when accepted | Cost-of-carrying-wrong rationale                                                                                            |
| ------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PREMISE-N`  | **FOLD or REFRAME-PLAN**          | Assumptions are cheap-to-flip if caught early. If the assumption is load-bearing across the plan, escalate to REFRAME-PLAN. |
| `REFRAME-N`  | **REPLAN**                        | Carrying a wrong design shape compounds — every downstream decision pivots on the shape. Replan early.                      |
| `SCOPE-N`    | **REPLAN**                        | Bundle-scope is upstream of all in-bundle work; getting it wrong invalidates whatever was about to ship.                    |
| `DEFAULT-N`  | **FOLD**                          | Tactical decision in a defined surface; flip the default + add a test case.                                                 |
| `SEQUENCE-N` | **FOLD**                          | Resequence is usually cheap (reorder steps; no re-architecture). Escalate only if dependencies block.                       |

Worked-example mapping from today's L141 cycle (mode-2 misses that, if surfaced, would have warranted):

- SCOPE-1 (bundle scope: swap L496 for canary) → **REPLAN** (re-score the 4-item bundle composition)
- DEFAULT-1 (L141 mismatch default: live alternative vs derived) → **FOLD** (flip default + add 1 test case)
- PREMISE-1 (L496 closure framing: keep open as tracer vs close) → **FOLD** (reframe entry shape without changing plan structure)

The disposition-default makes the auditor → plan-author handoff cleaner: "SCOPE-N accepted → REPLAN" is a single signal, no negotiation lap.

## Why the prefix matters

Three reasons distinct prefixes are load-bearing:

### 1. Different disposition processes

- Mode-1 findings flow into the existing fold pipeline: v2 fold (if architectural) or PR-author-time fold (if tactical). The plan-author or PR-author absorbs the finding and applies it.
- Mode-2 findings flow into a DIFFERENT process: replan or scope-recomposition or behavior-change-decision. The disposition isn't "apply a small change" but "renegotiate the framing." If they're mixed under MINOR/MAJOR prefixes, they get treated as fold-adjustments and the renegotiation never happens.

### 2. Cross-cycle traceability

A `PREMISE-1` finding filed in plan v1 audit, deferred to next cycle, can be greped across channel history as a deferred-mode-2-finding. Same prefix = same kind of work = traceable across cycles. Mixed prefixes lose this.

### 3. Severity-vs-mode confusion

A `MINOR` mode-2 finding (the framing is slightly off; small reframe) and a `MAJOR` mode-1 finding (significant implementation defect within the accepted frame) look comparable in severity but require completely different decision processes. The prefix needs to carry both axes.

## Example findings (illustrative — drawn from today's cycle)

### Mode-1 (downstream) examples

```
MINOR-RE-2 (L141 cross-audit):
  L141 resolver kind union missing `body-parse-failed`. No code path returns
  this kind — pure-shape parser either matches or doesn't. Recommend remove
  from type (1-line fix; mode-1 tactical).
  Severity: minor (cosmetic dead-code).
  Disposition: v2 fold (architectural, affects test coverage).

MAJOR-ARCH-1 (hypothetical L141):
  L141 resolver imports `readMetadata` from `./index.ts` directly instead of
  via `./api.ts` curated surface. Breaks the cross-edge re-export contract.
  Severity: major (sibling-parity break for downstream consumers).
  Disposition: v2 fold (architectural; pre-execution).
```

### Mode-2 (upstream) examples

```
SCOPE-1 (L141 plan v1 audit, missed today):
  4-item bundle includes L496 (already-fixed-just-verify; pure test add) but
  excludes substrate canary (`dotfiles-worktree-provisioner` missing
  `bun install`; sev-2 latent; blocks worktree-launched cross-edge).
  Alternative shape: swap L496 OUT, canary IN. Same item count; higher value;
  addresses active operational tax.
  Cost-benefit: 4-item bundle stays the same size; LOC budget shifts toward
  substrate (~80 LOC vs ~120 LOC); audit lens-pass count increases by 1
  (substrate lens). Net: higher leverage, similar effort.
  Disposition: requires bundle renegotiation OR explicit defer-to-next-cycle.

DEFAULT-1 (L141 plan v1 audit, missed today):
  When `mismatch-body-has-live-alternative` fires, default action "join
  derived channel anyway" is conservative-preserving-existing-flow. But user
  invoked `/handoff-resume parallel` SPECIFICALLY because peers are active
  elsewhere; live alternative is almost certainly intended target.
  Alternative shape: default to live alternative; render derived as fallback
  option with one-key opt-back. Non-magical in both cases (alternative is
  named explicitly; user can switch back).
  Cost-benefit: same render code; flips the default branch.
  Disposition: behavior change in v2.

PREMISE-1 (L496 plan v1 audit, missed today):
  Closure framing ("verify-then-close, not fix-then-close") assumes bug is
  closed. Primary-source shows zero dual-write lines historically, but bug
  fired empirically twice in 2026-05. No closing SHA found. May be
  conditional on something unverified. Alternative: keep entry open as
  tracer + add regression test. Future occurrence reads as "recurrence of
  L496" rather than "new bug."
  Cost-benefit: backlog entry stays open (cheap); recurrence-attribution
  preserved.
  Disposition: closure decision deferred OR keep-open with trigger.
```

## How to write a mode-2 finding properly

Mode-2 findings require **concrete alternative + cost-benefit**. "I have concerns" is not a finding. Format:

```
<PREFIX-N> (<plan-name or PR-N>):
  <one-paragraph statement of the assumption / shape / scope / default being
   challenged>
  Alternative shape: <concrete proposal — what would the design / scope /
   default look like if changed?>
  Cost-benefit: <what's the trade-off matrix? At least 2 axes — implementation
   cost, blast radius, operational value, sibling-parity, time-to-ship, etc.>
  Disposition: <what disposition is the auditor recommending? accept-fold,
   defer-to-backlog with trigger, BLOCK-and-renegotiate>
```

The concrete-alternative requirement is the mitigation for "bikeshedding the framing." A mode-2 finding that can't propose a specific alternative isn't a finding — it's noise.

## The synthesis report shape

When an auditor returns findings, the report should have separate mode-1 and mode-2 sections:

```
## Audit-result — <plan or PR>

**Verdict:** <SHIP-CLEAN | SHIP-WITH-FOLDS | BLOCK | REPLAN-NEEDED>

### Mode-1 findings (downstream verification)

#### Lens 1 — RE
- MINOR-RE-1: ...
- MINOR-RE-2: ...

#### Lens 2 — Architecture
- MAJOR-ARCH-1: ...

#### Lens 3 — CLI DX
- (no findings)

#### Lens 4 — Workflow
- MINOR-WF-1: ...

### Mode-2 findings (upstream challenge)

#### Premise / Scope
- SCOPE-1: ...
- PREMISE-1: ...

#### Default-action
- DEFAULT-1: ...

#### Alternative-shape / Sequence
- (no findings)

### Disposition recommendations

- v2 folds (architectural): MAJOR-ARCH-1, MINOR-RE-1
- PR-author-time folds (tactical): MINOR-RE-2, MINOR-WF-1
- Replan triggers: SCOPE-1
- Behavior-change decisions: DEFAULT-1
- Defer-to-backlog with trigger: PREMISE-1 (trigger: <criterion>)
```

The separation in the report mirrors the separation in disposition. A reader scanning the report sees mode-2 findings as a distinct class — they don't blur with the MINOR-X fold list.

## Severity-vs-mode matrix (when applied carelessly)

A common failure: tagging a real mode-2 finding as `MINOR-ARCH-N`. The finding looks tactical; it gets folded into v2 as a code change; the underlying framing question never gets renegotiated.

Example mis-tag:

> ~~MINOR-ARCH-1: rename CLI verb from `which-channel-from-handoff` to `resolve-handoff`. Better matches verb-style.~~

Actually mode-2 (REFRAME-N), not mode-1 (MINOR-ARCH). The verb name is a design-shape decision — it affects test names, skill bash, sibling consumers. Re-tag:

> REFRAME-1: verb name `which-channel-from-handoff` breaks the existing terse verb pattern (`from-handoff`, `meta`, `create`, `join`, `send`, `peers`). Alternative: `resolve-handoff`. Cost-benefit: half the keystrokes; matches existing style; back-compat preserved by keeping `from-handoff`. Disposition: v2 reauthoring (affects test names + skill bash).

The fix in code is identical. The disposition is different — REFRAME-1 forces explicit acknowledgment that a design-shape decision was just changed, vs MINOR-ARCH-1 sliding it into the fold list.

## How to apply

### For the auditor

- [ ] Tag every finding with the right prefix family — `<SEVERITY>-<LENS>-N` for mode-1; `<MODE>-N` for mode-2.
- [ ] Mode-2 findings: include concrete alternative + cost-benefit explicitly.
- [ ] Synthesis report: separate mode-1 and mode-2 sections.
- [ ] Disposition recommendation per finding: name the process (fold / replan / behavior-change / defer-with-trigger).

### For the disposition-decider (plan-author / PR-author)

- [ ] Read mode-1 and mode-2 sections separately. Different decision processes.
- [ ] Mode-2 disposition committed = sticky for the cycle. Don't reopen except for new evidence.
- [ ] Deferred mode-2 findings file as backlog entries with the explicit trigger criterion.

### For the cross-cycle reader

- [ ] Grep channel history for `PREMISE-` / `REFRAME-` / `SCOPE-` / `DEFAULT-` / `SEQUENCE-` to find deferred mode-2 findings from prior cycles.
- [ ] Cross-reference with current backlog to see which ones became next-cycle entries vs were dropped.

## Cross-references

- [[feedback-audit-upstream-vs-downstream-posture]] — the framework this memory operationalizes
- [[feedback-audit-request-framing-by-stage]] — sibling-operational memory on how the REQUESTER invites the right mode
- [[feedback-three-lens-audit-convergence]] — the domain-lens convention the mode-1 prefix extends
- [[feedback-bounded-reaudit-on-critical-fix-delta]] — adjacent: when severity changes after fix, the re-audit boundary
