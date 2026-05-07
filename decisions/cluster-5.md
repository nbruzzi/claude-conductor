# Cluster 5 of 21 INVERSIONS arc — config-protection (FINAL CLUSTER OF ARC)

**Slice:** Cluster 5 of the 21 INVERSIONS remediation arc per `~/.claude/notes/plugin-internals-audit-2026-05-06.md` §9 — the FINAL cluster.
**Cycle:** 2026-05-07
**Outcome:** SHIPPED — both PRs merged + post-merge CI green on each repo's main.

This file mirrors `decisions/cluster-1.md` + `decisions/cluster-2.md` + `decisions/cluster-3.md` + `decisions/cluster-4.md` shapes + adds explicit ARC COMPLETION narrative. Cluster 5 closes the 21 INVERSIONS arc (21/21 = 100%); plugin scope reaffirmed as exclusively multi-instance coordination machinery.

---

## 2026-05-07 — Decision A: substrate-canonical verdict (operational test unambiguous)

```yaml
---
ts: 2026-05-07T15:15:00Z
kind: scope
severity: load-bearing
phase: cluster-5
affects: [Cluster 5 verdict on all 3 config-protection files]
---
```

**Context:** Per `feedback-plugin-removal-test.md`'s operational test, all 3 config-protection files are within-session approval-aware write-protection primitives:

- `config-protection.ts` (164 LOC, pre-tool-use, canBlock) — Edit/Write gate against config files (tsconfig.json, eslint.config.\*, etc.); per-session HOME-derived state file (`~/.claude/config-protection-approvals/<hash>.json`); `ApprovalMarker` consumed by same-session Edit/Write gating.
- `config-protection-cli.ts` (221 LOC, has shebang) — CLI for `/approve-config-edit` slash command; per-session approval workflow.
- `config-protection-store.ts` (130 LOC) — storage primitives consumed only by config-protection + cli; co-locates with callers.

All within-session. Substrate-canonical correct.

**Options considered:**

1. **Substrate-canonical (CHOSEN)** — applies operational test rigorously; within-session approval state, not cross-instance coordination.
2. Plugin-canonical — would conflate per-session approval mechanism with multi-instance coordination; the approval workflow is session-private by design.

**Chosen:** Option 1.

**Reason:** Bravo Lane Q-A5 recon §8 + Alpha plan §2 both arrived at SUBSTRATE-CANONICAL via primary-source verification. **No recon-agent verdict-correction trap** (cf. Cluster 2 Decision A) — within-session vs cross-instance distinction unambiguous, same as Clusters 3+4.

**Operationalized:** All 3 files moved to `~/.claude-dotfiles/src/hooks/checks/`. `BUNDLED_CHECK_NAMES` shrinks 13 → 12 (only `config-protection` registered as hook; cli + store are utility modules; mirrors Cluster 3 fact-force pattern).

---

## 2026-05-07 — Decision B: extraction-manifest.md "NEEDS ENHANCEMENT" historical caveat dropped

```yaml
---
ts: 2026-05-07T15:20:00Z
kind: documentation
severity: minor (forensic-clarity)
phase: cluster-5
affects: [extraction-manifest new section row's rationale framing]
---
```

**Context:** Pre-Cluster-5 extraction-manifest.md L76 (post-Cluster-2; line shifts post-3+4) had an `extract-with-shim` row for `config-protection.ts` carrying the rationale: `Generic config-protection. **NEEDS ENHANCEMENT** in plugin (approval-aware mechanism per Phase 0 substrate-gap follow-up).`

The "NEEDS ENHANCEMENT" framing was authored at a time when the approval-aware mechanism HADN'T shipped yet. Subsequently, the mechanism DID ship: `ApprovalMarker` type in config-protection-store.ts + `/approve-config-edit` slash command + config-protection-cli implementation.

The "NEEDS" framing became HISTORICAL-STALE. Bravo Q-A5 recon §4 + §8 explicit on this; Bravo Lane B v1 MINOR-3 surfaced as fold-target.

**Options considered:**

1. **Drop the historical caveat in new section row's rationale (CHOSEN)** — neutral framing: "Config-file write-protection gate; approval-aware mechanism via `/approve-config-edit` slash command. Within-session HOME-derived state. Substrate-canonical post-Cluster-5."
2. Carry forward "NEEDS ENHANCEMENT" framing — would propagate stale documentation; future readers misled into thinking enhancement is pending.
3. Document the historical→present transition in the rationale — verbose; closure block is the better place for forensic narrative.

**Chosen:** Option 1.

**Reason:** the approval-aware mechanism IS the substrate-canonical state being captured. Historical caveat about plugin-side enhancement is moot post-substrate-canonical move. Forensic narrative of the resolution belongs in this Decision (Decision B), not in the row rationale.

**Operationalized:** Plan v1.1 §3.1 line 52 explicit on neutral-framing for new section. Bravo Q-A5 recon §4 enumerated the 3 row rationales with no NEEDS-ENHANCEMENT carryover.

---

## 2026-05-07 — Decision C: extraction-manifest.md MOVE-AND-RELABEL (Cluster 3+4 lessons inherited)

```yaml
---
ts: 2026-05-07T15:25:00Z
kind: documentation
severity: load-bearing
phase: cluster-5
affects:
  [
    extraction-manifest section structure; final cluster of MOVE-AND-RELABEL pattern execution,
  ]
---
```

**Context:** Cluster 3 Decision C established MOVE-AND-RELABEL: REMOVE existing rows from `generic discipline gates` section + ADD new rows in cluster-specific section. Cluster 3 Lane B v1 caught a CRIT-1 (ADD-only); Cluster 3 PR2 successful execution + Cluster 4 PR2 successful execution at this point.

Cluster 5 inherits: REMOVE 1 OLD config-protection.ts row + ADD NEW section "Hooks/checks — config-protection" with 3 rows (substrate-canonical Cluster 5 disposition).

**Options considered:**

1. **MOVE-AND-RELABEL (CHOSEN, inherited)** — explicit REMOVE old + ADD new sections both enumerated; per Cluster 3 Lane B CRIT-1 + Cluster 4 successful execution.
2. ADD-only — would create spec contradiction (config-protection.ts as both extract-with-shim AND substrate-canonical); rejected per Cluster 3 lesson.

**Chosen:** Option 1.

**Reason:** sibling-parity with Cluster 3+4 PR2 successful executions at `6d31cf47` + `b31fef62`. Pattern locked across Clusters 3-5; cluster-N-removed.test.ts now zero-count-lock siblings of cluster-N-substrate-canonical.test.ts.

**Operationalized:** Plan v1.1 §3.1 + §11 explicit on REMOVE-old (config-protection.ts row from generic-discipline-gates) + ADD-new-section (config-protection with 3 rows: main + cli + store). Lane D STRICT GATE PR2 audit verifies the 3-row outcome + clean section boundaries.

---

## 2026-05-07 — Decision D: cluster-5-removed.test.ts presence-only (per Cluster 2 v1.3 §F option-a)

```yaml
---
ts: 2026-05-07T15:30:00Z
kind: testing
severity: minor (sibling-parity)
phase: cluster-5
affects: [Cluster 5 paired test design — final cluster pattern lock-in]
---
```

**Context:** Cluster 2 v1.3 §F established option-a (`cluster-N-removed.test.ts` presence/shape-only; no count-lock). Locked across Clusters 3+4 successful executions.

Cluster 5 inherits same: `cluster-5-removed.test.ts` asserts `BUNDLED_CHECK_NAMES ∩ ["config-protection"] = ∅` (1-name disjointness; only config-protection registered).

**Options considered:**

1. **Presence/shape-only (CHOSEN; per option-a)** — sibling-parity with Clusters 3+4.
2. Add count-lock — re-introduce ratchet; rejected.

**Chosen:** Option 1.

**Reason:** sibling-parity across the full 5-cluster arc; option-a discipline was canonical from Cluster 2 v1.3 forward; Clusters 3+4+5 all conform. The single magic-number site ratchets across the arc: bundled-registrations.test.ts:72 EXPECTED_COUNT 29→20 (Cluster 1) → 16 (C2) → 15 (C3) → 13 (C4) → **12 (C5; final)**.

**Operationalized:** PR2 manifest at `46726ed` includes `test/hooks/cluster-5-removed.test.ts` (NEW, ~30 LOC, disjointness-only on 1 name). PR1 manifest at `dfe2853` includes `src/__tests__/hooks/cluster-5-substrate-canonical.test.ts` (NEW, ~85 LOC, presence/shape).

---

## 2026-05-07 — Decision E: ARC COMPLETION — plugin scope reaffirmed; 21/21 INVERSIONS files moved (100%)

```yaml
---
ts: 2026-05-07T15:35:00Z
kind: scope
severity: load-bearing
phase: cluster-5
affects:
  [
    arc closure; plugin scope post-arc; visible-but-deferred surface inventory; future-cluster discipline,
  ]
---
```

**Context:** The INVERSIONS arc was scoped per `~/.claude/notes/plugin-internals-audit-2026-05-06.md` §9 to move 21 single-instance discipline files from `nbruzzi/claude-conductor` (plugin) to `nbruzzi/claude-dotfiles` (substrate). The arc partition: A=39 plugin-canonical, B=21 INVERSIONS, C=5 parallel-by-design, D=0 ambiguous.

Cluster 5 (config-protection; 3 files) ships as the FINAL cluster. **Post-Cluster-5: 21 of 21 INVERSIONS files moved (100%).** Plugin scope is now exclusively multi-instance coordination machinery.

**Options considered:**

1. **Reaffirm plugin scope as multi-instance-coordination-only + close arc (CHOSEN)** — captures the architectural completion + provides forensic anchor for future readers + sets precedent for any future arc-class remediation.
2. Continue plugin scope ambiguity — leave the boundary informal; rejected because the audit doc framing demanded explicit reaffirmation.
3. Defer to next session — rejected because Cluster 5 closure is the canonical place for arc-completion narrative.

**Chosen:** Option 1.

**Reason:** the 21-file scope IS the arc; closing it deserves explicit ceremony. Future surfaces (5 parallel-by-design files, 2 partial-shim files, 1 plugin-extraction-work file from audit doc §9) are visible-but-deferred and out-of-INVERSIONS-arc-scope.

**Operationalized:**

- Plugin `bundled-check-names.ts` post-Cluster-5 narrative: "Plugin scope is now exclusively multi-instance coordination machinery (channels, sessions, handoffs, worktrees)."
- Plugin `INDEX.md` L184 narrative: count `13 → 12` + ARC COMPLETION inline ("FINAL cluster of INVERSIONS arc shipped 2026-05-07; 21/21 files moved; plugin scope reaffirmed").
- Plugin `extraction-manifest.md`: 5 distinct cluster-section headers across the manifest (generic-discipline-gates with Cluster 1 substrate-canonical rows + extract-with-shim siblings / CI verification protocol Cluster 2 / fact-force gate Cluster 3 / handoff invariants Cluster 4 / config-protection Cluster 5).
- Vault wiki concept page `~/Documents/Obsidian Vault/wiki/concepts/inversions-arc-patterns.md` updated by Bravo Q-ARC retrospective with arc-completion summary + 5-cluster metrics + lessons consolidated.
- `~/.claude/notes/plugin-internals-audit-2026-05-06.md` §9 updated: all 5 clusters marked SHIPPED + INVERSIONS arc CLOSED.
- Memory `feedback-inversions-arc-complete.md` filed: cross-cluster meta-discoveries (substrate-debt-mirror discipline, vocabulary-discipline, MOVE-AND-RELABEL pattern, parallel-lane-stacking, audit cycle convergence-by-divergence, Lane D STRICT GATE convention).

**Visible-but-deferred surfaces (out-of-arc-scope; tracked for future):**

- 5 parallel-by-design files (drift-maintenance only; Cluster A audit doc §9)
- 2 partial-shim files (registry/registry-assertion; low-priority cleanup)
- 1 plugin-extraction-work file (`hooks/dispatcher.ts`; different problem class — plugin-extraction work, not fork-to-shim)

---

_Cluster 5 SHIPPED 2026-05-07 — INVERSIONS arc COMPLETE (21/21):_

- Dotfiles PR #75 (substrate adds 3 config-protection files) MERGED `dfe2853` over branch `cluster-5-substrate-adds`
  - Pre-merge CI: runs `25506037747` + `25506058114` conclusion: success
  - Post-merge CI: run `25506174081` (`dfe2853`) conclusion: success
- Plugin PR #27 (plugin removes 3 config-protection files) MERGED `46726ed` over branch `cluster-5-plugin-removes`
  - Pre-merge CI: runs `25506653871` + `25506676244` conclusion: success
  - Post-merge CI: run `25506902274` (`46726ed`) conclusion: success
- Closure-block direct-push (this commit) on plugin main per b301bb4 / b8ddb51 / 4c3c954 / 7005d9f / 8c076be / c985fc0 / 13a180f precedent
- 3-lens audit history:
  - Plan v1: Alpha self-ARCH (light; Q-A5 recon already audit-grade) — CONVERGENT-CLEAN (0 findings per Alpha)
  - Plan v1 → v1.1: Bravo Lane B (1 MAJOR + 4 MINOR; 5 findings folded — allowlist-count MAJOR-1 + 4 line-ref/framing-discipline MINORs)
  - PR2 diff → SHIPPED: Bravo Lane D STRICT GATE CONVERGENT-CLEAN (0 findings; FINAL Lane D — fifth lens-run; cleanest cluster execution per Bravo lens table)
  - Total: 5 audit findings folded; 2 lens-runs (Alpha self + Bravo Lane B + Bravo Lane D CONVERGENT-CLEAN)
- Plan: `~/.claude/plans/cluster-5-config-protection.md` v1.1 (final)
- Recon: `~/.claude/notes/cluster-5-config-protection-recon-2026-05-07.md` (Bravo Lane Q-A5)

═══════════════════════════════════════════════
_INVERSIONS ARC SHIPPED 2026-05-07 — 21 of 21 files moved (100%):_
═══════════════════════════════════════════════

| Cluster | Theme                       | Files | Plugin source LOC | PR1 squash (dotfiles) | PR2 squash (plugin) | Closure block |
| ------- | --------------------------- | ----- | ----------------- | --------------------- | ------------------- | ------------- |
| 1       | Universal coding discipline | 9     | ~1,041            | `f727bd0`             | `48d331f`           | `b8ddb51`     |
| 2       | CI verification protocol    | 4     | 1,362             | `286bf91`             | `ca44a921`          | `8c076be`     |
| 3       | Fact-force gate             | 3     | 920               | `6a4ae21`             | `6d31cf47`          | `c985fc0`     |
| 4       | Handoff invariants          | 2     | 267               | `c5c7f41`             | `b31fef62`          | `13a180f`     |
| 5       | Config-protection           | 3     | 515               | `dfe2853`             | `46726ed`           | this commit   |

- Total source LOC moved: ~4,105
- Total audit findings folded across 5 clusters: 24 (C1) + 12 (C2 self) + 7 (C2 Charlie) + 4 (C2 Bravo Lane B) + 1 (C2 Bravo Lane D) + 0 (C3 self) + 3 (C3 Bravo Lane B) + 0 (C3 Lane D) + 0 (C4 self) + 4 (C4 Bravo Lane B) + 1 (C4 Bravo Lane D) + 0 (C5 self) + 5 (C5 Bravo Lane B) + 0 (C5 Lane D) = ~62+ findings
- Total lens-runs: 13 audit-cycle passes across 5 clusters
- Lane D STRICT GATE convention upheld 4 consecutive clusters (C2-C5; C1 was hotfix-after-squash with b8ddb51)

**Plugin scope post-arc:** exclusively multi-instance coordination machinery. The 12 remaining BUNDLED_CHECK_NAMES are: channels (channel-gc, channels-gc-reaper, active-channels-load), sessions (session-collision-gate, session-presence-register, session-presence-unregister, identity-injector), worktrees (dotfiles-worktree-cleanup, dotfiles-worktree-provisioner, dotfiles-worktree-gc), task-coordinator, teammate-idle-reminder.

---
