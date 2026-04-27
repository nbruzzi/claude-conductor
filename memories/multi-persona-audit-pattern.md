---
name: Multi-persona audit + verification loop as final planning phase
description: For substantial plans, always commission 2-3 domain-expert personas to audit the plan adversarially from distinct lenses, integrate findings, then run a verification loop where each persona re-checks their own findings before ExitPlanMode
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

For any substantial plan (architecture-level, system-design-level, or > ~800 words), the final phase before `ExitPlanMode` is a **three-persona adversarial audit + verification loop**. This is not optional polish — it's how plans go from "good" to "ceiling," and without the verification loop the audit becomes performative.

**Why:** During a content-architecture plan refinement, a multi-pass cloud-Claude refinement timed out and the capturing user suggested trying three distinct expert-persona audits. The first audit pass surfaced ~38 findings across SEO/GEO, framework architecture, and marketplace operator lenses — real gaps that a single-pass "push for ceiling" audit had missed, including the single biggest technical miss (a framework-version-specific feature). The capturing user then asked: _"Should the auditors review that you actually implemented (properly) what they found/suggested?"_ — which is the load-bearing follow-up. Without verification, the assistant can claim "I integrated all findings" and there's no way to know if the fixes addressed them correctly, misread the finding, or half-fixed it.

**How to apply:**

**Phase 1 — Audit commissioning (before `ExitPlanMode`):**

1. **Triggers:** Plan is architecture/system-design level, or plan file is > ~800 words, or the task has significant blast radius (migrations, refactors that touch many files, API redesigns, new feature areas). Trivial plans (one-line fixes, small utilities) don't need this.
2. **Choose 2–3 personas matched to the plan's risk surface.** The personas are not generic reviewers — they're specific experts whose lenses intersect with the plan's critical dimensions:
   - Database migration plan → DBA + reliability engineer + data engineer
   - API redesign → platform architect + API consumer + security reviewer
   - Refactor plan → performance engineer + maintainability advocate + tests-first TDD person
   - Frontend feature plan → senior frontend engineer + UX designer + accessibility advocate
   - Content architecture plan → SEO/GEO strategist + frontend architect + marketplace/business operator
   - Choose personas to maximize lens diversity, not overlap.
3. **Three is the right number.** Two risks mono-lensing. Four+ gets diminishing returns. Three forces distinct perspectives without bloat.
4. **Each audit is written cold, adversarial stance.** Not validating, not congratulatory. If the audit sounds like it's praising the plan, it's failing. The prompt for each persona: "Red-team this plan from your expert lens. What's wrong, what's missing, what's the biggest risk, what would you change before shipping?" Score the plan honestly (e.g., 6.5/10, 8/10) — this prevents inflation.
5. **Present findings structured per persona:** each gives a score, lists strengths, lists specific gaps with enough detail to act on, proposes fixes.
6. **Synthesize cross-cutting themes** after presenting individual audits — the pattern across multiple auditors is more signal than any single finding.

**Phase 2 — Integration:**

1. The user chooses scope of integration (all findings, priority subset, minimum must-fix).
2. Integrate findings into the plan file. Be explicit about which finding each edit addresses.
3. Do NOT claim "addressed" without being specific. Say what the fix IS, not just that there is one.

**Phase 3 — Verification loop (the load-bearing step):**

1. **Each persona re-reads ONLY their own findings.** Not the whole plan again — overhead waste.
2. **Each finding gets a binary judgment:** _addressed correctly_ / _not addressed or addressed wrong_.
3. **"Not addressed correctly" gets a one-paragraph explanation** of what's still broken and what would actually fix it.
4. **All "not addressed" items must be resolved before `ExitPlanMode`.** No hand-waving "we'll get to it later."
5. **The verification pass is bounded — typically 1 round, hard cap 3.** Additional rounds permitted when (a) the integration substantially changed the audited surface (new sections/components that the first verification couldn't have judged) or (b) findings were partially-addressed and a second integration pass should be re-verified. The anti-pattern blocked is **cyclical** verification (same scope re-verified looking for new gaps — that's where infinite loops live); the legitimate pattern allowed is **scope-expanded** verification (genuinely new content added in a follow-on integration pass needs verifying). Document the reason for any round beyond the first in the audit transcript header. **Why this loosening:** the capturing user, after the assistant cited "One round only" as a blocker for re-verifying contracts that had been added in a second integration pass: _"I disagree with this. Yes, we have spoken about (and I am against falling into) cyclical audits. But sometimes it is necessary to audit more than once... I have seen you need three rounds."_ The single-round framing was too rigid; it conflated "no cyclical loops" with "no follow-on verification ever," which prevented genuinely-warranted second rounds on substantively-changed surfaces.
6. **Honest self-scoring during verification:** report the count of correctly-addressed vs half-fixed vs deferred. Users should see the ratio. A session reporting "all 38 findings addressed" after a large integration pass is almost certainly lying or performative — real integration work has ~20–25% half-fix rate that the verification catches.

**Why the verification loop matters specifically:**

- Prevents performative integration (claiming a finding was addressed when the fix missed the point)
- Catches misreading of the original finding (fixing the wrong thing)
- Forces specificity about HOW the fix addresses the finding, not just THAT it exists
- Same adversarial stance that caught the gap can catch a half-fix
- Bounded so it doesn't turn into infinite review theater

**What the verification loop is NOT:**

- Not a re-audit of the whole plan (that's a second audit phase, different tool)
- Not optional
- Not a chance to add new findings (if an auditor surfaces something new during verification, it goes on a follow-up list, not back into the current loop)
- Not done mentally — each persona's verification is a written pass with binary per-finding judgment

**Practical guidance:**

- Budget 15–25% of planning time for the audit + verification phase
- If budget is tight, cut the number of personas from 3 to 2, not the verification loop
- The verification loop is cheaper than the first audit because each persona only re-checks their own findings, not the whole plan
- If more than 30% of findings fail verification, something is wrong with the integration process — slow down and be more careful
- This pattern is persistent across all substantial planning work, not project-specific

**Extension — terminal full-diff audit for multi-phase build work:**

The pattern above covers planning audits. Multi-phase build work needs a **second discipline**: after the last implementation phase, run a separate terminal audit on the **full cumulative branch diff**, not on any single phase's additions. Per-phase audits during the build catch slice-local hazards; the terminal audit catches accumulation hazards that only exist in composition. This is orthogonal to the planning audit — both are necessary for ceiling-quality infrastructure shipping.

Validated on a real multi-phase feature PR (six phases): five per-phase audits shipped clean. The terminal full-diff audit caught two real production hazards (a non-atomic sentinel write, and a push-diagnostic priority inversion that misreported slow auth failures as timeouts) that were structurally invisible to per-phase audits because each phase only saw its own additions. Both fixed in-branch before merge.

Tell terminal-audit personas explicitly: "Audit the full branch diff end-to-end, not individual slices. Look for hazards that only exist in the composition." Without that framing they default to per-slice review and the terminal phase's value evaporates. See `feedback-phased-audit-remediation-arc.md` for the full template.

**Extension — sibling-symmetry pre-flight for parallel-trio components:**

Both planning and terminal full-diff audits use a "diff vs base" lens — which silently misses sibling drift when a feature PR sits open while main lands sibling-pattern changes (the base then includes the sibling's changes, so the audit sees the pattern as "present" without ever comparing the two siblings against each other). For any audit (planning or merge-time) on a plan/PR that touches a known parallel-trio component, run a **sibling-symmetry pre-flight** before commissioning auditors:

1. **Detect parallel-trio components.** Maintain a registry of known sibling-component pairs in the project. Extend the registry when a third trio appears.
2. **Load the sibling-on-main as reference.** Read the sibling component's full source from `origin/main` HEAD.
3. **Compute symmetry-deltas** across imports, helper signatures, observability tags, doc-graph edges, test scaffolding.
4. **Inject the symmetry-delta summary into auditor dispatch context** — not as a generic prompt but with the actual deltas — and explicitly instruct auditors to flag structural asymmetry as findings.
5. **Bias selection toward Architecture lens** (+5 weight when pre-flight fired).

Validated on a real instance: three days after a Phase 6 terminal full-diff audit closed, an inline sibling-parity audit at merge time caught a real cross-attribution bug — one half of a parallel-trio pair was missing presence-aware deferral that the other half had received from a sibling-pattern PR while the branch sat open. The Phase 6 audit didn't catch this because by then the sibling PR was on the base; "diff vs base" never compared the two siblings against each other.

The skill encoding lives at the bundled audit skill's `Step 1.5`. The same trigger logic and pre-flight discipline applies to direct-Agent-dispatch audits outside the skill — see `feedback-sibling-parity-at-merge-time.md` for the cross-context lesson.
