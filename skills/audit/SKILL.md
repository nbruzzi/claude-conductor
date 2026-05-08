---
name: audit
description: Commission 2-4 expert auditors to adversarially review the current plan. Matches auditors by domain, dispatches in parallel, synthesizes findings, and runs a verification loop.
---

# Audit Board

Commission expert auditors to adversarially review the current plan before implementation begins.

## Step 1 — Locate the plan

Resolve the plan path in this order, stopping at the first hit:

1. **Explicit argument.** If the user ran `/audit <path>`, use that path.
2. **Conversation context.** Scan for a plan file path mentioned in this session (e.g., from plan mode, a `ExitPlanMode` call, or a file the user just wrote).
3. **Default directory.** Look in `~/.claude/plans/` for the most recently modified `.md` file.

If nothing is found, tell the user: "No plan found. Enter plan mode and create a plan, pass a path to `/audit <path>`, or move a plan into `~/.claude/plans/`." Stop.

Once located, record the plan's **size in bytes** and **word count** — both drive decisions downstream.

## Step 1.5 — Sibling-symmetry pre-flight (conditional)

Some plans ship one half of a parallel-trio pattern (e.g., the `vault-*` trio is a parallel sibling of the `dotfiles-*` trio). When such a PR sits open while main moves with sibling-pattern changes, the standard audit lens — "diff vs base" — silently misses parity drift because the base by then includes the sibling's changes, so the audit sees the sibling pattern as "present" and never compares the two siblings against each other. This step adds an explicit sibling-symmetry lens before auditor dispatch.

**Trigger:** the plan content references a known parallel-trio component (registry below). If no match, skip this step entirely and proceed to Step 2.

### Known parallel-trio component pairs

The following pairs are checked at pre-flight. **Extend this list whenever a third-or-later trio appears** (e.g., a future memory-\* sibling trio). Trigger on either side of any pair, in either direction.

- (`dotfiles-sync`, `vault-sync`)
- (`dotfiles-commit`, `vault-commit`)
- (`dotfiles-catchup`, `vault-catchup`)
- (`dotfiles-common`, `vault-common`)

### Plan-mode vs PR-mode triggers

- **Plan-mode** (auditing a plan file before implementation): the parallel-trio reference alone triggers pre-flight. The sibling-on-main is loaded as the reference baseline, since the plan will eventually become a PR that lands.
- **PR-mode** (auditing a branch's diff before merge): pre-flight is **mandatory** if either condition holds — (a) the plan references a parallel-trio component, OR (b) the branch has been open while main has gained 1+ commits touching either side of any registered pair. Check (b) via `git log --oneline <branch-base>..origin/main -- <sibling-file-paths>`.

### Pre-flight actions

When triggered:

1. **Identify the sibling-on-main.** For each detected parallel-trio component in the plan, locate its sibling component file on current `origin/main` HEAD. Read the sibling's full source. This becomes the **sibling-on-main reference** for this audit.
2. **Compute the symmetry-deltas.** Diff key axes between the plan's intended component state and the sibling-on-main:
   - **Imports** — does the plan's component import the same modules as the sibling, in the same shape?
   - **Helper signatures** — are equivalent helpers shaped the same (arg lists, return types, ordering of guards)?
   - **Observability tags** — are warn/log message shapes identical (e.g., `kind=...;count=N;self-known=bool`)?
   - **Doc-graph edges** — does `architecture.yaml` (or equivalent) have the same outbound edges from the plan's component as from the sibling on main?
   - **Test scaffolding** — do equivalent test cases exist (helper plant functions, env-scrub patterns, deferral assertion shapes)?
3. **Bias auditor selection.** When advancing to Step 2, add **+5** to the match score of any auditor whose triggers include `architecture` or `architecture-integration` (the lens most likely to catch structural asymmetry). This nudges Architecture into the selection without overriding other strong matches.
4. **Prepare a `## Sibling-Symmetry Context` attachment for Step 4.** It must include:
   - The detected component pair(s)
   - The symmetry-delta summary from action 2 (one short paragraph per axis with the actual delta, not a generic prompt)
   - An explicit instruction: _"Evaluate sibling parity as part of your standard adversarial review. Flag any structural asymmetry (signature, observability, edge, test) as a finding with severity proportional to the failure mode it enables."_

### Surfacing in Step 3

When pre-flight has fired, the recommendation presented to the user in Step 3 must explicitly mention:

> "Sibling-symmetry pre-flight: detected parallel-trio components [list]. Architecture weighted up by +5. Sibling-on-main context will be injected into dispatch with the following symmetry-deltas: [bullet summary]."

This ensures the user sees pre-flight ran, can verify the detected pairs are correct, and can adjust before commissioning.

### Why this step exists

This step encodes a structural blind spot caught at PR #42 merge time on 2026-04-25: PR #45 had landed sibling-pattern changes (`presence-aware dotfiles auto-commit`) on main while PR #42 sat open, and the terminal full-diff audit at PR #42 close used the standard "diff vs base" lens — by then the base included PR #45's sibling, so the audit saw the sibling pattern as "present" on the base and never compared the two siblings against each other. The fix was an inline sibling-parity audit added at merge time, which caught the gap and produced Phase 7. See `~/.claude/projects/-Users-{user}/memory/feedback-sibling-parity-at-merge-time.md` for the underlying pattern.

### Direct-Agent-dispatch correspondence

This same trigger logic and pre-flight discipline applies to **audits commissioned via direct Agent calls outside the `/audit` skill** (e.g., inline sibling-parity audits during PR-merge sessions). The skill is the canonical encoding, but the pattern itself isn't skill-specific. The memory entry referenced above is the cross-context source of truth.

## Step 2 — Match auditors to the plan

Read `~/.claude/agents/audit/registry.md`. Parse the `## Machine-readable index` TSV block — one row per auditor, tab-separated `file \t prefix \t name \t triggers-pipe-separated`. This is the authoritative source for trigger matching. Do **not** re-read each auditor's `.md` file for triggers — the registry is the cache.

**Match algorithm (case-insensitive, word-boundary):**

```python
import re
def match_count(triggers: list[str], plan: str) -> dict[str, int]:
    hits = {}
    for t in triggers:
        pattern = r'\b' + re.escape(t) + r'\b'
        n = len(re.findall(pattern, plan, flags=re.IGNORECASE))
        hits[t] = min(n, 50)  # per-trigger cap
    return hits
```

Sum hits per auditor. Rank by total.

**Selection rules:**

- Word count <800 → **3** auditors minimum. 800–8,000 → **3–4**. >8,000 → **4–5**. Always **3 minimum**, never less. **Scale up beyond the floor when the plan's risk surface warrants it** — multiple distinct domains in scope, high-stakes shipping, or cross-cutting concerns across security/performance/DX/accessibility/business/knowledge-system. Diminishing returns bite past ~5–6 (coordination overhead exceeds incremental insight, reconciliation rounds in 5b' get unwieldy), but **the cap is scope-driven, not a fixed numeric ceiling**. A 10K-word multi-system plan with broad risk surface warrants 5 distinct lenses; a 1K-word focused refactor warrants 3. Defaulting to 3 on every plan is itself a handicap.
- **At least one cold auditor** — prevents familiarity blind spots.
- **At least one familiar auditor** when the plan touches project internals (references dotfiles, hooks, wiki, memory, existing repos, or established conventions).
- **Maximum lens diversity** — if two candidate auditors share >50% of their trigger keywords, prefer the one with more matches and skip the other.
- **Sibling-symmetry pre-flight boost (Step 1.5)** — if pre-flight fired, add **+5** to the score of any auditor whose triggers include `architecture` or `architecture-integration`. This nudges the structural lens into selection without overriding stronger keyword matches.
- Break ties by adversarial relevance to the plan's domain.

## Step 3 — Present the recommendation

Show the user:

1. Which auditors were selected, with their total match count **and the top 3 hit triggers** (so the user can spot false positives — e.g., "`as(42)` dominating TypeScript's score" is a red flag).
2. Each selected auditor's **adversarial lens** (the question they'll try to answer).
3. Which auditors were runners-up (next 2-3 by match count), same format.

Then ask: **"Commission these auditors, or swap/add/remove?"**

Wait for user approval before proceeding. The user can:

- Accept the selection as-is
- Swap one auditor for another
- Add an extra auditor beyond the default count
- Remove an auditor they don't think is relevant

### Known-tension cross-reference

After computing the selected auditor set but **before** showing the recommendation, cross-reference the selection against the `## Known-tension pairs` section in `~/.claude/agents/audit/registry.md`. For each pair where both auditors are in the selected set, surface it informationally alongside the recommendation. Example:

> "Selected: Security Engineer, CLI DX Engineer, Performance Engineer.
> Known-tension zones for this combo: Security ↔ DX on user-input surfaces;
> Security ↔ Performance on validation cost vs throughput. Expect
> reconciliation rounds in Step 5b'."

Purely informational — the user can accept the predicted friction or swap an auditor before commissioning. Skip this subsection silently if no pairs match.

## Step 4 — Dispatch auditors

For each approved auditor, dispatch as a **parallel Agent tool call** using `subagent_type: "general-purpose"`.

### Plan delivery — inline vs file-path

- **Plan size <10KB:** paste the plan text inline under `## Plan Under Review`.
- **Plan size ≥10KB:** provide the plan's absolute path and instruct the agent to `Read` the file. Example: `Read the plan at: /Users/you/.claude/plans/foo.md`. Still describe briefly what the plan is about (one sentence) so the agent doesn't audit blind.

### For cold auditors:

- Read the auditor's full `.md` file (identity + expertise + audit protocol + output format).
- Send the full agent definition, no project context, plus the plan (inline or path per above).

### For familiar auditors:

- Read the auditor's full `.md` file.
- Read each file listed in the `context_sources` frontmatter field. Three resolver keys are supported:
  - `wiki` entries: `~/Documents/Obsidian Vault/wiki/{path}`
  - `memory` entries: `~/.claude/projects/-Users-{username}/memory/{path}` (resolve username via `whoami`)
  - `plugin` entries: `${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/{path}`
- **Verify every context file exists before dispatch.** If any is missing, stop and report which file is missing and which auditor needs it — do not dispatch with a hole in the context. This prevents silent context loss when wiki, memory, or plugin paths rot.
- Inject the concatenated context contents into the auditor's prompt under a `## Project Context` section, replacing the placeholder. Include the source path of each injected file as a sub-header so the auditor can judge which claim came from where.
- Send the full agent definition + injected context + plan (inline or path).

### Agent dispatch format:

Each agent call must include:

- The auditor's full markdown body as the system identity
- `## Plan Under Review` with either the plan text or a Read instruction
- For familiar auditors, `## Project Context` with injected file contents
- **When Step 1.5 fired:** `## Sibling-Symmetry Context` with the prepared symmetry-delta summary (component pair(s), per-axis deltas, and the explicit instruction to flag structural asymmetry as a finding). Place after `## Plan Under Review` and before `## Project Context` (when present).
- Closing instruction: "Audit this plan using your protocol. Follow your output format exactly. If your audit required substantive web research, append a `## Research Synthesis` section at the end of your report with the convergent findings, sources, and a 1-line relevance note per source. This captures the research byproduct separately from your audit findings."

**All auditor agents must be dispatched in a single message** so they run concurrently.

## Step 5 — Synthesize findings

After all agents return, present a unified report:

### 5a. Individual auditor reports

Present each auditor's findings in full, in the order they were dispatched.

### 5b. Cross-cutting themes (overlap map)

Before presenting findings for integration, cluster them into **semantic units** — findings from different auditors that address the same underlying gap **and share remediation direction**. A single schema-authority doc might resolve 4 findings from 3 auditors. Findings on the same plan section with **opposing remediation directions are not duplicates** — pass them through as tension candidates for Step 5b'. Present the unit count alongside the raw finding count (e.g., "32 findings → ~14 semantic units"). This prevents the integration step from addressing findings one-by-one and re-discovering the same class of issue across auditors, while preserving legitimate contradictions for explicit reconciliation.

### 5b'. Tension map + reconciliation

After 5b dedups by shared direction, detect contradictory-but-legitimate findings (different lenses proposing opposing directions on the same plan surface) and reconcile them auditor-to-auditor before integration.

#### Detection (hybrid)

**1. Pattern pass (skill-side, cheap, deterministic):**

For each pair of findings from different auditors:

- **Prerequisite — shared plan section anchor:** line range, section ID, URL, or quoted snippet. If findings don't share an anchor, no tension candidate.
- **Promote to tension** if findings share an anchor AND contain an opposing-direction keyword pair. Seed set (extend as new tensions surface):
  - `add` ↔ `remove`
  - `strict` ↔ `loose`
  - `validate` ↔ `defer`
  - `cache` ↔ `bypass`
  - `lock` ↔ `concurrent`
  - `explicit` ↔ `implicit`
  - `expand` ↔ `constrain`
  - `require` ↔ `optional`
  - `synchronous` ↔ `asynchronous`
- **Route to self-flag backstop** if findings share an anchor but either (a) no keyword pair matches, or (b) severities disagree (one critical, one minor on identical surface).

**2. Self-flag backstop (fires when pattern pass routes here):**

Dispatch each involved auditor a minimal Agent call (`subagent_type: "general-purpose"`) with prompt:

> "Auditor B emitted this finding on the same section as your finding X. Does B's finding contradict yours, align with yours, or address a separate concern? Answer one word: `tension`, `duplicate`, or `independent`."

Route on the combined responses:

- Any auditor returns `tension` → queue for reconciliation (conservative: one lens seeing contradiction is enough).
- Both return `duplicate` → merge into 5b's semantic unit for that section.
- Otherwise → pass through as independent findings.

#### Multi-party tensions (3+ auditors on the same section)

Chain pairwise. Pick the two most-directly-opposing auditors — measured by count of matching opposing-direction keyword pairs in their findings (more matches = more directly opposing). Run their reconciliation round. After convergence, re-check whether any remaining auditor is still in tension with the reconciled position; if so, run the next pairwise round with that auditor against the reconciled position-holder.

Do **not** run tri-party or panel rounds — they scale poorly and dilute focus.

#### Reconciliation round (pairwise Agent dispatch, parallel)

Each involved auditor receives an Agent call (`subagent_type: "general-purpose"`) containing:

- **System identity:** the auditor's full `.md` body from `~/.claude/agents/audit/cold/<file>` or `familiar/<file>` — same content delivery as Step 4.
- `## Your Finding` — the auditor's finding verbatim, including severity.
- `## Conflicting Finding` — the other auditor's finding verbatim, including severity.
- `## Other Auditor's Lens` — the one-line adversarial question from the other auditor's row in `~/.claude/agents/audit/registry.md`.
- `## Targeted Plan Section` — only the portion of the plan both findings address, not the full plan.
- `## Reconciliation Prompt` — instruction to return exactly one of the 4 structured shapes (see Output schema below), plus the anti-pattern blocks listed further down.

Both auditors are dispatched in a **single message** (parallel), matching Step 4's concurrency pattern.

#### Output schema

Each auditor must return structured output in this exact form:

```
shape: <reconciled-both | layer-claim | conditional | concede>
position: <one-paragraph concrete position>
dominant_layer: <only populated if shape == layer-claim>
condition: <only populated if shape == conditional>
```

**Shape definitions:**

- `reconciled-both` — a concrete approach that satisfies both concerns (e.g., "rate limiting (Security) + short feedback toast (DX) together").
- `layer-claim` — my concern dominates at layer X (e.g., data-layer); yours at layer Y (e.g., user-facing).
- `conditional` — satisfy yours iff [condition]; else mine wins.
- `concede` — my finding absorbs into yours; I withdraw.

#### Convergence matrix

Map both auditors' returned shapes to an outcome:

| Auditor A                                 | Auditor B                                 | Outcome                             |
| ----------------------------------------- | ----------------------------------------- | ----------------------------------- |
| `reconciled-both` (mergeable position)    | `reconciled-both` (mergeable position)    | ✓ converged                         |
| `concede`                                 | any                                       | ✓ converged (concede absorbs)       |
| `layer-claim` (layer X)                   | `layer-claim` (layer Y, non-overlapping)  | ✓ converged (dual-layer resolution) |
| `conditional` (compatible conditions)     | `conditional` (compatible conditions)     | ✓ converged                         |
| `layer-claim` (same layer)                | `layer-claim` (same layer, opposing)      | ✗ escalate                          |
| `conditional` (conflicting conditions)    | `conditional` (conflicting conditions)    | ✗ escalate                          |
| `reconciled-both` (incompatible position) | `reconciled-both` (incompatible position) | ✗ escalate                          |

"Compatible conditions" and "mergeable position" are compared at the **string level** in initial implementation — declared fields must be lexically compatible (no direct contradiction). Escalate ambiguous cases rather than auto-converging.

#### Anti-patterns blocked in the reconciliation prompt

State these explicitly in the Reconciliation Prompt body and require one of the 4 structured shapes as output:

- **Agreement-bias concession** — conceding because the other auditor "feels strongly," not because your lens genuinely permits.
- **Stubborn-lens escalation** — arguing beyond your declared domain.
- **Scope creep** — dragging in findings outside this specific tension.
- **Restatement without resolution** — "we both have good points" with no concrete shape.

#### Non-convergence handling

When the convergence matrix yields `✗ escalate`, surface the tension verbatim to the user:

- Both auditors' original findings.
- Both auditors' reconciliation outputs (shape + position + layer/condition).
- The divergence reason (which compatibility rule failed — e.g., "both `layer-claim` targeting `data-layer`").
- Prompt: "Auditor A's position, Auditor B's position, or a custom resolution?"

The user's choice becomes the locked direction. Both auditors verify against that direction in Step 6.

#### Kill-switches / soft guardrails

- **High-tension count warning:** if >8 tensions are detected in a single audit, surface a soft warning before dispatching reconciliation: _"High tension count (N). Consider whether the plan itself needs reframing before reconciling individually."_ No hard cap — the user decides.
- **Cost visibility:** report upfront before dispatch: _"5b' will dispatch M tensions × 2 auditors = 2M parallel calls."_ The user can opt out of 5b' entirely or trim the tension list before running.

### 5c. Aggregate score

Calculate the mean score across all auditors. Present as: `**Aggregate: X.X/10** (range: lowest–highest)`

**Consensus check:** If all auditors score above 8.0, flag this explicitly — "All auditors scored >8. This is unusual for a substantial plan and may indicate the auditors defaulted to approval rather than genuine criticism. Consider whether the plan's risk surface was adequately covered." High consensus on a positive outcome is a signal to scrutinize, not celebrate.

### 5d. Integration decision

Group findings by relationship type **before** presenting integration options:

```
Duplicate clusters       (N units — single canonical fix per unit, from 5b)
Reconciled tensions      (M — each with reconciled shape + position, from 5b')
Unconverged tensions     (K — each needs user direction, from 5b')
Independent findings     (L — each raw)
```

Then ask the user:

- **"Integrate all findings"** — address every finding (critical, major, and minor)
- **"Critical + major only"** — skip minor findings
- **"Specify finding IDs"** — user picks which findings to address (e.g., "SE-1, RE-3, DX-2")
- **"None"** — acknowledge the audit but don't integrate now

**Integration sequencing:** resolve semantic units in dependency order — foundation (schema, data model) → contracts (APIs, interfaces) → implementation (tests, policies) → surface (docs, naming). Prefer one new canonical doc or section that eliminates a class of findings over many scattered edits that each fix one finding.

### 5e. Research byproduct capture

If any auditor emitted a `## Research Synthesis` section in Step 4 output, consolidate them into a single markdown file at `~/Documents/Obsidian Vault/.raw/research-byproduct/[YYYY-MM-DD]-audit-[slug].md`.

**File contents:**

- Frontmatter: `type: raw`, `source: audit-byproduct`, `audit_slug`, `audit_date`, `auditors` (list), `plan_path`.
- One section per contributing auditor, with the auditor's `## Research Synthesis` content verbatim under a `## <Auditor Name>` heading.
- A consolidated `## Sources` section deduplicating across auditors.

**Behavior: auto-save with override.** Write the file by default. Do not prompt. Announce the path in the audit summary (e.g., "Research byproduct saved: `.raw/research-byproduct/2026-04-15-audit-heatprice-r8.md`"). The user can delete the file afterward if unwanted. This prevents loss in autonomous/unattended sessions.

**Skip condition:** if no auditor emitted a `## Research Synthesis` section, skip 5e entirely. Do not write an empty file. Do not announce.

See `[[Research Byproduct Capture]]` (in the vault) for the full principle.

## Step 6 — Verification loop

After integrating findings into the plan, dispatch each auditor **one more time** with a targeted verification prompt:

### Verification prompt:

- Include only the auditor's own findings (by finding ID)
- Include the updated plan (inline <10KB or file path ≥10KB, same rule as Step 4)
- Instruction: "For each of your findings below, judge: **ADDRESSED** or **NOT ADDRESSED**. Do not raise new findings — if you spot something new, note it in an Out-of-Scope section but do not score it."

### Verification rules:

- **Bounded rounds, not single round.** Default: 1 round. **Additional rounds permitted** when (a) integration substantially changed the audited surface (e.g., a new section was added that the first verification couldn't have judged) OR (b) findings were partially-addressed and the second integration pass should be re-verified. **Hard cap: 3 rounds per audit cycle** to prevent infinite loops. Document the reason for each additional round in the audit transcript header so future readers can see why it was warranted. The anti-pattern blocked is **cyclical** verification (same scope re-verified looking for new gaps); the legitimate pattern allowed is **scope-expanded** verification (genuinely new content needs verifying).
- **Each auditor verifies only their own findings** — no scope creep into other auditors' domains.
- If **>30% of findings** across all auditors are NOT ADDRESSED at the end of round 1, this is a signal to consider whether (a) a second integration pass + round 2 verification is warranted, or (b) the unresolved items should be deferred to per-phase audit, or (c) the user should be looped in to make the call. Surface the tally and propose; don't unilaterally re-run.
- **New findings in Out-of-Scope sections indicate the integration itself created surface area.** If any auditor reports substantive new issues (not just rephrasing), stop and flag: "Integration introduced new concerns — resequence before continuing." Do not auto-proceed to a second audit cycle (different from a second verification round); let the user decide whether to re-audit or accept.
- Unresolved findings after the verification rounds are listed for the user to decide on individually.
- Present the final verification summary and ask: "Plan ready to build, or address remaining items?"

### Reconciled-tension verification (from 5b')

For each reconciled tension, the verification prompt to each involved auditor additionally includes:

- Original finding verbatim.
- Reconciliation outcome (shape + position + condition/layer).
- Updated plan section implementing the reconciled approach.
- Instruction: _"ADDRESSED means the plan satisfies your finding **as reconciled** — not necessarily your original position verbatim."_

**Shape-specific handling:**

- `reconciled-both` — both auditors verify the merged position.
- `concede` — the conceding auditor's finding is **skipped** (pre-absorbed in 5b'; no verification call).
- `layer-claim` — each auditor verifies at their claimed layer only.
- `conditional` — both auditors verify that the condition is implemented as the gate.
- **Escalated (user-picked)** — both auditors verify against the user's direction. An auditor whose position wasn't picked may legitimately return NOT ADDRESSED; counted normally toward the >30% threshold.

**Anti-pattern blocked:** auditor re-litigating the reconciliation ("my original wasn't picked → NOT ADDRESSED"). Verification judges the _reconciled_ finding, not the _original_. The prompt must state this explicitly.

**Threshold counting:** reconciled tensions count as **one unit** toward the >30% NOT ADDRESSED threshold, not one-per-auditor. Same treatment as duplicate clusters from 5b. Prevents double-penalizing a single semantic concern.
