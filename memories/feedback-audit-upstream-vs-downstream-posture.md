---
name: feedback-audit-upstream-vs-downstream-posture
description: "Every audit has two modes — upstream (challenge the frame — is this the right problem/shape/scope/default?) and downstream (verify the work — is implementation correct?). Current convention (RE/Arch/CLI-DX/Workflow per feedback-three-lens-audit-convergence) is downstream-by-construction. Add a Premise/Scope lens, sequence upstream-before-downstream, signal mode-2 findings with PREMISE-X / REFRAME-X prefix, and bound mode-2 to pre-plan + plan-v1 stages to prevent late-cycle bikeshedding. Sibling-coord shift, not just an auditor change."
type: feedback
cadence: stable
scope: global
updated: a referenced date
origin: extracted
---

## The rule

Every audit has two modes that probe different surfaces. Both must fire when the audit happens at a stage that supports both, and the **upstream pass must run before the downstream pass**. The default current convention runs only the downstream pass, which inflates confidence in the wrong things.

- **Mode 1 — Downstream verification.** "Given this design, is the implementation correct? Are tests adequate? Edge cases handled? Race conditions covered?" The lens probes within the accepted frame. Risk-narrow, scope-narrow, sunk-cost-friendly.
- **Mode 2 — Upstream challenge.** "Is this the right problem to solve? Is the design shape right? What's the unstated alternative? What scope are we accepting that we shouldn't? What's the conservative default that may be the wrong default?" The lens probes the frame itself. Risk-wide, scope-wide, sunk-cost-hostile.

## Why this matters — the structural blind spot

The current 4-lens convention from `feedback-three-lens-audit-convergence` (Reliability Engineer / Architecture / CLI DX / Workflow) is mode-1 by construction. Each lens asks "is X correctly done?" — none ask "is X the right thing to be doing?" The convention's strength (distinct domain coverage per `feedback-distinct-lenses-over-repeat-verifications`) is real, but it's distinct coverage at the SAME level of abstraction. Three or four mode-1 lenses still leave the frame unchallenged.

`feedback-distinct-lenses-over-repeat-verifications` already named the lens-diversity axis at the SHAPE level (grep / typecheck / audit / smoke — different failure-mode shapes). This memory adds the orthogonal LEVEL axis: each shape can probe at the FRAME level (mode-2) or the IMPLEMENTATION level (mode-1). The current convention covers shape-diversity at one level; it doesn't cover level-diversity within shapes.

When mode-2 is missing, the failure mode is **convergent acceptance** — both peers agree on the design (one wrote it, the other only audited the implementation), neither challenged the frame, the design ships unchallenged. Reframes that should have happened pre-plan don't happen at all; they surface weeks later as "we should have done X."

## The two modes — definitions + examples

### Mode 1 — Downstream verification

**Question shape:** "Given the design as stated, is X correctly handled?"

**Examples:**

- RE-downstream: "Are race windows closed? Is rollback idempotent? Do error paths recover gracefully?"
- Architecture-downstream: "Is file org clean? Are imports correct? Does the cross-edge surface match the documented contract?"
- CLI-DX-downstream: "Is the error message ergonomic? Is the help text accurate? Does the verb name follow the existing style?"
- Workflow-downstream: "Is the skill bash integration clean? Are tests adequate? Does the pipeline pass?"

**When correct:** the frame is settled (the operating user directive, prior cycle ratification, external SLA, plan v2-locked). Late-cycle / per-PR / pre-merge stages. Time budget is tight. Reframe at this stage would be expensive (rebase / restart / scope churn).

### Mode 2 — Upstream challenge

**Question shape:** "Is the frame right? What's the unstated alternative? What scope/default/sequence is being silently accepted?"

**Examples:**

- RE-upstream: "Is the race-condition framing right? Should this be eventually-consistent instead of strongly-consistent? Is rollback the right shape, or should it be forward-fix only?"
- Architecture-upstream: "Is the module decomposition right? Should this be one fewer file? One more? Should this even be a CLI verb, or a flag on an existing verb? Should this be a hook instead?"
- CLI-DX-upstream: "Is the verb-vs-flag distinction right? Should the default action be the conservative one (current) or the user-intent-aligned one (alternative)? Should this surface return text or structured JSON?"
- Workflow-upstream: "Is the workflow shape right? Should this be in the skill or a hook? Should it run at plan-mode or session-start? Is the cadence right?"

**Premise/Scope (a fifth pure-mode-2 lens):**

- "Is the bundle the right scope? What's the lowest-yield item we could cut? What's the adjacent item just outside the bundle that's higher-yield than the lowest in-bundle item?"
- "What assumption is baked into this plan that, if wrong, makes the whole bundle wrong?"
- "What would NOT building this look like? What would 80% of this look like? What would 200% look like?"
- "Should this come before or after some other in-flight work?"

**When correct:** pre-plan-write, plan v1 cross-audit, plan v2 if not yet locked. The framing is still cheap to change. Time budget supports exploration.

## Sequencing across stage-gates

| Stage                                      | Mode mix                                      | Reframe cost   | Reframe-finding action          |
| ------------------------------------------ | --------------------------------------------- | -------------- | ------------------------------- |
| Pre-plan-write                             | **mode-2 dominant**                           | nearly free    | revise scope / shape            |
| Plan v1 cross-audit                        | **mode-2 + mode-1**                           | cheap (v1→v2)  | fold to v2 OR replan            |
| Plan v2 / plan-locked                      | mode-1 dominant; mode-2 only if BLOCKER class | expensive      | BLOCK → renegotiate             |
| Per-PR audit                               | mode-1 only; mode-2 deferred to next cycle    | very expensive | NEW backlog entry               |
| Pre-merge Lane D STRICT GATE               | mode-1 only                                   | catastrophic   | revert + replan                 |
| **Post-merge retrospective** (SCOPE-3 add) | **mode-2 + mode-1**; mode-2 surfaces lessons  | sunk           | NEW backlog entry + memory fold |

**Post-merge retrospective** is the 6th stage (folded a referenced date from Session A SCOPE-3 mode-2 challenge against the framework itself; the retroactive audit on Session B's framework codification was exactly this stage). Trigger: end-of-cycle / handoff-write / post-merge reflection. The cost of reframing is sunk (work shipped) but mode-2 findings here become **next-cycle scope-setters**: SCOPE-class miss → file as P0 next-up; DEFAULT-class miss → file as fold candidate; PREMISE-class miss → file as concept page / wiki entry. Mode-1 findings at this stage are typically "what tests should we have added in hindsight?" → NEW backlog entry. The retrospective audit is also where bootstrap-exception work (see § "Retroactive audits") gets formally closed.

Why this order matters: **mode-2 first, mode-1 second, within any single audit.** Mode-1-first creates sunk-cost bias — once you've verified that the implementation is correct, you're less willing to challenge the framing. The brain reads "this works" as "this is right." Mode-2 has to fire while the implementation isn't yet load-bearing in your confidence model.

When mode-2 fires AFTER mode-1 in the same audit (today's typical shape), reframe findings get treated as "concerns" rather than "blockers." They get deferred. They become next-cycle backlog. That's downgrading mode-2 by ordering.

## Lens-by-lens upstream/downstream pairs

Each existing domain lens can probe at both levels. The auditor for each lens should explicitly run BOTH passes at stages that support both, marked separately in the report.

### Reliability Engineer

- **Downstream:** atomicity, race windows, idempotence, error-recovery within the stated state shape.
- **Upstream:** is the state shape right? Should this be append-only instead of mutable? Should the failure mode be over-permissive or fail-loud? Is the strong-consistency assumption load-bearing or accidental?

### Architecture

- **Downstream:** module decomposition matches plan; imports clean; cross-edge surface correct; sibling-parity preserved.
- **Upstream:** is THIS the right decomposition? Should this be a CLI verb or a flag? A new file or an extension? A hook or a skill? A library or inline? Should the cross-edge boundary be here or one level up/down?

### CLI DX

- **Downstream:** error messages ergonomic; verb names consistent; help text accurate.
- **Upstream:** should the default action be conservative-or-user-intent-aligned? Is the surface shape right (text vs structured JSON)? Should this expose a new flag or change the existing default?

### Workflow

- **Downstream:** skill integration clean; pipeline gates pass; tests cover the surface.
- **Upstream:** is the workflow shape right? Should this fire at session-start or session-end? At plan-mode or execution-mode? As a hook or a manual skill? Should the cadence be per-cycle or per-arc?

### Premise/Scope (pure mode-2 — no downstream pair)

- "Is the bundle composition right? What's the lowest-yield in-bundle item we could cut? What's the highest-yield out-of-bundle item we should absorb?"
- "What assumption is baked into this plan that, if wrong, invalidates the bundle?"
- "Is this the right cycle for this work? Should it wait for X to land first? Should X wait for this?"
- "What's the cost of NOT doing this? If the answer is 'nothing,' the bundle isn't load-bearing — should it be a backlog entry instead?"

## Concrete upstream-challenge techniques

Five probes that surface mode-2 findings reliably. Apply at pre-plan + plan-v1 stages; deprioritize at later stages.

1. **Premortem framing.** "If this bundle ships and we hate it in 3 months, what's the most likely reason?" Forces the auditor to imagine a failure mode at the framing level, not just the implementation level. Common answers: wrong scope (too much / too little), wrong default behavior, wrong sequencing, missed alternative.

2. **Adjacent-item probe.** "What's the item just outside the bundle that's more valuable than the lowest item in the bundle?" Surfaces scope decisions silently inherited from "what the operating user directed" rather than re-derived from current value. Today's example: L496 (already-fixed-just-verify; pure test) vs substrate canary (sev-2 latent, blocks every worktree-launched cross-edge invocation) — never asked.

3. **Default-action challenge.** "For every behavior described as 'default,' ask: is this the conservative default, or the right default? Conservative defaults preserve sunk-state at the cost of user-intent alignment." Today's example: L141's mismatch case defaults to joining the derived (empty) channel. That's conservative — but user invoked parallel-mode SPECIFICALLY because peers are active; live alternative is almost certainly what they want. Conservative ≠ right.

4. **Inversion.** "If we did the OPPOSITE of this plan, what would we be optimizing for? What does that tell us about what we're trading off?" Surfaces hidden tradeoffs. If the inversion has any merit, the original plan should explicitly defend why it's better.

5. **Cost-of-not-doing.** "What gets worse if we DON'T do this? If 'nothing measurable,' the bundle isn't load-bearing — should it be a backlog-entry-with-defined-trigger instead of an in-cycle ship?"

6. **Best-of-breed comparison.** "Is this the best at what it does? What else is in the space? What's the bun-vs-npm delta against the named alternatives?" Distinct from Inversion (opposite shape) and Cost-of-not-doing (skip entirely) — this is the _substitute-comparison_ probe applied to tool / solution / pattern adoption. The question isn't "should we do this?" but "given we're doing this, is X the best instrument for the job?" Surfaces silent acceptance of the first plausible candidate. Most useful at tool-adoption, library selection, infra choice, abstraction-pattern lift, and pattern-extraction-from-source decisions. Asks the auditor to enumerate 2-4 named alternatives + compare on the axes that matter for the actual workflow (NOT abstract feature-list axes — workflow-specific ones). the operating user's framing (a referenced date): _"Does npm work? Sure. Is bun better, and for which reasons? Yes. Same question applies to every tool/solution: 'Is this even the best at what it does? Are there other/better ways?'"_ Over-fires when: commitment is already settled with sticky upstream cost (migration tax > delta); time-to-research-alternatives exceeds time-to-validate-current-choice; comparative-research becomes its own bikeshedding (5+ candidates explored when 2-3 named would have answered the question). Substrate-aligned application: tools that enter the substrate (per `[[feedback-projects-as-substrate-work]]`) ALWAYS earn this probe — substrate-class adoption is high-leverage + high-cost-to-replace, comparative-research is cheap relative to migration.

## Findings prefix convention

Findings prefix should DISTINGUISH the mode so they don't get folded together. Current convention uses `MINOR-X`, `MAJOR-X`, `CRITICAL-X` for severity — but doesn't distinguish mode.

**Proposed addition:**

- **Mode-1 findings (downstream):** keep current prefix conventions — `MINOR-RE-N`, `MAJOR-ARCH-N`, `CRITICAL-DX-N`, etc.
- **Mode-2 findings (upstream):**
  - `PREMISE-N` — challenges an assumption baked into the plan. Triggers replan if accepted.
  - `REFRAME-N` — proposes a different design shape. Triggers v2 reauthoring if accepted.
  - `SCOPE-N` — proposes a bundle change (add / cut / swap). Triggers bundle recomposition if accepted.
  - `DEFAULT-N` — proposes a different default action / behavior. Triggers behavior-change decision if accepted.

**Why distinct prefixes:** mode-2 findings should never get folded as "minor adjustments at PR-author time." They trigger different decision processes (replan vs adjust). Mixing them with mode-1 findings dilutes the severity signal.

**Cross-cycle visibility:** a finding marked `PREMISE-1` in plan v1 audit, deferred to next cycle, can be traced as a deferred-mode-2-finding in the future-cycle's planning. Same prefix means it can grep across the channel history.

## Audit-request framing

The audit-REQUESTER controls which mode the auditor runs, by how the ask is framed.

### Mode-2-inviting ask (use at pre-plan / plan-v1):

> "Push on the framing — am I solving the right problem? Is the bundle the right scope? Is the design shape right? What's the unstated alternative? Don't only verify the spec — challenge the spec."

### Mode-1-only ask (use at per-PR / pre-merge):

> "Standard Lane D STRICT GATE. Mode-1 verification only — race conditions, edge cases, test coverage, sibling-parity. Mode-2 reframes are deferred to next cycle; surface as backlog if you spot them but don't block on them."

### Stage-explicit ask (best practice):

> "Plan v1 cross-audit. Mode-2 mix expected: PREMISE / REFRAME / SCOPE findings are in-scope and trigger v2 reauthoring. Mode-1 findings fold to v2 if architectural or to PR-author-time if tactical."

The current convention (4-lens per `feedback-three-lens-audit-convergence`) doesn't specify mode in the ask — defaults to mode-1. Adding stage + mode to every audit-request is the operational fix.

## When mode-2 is wrong / counterproductive

Mode-2 is NOT free. Five cases where it's actively wrong:

1. **Framing settled by upstream constraint.** the operating user directed a specific scope, or a prior cycle ratified the design, or an external SLA defines the bounds. Re-challenging settled framing is noise — the auditor should focus on mode-1 within the settled frame. Convention: "we previously decided X" + cite the artifact = mode-2 on X is closed.

2. **Time budget too tight.** Mode-2 expands scope; mode-1 contains it. If the audit has hours not days, mode-1 is the better use of budget. Mode-2 findings would be deferred anyway.

3. **Late stage of cycle.** Per-PR audit and pre-merge gate are mode-1 territory. Reframes at these stages cost rebase + restart and damage cycle momentum. If a mode-2 concern surfaces this late, file as next-cycle backlog and ship the current bundle as-is — unless it's CATASTROPHIC class (data loss, security, irreversible).

4. **Premature pre-plan mode-2.** Before there's even a hypothesis to challenge, mode-2 spins on "what should we build?" without a concrete target. Mode-2 needs a draft to push against. Without a draft, it becomes ideation, not audit.

5. **Final-gate audit.** The pre-merge gate is "verify this is shippable as-is." Mode-2 reframes at this stage are out-of-scope by definition — the question isn't "should we ship this?" but "can we ship this safely?"

## Failure modes of overdone mode-2

Three classes of overdone mode-2, each with a mitigation:

### Bikeshedding the framing

**Symptom:** every audit becomes a fundamental-design debate. Plan v1 → v2 → v3 → v4 in the same cycle. Forward motion collapses into reconsideration loops.

**Mitigation:** **sticky commitments.** When both peers commit to a framing post-mode-2-review, that commitment is sticky — don't reopen unless new evidence surfaces. Convention: "post-plan-v2-lock, mode-2 findings file as next-cycle backlog, not as v3 reauthoring asks."

### Sibling demoralization

**Symptom:** if every plan you write gets fundamentally reframed by the cross-auditor, why write plans? The plan-author's effort becomes throwaway.

**Mitigation:** **concrete-alternative requirement.** A mode-2 finding must include the alternative shape AND a cost-benefit. "I have concerns" is not a finding; "here's the alternative and why it's better than the current design across {axis 1, axis 2, ...}" is. Forces mode-2 findings to be substantive.

### Velocity collapse

**Symptom:** endless reconsideration, no shipping.

**Mitigation:** **stage-gates + budget.** Mode-2 is dominant only at pre-plan + plan v1. After plan-lock, mode-2 findings need BLOCKER class to land in the current cycle. Everything else files as next-cycle backlog. Velocity preserved; mode-2 insights don't get lost.

## Sibling-coord protocol — sticky commitments post-mode-2 review

When both peers complete a plan-v1 mode-2 review and agree on the framing (or explicitly defer mode-2 concerns to next cycle), that's a STICKY commitment. The convention:

1. **At plan v1 cross-audit close**, the auditor signals: "Mode-2 findings: {PREMISE/REFRAME/SCOPE list}; commitment-disposition: {accept-fold | defer-to-backlog | block-and-revise}."
2. **At plan v2 land**, the plan-author confirms the disposition was applied (or explicitly notes which were deferred).
3. **Post-plan-v2-lock**, neither peer reopens the mode-2 findings in the current cycle except for new-evidence BLOCKER class. Deferred mode-2 findings live in backlog with the trigger criteria for next-cycle reconsideration.
4. **At per-PR audit**, mode-2 findings are filed as backlog entries for next cycle, not as PR-author-time folds.

This protocol prevents mode-2 from becoming late-cycle noise while ensuring legitimate reframes land at the right gate.

## Retroactive audits — when mode-2 fires post-build (SEQUENCE-2 fold)

Folded a referenced date from Session A SEQUENCE-2 mode-2 challenge against the framework. The stage table above assumes audits run BEFORE work lands (or at minimum, before merge). But mode-2 findings often surface AFTER work landed — operator-flagged after the fact ("this wasn't audited"), retrospective reflection at handoff-write, post-merge reading of the diff in a different mental state, or — the load-bearing case — when the substrate-rule itself is the audit (bootstrap exception: a framework can't apply itself before it exists).

**Two flavors:**

1. **Bootstrap exception** — the artifact being audited IS the audit-rule being authored. Pre-write audit-gate is structurally impossible because the gate doesn't exist yet. Closure shape: retroactive 2-mode audit by the sibling (or sub-agent, if no sibling available) AFTER landing. First-cycle ratification carries the bootstrap exception; subsequent cycles fall under normal audit-gate discipline. Today's audit-posture framework codification is the canonical bootstrap-exception case: the framework prescribes pre-write mode-2 for substrate-class change, but the framework itself shipped without that gate because the gate didn't exist yet. Session A's 3 mode-2 challenges post-codification + DEFAULT-1 fold + post-merge retrospective audit constituted the retroactive closure.

2. **Operator-flagged miss** — operator surfaces a mode-2 concern after work landed ("ironically, this work wasn't audited"). Closure shape: sibling runs retroactive 2-mode audit using current `post-merge retrospective` stage; surface any findings as either (a) next-cycle backlog filings, (b) fold-into-existing-artifacts if the work is still flexible (memory amendments, skill clarifications), or (c) discipline lesson recorded in handoff body. The retroactive audit's purpose is NOT to revert shipped work; it's to extract the lessons + file actionable next-cycle work.

**Discipline note:** retroactive audits do NOT excuse the missing pre-write gate when the gate was structurally available. If you skipped a pre-write audit-gate that should have fired, the retroactive audit must include an explicit discipline-lesson section pointing at the skip — not just "here's the audit we should have done." The lesson is the meta-finding; the audit findings themselves are content.

**Cross-ref:** `feedback-audit-request-framing-by-stage.md` § "Post-merge retrospective" template (covers the audit-request body for retroactive audits); `feedback-memorialize-then-violate-anti-pattern.md` (related discipline class: rules-shipped-without-applying-themselves).

## Today's concrete examples (a referenced date cycle)

Three mode-2 audit moments I missed (or accepted-without-challenge):

### Example 1 — Bundle composition (SCOPE-class miss)

**Setup:** Session A's plan v1 bundled L141 + L496 + L852 + L488 (4 items). I noted the substrate canary (`dotfiles-worktree-provisioner` missing `bun install`; sev-2 latent) during recon and posted it on channel as flagged. Session A said "keep separate, file as P0 next-up."

**What I did:** accepted. My audit asked Q4: "Substrate canary scope creep — bandwidth or separate?" I argued "separate" using `feedback-substrate-debt-larger-than-slice-scope.md`. Session A agreed.

**What mode-2 would have asked:** "Is the 4-item bundle the right composition? L496 is the lowest-yield item — already-fixed-just-verify; zero production impact; pure test add. The canary is sev-2 latent today, blocks every worktree-launched cross-edge invocation. Should we swap L496 OUT and canary IN? Net: same item count, higher value, addresses an active operational tax. Argument against: substrate work needs different audit cadence (true but inflates bundle by 1 lens-pass, not 4 items). Net-net swap seems favorable."

**Why I missed it:** I treated the bundle as ratified by the operating user's "1-4" directive and only audited within it. The directive was scope-cap, not scope-lock — I converted permission-to-do-4 into requirement-to-do-THESE-4. Mode-2 would have asked: "are these the right 4?"

### Example 2 — L141 default action (DEFAULT-class miss)

**Setup:** L141 design (c): when `mismatch-body-has-live-alternative` fires, render warning + candidate list + default action "join derived channel anyway; user can switch."

**What I did:** Q1-Q4 in my audit confirmed Session A's design choices. Did not challenge the default-action.

**What mode-2 would have asked:** "User invokes `/handoff-resume parallel` SPECIFICALLY because peers are active in another window. When the derived channel is empty AND an alternative is live with peers, the user's intent is almost certainly the live alternative — that's WHY they invoked parallel-mode. The 'join derived anyway' default is conservative (preserve existing flow) but contrary to user intent. Should the default be 'join the live alternative' with an opt-out to derived? Or: surface both and require explicit pick? Or: keep current default but make the switch command auto-typed into the prompt for one-key acceptance?"

**Why I missed it:** I read "non-magical per the operating user's principle" as endorsement of the conservative default. But "non-magical" doesn't mean "conservative" — it means "don't auto-switch silently." Surfacing the alternative + defaulting to it WITH an opt-out is non-magical AND user-intent-aligned. Conservative ≠ right.

### Example 3 — L496 closure vs trace (PREMISE-class miss)

**Setup:** L496 reframed as "verify-then-close, not fix-then-close" by Session A. Primary-source: 1373 messages / 51 channels / 0 dual-write lines historically. Regression test pins behavior.

**What I did:** accepted the reframe. Wrote the regression test. Closed.

**What mode-2 would have asked:** "If the bug fired empirically in 2026-05 (twice, on two different channels) and we can't find a closing SHA, maybe the bug is conditional on something we haven't characterized. The dual-write may return under conditions we don't currently exercise. Should we keep the entry OPEN as a tracer + add the regression test? If the bug returns, the open entry + closed regression test together pinpoint the new condition. Closing it means a future occurrence reads as 'new bug' rather than 'recurrence of L496.'"

**Why I missed it:** the closure framing was already on the table; I focused on the verification rigor (jq scan count, primary-source evidence) — mode-1 surface. Mode-2 would have challenged whether closure was the right disposition at all.

## How to apply — checklist

### For the AUDIT-REQUESTER (plan-author or PR-author)

- [ ] Specify the **stage** in the audit-request (pre-plan / plan-v1 / plan-v2-locked / per-PR / pre-merge).
- [ ] Specify the **mode mix** explicitly (mode-2 + mode-1 / mode-1 only / mode-2 only).
- [ ] If asking for mode-2, **invite challenge to specific axes** — framing, scope, default-action, sequence, alternative.
- [ ] If asking for mode-1 only, **explicitly defer mode-2 to next cycle** to set the auditor's expectation.
- [ ] At plan v2 land, confirm mode-2 disposition (accept-fold / defer-to-backlog / block-and-revise).

### For the AUDITOR

- [ ] **Run mode-2 BEFORE mode-1** within the audit. Read the plan once for framing, once for implementation.
- [ ] For each existing domain lens (RE / Arch / CLI-DX / Workflow), run BOTH the upstream and downstream pass when stage supports it.
- [ ] Add a dedicated **Premise/Scope lens** for pre-plan and plan-v1 audits. This is the pure-mode-2 lens with no downstream pair.
- [ ] **Tag findings by mode:** `MINOR-X` / `MAJOR-X` for mode-1; `PREMISE-N` / `REFRAME-N` / `SCOPE-N` / `DEFAULT-N` for mode-2.
- [ ] **Require concrete-alternative + cost-benefit** for every mode-2 finding. No "I have concerns" — only "here's the alternative shape and why."
- [ ] At late stages (per-PR / pre-merge), surface mode-2 findings as backlog entries, not as PR-author-time folds.

### For the SIBLING-COORD CHANNEL

- [ ] Post audit-request stage + mode mix explicitly.
- [ ] Post audit-result with separated mode-1 vs mode-2 sections.
- [ ] Post mode-2 disposition decisions (commitment commits the cycle to the framing).
- [ ] File deferred mode-2 findings as backlog entries with explicit next-cycle triggers.

## Relationship to existing memory ecosystem

This memory is sibling-class to several existing ones. Key relationships:

- **`feedback-three-lens-audit-convergence`** — established the 4-lens convention (RE / Arch / CLI-DX / Workflow + peer cross-audit). All mode-1 by construction. This memory extends by adding the upstream/downstream split per-lens + a fifth Premise/Scope lens.

- **`feedback-distinct-lenses-over-repeat-verifications`** — established lens-shape diversity (grep / typecheck / audit / smoke — different failure-mode shapes). This memory adds the orthogonal LEVEL axis: each shape can probe at FRAME level (mode-2) or IMPLEMENTATION level (mode-1).

- **`feedback-pattern-recognition-vs-design-intent-verification`** — established that pattern-recognition is inference, not verification. The discipline is closer to mode-2 thinking (challenge whether the implementation matches DESIGN INTENT, not just whether it compiles). This memory generalizes: mode-2 challenges the design intent itself, not just the implementation-vs-intent fidelity.

- **`feedback-pre-execution-empirical-verify-catching-layer`** — established the 5th catching layer (empirical verify of plan-assumptions against current state). Mode-1 in nature (verify the plan's facts). This memory adds: at the same gate, run a 6th mode-2 pass that challenges the plan's framing, not its facts.

- **`feedback-lens-narrow-fix-anti-pattern`** — established "fix at the layer that addresses ALL N symptoms, not just the first visible one." This is the FIX-SCOPE equivalent of upstream challenge. This memory generalizes: mode-2 audits at the design-scope what lens-narrow-fix challenges at the fix-scope.

- **`feedback-multi-persona-audit-pattern`** — multi-persona is a structural way to surface mode-2 (different personas see different framings). This memory makes the upstream/downstream split explicit so personas can be selected to balance both modes.

- **`feedback-ceiling-standard`** — mode-2 IS the ceiling-discipline for audits. Settling for mode-1-only is settling-for-floor.

- **`feedback-distinct-lenses-over-repeat-verifications`** — adjacent + extended. Same author-of-rule shape; same "more carefully" trap; same fix (orthogonal-axis stacking).

- **`feedback-walk-deliverable-graph-before-plan`** — pre-plan mode-2 technique (walking the graph before writing the plan IS upstream challenge of the plan's would-be shape).

- **`feedback-cadence-not-scope-dependent`** — sibling-class but at the cadence layer; audit-mode-mix is the within-audit equivalent of cadence-discipline at the cycle layer.

## Operational tie-in: /audit skill update

The current `/audit` skill (`~/Repos/claude-conductor/skills/audit/SKILL.md`) is downstream-by-construction:

- Step 2 matches auditors by **domain** (architecture, security, performance, DX, etc.) — domain auditors are mode-1 dominant.
- Step 5 synthesizes findings without distinguishing mode.
- No stage-gate sensitivity — pre-plan audit and per-PR audit dispatch identically.

Proposed extension (separately filed in backlog + a draft skill update):

- Add a **posture-auditor pool** to the auditor registry: Premise, Scope, Alternative-Shape, Sequence, Default-Action.
- Add **stage-gate sensitivity** to Step 2 selection: pre-plan calls dominant from posture pool; per-PR calls dominant from domain pool.
- Add **mode-tagged finding section** to Step 5 synthesis: mode-2 findings separately listed with PREMISE/REFRAME/SCOPE/DEFAULT prefix.
- Add **stage-mode-mix** to the audit-request schema: requester specifies stage + mode mix; auditors respect.

Backlog entry filed at vault `wiki/backlog.md`. Skill update is a follow-up cycle's work.
