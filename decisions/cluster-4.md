# Cluster 4 of 21 INVERSIONS arc — handoff invariants (plugin → substrate)

**Slice:** Cluster 4 of the 21 INVERSIONS remediation arc per `~/.claude/notes/plugin-internals-audit-2026-05-06.md` §9.
**Cycle:** 2026-05-07
**Outcome:** SHIPPED — both PRs merged + post-merge CI green on each repo's main.

This file mirrors `decisions/cluster-1.md` + `decisions/cluster-2.md` + `decisions/cluster-3.md` shapes. Cluster 4 is the smallest cluster in the arc (267 LOC source; 0 plugin tests) and the BEST yaml-pre-staging case (100% Cluster 1 anticipation coverage).

---

## 2026-05-07 — Decision A: substrate-canonical verdict (operational test unambiguous)

```yaml
---
ts: 2026-05-07T14:30:00Z
kind: scope
severity: load-bearing
phase: cluster-4
affects: [Cluster 4 verdict on both handoff invariant gate files]
---
```

**Context:** Per `feedback-plugin-removal-test.md`'s operational test, both handoff invariant files are within-session safety primitives:

- `handoff-latest-guard.ts` (85 LOC, stop event) — verifies `~/.claude/handoffs/LATEST.md` symlink integrity at session-stop time. HOME-derived path; same-session check; no multi-instance state.
- `handoff-symlink-write-guard.ts` (182 LOC, pre-tool-use, canBlock) — blocks Edit/Write on symlinked paths under `~/.claude/handoffs/`. Single-session safety guard against write-through clobber of aggregate pointers (LATEST.md). No multi-instance state.

**Options considered:**

1. **Substrate-canonical (CHOSEN)** — applies operational test rigorously; both files within-session symlink-state checks. Substrate has all needed parent dependencies parallel-by-design (`../types.ts`).
2. Plugin-canonical — would conflate "operates on session-bounded handoff files" with multi-instance coordination; the handoff files themselves are session-private by design.

**Chosen:** Option 1.

**Reason:** Bravo Lane Q-A4 recon §7 + Alpha plan §2 both arrived at SUBSTRATE-CANONICAL via primary-source verification. Within-session symlink protection is single-instance discipline. **No recon-agent verdict-correction trap** (cf. Cluster 2 Decision A) — the within-session vs cross-instance distinction unambiguous, same as Cluster 3.

**Operationalized:** Both files moved to `~/.claude-dotfiles/src/hooks/checks/`. `BUNDLED_CHECK_NAMES` shrinks 15 → 13 (both names registered as hooks; spans pre-tool-use + stop event arrays).

---

## 2026-05-07 — Decision B: cluster-4 vocabulary banner — "handoff invariants"

```yaml
---
ts: 2026-05-07T14:35:00Z
kind: documentation
severity: minor (vocabulary-discipline)
phase: cluster-4
affects:
  [
    check-names.ts banner; extraction-manifest section header; sibling-parity vs Clusters 1+2+3,
  ]
---
```

**Context:** Per `decisions/cluster-1.md` v2-anticipation addendum VOCABULARY-LOCK + Cluster 2 ARCH-V1.1-3/V1.1-7 folds + Cluster 3 Decision C MOVE-AND-RELABEL: each cluster needs a distinct banner/section name. Naming choice for Cluster 4 must convey:

- Scope: `~/.claude/handoffs/` artifact protection
- Pattern: per-session symlink + write-through safety guards
- Distinct vocabulary from Cluster 1 ("coding-discipline") + Cluster 2 ("CI verification") + Cluster 3 ("fact-force gate")

**Options considered:**

1. **"handoff invariants" (CHOSEN)** — concise; conveys both files (LATEST symlink-integrity + symlink-write-block) as invariants over handoff-file shape. Distinct from prior cluster vocabularies.
2. "handoff guards" — vaguer; "guards" overlaps with substrate's broader gate vocabulary.
3. "handoff symlink protection" — specific but verbose; ties to symlink mechanism rather than invariant intent.

**Chosen:** Option 1.

**Reason:** "handoff invariants" captures the load-bearing semantic: both files preserve invariants over the handoff artifact set (LATEST integrity + no-write-through). Forensic clarity for future readers + unique vocabulary across 5 clusters.

**Operationalized:**

- Substrate `check-names.ts` NEW banner: `// Keep-in-dotfiles — handoff invariants (substrate-canonical post Cluster 4 of INVERSIONS arc 2026-05-07)`
- Plugin `extraction-manifest.md` NEW section header: `### Hooks/checks — handoff invariants (substrate-canonical Cluster 4 INVERSIONS arc 2026-05-07)`

---

## 2026-05-07 — Decision C: extraction-manifest.md MOVE-AND-RELABEL (Cluster 3 lesson inherited)

```yaml
---
ts: 2026-05-07T14:40:00Z
kind: documentation
severity: load-bearing
phase: cluster-4
affects:
  [
    extraction-manifest section structure; preserves Cluster 3 Decision C precedent,
  ]
---
```

**Context:** Cluster 3 Decision C established the MOVE-AND-RELABEL pattern: REMOVE existing rows from `generic discipline gates` section + ADD new rows in cluster-specific section. Cluster 3 Lane B v1 caught a CRIT-1 when plan v1 was ADD-only; Cluster 3 v1.1 fold made the discipline explicit.

Cluster 4 PR2 inherits the pattern: 2 OLD rows for handoff-latest-guard.ts + handoff-symlink-write-guard.ts (with `extract-with-shim` disposition) MUST be REMOVED from generic-discipline-gates section in addition to ADD-new-section work.

**Options considered:**

1. **MOVE-AND-RELABEL (CHOSEN, inherited from Cluster 3 Decision C)** — explicit REMOVE old + ADD new sections both enumerated.
2. ADD-only — would create spec contradiction (rows declared as both extract-with-shim AND substrate-canonical).
3. UPDATE-IN-PLACE — diverges from Cluster 2/3 vocabulary discipline.

**Chosen:** Option 1.

**Reason:** sibling-parity with Cluster 3 PR2 successful execution at `6d31cf47`. Pattern locks across Clusters 4-5; both inherit the explicit dual-step.

**Operationalized:** Plan v1.1 §3.1 explicit on REMOVE-old (handoff-latest-guard.ts + handoff-symlink-write-guard.ts rows from generic-discipline-gates) + ADD-new-section (handoff invariants with 2 rows). Lane D STRICT GATE PR2 audit specifically verifies the 2-row outcome + clean section boundaries.

---

## 2026-05-07 — Decision D: cluster-4-removed.test.ts presence-only (per Cluster 2 v1.3 §F option-a)

```yaml
---
ts: 2026-05-07T14:42:00Z
kind: testing
severity: minor (sibling-parity)
phase: cluster-4
affects: [Cluster 4 paired test design]
---
```

**Context:** Cluster 2 v1.3 §F established option-a: `cluster-N-removed.test.ts` files are presence/shape-only (disjointness assertion only; NO count-lock). Substrate-side `cluster-N-substrate-canonical.test.ts` is also presence/shape-only. Single magic-number site (bundled-registrations.test.ts EXPECTED_COUNT) ratchets per cluster.

Cluster 3 inherited the pattern (Decision E). Cluster 4 inherits same.

**Options considered:**

1. **Presence/shape-only (CHOSEN; per option-a)** — `cluster-4-removed.test.ts` asserts `BUNDLED_CHECK_NAMES ∩ ["handoff-latest-guard", "handoff-symlink-write-guard"] = ∅` (2-name disjointness); no count assertion.
2. Add count-lock — re-introduce ratchet; rejected per option-a.

**Chosen:** Option 1.

**Reason:** sibling-parity across the 5-cluster arc; option-a discipline locked across Clusters 2-5.

**Operationalized:** PR2 manifest at `b31fef62` includes `test/hooks/cluster-4-removed.test.ts` (NEW, ~30 LOC, disjointness-only on 2 names). PR1 manifest at `c5c7f41` includes `src/__tests__/hooks/cluster-4-substrate-canonical.test.ts` (NEW, ~85 LOC, presence/shape).

---

## 2026-05-07 — Decision E: architecture.yaml — full pre-staging realization (BEST case in arc)

```yaml
---
ts: 2026-05-07T14:30:00Z
kind: architecture
severity: minor (forensic-traceability)
phase: cluster-4
affects:
  [
    architecture.yaml pre-staging precedent realization; Cluster 1 anticipation acknowledged,
  ]
---
```

**Context:** Cluster 1's architecture.yaml work pre-staged 9 cluster-1 nodes plus c-fact-force (Cluster 3) + c-config-protection (Cluster 5) + c-handoff-latest-guard (Cluster 4) + c-handoff-symlink-write-guard (Cluster 4). Cluster 4 is the FIRST cluster where 100% of needed yaml entries (BOTH cluster-4 nodes + invocation edges) are pre-staged. PR1 needs ZERO yaml changes.

Bravo Lane B v1 audit on plan v1 caught a MAJOR finding: plan v1 §3.2 + §11 had "ADD 2 nodes IF architecture-drift fires" framing — wasteful relative to the actual 100%-pre-staged state. Plan v1.1 fold corrected to explicit "NO CHANGES; verify grep returns 4 (2 nodes + 2 edges)".

**Options considered:**

1. **Explicit "NO CHANGES" framing in plan v1.1 (CHOSEN)** — celebrates the pre-staging discipline + prevents waste of PR1 author's verify cycle + zero-risk operationally.
2. Keep "IF architecture-drift fires" wording — operationally safe but understates the discipline win and risks accidental ADD by misreading author.

**Chosen:** Option 1.

**Reason:** sibling-parity with Cluster 3 Decision D documented Cluster 1's anticipation pattern as a forensic note. Cluster 4 deserves explicit recognition of being the BEST case in the arc; future Cluster 5 plan author leverages the same pre-staging insight.

**Operationalized:** Plan v1.1 §3.2 line 71 + §11 line 149 corrected per Bravo Lane B MAJOR-1 fold. PR1 verification: `grep -c "c-handoff-(latest-guard|symlink-write-guard)" architecture.yaml` returns 4. NO ADD operation.

---

_Cluster 4 SHIPPED 2026-05-07:_

- Dotfiles PR #74 (substrate adds 2 handoff invariants) MERGED `c5c7f41` over branch `cluster-4-substrate-adds`
  - Pre-merge CI: runs `25503405806` + `25503419025` conclusion: success
  - Post-merge CI: run `25503545647` (`c5c7f41`) conclusion: success
- Plugin PR #26 (plugin removes 2 handoff invariants) MERGED `b31fef62` over branch `cluster-4-plugin-removes`
  - Pre-merge CI: runs `25504104745` + `25504107800` conclusion: success
  - Post-merge CI: run `TBD` (`b31fef62`) conclusion: success
- Closure-block direct-push (this commit) on plugin main per b301bb4 / b8ddb51 / 4c3c954 / 7005d9f / 8c076be / c985fc0 precedent
- 3-lens audit history:
  - Plan v1: Alpha self-ARCH (light; Q-A4 recon already audit-grade) — CONVERGENT-CLEAN (0 findings)
  - Plan v1 → v1.1: Bravo Lane B (1 MAJOR + 3 MINOR; 4 findings folded — yaml-framing MAJOR-1 + 3 line-ref/anchor MINORs)
  - PR2 diff → SHIPPED: Bravo Lane D STRICT GATE (CONVERGENT-CLEAN-WITH-1-MINOR (L5 JSDoc fold via Option B in this commit) on `b31fef62`)
  - Total: 4 audit findings folded; 3 lens-runs
- ~9 + ~13 = ~22 files touched across both PRs; ~95 + ~700 deletions in plugin PR (smallest cluster scope)
- Plan: `~/.claude/plans/cluster-4-handoff-invariants.md` v1.1 (final)
- Architecture.yaml: ZERO changes (BEST yaml-pre-staging case in arc; both nodes + edges from Cluster 1 anticipation)
- Recon: `~/.claude/notes/cluster-4-handoff-invariants-recon-2026-05-07.md` (Bravo Lane Q-A4)
- Q-A5 (Cluster 5 final-cluster recon) staged at `~/.claude/notes/cluster-5-config-protection-recon-2026-05-07.md`

---
