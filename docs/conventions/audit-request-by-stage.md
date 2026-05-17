<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Audit-request templates by stage

**Scope:** operator + developer reference for how to frame an audit-request body so the audit-skill commissions the right mode-mix at the right stage. Sibling to `docs/conventions/message-kinds-and-verification.md`. Operational source for the per-stage templates that `feedback-audit-request-framing-by-stage.md` rationalizes.

Plan: `~/.claude/plans/twinkling-nibbling-gosling.md` v2 (L:508 audit-request-convention-doc lane).

## Why this exists

The audit-REQUESTER controls which mode the auditor runs by how the ask is framed. **Default-when-unspecified is mode-1 (downstream verification)**, so silence on mode-2 closes that door — the requester must open it explicitly when mode-2 is appropriate for the stage.

The two modes (per `memories/feedback-audit-upstream-vs-downstream-posture.md`):

- **Mode-1 — downstream verification.** "Given this design, is the implementation correct?" Probes within the accepted frame.
- **Mode-2 — upstream challenge.** "Is the frame right? What's the unstated alternative? What scope/default/sequence is being silently accepted?" Probes the frame itself.

Stage determines which mode-mix applies. The `/audit` skill's Step 0 reads the stage from the audit-request body; Step 2's 2-pool selection model (domain + posture pools per `agents/audit/registry.md`) picks auditors accordingly.

## The ask-fields every audit-request should carry

Regardless of stage, every audit-request body should specify:

1. **Stage** — `pre-plan-write` / `plan-v1` / `plan-v2-locked` / `per-PR` / `pre-merge-Lane-D` / `post-merge-retrospective`
2. **Mode mix** — mode-2 dominant / mode-2 + mode-1 / mode-1 only / mode-1 with mode-2 deferred
3. **Lenses** — which domain auditors + (optionally) posture auditors from the 2-pool registry
4. **Specific questions to push on** — concrete probes the requester wants answered
5. **Out-of-scope** — things the requester is NOT asking for (settled framing, deferred concerns, scope-locked decisions)
6. **Disposition gate** — what triggers replan vs fold vs defer-to-backlog

When mode-2 is in scope, also include:

7. **Mode-2-specific invitations** — "challenge the framing on X axis"; "push on the default action for Y"; "what's the adjacent item to Z we should consider?"

## Stage-by-stage templates

### Pre-plan-write (mode-2 dominant)

The plan doesn't exist yet. The auditor pushes against the would-be shape. Goal: arrive at a plan worth writing.

```
Pre-plan audit request — <topic>

Stage: pre-plan-write (nothing committed yet)
Mode mix: mode-2 dominant; mode-1 deferred until plan v1
Lenses: Premise/Scope (posture pool) + Architecture-upstream + Workflow-upstream

Context: <2-3 sentences on the problem space + what triggered the consideration>

Mode-2 challenges to push on:
1. Premise — is this the right problem to solve right now? What's the cost of not doing it?
2. Scope — what's the bundle composition? What's adjacent that should be included? What's marginal that should be cut?
3. Sequence — should this come before or after <X in-flight work>?
4. Alternative shape — what's the design option not under consideration?

Out-of-scope: implementation details (no plan to verify yet); existing-decision re-litigation on <X>.

Disposition gate: outputs feed plan v1 authoring. PREMISE/SCOPE findings shape the plan; nothing blocks since nothing's built.

Cadence: post findings with the framework's prefix convention (PREMISE-N / SCOPE-N / REFRAME-N / DEFAULT-N / SEQUENCE-N for mode-2; MINOR-X / MAJOR-X / CRITICAL-X for mode-1).
```

### Plan v1 cross-audit (mode-2 + mode-1 mix)

A draft exists. The auditor probes both the frame and the implementation surface. **Last cheap window for reframe.**

```
Plan v1 cross-audit request — <plan path>

Stage: plan-v1 (draft committed; nothing built; rewrite is cheap)
Mode mix: mode-2 + mode-1; mode-2 findings trigger v2 fold or BLOCK
Lenses: RE + Architecture + CLI-DX + Workflow + Premise/Scope (5 lenses; pre-plan-mode-2 dominant) — Pool A domain + Pool B all 5 posture auditors

Plan: <path>

Mode-2 invitations (push on these explicitly):
1. Premise — is the problem-framing right? What assumption baked into this plan, if wrong, invalidates it?
2. Scope — is the bundle composition right? Lowest-yield item to cut? Highest-yield adjacent item to absorb?
3. Default-action — for every behavior marked "default," is it the conservative default or the right default?
4. Alternative shape — what's the design option not under consideration?
5. Best-of-breed — given 2-4 named alternatives for each architectural choice, what's best across substrate-aligned axes?

Mode-1 lens-specific questions:
1. RE — <concrete failure-mode questions>
2. Architecture — <concrete decomposition questions>
3. CLI DX — <concrete surface questions>
4. Workflow — <concrete integration questions>

Out-of-scope: <items where framing is settled by upstream constraint>

Disposition gate:
- PREMISE / REFRAME / SCOPE accepted → v2 fold (architectural) OR BLOCK + replan
- DEFAULT accepted → behavior change in v2
- SEQUENCE accepted → fold to v2
- MINOR-X accepted → v2 fold (if architectural) OR PR-author-time fold (if tactical)

Cadence: post audit-result with separated mode-1 / mode-2 sections; aggregate score.
```

### Plan v2 / plan-locked (mode-1 dominant; mode-2 deferred)

Plan is committed; both peers agreed to the framing. Mode-2 findings now require BLOCKER class to land in-cycle.

```
Plan v2 (locked) confirmation request — <plan path>

Stage: plan-v2-locked (framing settled; mode-2 cost is now expensive)
Mode mix: mode-1 dominant; mode-2 only if BLOCKER class
Lenses: RE + Architecture + CLI-DX + Workflow (Pool A domain only; Pool B posture gated to 0-1 if BLOCKER suspected)

Plan: <path>

Mode-1 lens-specific questions:
1-4: <see plan-v1 template>

Out-of-scope: framing changes (settled at v1 cross-audit per <channel ts / body_ref>); scope changes (settled); default-action changes (settled).

Mode-2 escape hatch: if you discover a CATASTROPHIC framing flaw (data loss / security / irreversible), surface as BLOCK-CATASTROPHIC. Otherwise file as next-cycle backlog entry with explicit trigger.

Disposition gate:
- MINOR-X / MAJOR-X → fold per severity
- BLOCK-CATASTROPHIC → halt + renegotiate
- Anything else mode-2 → next-cycle backlog

Cadence: post audit-result; mode-2 backlog files separately if any surface.
```

### Per-PR audit (mode-1 only; mode-2 → backlog)

PR is open. Reframe at this stage costs rebase + restart. Mode-1 is the entire scope.

```
PR #<N> cross-audit request — <PR title>

Stage: per-PR (post-plan-v2-lock; pre-merge)
Mode mix: mode-1 ONLY; mode-2 findings file as backlog, do not block
Lenses: RE + Architecture + CLI-DX + Workflow (4 lenses; Pool A domain only; Pool B = 0)

PR: <URL>
Head SHA: <sha>
Diff: gh pr diff <N>

Mode-1 lens-specific questions:
1-4: <concrete questions tied to diff>

Out-of-scope:
- Framing changes (settled at v1; v2 land confirmed disposition)
- Scope changes (item is in-bundle by ratification)
- Default-action changes (settled)
- New mode-2 reframes — file as next-cycle backlog with explicit trigger

Disposition gate:
- SHIP-CLEAN / SHIP-WITH-FOLDS / BLOCK
- Mode-2 backlog entries land at PR merge time (not blocking)

Cadence: post audit-result with SHIP verdict.
```

### Pre-merge Lane D STRICT GATE (mode-1 only; no mode-2 even as backlog)

Final gate. "Can we ship this safely?" is the only question. Mode-2 at this stage = redirect to next cycle entirely.

```
Lane D STRICT GATE request — PR #<N>

Stage: pre-merge (last gate before squash)
Mode mix: mode-1 only; no mode-2 in any form
Lenses: 9-cell Lane D convergence per established convention; Pool B = 0

PR: <URL>
Head SHA: <sha>
Diff: <since-last-audit>

Final-verification questions:
1. CI green? Run IDs?
2. Pipeline locally clean? typecheck/format/lint/test?
3. Test coverage matches plan?
4. No regression to surrounding surface?
5-9: <Lane D specifics>

Out-of-scope: everything mode-2; everything that isn't "is this safe to ship as-is"

Disposition gate:
- CONVERGENT-CLEAN → squash + merge
- DIVERGENT → halt + investigate
```

### Post-merge retrospective (mode-2 + mode-1; lessons → next cycle)

Triggered by end-of-cycle reflection, operator-flagged miss ("this work wasn't audited"), or bootstrap-exception closure. The work is shipped; mode-1 findings become NEW backlog entries (regression tests, surface improvements); mode-2 findings become NEXT-CYCLE scope-setters.

```
Post-merge retrospective request — <cycle name / artifact>

Stage: post-merge retrospective
Mode mix: mode-2 + mode-1
Lenses: standard 4-lens (RE / Architecture / CLI-DX / Workflow) + Premise/Scope (Pool B = 1-2 posture, SCOPE + SEQUENCE typically)
Trigger: <end-of-cycle reflection | operator-flagged miss | bootstrap-exception closure>

What shipped: <PR list with squash SHAs + main-CI conclusions>
What the artifact carries: <substrate change / framework codification / feature shipped>

Mode-2 invitations (the load-bearing axis at this stage):
- PREMISE: was the underlying assumption right? If wrong, what should we do differently next time?
- REFRAME: did the design shape match the actual problem? Is there a better shape we'd choose if we did this again?
- SCOPE: was the bundle composition right? What did we under-scope (canary, etc.)? Over-scope?
- DEFAULT: were the conservative defaults the right choice? Or did we ship a wrong-default that's now load-bearing?
- SEQUENCE: was the ordering right? Did dependent work run before what it depended on?

Mode-1 lens-specific questions:
- Tests to add in hindsight?
- Edge cases now visible in main that weren't in the diff?
- Surface regressions to neighboring code?
- Cross-edge contracts that drifted?

Discipline-lesson axis (load-bearing for bootstrap-exception case):
- Was a pre-write audit-gate structurally available and skipped? If so, what's the lesson?
- Was the gate structurally unavailable (bootstrap)? If so, what's the first-cycle ratification shape?

Out-of-scope: reverting shipped work; folding mode-2 into shipped diffs (next-cycle backlog instead).

Disposition gate:
- SCOPE-class miss → file P0 next-up backlog entry
- DEFAULT-class miss → file fold candidate
- PREMISE-class miss → file concept page / memory amendment
- REFRAME-class miss → file as next-cycle scope-setter (may trigger re-plan of next cycle)
- SEQUENCE-class miss → file as ordering lesson
- Mode-1 findings → NEW backlog entry (regression test / surface improvement)
- Discipline lesson → handoff body section + memory fold if recurring class
```

## Self-audit framing

Self-audit (auditor and requester are the same session) inherits the same templates. Add a posture self-check:

- "Am I about to mode-1-only because I wrote the plan and don't want to challenge it?"
- "If a sibling wrote this exact plan, what would I push on as mode-2?"
- "What's the most defensive assumption baked into my own framing?"

Self-mode-2 is uncomfortable by design — fighting confirmation bias. If self-audit at pre-plan / plan-v1 doesn't surface any mode-2 findings, that's a signal the self-audit wasn't actually adversarial. Default presumption: my own draft has mode-2 issues I can't see; force the cognitive move.

## Anti-patterns to spot in audit-requests

Phrases that indicate the requester is silently closing mode-2 (or not framing the stage explicitly):

- **"Standard 4-lens"** — domain-only; mode-1 implicit. At pre-plan / plan-v1, this is wrong shape — extend to include Pool B posture auditors.
- **"Push back if I'm wrong about X"** — invites mode-1 on X but closes mode-2 on the rest.
- **"Audit when convenient; no rush"** — silent on stage + mode; auditor defaults to mode-1 verification.
- **"Quick read; 5-min job"** — caps audit budget at mode-1 only; mode-2 doesn't fit a 5-min budget.

**Fix:** every audit-request body should include the stage + mode-mix explicitly. Silence on either field defaults to "per-PR + mode-1 only" — which is wrong for the first 80% of the cycle.

## Cross-references

- `memories/feedback-audit-upstream-vs-downstream-posture.md` — the mode-1/mode-2 framework this convention operationalizes
- `memories/feedback-audit-request-framing-by-stage.md` — sibling rationale memory (design + decision history; this convention doc is the operational extract)
- `memories/feedback-audit-findings-prefix-distinguishes-mode.md` — finding-prefix convention auditors use to signal mode
- `agents/audit/registry.md` — 2-pool selection model (domain + posture) referenced by stage tables above
- `skills/audit/SKILL.md` Step 0 + Step 4 — imports templates from this doc at commission time
- `commands/session/channel.md` — sibling-coord channel reference; audit-request templates surface for peer-coord dispatch
