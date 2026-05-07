# Cluster 3 of 21 INVERSIONS arc — fact-force gate (plugin → substrate)

**Slice:** Cluster 3 of the 21 INVERSIONS remediation arc per `~/.claude/notes/plugin-internals-audit-2026-05-06.md` §9.
**Cycle:** 2026-05-07
**Outcome:** SHIPPED — both PRs merged + post-merge CI green on each repo's main.

This file mirrors `decisions/cluster-1.md` + `decisions/cluster-2.md` shapes. Cluster 3 carries forward per-cluster closure-block discipline + the v2-anticipation addendum on Cluster 1's substrate-debt-mirror inheritance picture (with the extraction-manifest MOVE-AND-RELABEL pattern added as Decision C this cycle).

---

## 2026-05-07 — Decision A: substrate-canonical verdict (operational test unambiguous)

```yaml
---
ts: 2026-05-07T13:45:00Z
kind: scope
severity: load-bearing
phase: cluster-3
affects: [Cluster 3 verdict on all 3 fact-force gate files]
---
```

**Context:** Per `feedback-plugin-removal-test.md`'s operational test ("if plugin removed, would single-instance OS-level Claude break?"), all 3 fact-force gate files are within-session state primitives:

- `fact-force.ts` — pre-tool-use Edit/Write gate; per-session state file (`~/.claude/.fact-force-state-<session>`); read by same session that wrote it
- `fact-force-scope-cli.ts` — CLI for per-session approval markers; `/fact-force-scope` slash command implementation
- `fact-force-scope-store.ts` — scope-marker storage primitives; consumed only by the above two

No cross-instance coordination machinery anywhere in the surface. Substrate-canonical correct.

**Options considered:**

1. **Substrate-canonical (CHOSEN)** — applies operational test rigorously; within-session vs cross-instance distinction unambiguous.
2. Plugin-canonical — would require treating per-session state as multi-instance coordination, which contradicts the actual implementation.

**Chosen:** Option 1.

**Reason:** Bravo Lane Q-A recon §8 + Alpha plan §2 both arrived at SUBSTRATE-CANONICAL via primary-source verification. **No recon-agent verdict-correction trap** (cf. Cluster 2 Decision A) — the within-session vs cross-instance distinction is unambiguous here, contrasting Cluster 2's ci-verification ambiguity which required overruling an Explore-subagent verdict.

**Operationalized:** All 3 files moved to `~/.claude-dotfiles/src/hooks/checks/`. `BUNDLED_CHECK_NAMES` shrinks 16 → 15 (only `fact-force` is registered as a hook; the 2 utility modules are co-located via filesystem locality).

---

## 2026-05-07 — Decision B: branch-enforcement.ts:49 cross-edge revert (Cluster 1 ARCH-1 unwind)

```yaml
---
ts: 2026-05-07T13:50:00Z
kind: architecture
severity: load-bearing
phase: cluster-3
affects:
  [
    substrate's branch-enforcement.ts; symmetric closure of Cluster 1 ARCH-1 fold,
  ]
---
```

**Context:** Cluster 1's plan v1.3 §B fold introduced a cross-edge import at `branch-enforcement.ts:49` from substrate to plugin's `claude-conductor/hooks/checks/fact-force` to import `isAllowlisted`. This was an EXPLICITLY anticipated temporary cross-edge — Cluster 1 plan v1.3 stated the cross-edge would be reverted when Cluster 3 (fact-force inversion) lands. Cluster 1 chose this option (b) cross-edge as the LEAST-DISRUPTION path; cluster-1 ARCH-1 fold preserved Cluster 1 scope without dependency-inversion.

Cluster 3 PR1 delivers on the anticipated revert.

**Options considered:**

1. **Revert L49 to local relative `./fact-force.ts` (CHOSEN)** — symmetric closure of Cluster 1 ARCH-1 fold; restores in-tree import; Cluster 1 plan v1.3 anticipated this exact change.
2. Keep cross-edge — would extend the temporary cross-edge indefinitely; violates the symmetric-closure intent.

**Chosen:** Option 1.

**Reason:** symmetric closure of Cluster 1's intentional-temporary cross-edge. fact-force is now local to substrate post-Cluster-3-PR1; the cross-edge target exists on substrate side; no compile-time indirection needed.

**Operationalized:** `~/.claude-dotfiles/src/hooks/checks/branch-enforcement.ts:49` (1-line change): `from "claude-conductor/hooks/checks/fact-force"` → `from "./fact-force.ts"`. Verified via cross-edge-imports.test.ts post-PR1: cross-edge specifier count reduces by 1 (plus the 5 other Cluster 3 cross-edge sites). extraction-manifest.md Cluster 1 branch-enforcement row note updated to remove the now-stale "Cluster 3 dependency, plugin-canonical until Cluster 3 lands" mention.

---

## 2026-05-07 — Decision C: extraction-manifest.md MOVE-AND-RELABEL discipline (Cluster 2 PR2 BLOCK + Cluster 3 Lane B CRIT-1 lessons)

```yaml
---
ts: 2026-05-07T13:58:00Z
kind: documentation
severity: load-bearing
phase: cluster-3
affects: [extraction-manifest section discipline; precedent for Clusters 4-5]
---
```

**Context:** Cluster 2 PR2's first implementation hit Lane D STRICT GATE BLOCK (CRIT-1) when adding a new "CI verification protocol" section header — the markdown table syntactically continued under the new header, vacuuming 8 unrelated rows into the new section. The fix moved 8 rows back; the lesson became `decisions/cluster-2.md` Decision E.

Cluster 3 had a NEW shape: existing fact-force.ts row (with `extract-with-shim` disposition) at L78 needed to MOVE to a new section with `substrate-canonical Cluster 3` disposition. Cluster 3 plan v1 ADD-only spec (§3.1 line 57) was caught by Bravo Lane B v1 CRIT-1: missing the REMOVE step would have left the L78 row stale, creating spec contradiction (file declared as both "extract-with-shim" AND "substrate-canonical Cluster 3" simultaneously).

**Options considered:**

1. **MOVE-AND-RELABEL (CHOSEN)** — explicit REMOVE old + ADD new pattern. Plan v1.1 §3.1 enumerates: REMOVE L78 fact-force.ts row + ADD new section header + ADD 3 NEW substrate-canonical rows.
2. UPDATE-IN-PLACE (Cluster 1 pattern) — change disposition of existing row from `extract-with-shim` → `substrate-canonical Cluster 3`; rows stay in `generic discipline gates` section. Rejected because v2-anticipation addendum's VOCABULARY-LOCK section mandates per-cluster section discipline.
3. ADD-only (Cluster 2 pattern) — would create spec contradiction since the OLD row predated the new section. Rejected.

**Chosen:** Option 1.

**Reason:** preserves vocabulary-discipline (per-cluster sections per addendum) AND avoids spec contradiction (no row says two things at once). Sets the canonical pattern for Clusters 4-5 — both have OLD `extract-with-shim` rows that need MOVE-AND-RELABEL when moving to substrate-canonical.

**Operationalized:** Plan v1.1 §3.1 line 57 + §11 verification checklist explicit: REMOVE old + ADD new sections both enumerated. Lane D STRICT GATE PR2 audit specifically verifies the 4-row outcome (3 fact-force + 1 cross-edge mention in branch-enforcement note row). Bravo Q-A4 recon §3 Cluster 4 documents the same MOVE-AND-RELABEL pattern as inheritance for Cluster 4 plan author.

---

## 2026-05-07 — Decision D: architecture.yaml pre-staging precedent (Cluster 1 anticipation)

```yaml
---
ts: 2026-05-07T13:50:00Z
kind: architecture
severity: minor (forensic-traceability)
phase: cluster-3
affects: [architecture.yaml pre-staging pattern observed across the arc]
---
```

**Context:** Cluster 1's architecture.yaml work pre-staged not just Cluster 1's own 9 nodes but ALSO `c-fact-force` node + invocation edge — anticipating Cluster 3 would deliver. Cluster 3 PR1 inherits this pre-staging: zero yaml-node changes for `c-fact-force` itself; PR1 only verifies whether `c-fact-force-scope-cli` + `c-fact-force-scope-store` need yaml entries (the architecture-drift hook may or may not fire on utility modules vs check modules).

Bravo Lane Q-A4 recon §3 documents the FULL pre-staging picture: Cluster 4's BOTH handoff invariant nodes are also pre-staged with full 6-field shape + invocation edges. The arc's yaml work was front-loaded into Cluster 1.

**Options considered:**

1. **Document the pre-staging as a Cluster 1 forensic note (CHOSEN)** — captures the anticipation pattern; provides forensic clarity for future readers wondering why Cluster 1 yaml work covered files Cluster 1 didn't directly move.
2. Re-add yaml entries per Cluster 3 PR1 — wasted work; would create duplicate yaml entries.

**Chosen:** Option 1.

**Reason:** Cluster 1's pre-staging is a load-bearing efficiency win for Clusters 3-5; documenting it preserves the forensic trail.

**Operationalized:** Plan v1.1 §3.2 line 73 explicit: "c-fact-force already present — no need to add". Bravo Q-A4 recon §3 + §8 cross-cluster pre-staging summary table document the picture for Cluster 4-5 authors. Future Cluster 5 plan author should verify config-protection yaml pre-staging at PR1 execute (not yet checked in this cycle).

---

## 2026-05-07 — Decision E: cluster-3-removed.test.ts presence-only (per Cluster 2 v1.3 option-a)

```yaml
---
ts: 2026-05-07T13:50:00Z
kind: testing
severity: minor (sibling-parity)
phase: cluster-3
affects: [Cluster 3 paired test design; precedent inheritance]
---
```

**Context:** Cluster 2 v1.3 §F established option-a discipline: `cluster-N-removed.test.ts` files are presence/shape-only — disjointness assertion only; NO count-lock. The cluster-N-substrate-canonical.test.ts sibling-parity is restored across the cross-edge paired test pair.

Cluster 3 inherits the pattern.

**Options considered:**

1. **Presence/shape-only (CHOSEN; per Cluster 2 v1.3 option-a)** — `cluster-3-removed.test.ts` asserts `BUNDLED_CHECK_NAMES ∩ ["fact-force"] = ∅` (1-name disjointness); no count assertion. `cluster-3-substrate-canonical.test.ts` asserts source-text presence patterns + file existence.
2. Add count-lock — would re-introduce the per-cluster magic-number ratchet that Cluster 2 v1.3 explicitly eliminated. Rejected per option-a.

**Chosen:** Option 1.

**Reason:** sibling-parity with Cluster 1+2's now-stripped paired-test shape. Single magic-number site (bundled-registrations.test.ts EXPECTED_COUNT) ratchets per cluster; cluster-N-removed files focus on disjointness invariant only.

**Operationalized:** PR2 manifest at `6d31cf47` includes `test/hooks/cluster-3-removed.test.ts` (NEW, ~30 LOC, disjointness-only). PR1 manifest at `6a4ae21` includes `src/__tests__/hooks/cluster-3-substrate-canonical.test.ts` (NEW, ~85 LOC, presence/shape via Bun.file().text()).

---

_Cluster 3 SHIPPED 2026-05-07:_

- Dotfiles PR #73 (substrate adds 3 fact-force gate files) MERGED `6a4ae21` over branch `cluster-3-substrate-adds`
  - Pre-merge CI: runs `25500449364` + `25500630936` conclusion: success
  - Post-merge CI: run `25500765903` (`6a4ae21`) conclusion: success
- Plugin PR #25 (plugin removes 3 fact-force gate files) MERGED `6d31cf47` over branch `cluster-3-plugin-removes`
  - Pre-merge CI: runs `25501358453` + `25501377659` conclusion: success
  - Post-merge CI: run `25501870814` (`6d31cf47`) conclusion: success
- Closure-block direct-push (this commit) on plugin main per b301bb4 / b8ddb51 / 4c3c954 / 7005d9f / 8c076be precedent
- 3-lens audit history:
  - Plan v1: Alpha self-ARCH (light; recon already audit-grade)
  - Plan v1 → v1.1: Bravo Lane B (1 CRIT + 1 MAJOR + 1 MIN; 3 findings folded — extraction-manifest REMOVE-step CRIT-1, JSDoc-line-drift MAJOR-1, slash-command-spec-stale MINOR-1)
  - PR2 diff → SHIPPED: Bravo Lane D STRICT GATE (CONVERGENT-CLEAN on `6d31cf47`)
  - Total: 3 audit findings folded; 3 lens-runs
- ~10 + ~12 = ~22 files touched across both PRs; ~150 + ~1,000 deletions in plugin PR (smaller than Cluster 2 due to ~3x smaller scope)
- Plan: `~/.claude/plans/cluster-3-fact-force.md` v1.1 (final)
- `decisions/cluster-2.md` shipped at `8c076be` (Cluster 2 closure block; reference precedent for this cluster)
- New memories filed across this cycle: TBD by Alpha (likely `feedback-extraction-manifest-move-and-relabel-discipline.md` for the Lane B CRIT-1 lesson)
- Cluster 4 plan-author handoff filed: `~/.claude/notes/cluster-4-handoff-invariants-recon-2026-05-07.md` (Bravo Lane Q-A4)
- Q-C3 verification filed: `commands/fact-force-scope.md` confirmed already-aspirational-substrate (NO modifications needed in PR1; file copy of `fact-force-scope-cli.ts` makes slash command operational)
- Vault wiki concept page (Bravo Q-C; landed at Cluster 2 cycle): `wiki/concepts/inversions-arc-patterns.md` covers cross-cluster patterns including Cluster 3's MOVE-AND-RELABEL discipline

---
