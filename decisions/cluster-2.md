# Cluster 2 of 21 INVERSIONS arc — CI verification protocol (plugin → substrate)

**Slice:** Cluster 2 of the 21 INVERSIONS remediation arc per `~/.claude/notes/plugin-internals-audit-2026-05-06.md` §9.
**Cycle:** 2026-05-07
**Outcome:** SHIPPED — both PRs merged + post-merge CI green on each repo's main.

This file mirrors `decisions/cluster-1.md`'s shape per the precedent established 2026-05-07. Cluster 2 carries forward the per-cluster closure-block discipline + the v2-anticipation addendum on Cluster 1's substrate-debt-mirror inheritance picture (which Cluster 2 v1.3 §3.3 generalized via option-a — see Decision F below).

---

## 2026-05-07 — Decision A: substrate-canonical verdict-correction trap (recon-agent overruled)

```yaml
---
ts: 2026-05-07T03:30:00Z
kind: scope
severity: load-bearing
phase: cluster-2
affects: [Cluster 2 verdict on all 4 ci-verification files]
---
```

**Context:** Charlie's Lane A recon (Cluster 2 follow-on) returned an Explore-subagent verdict `(l) operational-test verdict: PLUGIN-CANONICAL — these ARE multi-instance coordination machinery` for the 4 ci-verification files. Recon-agent reasoning conflated within-session-state-persistence (sentinel files keyed by session_id, read by same session's stop event) with cross-instance coordination. This verdict, if integrated, would have produced a Cluster 2 plan v1 framing the move as a no-op-rename rather than a substantive substrate-canonical migration.

**Options considered:**

1. **Trust agent verdict (plugin-canonical)** — would have wasted a Cluster 2 plan-cycle on no-op-move framing; misalignment with audit doc §9 priorities.
2. **Primary-source verify against `feedback-plugin-removal-test.md` (CHOSEN)** — apply the operational test directly: "if plugin removed, would single-instance OS-level Claude break?" Substrate's dispatcher would still register and run ci-verification checks from local imports; the within-session sentinel persistence is single-instance discipline.

**Chosen:** Option 2 (primary-source). Verdict locked as **substrate-canonical** for all 4 ci-verification files.

**Reason:** the operational test in `feedback-plugin-removal-test.md` distinguishes "persists state within one Claude session's lifecycle" (single-instance discipline) from "cross-instance coordination machinery" (channels, sessions, handoffs, worktrees). ci-verification's sentinel files are keyed by session_id and read by the SAME session — that's within-session, not cross-instance. Substrate-canonical correct.

**Operationalized:** Plan v1 §2 §10 captured the recon-agent verdict-correction. New memory `feedback-subagent-direction-verdicts-need-primary-source-check.md` filed at session boundary. Audit doc §9 classification stands. Bravo Lane Q-A recon for Cluster 3 (filed `~/.claude/notes/cluster-3-fact-force-recon-2026-05-07.md` 2026-05-07T13:23Z) confirmed no analogous trap surfaces in Cluster 3 (within-session vs cross-instance distinction is unambiguous for fact-force).

---

## 2026-05-07 — Decision B: substrate test layout — FLAT, not nested

```yaml
---
ts: 2026-05-07T03:35:00Z
kind: testing
severity: load-bearing
phase: cluster-2
affects: [test path resolution; precedent for Clusters 3-5]
---
```

**Context:** Plan v1 §3.2 invented a nested substrate test layout `src/__tests__/hooks/checks/ci-verification-*.test.ts`. ARCH self-audit (3 CRIT) caught this as ARCH-CR1: substrate's actual convention is FLAT `src/__tests__/hooks/<name>.test.ts` (verified `ls __tests__/hooks/checks/` returned "No such file"; Cluster 1's paired test landed flat).

**Options considered:**

1. **Adopt FLAT layout (CHOSEN)** — match Cluster 1 sibling-parity + substrate convention. Cluster 1's `cluster-1-substrate-canonical.test.ts` at `src/__tests__/hooks/cluster-1-substrate-canonical.test.ts` (flat) is the precedent.
2. Create new nested layout — would diverge from substrate convention; cause inconsistency for Clusters 3-5 to inherit.

**Chosen:** Option 1.

**Reason:** sibling-parity with Cluster 1 + substrate convention. Memory `feedback-substrate-test-layout-flat-convention.md` filed at session boundary 2026-05-07.

**Operationalized:** All Cluster 2 substrate tests at flat `src/__tests__/hooks/`. Cluster 2 plan v1.1 §3.2 + §11 corrected; verify-grep `ls src/__tests__/hooks/checks/ci-verification-*.test.ts` confirms zero matches post-PR1 (no nested files). Test import-flip regex re-derived for plugin-internal-relative source: `s|\.\./\.\./\.\./src/hooks/(checks/[^"]+|types)\.ts|../../hooks/$1.ts|g`.

---

## 2026-05-07 — Decision C: architecture.yaml entries — explicit 6-field shape per file

```yaml
---
ts: 2026-05-07T11:43:00Z
kind: architecture
severity: critical
phase: cluster-2
affects: [architecture.yaml node entries; precedent for all future clusters]
---
```

**Context:** Plan v1.1 ARCH-CR3 fold added "ADD 4 NODE entries with `kind: check, layer: dotfiles`" — categorical fields only. Bravo Lane B v1.2 audit (ARCH-V1.2-MAJOR-2 finding) caught the spec as incomplete: substrate's `architecture-drift` PostToolUse check (`src/hooks/checks/architecture-drift.ts:80-87`) explicitly checks for `path: "<relPath>"` substring in architecture.yaml. Without `path:` field in node entries, architecture-drift fires on every Edit/Write of new ci-verification source files post-PR1.

Plus ARCH-V1.1-2 finding from Charlie Lane B: plan v1.1 §3.2 invocation edge listed `h-session-start → c-ci-verification-auth-warn` but actual node id is `h-session` (verified `architecture.yaml:94 — id: h-session,` with `event: session-start`). Verbatim plan execution would create orphan edge → graph-integrity violation.

**Options considered:**

1. **Explicit 6-field shape per node + correct h-session edge syntax (CHOSEN)** — match Cluster 1 sibling-parity per `c-auto-format` at `architecture.yaml:183-189`: `id, layer, kind, path, event, purpose`. Edges use single-line shape `- { from: h-<event>, to: c-X, kind: invokes }` per L809-846 precedent.
2. Categorical-fields-only — would trigger architecture-drift hook on every PR1 file Edit; sibling-parity violation; downstream cluster authors inherit incomplete pattern.

**Chosen:** Option 1.

**Reason:** architecture-drift's `path:`-substring check makes the `path:` field load-bearing operationally, not just aesthetic. Plus sibling-parity per `feedback-sibling-parity-at-merge-time.md` — heterogeneous yaml entries violate vocabulary discipline. h-session correction prevents orphan-edge graph integrity violation.

**Operationalized:** Plan v1.3 §3.2 + §11 expanded to per-file 6-field yaml shape with TIER-purposes (auth-warn=session-start, gate=stop, pre-push-arm=pre-tool-use, reminder=post-tool-use). Edges enumerated single-line per precedent. Verify-grep `grep -c "c-ci-verification" architecture.yaml` returns 8 (4 nodes + 4 edges). Cluster 1 had pre-staged c-fact-force node correctly — Cluster 3 PR1 inherits this pattern (architecture.yaml already has c-fact-force; doesn't need to ADD; per Bravo Lane Q-A recon).

---

## 2026-05-07 — Decision D: canonical-sync discipline applied between cross-repo PRs

```yaml
---
ts: 2026-05-07T03:00:00Z
kind: process
severity: load-bearing
phase: cluster-2
affects: [PR1→PR2 sequencing for all multi-repo cluster work]
---
```

**Context:** Cluster 1 hit the live-substrate-sequencing canonical-sync trap mid-flight: `gh pr merge --squash --delete-branch` from Alpha-original's worktree silently failed the local canonical-sync step; canonical dotfiles main stayed on `7509aab` (pre-PR1) for ~20 min while plugin canonical advanced through PR2 to `48d331f`. Module-load failures cascaded for ~20 min until manual `git pull --ff-only origin main`. Lesson memorialized as `feedback-canonical-sync-after-worktree-merge.md`.

**Options considered:**

1. **Mandatory `git pull --ff-only origin main` between PR1 squash and PR2 work (CHOSEN; per Cluster 1 lesson)** — explicit canonical-sync as a checklist item in plan §4 + §11 verification list. Discipline applied at PR2 merge boundary too.
2. Trust `gh pr merge` to handle canonical-sync — proven false by Cluster 1 incident.

**Chosen:** Option 1.

**Reason:** worktree-driven cross-repo merges leave the canonical checkout lagging origin/main; downstream operations (PR2 work, hook dispatch) read from canonical and break silently. Memory `feedback-canonical-sync-after-worktree-merge.md` codifies the discipline.

**Operationalized:** Plan v1.3 §4 mandates `cd ~/.claude-dotfiles && git pull --ff-only origin main` between PR1 squash and PR2 work; §11 PR2 final step adds same for both repos. Cluster 2 cycle: PR1 squash followed by canonical-pull (no trap). PR2 squash also followed by canonical-pull. Zero canonical-sync failures.

---

## 2026-05-07 — Decision E: extraction-manifest.md NEW section header per cluster (vocabulary discipline)

```yaml
---
ts: 2026-05-07T03:50:00Z
kind: documentation
severity: load-bearing
phase: cluster-2
affects: [extraction-manifest section structure; precedent for Clusters 3-5]
---
```

**Context:** Plan v1.1 §3.1 line 104 ARCH-V1.1-7 fold (Charlie Lane B v1.1 finding) specified: "ADD a NEW section header `Hooks/checks — CI verification protocol (substrate-canonical Cluster 2 INVERSIONS arc 2026-05-07)` with 4 NEW ROWS at sibling position to existing Cluster 1 section". The intent: per-cluster vocabulary discipline — distinct section per cluster, no shared fall-through bucket; mirror Cluster 1 separate-section precedent. Locked by my Lane M `decisions/cluster-1.md` v2-anticipation addendum's VOCABULARY-LOCK section.

**First implementation (commit `6a946716` on PR2 branch) violated the discipline (BRAVO-LANE-D-CRIT-1, 2026-05-07T13:15Z):** the new section header was inserted between rows of an existing markdown table, but the table syntactically continued under the new header — vacuuming 8 unrelated rows (architecture-coverage/drift/orphans + channel-gc + active-channels-load + session-collision-gate + session-presence-register/unregister) into the new section. The "CI verification protocol" section ended up containing 12 rows instead of the specified 4.

**Lane D STRICT GATE caught this pre-squash.** Alpha force-pushed fix at `17cfd87`: 8 rows moved back to "Hooks/checks — generic discipline gates"; new section restored to exactly 4 ci-verification rows.

**Options considered:**

1. **Distinct section header per cluster (CHOSEN, post-CRIT-1 fold)** — per Cluster 2 plan + addendum vocabulary discipline. Section-add discipline must include audit-after that ALL rows below the insertion point still sit under their intended section header (the markdown-table-without-explicit-close trap).
2. Fold ci-verification rows into existing Cluster 1 "generic discipline gates" section — would corrupt vocabulary across 5 cluster moves.

**Chosen:** Option 1.

**Reason:** vocabulary-lock per cluster preserves forensic provenance (which checks landed in which slice). Future Cluster 3-5 authors inherit clean separation. Bravo Lane Q-A recon doc §11 risk #1 flags this trap as High-likelihood for Cluster 3 PR2 (the precedent is now explicit).

**Operationalized:** PR2 final state at `17cfd87` post-fold: 3 distinct section headers at L70 / L97 / L106 (`generic discipline gates` / `CI verification protocol` / `Nick-specific (KEEP)`). New "CI verification protocol" section contains exactly 4 ci-verification rows. Lane D STRICT GATE convention proved its value — without it, the corrupted manifest would have shipped + Cluster 3 would have inherited the failure surface. Future-cluster discipline: section-add must be paired with row-boundary verification.

---

## 2026-05-07 — Decision F: option-a — drop count-assertion from `cluster-N-removed.test.ts`

```yaml
---
ts: 2026-05-07T12:05:00Z
kind: testing
severity: major
phase: cluster-2
affects:
  [
    substrate-debt-mirror discipline; Bravo Lane M decisions/cluster-1.md addendum amendment,
  ]
---
```

**Context:** Bravo Lane B v1.2 audit (ARCH-V1.2-MAJOR-3 finding) surfaced that Cluster 2 plan v1.1 introduced a NEW magic-number ratchet site at `cluster-2-removed.test.ts` (asserting `BUNDLED_CHECK_NAMES.length === 16`). Combined with the existing `cluster-1-removed.test.ts:43 EXPECTED_POST_PR2_COUNT = 20` ratchet, this would have grown linearly with cluster count — by Cluster 5, plugin would have 5 cluster-N-removed.test.ts files + bundled-registrations.test.ts:68 = 6 magic-number sites needing per-cluster updates. Decision E load-bearing invariant on `cluster-N-removed.test.ts` is disjointness ("these N names live in substrate, never plugin"); count-lock duplicated `bundled-registrations.test.ts:68` and added ratchet-multiplication.

**Options considered:**

1. **Option (a) — drop count-assertion from cluster-N-removed.test.ts (CHOSEN)** — keep disjointness-only assertion; restore sibling-parity with substrate-side `cluster-N-substrate-canonical.test.ts` (presence/shape-only). Cross-cluster cleanup: Cluster 2 PR2 also REMOVES `cluster-1-removed.test.ts:43 EXPECTED_POST_PR2_COUNT` + its locking `it()` block. From Cluster 2 forward: 1 magic-number site (bundled-registrations.test.ts:68) ratchets per cluster; cluster-N-removed.test.ts stays disjointness-only.
2. Option (b) — consolidate count-assertions into single all-clusters file. Merge artifact; requires migration; deferred.
3. Option (c) — accept N+1 ratchet sites; document burden in plan §7. Substrate-debt grows linearly; rejected per `feedback-substrate-debt-larger-than-slice-scope.md`.

**Chosen:** Option 1.

**Reason:** sibling-parity restored across the cross-edge paired test pair (substrate-side presence-only ↔ plugin-side disjointness-only). Decision E load-bearing invariant preserved; ratchet-multiplication eliminated; per `feedback-substrate-debt-larger-than-slice-scope.md` justifies cross-cluster cleanup of `cluster-1-removed.test.ts`.

**Operationalized:** Plan v1.3 §3.3 paired test design simplified to disjointness-only. PR2 manifest at `17cfd87` includes:

- `test/hooks/cluster-1-removed.test.ts`: REMOVE `EXPECTED_POST_PR2_COUNT` constant + `it("BUNDLED_CHECK_NAMES count is locked at EXPECTED_POST_PR2_COUNT")` block; add comment explaining v1.3 ARCH-V1.2-MAJOR-3 option-a generalization
- `test/hooks/cluster-2-removed.test.ts` (NEW): presence/shape-only — `BUNDLED_CHECK_NAMES ∩ CLUSTER_2_NAMES = ∅`; no count assertion
- `decisions/cluster-1.md` v2-anticipation addendum amended (commit `4c3c954`): MAGIC-NUMBER REMAINS section rewritten — 1 site only post-Cluster-2; per-cluster delta projections (Cluster 3 16→15 / Cluster 4 15→13 / Cluster 5 13→10)

Future Cluster 3-5 authors: cluster-N-removed.test.ts files keep disjointness-only assertions; bundled-registrations.test.ts:68 EXPECTED_COUNT is the single source-of-truth count-lock that ratchets per cluster.

---

_Cluster 2 SHIPPED 2026-05-07:_

- Dotfiles PR #72 (substrate adds 4 ci-verification protocol checks) MERGED `286bf91` over branch `cluster-2-substrate-adds`
  - Pre-merge CI: runs `25496311076` + `25496328327` (both `efbe50f`) conclusion: success
  - Post-merge CI: run `25496435919` (`286bf91`) conclusion: success
- Plugin PR #24 (plugin removes 4 ci-verification protocol checks) MERGED `ca44a921` over branch `cluster-2-plugin-removes`
  - Pre-merge CI: runs `25497703738` + `25497716821` (both `6a946716`, pre-CRIT-1-fold); post-CRIT-1-fold runs `25498261778` + `25498263359` (both `17cfd87`); conclusion: success
  - Post-merge CI: run `25498665251` (`ca44a921`) conclusion: success
- Closure-block hotfix (this commit) MERGED direct on plugin main `(this commit)` per b301bb4 / b8ddb51 / 4c3c954 precedent
- 4-lens audit history:
  - Plan v1 → v1.1: Alpha self-ARCH (3 CRIT + 5 HIGH + 4 MIN; 12 findings folded)
  - Plan v1.1 → v1.2: Charlie Lane B (2 CRIT + 1 MAJOR + 4 MIN; 7 findings folded by Alpha-resume)
  - Plan v1.2 → v1.3: Bravo Lane B (0 CRIT + 3 MAJOR + 1 MIN; 4 findings folded)
  - PR2 diff → SHIPPED: Bravo Lane D STRICT GATE (1 CRIT — extraction-manifest.md vocabulary corruption; folded same-session at `17cfd87` before squash)
  - Total: 24 audit findings folded; 4 lens-runs; convergence-by-divergence at multiple layers
- 18 + ~30 = ~48 files touched across both PRs; ~133 + ~3,006 deletions in plugin PR
- Plan: `~/.claude/plans/cluster-2-ci-verification.md` v1.3 (final)
- `decisions/cluster-1.md` v2-anticipation addendum amended (commit `4c3c954`) per Decision F
- 6+ new memories filed across this cycle: `feedback-respect-explicit-peer-coord-gates.md`, `feedback-canonical-sync-after-worktree-merge.md`, `feedback-subagent-direction-verdicts-need-primary-source-check.md`, `feedback-substrate-test-layout-flat-convention.md`, `feedback-plugin-test-imports-not-cross-edge.md`, `feedback-pattern-extrapolation-needs-primary-source.md` (Bravo), plus Alpha's `feedback-sibling-parallel-lane-stacking.md`
- Vault backlog: TBD follow-up entries to be filed by Bravo at slice close

---
