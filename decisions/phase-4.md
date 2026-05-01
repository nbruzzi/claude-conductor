<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision Log — Phase 4

Per-entry schema (same as `phase-3.md`):

```yaml
---
ts: <ISO-8601>
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: 4
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

## 2026-05-01 — Decision A: retire `bundled-registrations` parity script

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: architectural
severity: major
phase: 4
affects:
  [
    scripts/check-bundled-registrations-parity.sh,
    package.json,
    .github/workflows/test.yml,
    test/hooks/exports-map-coverage.test.ts,
    dotfiles/src/__tests__/hooks/cross-edge-imports.test.ts,
    dotfiles/src/__tests__/hooks/check-names-superset.test.ts,
  ]
---
```

**Context:** with the dotfiles shim layer dropped (Phase 4) and bundled checks consumed cross-edge from plugin canonical, the existing `check-bundled-registrations-parity.sh` script — which compared dotfiles' bundled-registrations parallel block against plugin's — has nothing parallel to compare. Its invariants (#1-4) are now either obsolete (no parallel block) or migrated to other enforcement.

**Options considered:**

1. **Retire the script + replace via paired structural tests on each repo edge** (chosen) — plugin-side `exports-map-coverage.test.ts` asserts every `BUNDLED_CHECK_NAMES` entry has an exports-map entry; dotfiles-side `cross-edge-imports.test.ts` + `check-names-superset.test.ts` assert their half. Both run as normal tests, not a separate parity script.
2. Repurpose the script as a logical-block diff — marginal value; the parallel block doesn't exist anymore so what is being compared?
3. Keep with relaxed assertions — unclear what it would assert; degrades to a no-op.

**Chosen:** Option 1.

**Reason:** Imperative parity scripts live OUTSIDE the contract they enforce — they go stale, get bypassed, get retired without replacement. Tests live NEXT to the contract, run as part of normal test suites, cover BOTH sides because each side has its own test on its own surface. This pattern generalizes — see Decision H. Plugin retirement landed in Bravo Lane #6 PR #8 at `6b961bc`.

**Supersedes / superseded_by:** none.

---

## 2026-05-01 — Decision B: retain dotfiles `bundled-registrations.ts` as composition layer

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: architectural
severity: minor
phase: 4
affects:
  [
    dotfiles/src/hooks/checks/bundled-registrations.ts,
    dotfiles/src/hooks/dispatcher.ts,
  ]
---
```

**Context:** with all 25 bundled checks now imported cross-edge, does dotfiles still need `bundled-registrations.ts`, or could the dispatcher call plugin's `registerBundled` directly?

**Options considered:**

1. **Retain it as a thin dotfiles-side composition layer** (chosen) — it imports plugin canonicals + calls `RegistryBuilder.add` + applies any dotfiles-side wrap-when-needed (per Decision C). One indirection level, but a load-bearing one if dotfiles ever needs to inject observability/config around a plugin check.
2. Drop it entirely + dispatcher calls `claude-conductor/hooks/checks/bundled-registrations.registerBundled` — minimal. Cons: forecloses the wrap-when-needed seam without a clear trigger to reverse.

**Chosen:** Option 1, with an explicit **trigger for re-evaluation:** if Phase 5 lifts the B2 candidates (compound-bash-detector + run-affected-tests) AND `bundled-registrations.ts` adds zero local register() calls in the process, drop the file in Phase 6 and have dispatcher call plugin's `registerBundled` directly. Make the decision falsifiable.

**Reason:** dotfiles-side composition is cheap to keep (~10 LOC + JSDoc), and the wrap-when-needed seam (Decision C) lives THROUGH this layer. Premature drop forecloses that seam without a tested replacement. The trigger keeps it falsifiable — drop happens automatically when justified.

---

## 2026-05-01 — Decision C: wrap-when-needed pattern for dotfiles-side observability/config

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: api-shape
severity: minor
phase: 4
affects: [dotfiles/src/hooks/checks/]
---
```

**Context:** if a future scenario requires wrapping a plugin canonical check with dotfiles-side observability, config, kill-switch overlay, or rate-limiting — what's the playbook?

**Options considered:**

1. **Re-introduce a local file at `dotfiles/src/hooks/checks/<name>.ts` that imports from `claude-conductor/hooks/checks/<name>`, wraps the check, exports under the same name, and have `bundled-registrations.ts` import from local instead of cross-edge for that one name** (chosen) — minimal surface, no architectural foreclosure.
2. Add a wrap-mechanism to plugin's `registerBundled` (e.g., per-name middleware) — over-engineered for the rare case.
3. Wait for the scenario to arise and design then — reactive; risk of inventing under pressure when the problem is concrete.

**Chosen:** Option 1.

**Reason:** Cheap to add later (no architectural foreclosure); the playbook is canonized so it's not invented under pressure. The retained `bundled-registrations.ts` (Decision B) is the composition layer that makes per-name wrap a one-line edit.

---

## 2026-05-01 — Decision D: SPDX coverage via dotfiles umbrella LICENSE for deleted files

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: tooling
severity: minor
phase: 4
affects: [dotfiles/LICENSE, dotfiles/src/hooks/checks/]
---
```

**Context:** Phase 4 deletes 28 dotfiles shim files that carried per-file SPDX headers. Does this leave an attribution gap?

**Options considered:**

1. **Rely on dotfiles repo's umbrella `LICENSE` (Apache-2.0) to cover the dotfiles tree as a whole** (chosen) — per-file SPDX headers are not load-bearing for license clarity. Plugin canonical files (consumed via `node_modules/claude-conductor/...`) carry their own SPDX headers in their source-of-truth location.
2. Mass-edit per-file SPDX headers across the deletions (no-op since files are gone).
3. Add an explicit "deleted in Phase 4" attribution log somewhere — over-engineered.

**Chosen:** Option 1.

**Reason:** Dotfiles repo's umbrella LICENSE is the right granularity for repo-wide attribution. Source-of-truth files (plugin canonicals) carry their own SPDX. No attribution gap.

---

## 2026-05-01 — Decision E: accept Slice 2 soak-time risk on 3 worktree-substrate hooks

```yaml
---
ts: 2026-05-01T13:00:00Z
kind: scope
severity: major
phase: 4
affects:
  [
    plugin/src/hooks/checks/dotfiles-worktree-cleanup.ts,
    plugin/src/hooks/checks/dotfiles-worktree-gc.ts,
    plugin/src/hooks/checks/dotfiles-worktree-provisioner.ts,
  ]
---
```

**Context:** Phase 4 deletes 3 dotfiles shims for hooks that shipped only 24 hours ago in Phase 3 Slice 2 (`dotfiles-worktree-{cleanup,gc,provisioner}`). If a latent bug surfaces in plugin canonical for any of these post-P4, the dotfiles shim — which would have been a fail-safe during the 24h soak — no longer exists.

**Options considered:**

1. **Accept the soak-time risk explicitly + rely on the wrap-when-needed seam (Decision C) for recovery** (chosen) — Slice 2 was 3-lens-audited at SHIP (RE 9.0 / ARCH 8.0 / Bravo 9.0) and passed cross-instance verification. The 3-lens audit + soak-period rigor justifies the confidence.
2. Defer those 3 to a P4.5 post-soak slice — doubles atomic-wiring transactions and increases coordination overhead. The accept-the-risk choice is simpler and the audit trail justifies the confidence.

**Chosen:** Option 1.

**Reason:** Slice 2's 3-lens audit + Bravo verification were rigorous; the wrap-when-needed pattern (Decision C) provides a recovery seam if a latent bug surfaces. Splitting P4 doubles coordination overhead for marginal risk reduction.

---

## 2026-05-01 — Decision F: defer `session-collision-gate` + `session-presence-register` from delete-list (REV-1.8 course correction)

```yaml
---
ts: 2026-05-01T12:35:00Z
kind: scope
severity: major
phase: 4
affects:
  [
    dotfiles/src/hooks/checks/session-collision-gate.ts,
    dotfiles/src/hooks/checks/session-presence-register.ts,
    dotfiles/src/hooks/checks/bundled-registrations.ts,
    dotfiles/src/active-sessions/cli.ts,
    dotfiles/src/__tests__/hooks/session-collision-gate.test.ts,
    dotfiles/src/__tests__/hooks/session-presence-register.test.ts,
    dotfiles/src/__tests__/hooks/session-presence-unregister.test.ts,
    dotfiles/src/__tests__/shared/fail-open-symmetry.test.ts,
  ]
---
```

**Context:** mid-Phase-v test gate surfaced 11 failing tests in `session-collision-gate.test.ts` + `session-presence-register.test.ts`. Tests configure dotfiles' `active-sessions` module-level state via `setCoordinationRootsForTesting`; plugin's check-fn (post cross-edge flip) reads PLUGIN's `active-sessions` module — different instances, state mismatch. Two B5-drift files were originally slated for deletion in REV 3 + REV-1.7; the test failures revealed the deferred ARCH-3 conflict.

**Options considered:**

1. **Revert these 2 from delete-list; defer to ARCH-3 flip-on slice when active-sessions canonicalization happens** (chosen) — preserves Phase 4's other 28 deletions, doesn't expand scope to active-sessions.
2. Add active-sessions canonicalization to Phase 4 scope — significantly expands Phase 4; conflicts with REV 3 §3 which explicitly deferred active-sessions to flip-on slice.
3. Delete the affected tests (lose coverage) — coverage loss; tests are valuable; rejected.
4. Plugin canonicalize JUST the test setup helpers (e.g., `setCoordinationRootsForTesting`) without full active-sessions migration — partial migration, fragile, leaves state-sharing concerns lurking.

**Chosen:** Option 1.

**Reason:** ARCH-3 active-sessions canonicalization is already filed as flip-on dependency-blocker. Deferring these 2 files cleanly aligns with that work — when ARCH-3 lands and active-sessions is unified across repos, these 2 files can be deleted then. Net P4 reduces from 30 deletions to 28 with no architectural cost. The course correction was caught by Phase v test gate (the safe-sequencing checkpoint did its job).

**Supersedes / superseded_by:** scoped under ARCH-3 follow-up (flip-on slice).

---

## 2026-05-01 — Decision G: Safe Edit Sequencing pattern for refactors touching the dispatcher's eager-import graph

```yaml
---
ts: 2026-05-01T12:00:00Z
kind: tooling
severity: major
phase: 4
affects:
  [dotfiles/src/hooks/dispatcher.ts, dotfiles/RECOVERY.md, future-refactors]
---
```

**Context:** Phase 4 RE-2 audit pre-validation (deliberate-broken-import smoke) confirmed Slice 1's `CLAUDE_CONDUCTOR_DISABLE_HOOKS=*` bailout does NOT rescue mid-flight import-resolve failures — Bun resolves dispatcher.ts:42 imports BEFORE env var is read at line 564. This breaks the assumed "safe to delete shims first, then flip imports" pattern: a partial-delete state would wedge the dispatcher with no recovery.

**Options considered:**

1. **Flip imports FIRST while shims still on disk → typecheck checkpoint → only then delete shims** (chosen) — both `./<name>.ts` and `claude-conductor/hooks/checks/<name>` resolve to the same module via the shim re-export. Dispatcher stays functional throughout the transaction window. Typecheck checkpoint catches any flip typo before any deletion.
2. Run the atomic transaction as a single sed/script — same effect for the import flip, but doesn't add the typecheck checkpoint between flip and delete.
3. Defer the entire refactor pending dispatcher hardening — too conservative; Safe Edit Sequencing is sufficient.

**Chosen:** Option 1.

**Reason:** Eliminates mid-flight wedge risk for THIS atomic transaction. The flip-then-typecheck-then-delete sequence preserves both-paths-resolve invariant during the transaction's edit window; if a flip is wrong, typecheck fails BEFORE any shim is deleted, so revert is clean. Documented in RECOVERY.md and `feedback-dispatcher-bailout-precedes-imports.md` for future refactors.

**Follow-up backlog:** dispatcher hardening — wrapper script (`dispatcher.sh`) reading `CLAUDE_CONDUCTOR_DISABLE_HOOKS=*` and exiting clean BEFORE invoking `bun run dispatcher.ts`, OR top-level dynamic `import()` gated on env var. Either path bullet-proofs bailout for ANY future broken-import scenario, generalizing beyond the Safe Edit Sequencing per-refactor discipline.

---

## 2026-05-01 — Decision H: cross-edge contracts use paired structural tests, not parity scripts (generalized rule)

```yaml
---
ts: 2026-05-01T13:30:00Z
kind: architectural
severity: major
phase: 4
affects: [all-future-cross-edge-work]
---
```

**Context:** Decision A retired the bundled-registrations parity script in favor of paired structural tests. Question — is this a one-off Phase-4-specific approach, or a generalizable principle for all cross-edge contracts (cross-repo, cross-package, plugin-host, SDK ↔ application, RPC schemas)?

**Options considered:**

1. **Apply the pattern as a generalized rule for all future cross-edge work** (chosen) — whenever you encounter or design a cross-edge contract, replace imperative parity scripts with paired structural tests on each side.
2. Keep it Phase-4-specific; revisit per case — risks reinvention each cycle, which the parity-script-comes-back failure mode shows is real.

**Chosen:** Option 1.

**Reason:** The parity-script-vs-paired-tests tradeoff is structural, not Phase-4-specific. Imperative parity scripts live OUTSIDE the contract; tests live NEXT to it. Drift on either side fails the suite — there's no single point of failure. This applies to package boundaries, repo boundaries, microservice boundaries, plugin-host contracts, RPC schemas, SDK ↔ application contracts. Any cross-edge contract should be enforced via paired tests, not a comparison script.

**Operationalized as:** `feedback-cross-edge-contract-via-paired-tests.md` in dotfiles memory (surfaces on every session-start to apply the rule by default for future ANY refactor).

---

_Phase 4 SHIPPED 2026-05-01:_

- Plugin PR #7 (exports-map-coverage test) MERGED `c448898`
- Plugin PR #8 (parity-script retirement) MERGED `6b961bc`
- Dotfiles PR #56 (atomic — 28 deletions + 31 import flips + 14 retargets + 2 new tests + RECOVERY.md) MERGED `c68850d` over commit `b18ca59`
- Pre-merge dotfiles CI: runs 25215169453 + 25215170545 conclusion: success
- Plugin Lane #6 CI: runs 25214969349 + 25214803801 conclusion: success
- Post-merge dotfiles CI: run 25215256785 conclusion: success
- 4-lens audit: REV 3 (RE 7.0 / ARCH 7.5 / CS 7.5 / Bravo 8.5) → REV-1 ops audit (RE 6.5 / ARCH 7.5 / Workflow 7.0) → REV-1.5 verification loop (8.57/10) → REV-1.6/1.7 amendments → REV-1.8 course correction → Subagent (RE) Nick-lens 7.5/10 → Bravo Lane (4) cross-instance 8.5/10
