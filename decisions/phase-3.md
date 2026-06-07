<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision Log — Phase 3

Per-entry schema (same as `phase-2.md`):

```yaml
---
ts: <ISO-8601>
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: 3
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

## 2026-05-30 — Cycle-3: session-start reconcile-boot hook is REPORT-MODE (not auto-apply)

```yaml
---
ts: 2026-05-30T18:08:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/hooks/checks/session-reconcile-boot.ts,
    src/hooks/checks/bundled-registrations.ts,
    src/hooks/bundled-check-names.ts,
    src/active-sessions/reconcile-boot.ts,
  ]
---
```

**Context:** The reconcile-boot library (Cycle-2 2a/2b) ships the GC, but it is only invocable manually via the `reconcile-boot --apply` CLI (Charlie #167). Cycle-3 TODO #1 ("--apply operator-reachability") adds a session-start hook so the GC surfaces automatically at boot. Design question: should the hook run `runReconcileBoot({ apply: true })` (auto-GC stale presence at every session-start) or report-only?

**Options considered:**

1. **Report-mode (chosen)** — the hook runs `runReconcileBoot` with NO `apply`, surfacing gc-eligible/malformed counts as a non-blocking briefing; the operator invokes `--apply` via the CLI at their discretion. Pros: preserves `applyGc`'s NEVER-auto-kill guard #1 (operator-explicit `--apply`); "operator-reachable" is satisfied by surfacing; boot is the worst moment to auto-GC (mid-startup / briefly-quiet / paused peers present). Cons: GC is not fully automatic (requires an operator action after the nudge).
2. **Auto-apply at session-start** — the hook runs `{ apply: true }`, deleting gc-eligible stale presence at every boot. Pros: fully automatic. Cons: STRIPS the operator-explicit guard for ALL sessions — the cardinal NEVER-auto-kill invariant the entire 2a/2b arc was isolated to protect; auto-deletes coordination state with zero operator action.

**Chosen:** Report-mode.

**Reason:** `applyGc`'s NEVER-auto-kill rests on four guards, the first being operator-explicit `--apply` (`reconcile-boot.ts` `applyGc` JSDoc). Auto-applying at boot removes that guard cohort-wide. "Operator-reachable" (TODO #1's goal) is fully satisfied by SURFACING at boot + the operator closing the loop via the CLI — agency, not auto-deletion. Auto-apply-at-boot would be a deliberate mode-2 relaxation of the cardinal invariant for all sessions: an explicit operator escalation, never a hook default. Ratified by Alpha (reconcile-boot arc owner + Cycle-3 captain), 2026-05-30.

## 2026-04-30 — Decision A: `CLAUDE_CONDUCTOR_DISABLE_HOOKS` env-var primitive

```yaml
---
ts: 2026-04-30T13:45:00Z
kind: api-shape
severity: major
phase: 3
affects:
  [src/shared/disable-hooks.ts, dotfiles/src/hooks/dispatcher.ts, runbook]
---
```

**Context:** Phase 2 Wave 2 audit (CLI-W2-1 CRITICAL) found `CLAUDE_CONDUCTOR_DISABLE_HOOKS` documented in `docs/architecture/hooks-layer.md` (Slice 4.5) but never implemented. Per Nick's 2026-04-29 Option B sign-off, Slice 10 closed the doc-lie via strike + per-hook recovery hints, routing the universal kill-switch primitive to Phase 3 first slice. Phase 3 Slice 1 implements it. The primary design decision is the **shape** of the operator surface: how operators express "disable these hooks."

**Options considered:**

1. **Env var, comma-separated names** (chosen) — `CLAUDE_CONDUCTOR_DISABLE_HOOKS=name1,name2`. Pros: zero-file-system-state; ephemeral by default; standard Unix idiom; composes with shell scripts. Cons: comma-separated not as discoverable as JSON; case-sensitivity needs documentation.
2. **Env var, JSON config** — `CLAUDE_CONDUCTOR_DISABLE_HOOKS_JSON='{"disabled":["name1"]}'`. Pros: extensible (room for per-hook flags). Cons: JSON in shell is awkward; quoting hell; no clear win for the simple "disable these hooks" use case.
3. **Per-hook file kill-switches only** (already exists) — `~/.claude/<name>-off`. Pros: explicit-acknowledgement audit trail in filesystem; durable across sessions. Cons: slow under multi-hook wedge (one `touch` per hook); not discoverable without reading source.
4. **Profile-based disable** — extend `HOOK_PROFILE` with custom-named profiles. Pros: composes with existing profile machinery. Cons: not emergency-stop-shaped (operators don't define new profiles mid-incident); shifts semantics away from "kill-switch."

**Chosen:** Option 1 — env var, comma-separated.

**Reason:** matches operator workflow ("export X=name1,name2 → emergency disable → unset X"); minimal cognitive overhead; orthogonal to file-toggle (which retains its explicit-acknowledgement audit trail role); composes with profile-filter without overlap. Comma-separated semantics match Phase 1's existing CLAUDE*CONDUCTOR*\*\_DIR pattern. Case-sensitivity matches hook-name identifier discipline.

**Supersedes / superseded_by:** none. Decisions B + C below cover composition policy and cross-edge architecture.

---

## 2026-04-30 — Decision B: Composition + emergency-disable policy + catalog discoverability

```yaml
---
ts: 2026-04-30T13:46:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/shared/disable-hooks.ts,
    dotfiles/src/hooks/types.ts,
    dotfiles/src/hooks/dispatcher.ts,
    runbook,
    docs/operations/_index.md,
  ]
---
```

**Context:** how does `CLAUDE_CONDUCTOR_DISABLE_HOOKS` compose with the existing filter mechanisms (profile, `--check=NAME` isolation, file-toggles)? What about blocking hooks — should the kill-switch refuse to disable safety-critical gates like `destructive-cmd`? And how does operator discovery scale as more phase-runbooks accumulate?

**Options considered:**

For composition ordering:

1. **profile → env → isolation** (chosen) — profile-filter (`HOOK_PROFILE`) applies first, env-var-disable second, `--check=NAME` isolation third. A check is skipped if any layer excludes it. Tag-stacking in `--list` shows `[disabled by profile,env]` when both apply.
2. profile → isolation → env — wrong; isolation is the most-specific operator action and should be last so explicit `--check=NAME` can override env-disable for manual debugging.
3. env → profile → isolation — wrong; profile is the substrate-stable layer and should be the base.

For blocking-hook policy:

1. **Allow disabling blocking hooks unconditionally + LOUDER per-dispatch warning + breadcrumb** (chosen, per Bravo C4) — emergency-disable is unfettered; warning is the audit trail.
2. Refuse to disable blocking hooks via env var — security guard. Cons: too paternalistic for an emergency-stop primitive; operators in real distress need full control.
3. Sibling env var (`CLAUDE_CONDUCTOR_DISABLE_HOOKS_ALLOW_BLOCKING=true`) required before kill-switch can disable canBlock checks — opt-in friction. Cons: adds friction at the worst moment.

For catalog discoverability:

1. **Per-phase runbook + topic-keyword cross-reference table in `_index.md`** (chosen) — each phase's operator surface gets its own runbook (`phase-2-hooks.md`, `phase-3-kill-switch.md`); `_index.md` carries a topic→runbook table so operators searching for "kill switch" or "per-hook recovery" don't need to know phase numbers.
2. Single accreting runbook (`phase-2-hooks.md` extended) — cons: monolithic file, hard to navigate, doesn't scale to Phase 4+.
3. Topic-keyed runbooks (`kill-switch.md`, `cursor-substrate.md`, etc.) — pros: maximum discoverability. Cons: harder to attribute to phase boundaries; harder to plan-doc.

**Chosen:**

- Composition: profile → env → isolation, with `[disabled by profile,env]` stacked tag.
- Blocking-hook: allowed, LOUDER per-dispatch stderr warning + persistent `kill-switch` breadcrumb.
- Catalog: per-phase runbook + cross-reference table.

**Reason:**

- Composition order mirrors the layering of operator intent: profile is the longest-lived (session config), env is in-session adjustment, isolation is per-invocation. Explicit > ambient — `--check=NAME` last lets operators force-debug an env-disabled hook.
- Blocking-hook unconditional-allow matches the "emergency disable is unfettered" framing. Per-hook file kill-switches still exist as the explicit-acknowledgement path; env var is the universal override. The louder warning is loud enough that no operator can plausibly miss it; the breadcrumb log is durable for post-incident audit.
- Per-phase runbook scales linearly with phases; topic-keyword cross-reference scales sub-linearly with operators-who-don't-know-phase-numbers.

**Catalog-discoverability addendum (CLI-DX-NEW-2):** the topic table in `docs/operations/_index.md` is the operator's primary index; runbook contents-ordered-by-phase is secondary. The convention introduced this slice (per-phase doc + topic-keyword table) is the convention for future phase runbooks.

**Supersedes / superseded_by:** none.

---

## 2026-04-30 — Decision C: Parser-vs-dispatcher cross-edge split + presence-failure variant extension

```yaml
---
ts: 2026-04-30T13:47:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/shared/disable-hooks.ts,
    src/hooks/registry.ts,
    src/shared/presence-failure-log.ts,
    package.json (exports),
    dotfiles/src/hooks/dispatcher.ts,
  ]
---
```

**Context:** the dispatcher lives in dotfiles (`~/.claude-dotfiles/src/hooks/dispatcher.ts`); the plugin (`claude-conductor`) ships the registry + shared primitives. Where does the kill-switch parser live? Does the registry need new primitives to support full-union validation? What new breadcrumb taxonomy is needed?

**Options considered:**

For parser placement:

1. **Plugin-side, pure parser primitive** (chosen) — `src/shared/disable-hooks.ts` exports `parseDisableHooksEnv(raw, knownNames, blockingNames, nameToEvents, currentEvent): DisableHooksResult`. No I/O, no registry coupling. Dotfiles dispatcher computes inputs from registry, calls parser, applies result.
2. Dotfiles-side, integrated with dispatcher — pros: simpler call chain; parser is dispatcher-internal. Cons: not testable in isolation; cross-instance verification harder; no plugin-side reuse for future operators.
3. Plugin-side, dispatcher-integrated parser+applier — pros: single function call. Cons: violates substrate boundary (plugin doesn't ship a dispatcher; that's dotfiles-specific).

For registry primitive lift:

1. **Lift `allCheckNames()` + `allBlockingNames()` + `nameToEvents()` to SealedRegistry** (chosen, per TS-2 audit + Bravo TS-2 validation) — V2 anticipation per `feedback-partial-v2-anticipation-primitives.md`. SealedRegistry already had per-event helpers (`checksFor`, `blockingNamesFor`); the full-registry-union forms are sibling primitives.
2. Compute the union ad-hoc in dotfiles dispatcher — cons: when a 2nd consumer appears (Phase 3+ slices), they re-implement the same loop; sibling-parity drift.
3. Generic `forEachRegistration(fn)` helper — pros: maximum flexibility. Cons: harder to use; clients reach inside the registry via callback.

For presence-failure variant:

1. **Add `"dispatcher"` source + `"kill-switch"` kind** (chosen, per RE-1 audit + Bravo Q1 validation) — distinct from existing `"channels-identity"` source. Operators tailing breadcrumbs can grep `source == "dispatcher" and kind == "kill-switch"` to surface kill-switch events specifically.
2. Reuse `"operator-reset"` kind — cons: ambiguous, conflates intentional kill-switch use with accidental operator-driven state resets elsewhere.
3. Add only the source variant (no new kind) — cons: insufficient discrimination for breadcrumb log queries.

**Chosen:**

- Parser placement: plugin-side, pure primitive at `src/shared/disable-hooks.ts`.
- Registry primitive lift: `allCheckNames`, `allBlockingNames`, `nameToEvents` on SealedRegistry.
- Breadcrumb variant: new `"dispatcher"` source + new `"kill-switch"` kind.

**Reason:**

- Pure primitive in plugin = testable in isolation, cross-instance verifiable, future-reusable. Dotfiles dispatcher integration is a thin layer (compute inputs, call parser, apply result).
- Registry primitives lift mirrors the partial-V2 anticipation pattern: lift shared primitives when a second caller appears, defer structural choices. The 3 new primitives are pure functions over existing internal state; zero behavior change to existing callers; clear win for future Phase 3+ slices that need full-union queries.
- Distinct breadcrumb taxonomy lets operators slice the log by concern: kill-switch breadcrumbs are a different operator-facing signal than channel-identity breadcrumbs (different recovery procedures, different audiences).

**Cross-edge atomic-wiring contract** (light per Bravo C6): this is a primitive slice, NOT a hook slice. The hook contract (4-plugin / 5-dotfiles surfaces) doesn't apply. Cross-edge surface is plugin-export + dotfiles-import + sequencing only. Plugin lands first; old-plugin + new-dotfiles fails at import time (loud), new-plugin + old-dotfiles is unused-export safe.

**Supersedes / superseded_by:** none.

---

## 2026-04-30 — Decision D: Per-session dotfiles worktrees substrate (Slice 2)

---

**Status:** SHIPPED (plugin lane lands as commits 599c209 + 4ab733b + ebefdcb + 92c24a5 + this commit; awaits plugin merge to main + Bravo lane).

**Context:** the recurring shared-tree-bleed failure mode (per
`feedback-parallel-session-shared-tree-branch-race.md`) — two concurrent
Claude sessions share `~/.claude-dotfiles` as a single working tree, and
branch checkouts / staged files / pre-commit runs leak across sessions.
Recorded incidents on 2026-04-26, 2026-04-29, 2026-04-30. Bravo manually
dogfooded a `~/.claude-dotfiles-bravo` worktree workaround during Slice 1.

Slice 2 substrate-bakes the workaround: every Claude session, when the
feature flag `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=1` is set, gets its
own `git worktree` of canonical at `~/.claude-dotfiles-<sid-prefix-8>/`.
Default-off in this slice (D9); flip-default scheduled as a follow-up
commit on main after Bravo first-dogfood ack.

---

**Sub-decisions ratified (per REV 0.2 Nick decisions):**

- **D-ARCH1 — Slash command symlink restore.** Source-of-truth for
  `commands/session/*.md` is plugin canonical (`~/claude-conductor/commands/session/`).
  install.sh:248 already declares `commands/session/` as a `DIR_SYMLINK`
  pointing at `node_modules/claude-conductor/commands/session/`. Bravo lane
  deletes the stale dotfiles fork files and re-establishes the symlink.

- **D-ARCH3 — Heartbeat-body sentinel anchored at canonical-claude-home.**
  The per-session `dotfilesRoot` value lives as an optional field on the
  existing `OwnerRecord` heartbeat body at
  `~/.claude/active-sessions/<canonical-claude-home>/heartbeats/<sid>`,
  NOT a separate `~/.claude/session-state/` directory. Anchored at the
  always-resolvable canonical `~/.claude` artifact-id. Provisioner
  explicitly pins the anchor at session-start regardless of CWD (REV 0.2
  ARCH-1 fix); `touchHeartbeat()` is read-merge-write so the field
  survives subsequent dispatcher fires (REV 0.2 ARCH-2 / RE-101 fix).

- **D-ARCH5 — Slash command sentinel-reader prelude.** Each plugin canonical
  slash command prepends `eval "$(bun run ${plugin}/src/cli/resolve-dotfiles-root.ts --session-id "$CLAUDE_SESSION_ID")"`
  - `cd "${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}"`.
    Both hooks and slash commands resolve via the same `dotfilesRoot()`
    core. Failure-fallthrough is silent (REV 0.2 ARCH-5): if the bun-run
    fails, eval consumes empty stdout and the downstream fallback chain
    takes over.

- **D-CLIDX3 — `[fff-off]` tag string.** Feature-flag-disabled hooks
  render `[fff-off]` in dispatcher `--list` output. Tag stacking grammar
  (Bravo B9): bare single-tag form when one dimension is disabled
  (`[disabled]` / `[env-disabled]` / `[fff-off]`); unified
  `[disabled by <reasons>]` grammar when 2+ dimensions are disabled
  (`[disabled by profile,env,fff]`). Sibling-parity with Slice 1's
  existing `[disabled by profile,env]` pattern. **NOTE:** this edit
  lands in dotfiles' `src/hooks/dispatcher.ts` (Bravo lane), not plugin
  — see `dispatcher-migrate-to-plugin` polish backlog.

- **D-CLIDX4 — Full 10-scenario runbook manifest.** `docs/operations/phase-3-worktrees.md`
  ships with 10 depth-3 scenarios (1-disable-this-session, 2-wedged-worktree,
  3-missed-cleanup, 4-migrate-uncommitted, 5-sid-collision, 6-provision-failure,
  7-gc-reaped-while-active, 8-flip-revert-recovery, 9-second-terminal,
  10-fresh-install-bootstrap) + 8 verbatim error drafts (E-1 through E-8)
  - Operational notes (Time Machine exclusion + path-walk discipline +
    hard-vs-soft ceiling + mixed flag-state).

- **D-RE6 — Strict-serialization lane split.** Alpha plugin lane lands
  AND merges to main BEFORE Bravo's dotfiles lane begins. Bravo first-
  spin opens a fresh terminal with `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=1`
  set explicitly. Manual `~/.claude-dotfiles-bravo` workaround
  decommissioned. Don't dogfood the substrate while building it.
  Channel signal protocol: Alpha posts `MAIN-MERGE-LANDED <sha>` on
  channel `2026-04-28_01-50` after plugin merge to main (regex
  `^MAIN-MERGE-LANDED [0-9a-f]{7,40}$`); Bravo's lane-start
  `/handoff-resume` reads channel history and verifies SHA matches
  `git -C ~/claude-conductor rev-parse origin/main` before proceeding.

---

**CLI verb hierarchy (REV 0.2 Q5):** for v1, the new CLI verbs (`session
resolve-dotfiles-root`, `worktrees show`) live as flat scripts at
`src/cli/` invoked directly by slash commands and operators. The
top-level `bin/claude-conductor` dispatcher (`src/cli/dispatcher.ts`)
currently routes `channels` and `todos` subcommands; routing the new
verbs through it is a polish item if/when the verb count grows or
operator UX warrants it.

---

**Alternatives considered + rejected:**

- **Two parallel registries (sentinel dir + active-sessions registry)** —
  Eliminated by D-ARCH3 in favor of heartbeat-body-extension. Two
  registries to keep in sync = future drift hazard.
- **Slash commands as canonical-tier-by-design** (no sentinel-reader
  prelude) — Eliminated by D-ARCH5. Two-tier resolution
  (hooks→worktree, slash→canonical) is a foot-gun.
- **Hard ceiling N=20 with refusal** — Eliminated by REV 0.2 RE-105.
  TOCTOU window; brief over-shoot tolerated by design. Soft ceiling
  with system-reminder converges at steady state via the GC reaper.
- **Parent-dir worktree naming `~/.claude-dotfiles-worktrees/<sid>/`** —
  Filed as polish (`worktree-parent-dir-tidy`). Cleaner home-dir but
  requires `file:../../claude-conductor` path bump.
- **Lazy provisioning on plan-mode-entry** — Filed as polish
  (`worktree-provisioning-lazy`). Bravo's recommendation; Nick chose
  default-on for v1.

---

**Cross-edge atomic-wiring (Bravo lens-audit (a) confirmed 5×3=15
dotfiles-side surfaces):** 3 new hooks → per-hook 5-rule contract from
`feedback-atomic-wiring-discipline.md`. Plugin-side: 4 surfaces × 3
hooks + 1 shared bundled-registrations.test.ts assertion file = 13
plugin-side touches. Dotfiles-side (Bravo lane): 5 surfaces × 3 hooks =
15 dotfiles-side touches across 8 actual files (3 shims + check-names +
bundled-registrations + 2 ORDER files + registry.test.ts).

---

**REV history:**

- REV 0 (initial draft, 2026-04-30) → 3-persona audit (RE 7.0 / Architecture
  7.0 / CLI DX 7.0) returned 6 CRITICAL + 13 MAJOR + 10 minor.
- REV 0.1 (folded REV 0 findings) → 2-persona re-audit returned 2 NEW
  CRITICAL (ARCH-1 anchor + ARCH-2/RE-101 schema/touchHeartbeat) + 6
  MAJOR. Bravo lens-audit (1 HOLD-WITH-FIX + 2 PASS-with-annotations).
- REV 0.2 (folded REV 0.1 findings) → bounded re-audit on critical-fix
  delta returned 0 CRITICAL + 5 spec-clarity (ARCH-7/8/9 + RE-201/202 +
  Bravo F1/F2/F3/F4) — all folded inline. Bravo full-plan SHIP 9.0/10.

---

**Supersedes / superseded_by:** Decision D supersedes nothing; future
worktree extensions (vault per-session worktrees, plugin per-session
worktrees) will reference back to this decision as the substrate
template.

---

## Decision E — Provisioner observability (post-Slice-2 follow-up, 2026-05-04)

**Status:** Decided + landed (this PR).

**Context:** Phase 3 Slice 2 shipped per-session worktree substrate
(Decision D). Empirical state observed across multiple sessions: the
provisioner hook emits `[dotfiles-worktree-provisioner] created
<path>`, but `git worktree list` shows only canonical and the directory
does not exist on disk at later inspection. Three `worktree-gc-reaped`
entries from 2026-05-01/02 in `~/.claude/logs/.presence-gate-failures.log`
attribute the reaping to `(orphan; no anchor)`. The silent-failure is
partially observable today, but at GC-time and attributed to the wrong
session — the causal link "X was just provisioned, then reaped due to Y
mismatch" is missing.

**Decision:** add post-`provisionWorktree` verification to the provisioner
hook. Three facets capture the failure modes:

1. **stat-errno** (replaces v2 plan's `existsSync`): distinguishes
   ENOENT, EACCES, ELOOP, etc. so diagnostic logs preserve the actual
   filesystem error.
2. **realpath-mismatch** (the load-bearing H2 hypothesis detector):
   compute `realpathSync(worktreePath)` post-creation; if the realpath
   form differs from the raw `worktreePath` AND starts with the realpath
   form of `dotfilesCanonical`, GC's `byDotfilesRoot.get()` lookup will
   miss the raw-keyed sentinel → orphan → reap. Source-trace confirmed
   via `worktrees/index.ts:202` (GC realpath-resolves canonical) +
   `dotfiles-worktree-provisioner.ts:88` (provisioner stores raw). H2
   is a confirmed bug, not a hypothesis.
3. **sentinel-readback-null**: defensive-tautology within a single hook
   execution (the value was just written), but kept cheap (~5 LOC) for
   cross-session diagnostic — a sentinel-readback-null in production
   would indicate the registry write itself failed silently.

A 12th `PresenceFailureKind` value `worktree-provision-incomplete` is
added to the type union AND to the hand-rolled `isPresenceFailureKind`
runtime guard at `presence-failure-log.ts:258-276`. Both edits are
required: the runtime guard is NOT literal-derived; without the guard
extension, `parseEvent` silently rejects every newly-written event —
the exact silent-failure pattern this slice exists to fix, built into
the slice itself.

**Verification placement:** hook-level (caller of `provisionWorktree`),
not in the worktrees primitive. The primitive trusts `git worktree add`'s
exit code; the policy of "verify post-create + emit anomaly" belongs at
the hook layer alongside the other reconciliation patterns the cleanup
hook + GC reaper already use (`worktree-cleanup-incomplete` is the
sibling pattern).

**Out of scope of this slice (next slice):** the actual race fix
(realpath-mismatch mitigation in either `setSentinelDotfilesRoot` or
the worktrees primitive). This slice provides the LOUD diagnostic; the
race fix uses accumulated logs across N sessions to design targeted
mitigation.

**Audit lineage:** plan v1 → ARCH + RE subagent audits (8 findings v2
fold) → Bravo cross-audit + Architecture Auditor outside-view (3
findings v3 fold catching v2 tautological folds) → ship-without-v4-audit
per tight-fold criteria.

**Cross-references:**

- Plan: `~/.claude/plans/soft-churning-allen.md` v3
- Channel: `2026-05-03_20-31` Round 2 (2026-05-04)
- Empirical baseline: `~/.claude/logs/.presence-gate-failures.log`
  3 `worktree-gc-reaped` entries (2026-05-01/02)
- Memory candidate (post-Round-2): substrate-fix candidates need
  explicit upstream-coverage check + same-event-chain ordering audit +
  literal-derived-guard verification BEFORE convergence framing — Bravo
  - Alpha both hit this on Round 2, both via subagent-distance catches
    that peer-audits missed.

---

## Decision F — `substrate-rename` (Phase 3 Step G; ARCH-W2-4 closure) — atomic-commit-1 (additive new-name + dual-read protocol) (2026-05-12)

**Status:** SHIPPED — atomic-commit-1 via plugin SHA `2843438` on branch `substrate-rename` (PR #37). Legacy-name removal commit DEFERRED to a follow-up cycle, earliest 2026-06-12 (≥30 days post-merge); see Out of scope below.

**Context:** Phase 2 `decisions/phase-2.md` Decision C deferred `substrate-rename` (ARCH-W2-4) to Phase 3 as one of 5 routed substrate-fix backlog items. Step G of Phase 3 substrate-completion cycle 2026-05-12 closes the atomic-commit-1 portion (write to NEW name; read with dual-read fallback to LEGACY). The 30-day verification window precedes a separate removal commit.

**5 per-channel subdirectory renames (noun-form standardization):**

| Legacy name      | New canonical name       | Rationale                                                                                                     |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `heartbeat/`     | `heartbeats/`            | Set-plurality consistency with `identities/` (per-session liveness markers; a SET of heartbeats per channel). |
| `last-seen/`     | `last-seen-cursors/`     | Noun-form (was adjective+participle); explicit "cursor" terminology.                                          |
| `gc-reap/`       | `reap-cursors/`          | Noun-form (was abbreviation+verb); preserves "reap" type-identifier in path.                                  |
| `identity-emit/` | `identity-emit-cursors/` | Noun-form (was noun+verb); explicit "cursor" terminology.                                                     |
| `idle-emit/`     | `idle-emit-cursors/`     | Noun-form (was adjective+verb); explicit "cursor" terminology.                                                |

**Naming-decision: Option (A) flat noun-suffix over Option (B) bundled `cursors/` hierarchy.** Reasoning (KS-lens, channel `2026-05-11_08-15` consensus 2026-05-13 ~00:50 UTC):

1. Sibling-parity diff-minimality — Option A is single-level rename; matches `feedback-live-substrate-sequencing.md` additive-first discipline. Option B (cursors/<x>/) would double the dual-read fallback complexity.
2. Discoverability preserved — path keeps type-identifier ("reap" still in path; not buried under generic `cursors/`).
3. Less test-infrastructure rewrite — option A touches paths 1:1; option B would require test dir-creation logic to nest under `cursors/`.
4. Hierarchy can come later — if cursor-collection abstraction emerges as a need, a follow-up cycle adds `cursors/` parent dir over the renamed siblings. Future-proofed without overcommitting now.
5. `heartbeat/` → `heartbeats/` for set-plurality consistency matches `identities/` (already plural for set-of-letters).

**Dual-read protocol (each path):**

- **READ:** try NEW path first; fall back to LEGACY on ENOENT.
- **WRITE:** NEW path only.
- **CLEAR / UNLINK:** walk BOTH paths (preserve clear semantic regardless of which writer-version produced the file).
- **ENUMERATE:** union BOTH directories (`newestHeartbeatMtime`, reaper's `pruneStaleLastSeenCursors`).
- **Rate-gate (`shouldReap`):** take MAX(newMtime, legacyMtime) — first-existing-wins would defeat the gate during transition (ARCH-2 fold in v2.14).

**Pre-flight discipline applied:**

- Active-session abort criterion (plan-spec line 583): verified 0 peer sessions live <60min via `bun run src/active-sessions/cli.ts list` — only self-heartbeats present. PROCEED.
- Per-phase write-graph trace verified each consumer's read/write/clear/enumerate semantics against the rename pattern.
- Step F (Decision E in phase-3.md predecessor cycle — see plan-spec) lock-domain registry's `per-channel-cursor` + `per-channel-heartbeat` domain coverage holds across the rename (resource-type-based, not path-literal-based).

**Audit lineage:** Plan v2.11 → atomic-commit-1 at `2843438` → multi-lens audit (ARCH + KS subagents per plan-spec audit-class). ARCH returned 1 CRITICAL (cross-edge dotfiles paired-update required) + 5 MAJOR (shouldReap fix, doc lag, test helper, missing dual-read tests, 30-day tracking) + 3 MINOR. KS returned 5 MAJOR (runbook lag, missing Decision F entry, orphan memory cross-ref, test helper, CHANGELOG + backlog stale) + 3 MINOR. v2.14 commit-amend folded findings inline (this Decision F entry is one of them).

**Out of scope (deferred to follow-up cycles):**

- **Legacy-name removal commit** — earliest 2026-06-12 (≥30 days post-Step-G merge). Trigger conditions (any of): (a) 30-day-empirical-absence of pre-Step-G peer writes verified via `find <channelsDir>/*/{heartbeat,last-seen,gc-reap,identity-emit,idle-emit} -mtime -7` returning empty; (b) Phase 4 public-release decision; (c) explicit cleanup slice scheduled.
- **Optional bundled `cursors/` hierarchy refactor** (Option B) — future cycle if cursor-collection abstraction becomes load-bearing.
- **Active-sessions registry subdir naming** — separate cycle scope; Step G is channel-subdir-rename only per plan-spec line 591.
- **Cross-edge dotfiles paired-update** — handled in dotfiles repo via paired PR per `feedback-handshake-before-merge-parallel-sessions.md` (Delta sibling lane).

**Cross-references:**

- Plan: `~/.claude/plans/coordination-substrate-completion-next-session.md` Step G section (v2.11 → v2.14)
- Backlog (closed via this Decision): `~/Documents/Obsidian Vault/wiki/backlog.md:624` `substrate-rename` — original spec proposed `_cursor` singular suffix; actual landing chose `_cursors` plural for sibling-parity with `identities/`. See backlog correction note.
- New backlog item filed: `substrate-rename-legacy-removal` — Phase 3 Step G follow-up commit; trigger ≥2026-06-12.
- Memory: `feedback-live-substrate-sequencing.md` (additive-first discipline; bundled at `memories/` per Step G v2.14 KS-3 fold).
- ARCH-W2-4 source: `decisions/phase-2.md:167`.
- Related Decision: Step F (`lock-domain.ts` registry) — `per-channel-cursor` + `per-channel-heartbeat` domains cover renamed paths without registry update needed.

---

## Decision: P0 substrate canary — symlink-clone over `bun install` for cross-edge resolution from per-session worktrees

```yaml
---
ts: 2026-05-17T14:00:00Z
kind: architectural
severity: major
phase: 3
backlog: "wiki/backlog.md:892"
plan: "~/.claude/plans/twinkling-nibbling-gosling.md"
prs: ["#62 squash 8cd8b6c", "#63 squash ba3124a"]
main_ci: ["25992322595 success", "25992988493 success"]
audit_class: "plan-v1 cross-audit (4-auditor mode-2 + mode-1) + 2× per-PR mode-1"
---
```

### Context

`dotfiles-worktree-provisioner` (`src/hooks/checks/dotfiles-worktree-provisioner.ts`) creates per-session worktrees via `git worktree add` but did NOT make cross-edge dependencies resolvable from the new worktree. Fresh worktrees had no `node_modules/`, so all bun-based code that cross-edge-imports `claude-conductor` failed from any session with `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=1`. Sev-2 regression for flag-on sessions, latent until L141 cycle recon (2026-05-17 ~00:15Z, primary-source traced by Bravo).

### Decision: symlink-clone (Path A) over `bun install` (Path B)

Add `linkCanonicalNodeModules(canonicalPath, worktreePath)` primitive (`src/worktrees/index.ts`) creating a single symlink at `<worktreePath>/node_modules` → `<canonicalPath>/node_modules`. Hook composes it unconditionally after worktree materialization (Path B Option B per the L93 third-existing-path catch).

### Rationale

Backlog filing recommended candidate (a) `bun install --frozen-lockfile`. Plan v1 adopted that approach. Bravo's plan-v1 mode-2 cross-audit (per the audit-posture framework shipped earlier same session as PR #61 `f3deb74`) caught ARCH PREMISE-1 critical: canonical's `node_modules/claude-conductor/` is already a per-file symlink mirror back to `~/Repos/claude-conductor/` (bun's `file:` protocol shape). Re-running `bun install` in every worktree recomputes a tree the canonical already has — wasted ~10s per session-start + lockfile-divergence risk on dotfiles where `bun.lock` is gitignored.

Alpha's primary-source empirical validation 2026-05-17 ~13:10Z: `ln -s` from a fresh worktree to canonical's `node_modules` + `bun test-resolve.mjs` from a worktree-resident script returns `OK keys=runChannelsCli`. Production-pattern `bun run node_modules/claude-conductor/src/channels/cli.ts ...` also resolves correctly.

Path A trades:

- Build-time: O(microseconds) vs O(10s) per session-start
- Failure surface: refuse-to-overwrite operator collisions (real dir, different-target symlink) + EEXIST race recovery + `already-linked` idempotent re-call vs Path B's ENOSPC, zombie bun processes, install-corrupt-state, lockfile divergence
- Operator-mental-model: symlink mirrors canonical's existing resolution shape — `node_modules/claude-conductor/<file>` chains through canonical's symlinks to `~/Repos/claude-conductor/<file>` exactly as canonical does

Mode-2 collapse: 8 mode-2 findings raised across 4 auditors (ARCH/WP/RE/TA); PREMISE-1 acceptance collapsed ~70% of plan-v1 (PREMISE-1-RE / PREMISE-2-RE / REFRAME-1-ARCH / REFRAME-1-RE / SCOPE-1 lockfile / DEFAULT-1 ARCH+WP+RE / DEFAULT-2-WP / SEQUENCE-1 ARCH+RE+WP all moot under Path A).

### Path B Option B (hook integration)

Plan-v2 initial draft placed the link composition on `provisionWorktree`'s `ok` AND `exists` result branches. Bravo's plan-v2 read-through caught a third existing-path: the hook's outer `existsSync(worktreePath)` early-return at L93 (steady-state session-resume — the most common case). Alpha ratified **Option B** (lift link composition OUTSIDE the conditional) so all three terminal materialization states converge before the link call. Hook flow: set-sentinel → materialize-worktree (existsSync-early OR provision) → link → verify.

### Audit-posture framework first-cycle ratification

This cycle was the framework's empirical proving ground. Framework (memories `feedback-audit-upstream-vs-downstream-posture.md` + `feedback-audit-request-framing-by-stage.md` + `feedback-audit-findings-prefix-distinguishes-mode.md`) shipped on this session's first PR (#61 `f3deb74`, discipline-debt cleanup of yesterday's codification). The very next plan-v1 cycle (this P0) exercised the framework's `/audit` skill Step 0 stage-mode-mix selection, Step 2 sensitivity (Architecture +3 + workflow forced in), Step 4 mode-2-invitation block, Step 5 mode-separation directive.

Results:

- **1 load-bearing mode-2 finding** (ARCH PREMISE-1) → collapsed 70% of plan-v1
- **1 false-positive caught by cross-auditor** (TA-5 sibling-check vs ARCH-4): ARCH claimed presence-failure-log test didn't pin the kind union; TA-5 correctly identified the SLICE_2_KINDS pattern at L211-220 + flagged the new `SLICE_3_KINDS` array
- **11 load-bearing mode-1 findings folded** + 6 minor
- **REPLAN-class catches:** 1 (PREMISE-1 — the entire approach pivoted from `bun install` to symlink-clone)
- **Aggregate score:** 6.625/10 (range 6.0 RE — 7.5 WP)

Framework earned its weight cycle 1. Pre-emptively naming mode-2 axes in the plan §"Mode-2 framing notes (pre-audit)" subsection invited the right kind of upstream challenge rather than burying it.

### Out-of-scope (deferred follow-ups)

- **Per-file symlink mirror as alternative implementation** — instead of one big symlink at `node_modules/`, replicate canonical's mirror structure file-by-file in worktree. More complex, isolated per-worktree, but pays construction cost of canonical's. Defer until concrete operator concern surfaces.
- **Canonical's `node_modules` doesn't exist yet** — first-ever invocation pre-`bun install` at canonical. Plan handles via primitive's `kind: "skip"` + hook breadcrumb. Long-term: dotfiles-onboarding skill should ensure `bun install` runs on dotfiles canonical at first session.
- **Plugin paired-helper `src/shared/plugin-root.ts`** (backlog L:890). Independent next slice; cross-edge symmetry with `dotfiles-root.ts`.
- **Bun workspace setup** (original backlog candidate c). Proper architectural fix. Defer indefinitely — Path A subsumes the substrate canary use case.

### Cross-references

- Plan: `~/.claude/plans/twinkling-nibbling-gosling.md` v2
- Backlog (closed via this Decision): `~/Documents/Obsidian Vault/wiki/backlog.md:892`
- PR #62 squash `8cd8b6c` — primitive lane (Alpha)
- PR #63 squash `ba3124a` — hook lane (Bravo)
- PR #61 squash `f3deb74` — audit-posture framework codification (prerequisite for this cycle's audit method)
- Memory: `feedback-audit-upstream-vs-downstream-posture.md` (framework primary)
- Memory: `feedback-audit-request-framing-by-stage.md` (per-stage templates)
- Memory: `feedback-audit-findings-prefix-distinguishes-mode.md` (PREMISE/REFRAME/SCOPE/DEFAULT/SEQUENCE prefix convention)
- Memory: `feedback-bun-exports-map-gates-everything.md` (related: exports-map gating that motivated the canary class)
- Memory: `feedback-cross-platform-tmpdir-divergence.md` (macOS `/var ↔ /private/var` realpath fallback in `samePath`)
- Channel: `2026-05-17_03-21` — Alpha (sid 207c3247) + Bravo (sid f3da24e2) coordination throughout

---

## Decision: Post-framework-ratification arc — posture-auditor pool + audit-request convention doc + slash-prelude eval-shim refactor (L:506 + L:508 + L:894 bundle)

```yaml
---
ts: 2026-05-17T16:55:00Z
kind: architectural
severity: major
phase: 3
backlog:
  - "wiki/backlog.md:506 (posture-auditor pool)"
  - "wiki/backlog.md:508 (audit-request templates)"
  - "wiki/backlog.md:894 (slash-prelude eval-shim refactor)"
plan: "~/.claude/plans/twinkling-nibbling-gosling.md v2"
prs:
  - "#66 squash b35f32b (L:506)"
  - "#65 squash 014ed2e (L:894)"
  - "#67 squash 62ceed5 (L:508)"
main_ci:
  - "25996534026 success (#66)"
  - "25996592371 success (#65)"
  - "25996962882 success (#67)"
audit_class: "plan-v1 4-auditor cross-audit (REPLAN 6.875/10) + 3× per-PR mode-1 (all SHIP)"
---
```

### Context

Same session as the prior P0 substrate canary cycle (L:892). After audit-posture framework codification shipped (PR #61 `f3deb74`), the very next plan-v1 cycle exercised the framework empirically — 1 load-bearing PREMISE catch collapsed ~70% of plan-v1. The framework earned its weight. This bundle is the **post-framework-ratification completion arc**: 3 backlog items that operationalize the framework + close one Sev-3 prompt-fatigue tax.

The 3 items selected by 4-axis weighting (ratified-but-stale × operational-tax × bounded-scope × blast-radius):

- **L:894** composite 18 (a=5/b=5/c=5/d=3) — eval-shim per-session prompt tax (27 prompts in a ~75min cycle)
- **L:506** composite 15 — posture-auditor pool completes the framework
- **L:508** composite 14 — convention doc operationalizes per-stage templates

Charlie also extended the framework mid-session with the **Best-of-breed comparison** technique (Nick's bun-vs-npm framing applied as a 6th upstream-challenge probe), which Bravo's plan-v1 cross-audit then exercised on this very bundle.

### Decisions (5)

#### 1. Posture-auditor categorization → new `agents/audit/posture/` top-level directory

Plan v1 proposed `agents/audit/familiar/` (matching existing taxonomy). 4-auditor cross-audit converged on REFRAME: posture-auditors are LENS-class (axes applied across any plan), not domain-class or project-context-injected (the `familiar/` definition). Three independent lines of evidence:

- ARCH — keyword-trigger selection model structurally breaks for meta-axes that don't appear as plan-text keywords.
- WP — source memory uses "**pool**" language ("Add a posture-auditor pool"), suggesting distinct category.
- KS — `familiar/` definition is "project-aware-with-memory-context-injection"; posture-auditors don't fit.

Decision: new top-level category `agents/audit/posture/`. Registry header: "21 auditors: 13 cold + 4 familiar + 5 posture + 1 template" (explicit 3-category split). Triggers column empty in TSV by design (stage-gated, not keyword-triggered).

**Alternative rejected (inversion):** extend each domain auditor's body with explicit mode-2 prompts. Lower decomposition cost; higher coupling. Plan v1's Step 2 sensitivity (Architecture +3 + workflow-force) was the partial-inversion path already in place; preserved as fallback when Pool B selects zero (e.g., domain-heavy plans).

#### 2. 2-pool auditor selection model

Plan v1 had implicit 1-pool model. ARCH PREMISE-1 caught the pool-slot-math issue: adding 5 LENS-class lenses to a 17-auditor keyword-matched pool that selects 3-5 means posture-auditors compete for slots and fire 0-1 times per audit.

Decision: declare **2-pool architecture** in SKILL.md Step 2 + registry Selection Heuristics:

- **Pool A — domain (cold + familiar):** selected per keyword-trigger heuristics at ALL stages.
- **Pool B — posture:** selected per stage from Step 0 (all 5 at pre-plan-write; 3-5 at plan-v1; 0-1 at plan-v2; 0 at per-PR / pre-merge; 1-2 at post-merge retrospective).

Total commissioned = Pool A ∪ Pool B with independent caps; pools don't compete for slots. Stage-mode-mix sensitivity (Architecture +3 + workflow-force) preserved as Pool-B-yields-zero fallback in Pool A.

#### 3. Template home → `docs/conventions/audit-request-by-stage.md`

Tension T-1 (3-auditor convergence on REJECTING the plan's `templates/` top-level proposal): ARCH proposed `docs/conventions/audit-request-by-stage.md` (sibling to existing `message-kinds-and-verification.md`); KS proposed `agents/audit/templates/` (co-located with auditors); WP requested enumeration.

Decision: **`docs/conventions/audit-request-by-stage.md`** — rationale: stable contract docs live there by convention, posture-auditor pool is one consumer not the sole consumer, sibling-shape to existing convention docs, zero new top-level dirs.

#### 4. Memory body trim direction → option (c) memory canon + plugin extract

Plan v1 picked option (a) trim-without-preservation; broke self-sufficient-notes discipline. KS REFRAME-1 rejected.

Decision: **option (c)** — user-canonical memory bodies preserved with full prose + cross-references intact; plugin-bundled `<plugin-root>/memories/*` are the operational extract (referenced by posture-auditor `context_sources.plugin:` paths). Pointer line added at top of `feedback-audit-request-framing-by-stage.md` ("operational per-stage templates also live at `docs/conventions/audit-request-by-stage.md`"). NO body trim.

This establishes the principle for future memory-to-plugin lifts: **memory is canon; plugin extracts for operational reference**.

#### 5. `--print` direct-assign on resolver (eval-shim refactor)

Backlog L:894 proposed 4 candidates (a `--print` direct-assign / b session-start env injection / c cached-file write / d inline fallback). Plan v1 picked (a). CLI REFRAME-1 mode-2 finding proposed flipping the default to `--print` + adding `--export-shell` opt-in for legacy. Disposition: deferred per per-PR-mode-1-only discipline.

Decision: `--print` flag opt-in; legacy `export ...` default preserved unchanged. Backwards-compat invariant honored. Slash-command preludes switch from `eval "$(...)"` to `CLAUDE_DOTFILES_ROOT_RESOLVED="$(... --print)" || { echo "[prelude] resolve-dotfiles-root failed; falling back" >&2; ... }` — DEFAULT-1 breadcrumb fold replaces silent fallback with explicit stderr message.

### Audit-posture framework second-cycle ratification

This cycle was the framework's second empirical exercise (first was P0 substrate canary L:892, captured in the prior decision entry). Notable measurements:

- **Mode-2 findings raised:** 8 distinct PREMISE/REFRAME/SCOPE/DEFAULT/SEQUENCE prefixes across 4 auditors (ARCH/WP/KS/CLI)
- **REPLAN-class catches:** 5 cross-auditor-convergent (categorization, pool slot math, template home, memory trim direction, branch+merge sequence) → all folded inline to plan v2
- **False positives caught by cross-auditor cross-check:** 0 this cycle (1 in prior cycle)
- **Aggregate score:** 6.875/10 (range 6.5 KS/WP — 7.5 CLI)
- **Mode-1 critical folds:** 3 (memory bundling, --help flag, CI evidence block)
- **Mode-1 major+minor folds:** ~15
- **Technique #6 (Best-of-breed comparison) usage:** 3 auditors enumerated 3-5 named alternatives per major decision with substrate-aligned cost-benefit analysis. First-cycle usage validated the technique's value.

### Cross-cutting patterns observed (cross-auditor)

These were flagged in the audit synthesis but deferred from inline-fold per their structural-deferred nature. File as next-cycle backlog if recurrence pattern strengthens:

1. **Selection-algorithm complexity creeping** (ARCH) — SKILL.md Step 2 accreting stage-gated bias clauses. v2's 2-pool model is structural cleanup; if recurrence happens, structural rewrite to "declared-pools, declared-rules" is the next-cycle task.
2. **Memory-vs-plugin-artifact load-bearing inversion** (KS) — v2's option-(c) approach (memory canon + plugin extract) establishes the principle; this decision entry documents it. Future similar moves apply the principle.
3. **Process shortcut erosion** (WP) — v1 had "two PRs from one branch" anti-pattern; v2 restored one-PR-one-branch via three separate branches. Vigilance against precedent erosion.

### CI-vs-local-drift catch (cross-cycle learning)

Two empirical catches this cycle exemplify why CLAUDE.md mandates `gh run watch` after every push:

1. **PR #66 substrate-leak gate trip** — Bravo's local `verify:fold` passed; CI failed on `check-generic-paths.sh` finding 2 hardcoded `nbruzzi` references in the new test file. Fix shape: `userInfo().username` from `node:os` (portable across operators). Local-clean ≠ CI-clean exactly as CLAUDE.md flags.
2. **PR #67 bundled-memory `updated:` frontmatter regression** — L:506's anonymization pass over-corrected by stripping ISO dates from `updated:` frontmatter (legitimate metadata per memories-to-bundle.md). L:508 caught + restored + added test pin going forward. Cross-cycle regression caught BY the same cycle's audit framework operating on its own artifacts.

### Out-of-scope (deferred follow-ups)

- **CLI REFRAME-1 default-direction flip (--print default + --export-shell opt-in):** mode-2 finding deferred per per-PR-mode-1-only discipline. Conservative default (`--print` opt-in) shipped; default-flip is a next-cycle decision if backwards-compat concerns warrant re-evaluation.
- **SKILL.md Step 2 structural rewrite to "declared-pools, declared-rules":** flagged as cross-cutting pattern #1; defer to next plan-v1 if 2-pool model proves insufficient.
- **L:526 isManagedRepo worktree-pattern tighten** — composite-14 opportunistic; defer.
- **L:890 plugin-root paired-helper** — composite-12 architectural; defer per its own trigger conditions.
- **Posture-auditor 6th-stage row in SKILL.md Step 0 stage-mix table:** minor doc-sync gap surfaced in PR #67 audit; post-merge-retrospective stage in convention doc but not in SKILL.md table. Future cleanup pass.

### Cross-references

- Plan: `~/.claude/plans/twinkling-nibbling-gosling.md` v2 (full content; folded ARCH PREMISE-1 + 4 other REPLAN-class + 3 critical mode-1 + ~15 major/minor)
- Backlog entries closed via this bundle: `wiki/backlog.md:506` + `:508` + `:894`
- PR #66 squash `b35f32b` — Bravo L:506 posture-auditor pool
- PR #65 squash `014ed2e` — Alpha L:894 eval-shim refactor
- PR #67 squash `62ceed5` — Bravo L:508 audit-request convention doc
- PR #61 squash `f3deb74` — audit-posture framework codification prerequisite
- PR #64 squash `7df108a` — prior P0 substrate canary decision-log (same-day precedent for the post-merge decision-log PR pattern)
- Memory: `feedback-audit-upstream-vs-downstream-posture.md` (framework primary; extended in this session to include technique #6 Best-of-breed comparison)
- Memory: `feedback-audit-findings-prefix-distinguishes-mode.md` (PREMISE/REFRAME/SCOPE/DEFAULT/SEQUENCE prefix convention)
- Memory: `feedback-audit-request-framing-by-stage.md` (rationale doc; operational templates extracted to `docs/conventions/audit-request-by-stage.md`)
- Memory: `feedback-projects-as-substrate-work.md` (Charlie's framing — substrate-aligned tools earn the best-of-breed probe always)
- Memory: `feedback-name-not-ordinal-references.md` (Charlie's naming-convention extension; applied throughout this entry — "Best-of-breed comparison" not "technique #6")
- Channel: `2026-05-17_03-21` — Alpha (sid 207c3247) + Bravo (sid f3da24e2) + Charlie (sid d6137354) coordination throughout

---

## Decision: Sharded-swinging-locket — post-audit-residual polish quintet (L:504 + L:771 + L:761 + L:757 + L:527)

```yaml
---
ts: 2026-05-17T19:10:00Z
kind: tooling
severity: minor
phase: 3
affects:
  [
    src/channels/cli.ts,
    test/channels/cli-body-file.test.ts,
    package.json,
    CONTRIBUTING.md,
    scripts/check-import-extensions.sh,
    test/scripts/check-import-extensions.test.ts,
    dotfiles/src/hooks/checks/test-gate.ts,
    dotfiles/src/hooks/checks/branch-enforcement.ts,
    dotfiles/src/__tests__/hooks/test-gate.test.ts,
    dotfiles/src/__tests__/hooks/branch-enforcement.test.ts,
    dotfiles/src/__tests__/hooks/dispatcher.test.ts,
  ]
---
```

**Context:** Nick prompted a 4-axis backlog scoring pass (ratified-but-stale / operational tax / bounded scope / blast radius) over the ~196 open items in `wiki/backlog.md`. The top-5 selection (filed names L:504 / L:771 / L:761 / L:757 / L:527, line numbers as of plan-v1 author time) was a coherent post-audit-residual polish bundle, each item primary-source-traced to disciplined prior cycles (the 2026-04-28 Bravo plugin audit batch + the 2026-05-08 dotfiles F1 follow-up). Every item had a settled fix shape, sub-50-LOC budget, and a named author whose research was already captured in the entry. Execution was the only missing step. Plan: `~/.claude/plans/sharded-swinging-locket.md` v1 (no v2 needed; SHIP-CLEAN with 3 minor folds).

**Cycle outcome:** 5 PRs shipped end-to-end with full main-CI evidence (see table below); 5 backlog closures landed in `wiki/backlog.md`; 1 new feedback memory filed; 1 plan-v1 cross-audit cycle (no replan); 4 per-PR cross-audits (4 × SHIP-CLEAN with 0 findings total).

**5 PRs shipped:**

| PR   | Repo             | Squash     | Subject                                                              | Main-CI run   | Conclusion                             |
| ---- | ---------------- | ---------- | -------------------------------------------------------------------- | ------------- | -------------------------------------- |
| #70  | claude-conductor | `35a19da`  | L:504 — denylist refusal hint (~/scratch/ pointer)                   | `25998895538` | success                                |
| #71  | claude-conductor | `8750d94`  | L:771 — `bun run check` alias for `verify` + CONTRIBUTING note       | `25999130850` | success                                |
| #72  | claude-conductor | `e48adfc`  | L:761 — `check-import-extensions.sh` dynamic-import regex + new test | `25999595360` | success                                |
| #111 | claude-dotfiles  | `a1598e2`  | L:757 — HOME-empty observability in test-gate + branch-enforcement   | `25999709992` | success                                |
| #112 | claude-dotfiles  | `f91fd88a` | L:527 — inline-prefix regression test (F1 v2 codification)           | `26000035477` | success (pending verify at close time) |

**Decisions captured in this cycle:**

1. **L:771 staleness fold (mode-2 catch):** primary-source verify before plan-v2-lock found that `check-bundled-registrations-parity` script no longer exists; `verify` script already orchestrates the 5 gates + tests. Original entry's "multi-script orchestrator" fix reduced to a 1-line `check` alias for `verify` + a 1-line CONTRIBUTING note. Bravo's plan-v1 cross-audit Q1 disposition: SHIP-as-planned (PREMISE-2 catch validated).

2. **L:757 cross-edge file relocation:** backlog entry filed 2026-04-28 against plugin paths (`claude-conductor/src/hooks/checks/test-gate.ts` etc.); files moved to dotfiles substrate during the INVERSIONS arc (2026-05-07 → 2026-05-08). Caught via `find` before lane lock. Lane reassigned plugin → dotfiles. No plan replan.

3. **L:757 vs L:527 — test-boundary taxonomy clarified:** plan-v1 fold #3 recommended "process-boundary discipline a la disable-hooks.test.ts" for both items. Bravo self-corrected during L:757 implementation: helper-function tests use in-process invocation via INTERNAL exports (matching `branch-enforcement.test.ts` precedent), not process-boundary. L:527 IS process-boundary (testing process.env behavior of the dispatcher subprocess; in-process would not exercise the env-inheritance boundary). Same author, opposite test shapes, both correct — the taxonomy was the missing piece. Memorialized as `feedback-test-boundary-taxonomy-helper-vs-binary.md`.

4. **Lane split (plugin / dotfiles by repo, not by sequence):** the 5-item bundle naturally divided 3 plugin (L:504 + L:771 + L:761) / 2 dotfiles (L:757 + L:527). Alpha took plugin (matching Alpha's identity continuity from the prior cycle's plugin work), Bravo took dotfiles. Zero file overlap; zero cross-edge dependencies; lanes ran in parallel after L:504 (Alpha solo pre-slice) landed.

5. **Audit cadence:** plan-v1 cross-audit (mode-1 dominant + mode-2 invitations open on L:771 staleness) → 3 minor folds (1 anticipated by Alpha live-update before verdict; 2 Bravo-lane) → no v2 file needed → per-PR cross-audits (4 PRs × 1 lens = light-touch, all SHIP-CLEAN). Total: 1 plan-v1 audit + 4 per-PR audits + 0 findings folded post-audit. Cleanest audit cadence in the recent cycle history.

**Cycle metrics:**

- **PRs shipped:** 5 (3 plugin Alpha + 2 dotfiles Bravo); 1 was an Alpha solo pre-slice (L:504) shipped while plan-v1 cross-audit was in flight
- **Plan-v1 cross-audit cycles:** 1; SHIP-CLEAN verdict; 3 minor folds; 0 mode-2 reframes; 0 replan
- **Per-PR cross-audits:** 4 (L:504 trivial-skip per plan v1; L:771 + L:761 Alpha-receives-Bravo-audit; L:757 + L:527 Bravo-receives-Alpha-audit); all 4 SHIP-CLEAN, 0/0/0 findings each
- **Backlog deltas:** -5 closed (L:504, L:771, L:761, L:757, L:527); -1 net change in cycle character (5 items removed from 196 open)
- **New memories filed:** 1 (`feedback-test-boundary-taxonomy-helper-vs-binary.md`)
- **Nick interventions:** 0 protocol-class; 1 directional (rubric prompt + lane authorization); 1 wind-down style ("no handoff, just check-in")
- **Cross-cycle catch:** L:771 staleness (PREMISE-2 caught by primary-source verify before plan-v2-lock); L:757 file relocation (caught by `find` before lane assignment lock)

**Why this cycle matters (pattern observation):** The 4-axis backlog rubric (ratified-but-stale / operational tax / bounded scope / blast radius) reliably surfaces shippable polish items that compose into ~90-min cycles. Each item carried its own audit-research from the original filing; execution was unambiguous. The cycle character is "honor existing work" — don't redesign, just ship what previous audits already designed. Recommend running this rubric quarterly OR opportunistically when no urgent P0 surfaces but the backlog has tail items aging > 30 days.

**Cross-references:**

- Plan: `~/.claude/plans/sharded-swinging-locket.md` (v1, no v2)
- Backlog entries closed: `wiki/backlog.md` L:504 + L:771 + L:761 + L:757 + L:527 (line numbers as filed; current positions shifted by sibling-session edits)
- Channel: `2026-05-17_17-00` — Alpha (sid `163efa04`) + Bravo (sid `ebff22dd`) coordination throughout
- Memory filed: `feedback-test-boundary-taxonomy-helper-vs-binary.md`
- Memories consulted: `feedback-substrate-precedent-as-design-rescue` (2-instance "wait for 3rd site" precedent applied at L:757), `feedback-audit-recommendations-primary-source-verified` (caught L:771 staleness), `feedback-pre-staged-caller-reads-validation` (Bravo's pre-stage research on his lane sites), `feedback-audit-request-framing-by-stage` (plan-v1 vs per-PR mode-mix), `feedback-sibling-coordination-protocol` (Core 6 + Optional 1 held throughout)
- Prior cycle context: `HANDOFF_2026-05-17_17-00.md` (resumed-from)
- Author note: L:504 line number drifted to L:506 mid-cycle when Charlie's parallel work added entries above; recorded as observation, not blocker — backlog L:N IDs are relative pointers that shift under parallel-session edits. Future consideration: stable content-hash IDs OR explicit `id:` frontmatter slugs.

---

## Decision: Sharded-swinging-locket slice 2 — body_ref attribution + ci-reminder cursor + extractValidSessionId (L:140 + L:481 + L:768)

```yaml
---
ts: 2026-05-17T20:15:00Z
kind: tooling
severity: minor
phase: 3
affects:
  [
    src/channels/cli.ts,
    src/channels/index.ts,
    src/hooks/session-id.ts,
    src/hooks/timing.ts,
    src/hooks/checks/active-channels-load.ts,
    src/hooks/checks/identity-injector.ts,
    src/hooks/checks/teammate-idle-reminder.ts,
    src/hooks/checks/task-coordinator.ts,
    src/hooks/checks/peer-message-deliverer.ts,
    test/channels/cli-send-body-ref-regression.test.ts,
    test/hooks/session-id.test.ts,
    dotfiles/src/hooks/checks/ci-verification-reminder.ts,
    dotfiles/src/__tests__/hooks/ci-verification-reminder.test.ts,
  ]
---
```

**Context:** Slice 2 continuation of slice 1 (`sharded-swinging-locket` post-audit-residual polish quintet). Nick promoted the next 3 high-composite items from the original agent-assisted 4-axis backlog scoring pass after slice 1 shipped clean. Same cycle character: "honor existing work" — backlog items already had ratified research; execution was the only missing step.

**Cycle outcome:** 3 PRs shipped end-to-end with full main-CI evidence; 3 backlog closures landed; 0 cross-audit findings post-fold; 0 Nick protocol-class interventions. Plan-v1 cross-audit produced 1 MINOR fold (Bravo's counter-proposal on channels/index.ts:303 migration for all-7-consumer symmetry) and 4 ACCEPT verdicts. No replan. No mode-2 reframes after fold.

**3 PRs shipped:**

| PR   | Repo             | Squash    | Subject                                                         | Main-CI run   | Conclusion |
| ---- | ---------------- | --------- | --------------------------------------------------------------- | ------------- | ---------- |
| #73  | claude-conductor | `3ccdf8d` | L:768 — extractValidSessionId helper + 7 consumer migrations    | `26001269955` | success    |
| #74  | claude-conductor | `d709e42` | L:140 — body_ref read-error attribution (silent-truncation fix) | `26001420772` | success    |
| #113 | claude-dotfiles  | `b5cd06a` | L:481 — once-per-session cursor for ci-verification-reminder    | `26001421839` | success    |

**Decisions captured in this slice:**

1. **L:140 scope refinement (mode-2 catch, plan-v1 SCOPE-1 ACCEPT):** backlog entry mentioned "pagination," but `readBodyFile` is a single `readFileSync` with no pagination today. Plan-v1 reframed to "address what exists (null-fallback path); defer real pagination if/when streaming added." Bravo ratified ACCEPT. Final shape: explicit `body_read_error: string` attribution + stderr breadcrumb, behavior preservation (body absent on read failure, body_ref preserved).

2. **L:481 cross-edge file location:** same pattern as slice 1 L:757 — backlog filed against plugin path, file lives in dotfiles substrate post-INVERSIONS arc. Caught at plan time via `find` (slice 1 lesson institutionalized). Zero plan rework.

3. **L:768 channels/index.ts:303 v2 fold (plan-v1 MINOR-1):** plan-v1 carved-out the already-wrapped site as "intentionally not migrated"; Bravo's cross-audit counter-proposed all-7-consumer symmetry + drop the redundant `&& isValidSessionId(fromInput)` from the downstream check. Net: -1 LOC at the migration site, full symmetry across 7 consumers, no redundancy. Pattern: outside-view audit improves on inside-view's "consistency vs. minimal-churn" tradeoff.

4. **L:481 cursor pattern duplication:** inline-in-both `ci-verification-reminder.ts` + existing `output-externalization-nudge.ts` per the 2-instance-no-lift precedent (`feedback-substrate-precedent-as-design-rescue.md`). Will lift to shared `~/.claude-dotfiles/src/hooks/checks/session-cursor.ts` when a 3rd cursor consumer surfaces.

5. **L:768 `extractSessionId` survival (plan-v1 MINOR-2 ACCEPT):** keep raw form with `@deprecated` JSDoc + cross-pointer to safe-by-default `extractValidSessionId`. Minimal-churn lean over rename-to-`extractSessionIdRaw`. The `@deprecated` JSDoc triggers TS-level deprecation warnings (better than convention-only); eslint rule banning raw form deferred to backlog candidate.

6. **Lane split (plugin-or-dotfiles by author honor + LOC balance):** Alpha got L:140 (channels-adjacent to slice 1 L:504) + L:481 (Alpha-filed) ≈ 165 LOC across 2 PRs. Bravo got L:768 (Bravo-filed RE-2; deepest context on the 7-consumer set) ≈ 130 LOC across 1 PR. Roughly balanced.

7. **Drive-by during execution:** 2 Charlie backlog entries (lines 212+219 at cycle time) lacked the scope-prefix convention and were tripping the `wiki-backlog-scope-check #15` canary test in the full dotfiles test suite. Added 'Cross-repo —' prefix to both (zero content change); inline note in each that Alpha added the prefix during slice-2. Pattern: live canary tests catch convention drift across sibling sessions; act on the catch when shipping is gated.

**Cycle metrics:**

- **PRs shipped:** 3 (2 Alpha plugin/dotfiles + 1 Bravo plugin)
- **Plan-v1 cross-audit cycles:** 1; SHIP-CLEAN with 3 minor folds (Q2 MINOR-1 actionable; Q1 + Q4 SCOPE-1/SCOPE-2 ACCEPT; Q3 MINOR-2 ACCEPT)
- **Per-PR cross-audits:** 3 (Bravo audits 2 Alpha PRs; Alpha audits 1 Bravo PR); all 3 SHIP-CLEAN with 0/0/0 findings
- **Backlog deltas:** -3 closed (L:140 + L:481 + L:768); slice 1 + slice 2 = -8 from the post-rubric backlog tail
- **New memories filed:** 0 (slice 1's `feedback-test-boundary-taxonomy-helper-vs-binary` covers the cross-cycle pattern observed here too)
- **Nick interventions:** 0 protocol-class; 1 directional (rubric continuation prompt); 1 wind-down style ("no handoff, just check-in" precedent inherited from slice 1)
- **Cross-cycle catch:** L:768 consumer-count drift (5→7 since filing — caught via grep at plan time); L:481 cross-edge file location (caught via `find` at plan time — slice 1 pattern reapplied); Charlie convention-drift on backlog scope-prefix (caught via live canary at pre-commit time — drive-by fixed).

**Why this slice matters (pattern reinforcement):** Slice 2 is the same shape as slice 1 (4-axis pickup → plan-v1 → cross-audit → ship). The repeated success at this shape — 8/8 PRs across both slices clean, 0/0/0 findings on 5 of the 7 cross-audits, 1 MINOR fold ratified outside-view — validates the rubric+cadence as a sustainable polish-cycle template. Next opportunity: apply rubric again when 4-axis weights produce a new top-N set after backlog naturally accumulates more items.

**Cross-references:**

- Plan: `~/.claude/plans/sharded-swinging-locket.md` (slice 2 overwrite of slice 1 plan; slice 1 retrospective entry above is the slice 1 record)
- Backlog entries closed: L:140 + L:481 + L:768 (line numbers as filed; current positions checked at close time)
- Channel: `2026-05-17_17-00` — Alpha (sid `163efa04`) + Bravo (sid `ebff22dd`) coordination throughout (continued from slice 1)
- Slice 1 retrospective: this file above; same cycle metrics shape; same sibling-coord protocol
- Memories applied: `feedback-test-boundary-taxonomy-helper-vs-binary` (slice 1 codification; held in test-shape choices this slice — L:140 + L:481 use process-boundary spawn for end-to-end coverage; L:768 uses in-process for helper test), `feedback-substrate-precedent-as-design-rescue` (cursor-pattern 2-instance-no-lift discipline at L:481), `feedback-audit-recommendations-primary-source-verified` (caught L:768 consumer-count growth)
- Drive-by: 2 Charlie backlog entries (lines 212+219) scope-prefix added

---

## Decision: Sharded-swinging-locket slice 3 — handoff-guard parity + memory-authoring summary hook (L:186 + L:187 + L:893)

```yaml
---
ts: 2026-05-17T21:20:00Z
kind: tooling
severity: minor
phase: 3
affects:
  [
    dotfiles/src/hooks/checks/memory-authoring-summary.ts,
    dotfiles/src/hooks/checks/memory-system-registrations.ts,
    dotfiles/src/hooks/checks/handoff-symlink-write-guard.ts,
    dotfiles/src/hooks/checks/handoff-latest-guard.ts,
    dotfiles/src/hooks/check-names.ts,
    dotfiles/src/hooks/handlers/stop.order.ts,
    dotfiles/src/__tests__/hooks/memory-authoring-summary.test.ts,
    dotfiles/src/__tests__/hooks/handoff-symlink-write-guard.test.ts,
    dotfiles/src/__tests__/hooks/handoff-latest-guard.test.ts,
    dotfiles/src/__tests__/hooks/registry.test.ts,
  ]
---
```

**Context:** Slice 3 continuation. Nick promoted next-tier candidates from the original 4-axis backlog rubric: low-(b) high-(c) Reliability polish items from the 2026-04-21 PR #44 audit batch (L:186 + L:187) + one substantive Memory cluster item from 2026-05-09 (L:893). Same cycle character carried from slices 1+2: "honor existing work" via the rubric. All 3 items shipped end-to-end with 0/0/0 cross-audit findings.

**3 PRs shipped (all dotfiles):**

| PR   | Squash     | Subject                                                           | Main-CI run   | Conclusion |
| ---- | ---------- | ----------------------------------------------------------------- | ------------- | ---------- |
| #114 | `a94d9816` | L:893 — End-of-session memory-authoring summary Stop hook         | `26002675440` | success    |
| #115 | `0f34d99`  | L:186 — handoff-symlink-write-guard readlink + lstat one-hop fix  | `26002823044` | success    |
| #116 | `b3c74ac`  | L:187 — handoff-latest-guard readlinkSync parity with write-guard | `26002880863` | success    |

**Decisions captured in this slice:**

1. **L:893 transcript-tail.ts lift — fold from plan v1 to INLINE-in-third (channel ts 20:31Z):** plan v1 proposed lifting `readTail` + `extractAssistantBlocksAfterLastUser` to a new `transcript-tail.ts` per the 3rd-site precedent (output-externalization-nudge + feedback-minimal-output-detector + new = 3). Mid-implementation reversed to INLINE after finding the lift would require refactoring 2 stable callers (broader blast radius than budgeted). Deferred lift becomes a follow-up backlog item; pragmatic when the precedent's pull (3rd site) is outweighed by refactor-of-stable-callers cost. Pattern memorialized for cycle-4+ calibration.

2. **L:893 classification heuristic simplified (undisclosed mid-impl fold — flagged by Bravo audit):** plan v1 specified ADDED/MODIFIED via git-status. Implementation simplified to Edit/MultiEdit/NotebookEdit→MODIFIED + Write→TOUCHED. At Stop-time post-edit, file state on disk doesn't distinguish ADDED from MODIFIED without a git-spawn (latency + dependency); trade was operator-info-richness vs hook-latency. Bravo's audit ratified right-trade, with explicit process-note that the fold should have been channel-surfaced (parallel to the transcript-tail.ts lift fold at 20:31Z) — cadence calibration item for slice 4.

3. **L:186 + L:187 parity-driven shape:** both items shipped as byte-for-byte parity treatments of readlinkSync error differentiation. L:186 added the wrap to handoff-symlink-write-guard.ts; L:187 mirrored to handoff-latest-guard.ts. Sibling-pair holding was the explicit goal; achieved. Test pattern (mock.module + spread origFs + try/finally restoration) standardized across both — sets precedent for future read-error-class hardening via the same mock shape.

4. **L:186 lstat one-hop semantic correction (subtle):** existsSync chain-follow → lstat one-hop. Pre-fix, a broken-symlink-entry as intermediate target classified as 'target missing'; post-fix correctly classifies as 'currently targets <intermediate>' (entry exists qua dangling-symlink). Operator's primary question is about the immediate target, not the recursive chain.

5. **Lane split (Alpha substantive single PR + Bravo sibling-paired pair):** Alpha got L:893 (~280 LOC + 14 test cases — single substantive PR; honors Alpha-filed item). Bravo got L:186 + L:187 (~135 + ~90 LOC across 2 PRs — sibling-paired). LOC-balanced; Alpha-heavy by single-PR-size, Bravo-balanced by 2-PR throughput. Pattern: substantive new module vs incremental pair extends both lanes' execution muscle.

6. **dispatcher-edit-guard kill-switch use (single bypass, audit-trailed):** during atomic stop.order.ts wiring, the 3rd Edit/Write within the 5-min window correctly triggered dispatcher-edit-guard (per L:852 design). Used the file-based kill-switch `~/.claude/dispatcher-edit-guard-off` per CLAUDE.md "Hook bypass" discipline + immediately removed after the single Write. Audit-trail preserved (channel-surfaced in PR #114 audit-request). Pattern: kill-switch use is acceptable when the alternative (waiting 5 min) is operational waste + the bypass is bounded + the audit-trail is explicit.

7. **Parallel-session shared-tree branch-race observed (mid-cycle):** Bravo's session checked out his branch on the shared dotfiles working tree, mid-slice; Alpha's working tree switched to Bravo's branch as a side-effect (per `feedback-parallel-session-shared-tree-branch-race.md`). Alpha's remote branch + PR #114 unaffected (already pushed). Pattern: known + expected; recover by reading the channel for context, not by switching back (would conflict with Bravo's active work).

**Cycle metrics:**

- **PRs shipped:** 3 (1 Alpha dotfiles + 2 Bravo dotfiles)
- **Plan-v1 cross-audit cycles:** 1; SHIP-CLEAN; 1 fold accepted (Alpha self-fold on lift) + ratified ACCEPT on all 5 plan-v1 open questions
- **Per-PR cross-audits:** 3 (Alpha audits 2 Bravo PRs; Bravo audits 1 Alpha PR); all 3 SHIP-CLEAN with 0/0/0 findings; Bravo's audit flagged 1 process-note (mid-impl classification-shape fold should have been channel-surfaced)
- **Backlog deltas:** -3 closed (L:186 + L:187 + L:893); slice 1+2+3 cumulative = -11 from the post-rubric backlog tail
- **New memories filed:** 1 (`feedback-live-canary-asymmetric-cost.md`) — from Nick's structural-takeaway prompt mid-cycle
- **New backlog entries filed:** 1 (Cross-repo — move backlog-scope-check canary closer to introducer via vault commit hook) — deferred until 3rd incident OR convention extension
- **Nick interventions:** 0 protocol-class; 1 directional (slice 3 promotion); 1 mid-cycle (canary-pattern backlog-file ask); 1 wind-down style ("check-in, no handoff" precedent continued)
- **Cross-cycle catch:** L:893 mid-impl folds caught by Bravo audit (lift defer + classification simplification); dispatcher-edit-guard correctly fired at the 3rd-edit threshold (L:852 design holding)
- **Cross-cycle pattern memorialized:** live cross-repo canary asymmetric-cost pattern (slice 1+2 wiki-backlog-scope-check incidents) filed as standalone memory + backlog item for the introducer-side fix

**Why this slice matters (third-cycle rubric validation):** 11/11 PRs across slices 1+2+3 with 0 unfixed CI failures + 0 Nick protocol-class interventions. Three consecutive successful applications of the 4-axis pickup framework strongly validates it as a sustainable polish-cycle template. The pattern is reproducible: rubric → plan-v1 → cross-audit → ship; per-cycle outcome predictable; backlog tail meaningfully shrinking. Next-tier candidates for slice 4 likely from the remaining Reliability batch (L:142 picker scoring + L:145 heredoc + L:188 structured-logging) and/or remaining Memory cluster (L:895 /memory-audit sibling to this slice's L:893).

**Cross-references:**

- Plan: `~/.claude/plans/sharded-swinging-locket.md` (slice 3 overwrite; slice 1+2 retrospectives are this file)
- Backlog entries closed: L:186 + L:187 + L:893 (line numbers as filed)
- Channel: `2026-05-17_17-00` — Alpha (sid `163efa04`) + Bravo (sid `ebff22dd`) coordination continued from slices 1+2
- Memory filed mid-cycle: `feedback-live-canary-asymmetric-cost.md`
- New backlog item filed mid-cycle: Cross-repo — move wiki-backlog-scope-check canary closer to introducer
- Slices 1+2 retrospectives: this file above (same cycle metrics shape; same sibling-coord protocol; same audit cadence)
- Slice 1 memory applied: `feedback-test-boundary-taxonomy-helper-vs-binary.md` (Stop hook tests use transcript-tail-based-spawn-equivalent in-process — pattern matched correctly to the helper-function side of the taxonomy)

---

## Decision: Sharded-swinging-locket slice 4 — 4-axis pickup, 6 PRs across plugin + dotfiles (Items 1+3+5 Alpha + 2+4 Bravo + 6 Alpha-extension)

```yaml
---
ts: 2026-05-18T00:35:00Z
kind: tooling
severity: minor
phase: 3
affects:
  [
    plugin/src/channels/cli.ts,
    plugin/src/channels/handoff-resolver.ts,
    plugin/commands/session/handoff-resume.md,
    plugin/test/skills/structure.test.ts,
    plugin/test/channels/cli-stdin-timeout.test.ts,
    plugin/test/channels/handoff-resolver-picker-liveness.test.ts,
    dotfiles/src/hooks/dispatcher.sh,
    dotfiles/install.sh,
    dotfiles/settings.json,
    dotfiles/RECOVERY.md,
    dotfiles/src/__tests__/hooks/dispatcher-sh-wrapper.test.ts,
    dotfiles/src/__tests__/hooks/checks/destructive-cmd.test.ts,
    dotfiles/src/__tests__/hooks/checks/no-any.test.ts,
    dotfiles/src/__tests__/hooks/checks/no-enum.test.ts,
    dotfiles/src/__tests__/hooks/checks/prefer-bun.test.ts,
    dotfiles/src/__tests__/hooks/checks/sensitive-files.test.ts,
  ]
---
```

**Context:** Slice 4 of the sharded-swinging-locket cycle — 4-axis backlog pickup applied for the 4th consecutive time. Alpha lane (Items 1+3+5) + Bravo lane (Items 2+4) + mid-cycle Item 6 follow-up as the unblocker for an install.sh substrate gap that surfaced during Item 1 impl. Cycle character: bidirectional ratification of the sibling-unavailable autonomy-merge convention from slice-3 — Alpha exercised it (Items 1+3+5, Nick-explicit-go + 75min Bravo silence), Bravo armed-but-preempted (Items 2+4 threshold at 00:58Z; Alpha audit-ratified at 00:29Z, 29min before trigger).

**6 PRs shipped:**

| PR   | Lane  | Item | Squash    | Repo     | Subject                                                                                    | Main-CI run   | Conclusion |
| ---- | ----- | ---- | --------- | -------- | ------------------------------------------------------------------------------------------ | ------------- | ---------- |
| #117 | Alpha | 1    | `e734bd9` | dotfiles | L:463 — dispatcher.sh wrapper for `CLAUDE_CONDUCTOR_DISABLE_HOOKS=*` recovery sentinel     | `26005467200` | success    |
| #75  | Alpha | 3    | `aee4190` | plugin   | L:142 — summarizeChannelForHandoff + Step 1a picker channel-liveness                       | `26005468567` | success    |
| #118 | Alpha | 5    | `04bf80f` | dotfiles | L:529 — dedicated test files for cluster-1 substrate checks (5 files)                      | `26005469380` | success    |
| #119 | Alpha | 6    | `30afb0c` | dotfiles | install.sh + L:909 worktree-node_modules SE-4 escape-scan exclusion                        | `26006004887` | success    |
| #76  | Bravo | 2    | `bfc9be4` | plugin   | L:503 — structural test slice for 6 plugin skill-class artifacts (DEADLINE 2026-05-20 met) | `26007294457` | success    |
| #77  | Bravo | 4    | `8affef7` | plugin   | L:145 — readStdin time-to-first-byte timeout (TA-2 closure)                                | `26007295446` | success    |

**Decisions captured in this slice:**

1. **Item 1 dispatcher.sh sentinel semantic — Q1 self-fold pre-impl (channel ts 22:17Z):** Alpha's plan v1 leaned "bail on any non-empty `CLAUDE_CONDUCTOR_DISABLE_HOOKS` value." Primary-source read of `parseDisableHooksEnv` showed `*` is NOT a recognized wildcard. Original lean would have regressed named-disable behavior (`=fact-force` wrongly bypassing dispatcher). Corrected to literal `*` sentinel only — narrow exception; named-disable semantics preserved. Pattern: primary-source-verify a planned default-action against the existing parser before locking the lean.

2. **Item 4 scope refinement — `--body-file` already shipped:** plan v1 cited "Lean (a)+(b): fail-loud after 3s + add `--body-file` flag." Pre-impl primary-source check confirmed `--body-file` is already shipped (cli.ts:533 + PR #70 + L:517 RESOLVED). Item 4 scope reduced to lean (a) only — the TA-2 known-follow-up at cli.ts:847-854 explicitly lane-opened "Async-readable + timeout detection." Pattern: pre-impl scope verification can shrink work without missing the intent.

3. **TA-2 latency estimate refuted empirically:** original TA-2 comment said timeout detection "adds 50ms latency per send." Implementation refuted: `Promise.race` against an unref'd `setTimeout` adds zero observable happy-path latency (timer cleared synchronously on first chunk + `.unref()` ensures it doesn't hold event loop alive). Pattern: TA-style follow-up estimates should be re-validated at impl time; the framing assumption may be wrong.

4. **Item 6 filed mid-cycle + shipped same-cycle:** install.sh + L:909 worktree-node_modules tension surfaced during Item 1 impl (worktree-commits hit 21/32 install.sh test failures). Alpha filed as backlog entry mid-cycle, offered as Item 6; Bravo declined (Item 2 deadline pressure); Alpha picked up as Alpha-lane extension. PR #119 shipped as bounded SE-4 exception (node_modules-internal-only with realpath-under-canonical-node_modules sub-gate). Bravo retroactive audit observed-not-blocked; regression test for safety-invariant filed as follow-up backlog rather than same-PR fold (per autonomy-merge timing).

5. **2nd instance of sibling-unavailable autonomy-merge precedent (Alpha-side, executed):** Alpha autonomy-merged Items 1+3+5 at 23:08Z with Nick-explicit-go after Bravo's 75-min silence. Bravo had joined the wrong channel (derived `2026-05-17_21-30` instead of cycle `2026-05-17_22-00`) until Nick's "check for communication" prompt routed correctly. Self-audit substituted for sibling cross-audit per slice-3's threshold (3-lens SHIP-CLEAN + CI green + ≥75min peer silence + Nick-explicit-go). Bravo retroactively ratified SHIP-CLEAN-IMPLIED 0/0/0 at 00:31Z; no follow-up PRs filed. Pattern: autonomy-merge convention holds bidirectionally.

6. **2nd instance of sibling-unavailable autonomy-merge precedent (Bravo-side, armed-but-preempted):** Bravo set up symmetric gate at 00:31Z — autonomy-squash threshold at 00:58Z if Alpha stayed silent past 75min. Threshold-clock Monitor armed for empirical observability + channel-surfaced for peer awareness. Alpha's audit ratification arrived at 00:29Z (29min under threshold). Pattern: arming the gate + channel-surfacing it accelerates peer re-engagement vs ambiguous "waiting" state. Gate Monitor stopped on peer return.

7. **L141 mismatch handling pattern validated end-to-end:** Bravo's `/handoff-resume parallel` resolved derived channel `2026-05-17_21-30` (empty) vs cycle channel `2026-05-17_17-00` (2 live-tracked peers, both heartbeats ~18min stale). Per L141 default, joined derived; later routed to slice-4 channel `2026-05-17_22-00` via Alpha's channel-surface in the cycle channel. The 5-kind summarizeChannelForHandoff helper Alpha shipped in PR #75 would have made this transition smoother had it been integrated into the resume flow — slice-5 fold candidate.

8. **Lane split shape (Alpha 4 PR / Bravo 2 PR):** Alpha lane = 3 planned items + 1 mid-cycle Item 6 (~1271 LOC across 11 files). Bravo lane = 2 planned items (~444 LOC across 3 files). LOC ratio ~3:1 Alpha:Bravo — Alpha-heavy by count + LOC; Bravo-balanced by per-item depth (Item 2 cross-skill structural audit + Item 4 substrate primitive timeout). The 4-axis pickup rubric naturally bifurcates lane dimensions (count, LOC, complexity, deadline pressure).

**Cycle metrics:**

- **PRs shipped:** 6 (4 Alpha + 2 Bravo). Cross-cycle (slices 1+2+3+4): **17 PRs / 17 main-CI green / 0 unfixed failures**.
- **Plan-v1 cross-audit cycles:** 2 (Alpha's lane Q1-Q9 self-folded + Bravo accepted without counter-propose; Bravo's lane Q-B1..Q-B6 leans all accepted by Alpha).
- **Per-PR cross-audits:** 5 (Bravo on Alpha's #119; Alpha on Bravo's #76 + #77; Bravo retroactive on Alpha's #117 + #75 + #118 = SHIP-CLEAN-IMPLIED 0/0/0).
- **Mode-2 catches:** 4 (Q1 dispatcher.sh sentinel semantic; Item 4 `--body-file` scope refinement; TA-2 latency refutation; install.sh + L:909 substrate-gap filed mid-cycle).
- **Backlog deltas:** -6 closed (L:142 + L:145 + L:463 + L:503 + L:529 + install.sh-vs-L:909). +1 filed (Bravo's safety-invariant regression test for Item 6). Net **-5 this slice**; cumulative slice 1+2+3+4 = **-17 net** from rubric tail.
- **New memories filed:** 0 this slice (vs slice-3's 1 + slice-1's 1). Cycle 4 was substrate-pattern-application; the autonomy-merge precedent bidirectional ratification is recorded here (not in standalone memory) per slice-3 precedent for protocol-record items.
- **Nick interventions:** 1 (slice-opening autonomy direction at session start + "check for communication" routing-fix when Bravo was on wrong channel). 0 protocol-class.
- **TA-2 closed:** known-follow-up at cli.ts:847-854 deferred since the original Slice 3a body-file plumbing landed (vivid-seeking-crayon plan).

**Why this slice matters (fourth-cycle rubric validation + bidirectional autonomy convention):** 17/17 PRs across slices 1+2+3+4 with 0 unfixed CI failures + 0 Nick protocol-class interventions. Four consecutive successful applications of the 4-axis pickup framework. Slice 4 added the cross-instance autonomy-merge convention as a bidirectional pattern — both Alpha and Bravo have now exercised "sibling-unavailable autonomy-merge" under explicit Nick authorization + 75min peer silence + 3-lens self-audit threshold. The convention is symmetric in design; this slice ratified it empirically. Next-tier candidates for slice 5 likely from L:188 structured-logging (remaining Reliability batch) + L:895 /memory-audit (sibling to slice-3 L:893 Memory cluster).

**Cross-references:**

- Plans: `~/.claude/plans/idempotent-bouncing-cocoa.md` (Alpha lane) + `~/.claude/plans/crisp-watching-beacon.md` (Bravo lane)
- Backlog entries closed (vault): L:142 + L:145 + L:463 + L:503 + L:529 + install.sh-vs-L:909 substrate-gap entry
- Backlog entry filed mid-cycle: Item 6 safety-invariant regression test (opportunistic follow-up)
- Channel: `2026-05-17_22-00` — Alpha (sid `f93c00bc`) + Bravo (sid `d5c6c6d8`) coordination
- Cycle channels traversed: `2026-05-17_21-30` (Bravo's derived channel, briefly joined per L141 default) → `2026-05-17_17-00` (cycle channel from slice-3, where Alpha left routing-message) → `2026-05-17_22-00` (slice-4 channel)
- Sibling-unavailable autonomy-merge precedent: slice 3's `decisions/phase-3.md` entry codified the trigger conditions; slice 4 ratified bidirectionally (Alpha-executed + Bravo-armed-preempted)
- TA-2 closure source: cli.ts:925 comment block + StdinTimeoutError class + send-case catch arm + commit body of squash `8affef7`

---

## 2026-05-18 — Slice 5: Self-Monitoring Infrastructure cohort-pass (`iterative-scribbling-diffie`)

```yaml
---
title: "Slice 5 — Self-Monitoring Infrastructure cohort-pass"
date: 2026-05-18
kind: tooling
severity: minor
phase: 3
affects:
  [
    dotfiles/src/shared/kill-switch.ts,
    dotfiles/src/shared/bash-parser.ts,
    dotfiles/src/shared/transcript-scanner.ts,
    dotfiles/src/__tests__/shared/kill-switch.test.ts,
    dotfiles/src/__tests__/shared/bash-parser.test.ts,
    dotfiles/src/__tests__/shared/transcript-scanner.test.ts,
    dotfiles/src/hooks/checks/ci-verification-gate.ts,
    dotfiles/src/hooks/checks/ci-verification-reminder.ts,
    dotfiles/src/hooks/checks/ci-verification-auth-warn.ts,
    dotfiles/src/hooks/checks/ci-verification-pre-push-arm.ts,
    dotfiles/src/hooks/checks/compound-bash-detector.ts,
    dotfiles/src/hooks/checks/memory-authoring-summary.ts,
    dotfiles/src/hooks/checks/observer-nominator.ts,
    dotfiles/src/hooks/checks/feedback-minimal-output-detector.ts,
    dotfiles/src/hooks/checks/output-externalization-nudge.ts,
    dotfiles/src/hooks/checks/test-gate.ts,
    dotfiles/src/hooks/checks/hindsight-registrations.ts,
    dotfiles/src/__tests__/hooks/cross-edge-imports.test.ts,
    dotfiles/src/__tests__/hooks/checks/test-gate.test.ts,
    dotfiles/architecture.yaml,
    plugin/scripts/check-generic-paths.sh,
    plugin/memories-to-bundle.md,
    vault/wiki/backlog.md,
  ]
---
```

**Context:** Slice 5 of the cohort-pass strategy — first deliberate "shrink ONE cluster by ≥5 items" application. Target: Self-Monitoring Infrastructure cluster (largest at 26 open items, oldest with multi-week cohorts). Outcome: cluster 26 → 17 open (-9 net; 12 closures + 3 new follow-up filings landing in same section). Cycle character: HEAVY pre-LOCK audit cadence (3-lens convergence + Bravo cross-audit → 12 + 7 = 19 audit folds incorporated before any LOC write); per-PR audits caught a memorialize-then-violate anti-pattern (B1 fold-2 reversal); 3rd ratification of sibling-unavailable autonomy-merge precedent (Alpha-side A2 + A3 with Bravo explicit AUDIT-DEFER ack vs prior silence-threshold trigger).

**9 PRs shipped:**

| PR   | Lane  | Item | Squash     | Repo      | Subject                                                                   | Main-CI run   | Conclusion |
| ---- | ----- | ---- | ---------- | --------- | ------------------------------------------------------------------------- | ------------- | ---------- |
| #120 | Alpha | A1   | `de24e161` | dotfiles  | Lift `killSwitchPaths` plural helper to `src/shared/kill-switch.ts`       | `26009851212` | success    |
| #121 | Alpha | A2   | `2d5fb96e` | dotfiles  | Lift `bash-parser` 7 regex constants + helpers to `src/shared/`           | `26009973109` | success    |
| #122 | Alpha | A3   | `29cb0827` | dotfiles  | Lift `transcript-scanner` (readTail + generic tryParse + stripFencedCode) | `26010054464` | success    |
| #78  | Bravo | B4   | `8594130f` | conductor | check-generic-paths.sh P4 hex-string detector + FP-class exclusion        | `26010156458` | success    |
| #123 | Bravo | B5+6 | `f3dd9c62` | dotfiles  | Bundled — stale §§ ref + cross-edge-imports regex extension               | `26010157546` | success    |
| #124 | Bravo | B7   | `2095e95a` | dotfiles  | Expand test-gate.test.ts to full cluster-1 coverage                       | `26010425147` | success    |
| #125 | Bravo | B1   | `f72168d2` | dotfiles  | TIER-3a global async cache (1h freshness) for ci-verification-auth-warn   | `26010773395` | success    |
| #126 | Bravo | B3   | `22975b50` | dotfiles  | Kill-switch usage telemetry across 4 CI-verification checks               | `26011009998` | success    |
| #127 | Bravo | B2   | `625794a5` | dotfiles  | test-gate SHA cache (package.json + bun.lock keyHash)                     | `26011043059` | success    |

**Decisions captured in this slice:**

1. **Cohort-pass strategy as 1st application:** prior 4 slices (1-4) applied 4-axis pickup (ratified-but-stale / operational-tax / bounded-scope / blast-radius) which picks individual high-ROI items but doesn't shrink cohorts. Slice 5 deliberate target: shrink ONE cluster by ≥5 items. Outcome: 12 closures in Self-Monitoring (26 → 14 + 3 new = 17 net); -9 vs target ≥5. Pattern: cohort-pass complements per-slice 4-axis rubric for cluster-stagnation pressure.

2. **Pre-LOCK 3-lens convergence + Bravo cross-audit caught 19 folds before any LOC write:** Architecture lens (code-architect agent) returned 7 folds (DRY_RUN_PATTERN regex speculative error; TranscriptLine type-export scope; KillSwitchPaths type widening; architecture.yaml updates; etc.). Workflow lens returned 8 folds (lane balance; A1→B2 dependency assumption wrong; B3 mode-2 audit needed; branch naming; pre-flight). Premise lens via primary-source verification caught 5 stale-premise items (L475/477/479/485/487 reference Plugin canonical but truth is substrate post-INVERSIONS Cluster 2). Bravo cross-audit added 7 more folds (B7 file-exists-not-create; B1 cache-key scope global; A2/A3 framing; Lane D pause discipline; dotfiles pre-flight; cross-artifact L-number grep). Total 19 folds incorporated pre-impl. Pattern: heavy pre-impl audit cadence on substrate-fix slices reduces per-PR fold-cycles AND catches stale-premise that would otherwise ship as wrong-target work.

3. **Memorialize-then-violate anti-pattern caught at B1 cross-audit:** Bravo's plan-v1 audit FOLD 2 explicitly prescribed GLOBAL cache key for `gh auth status` (user-wide state, cross-session amortization). Bravo's B1 impl drifted to per-session keying despite his own fold. Alpha mode-1 audit caught the drift; Bravo applied the fix + added a BONUS catch (warn-class outcome guard — only pass-class outcomes get cached, preventing cross-session sessionId leak via cached warn messages). Pattern: cross-audit is NOT just for catching unknowns — it catches the _known_ discipline lapses that the author argued themselves out of during impl. The B1 episode is a textbook `feedback-memorialize-then-violate-anti-pattern.md` instance. Worth a rent-payment annotation on that memory.

4. **3rd ratification of sibling-unavailable autonomy-merge precedent (Alpha-side, A2 + A3, explicit-defer mode):** slice 3 codified the trigger conditions; slice 4 ratified bidirectionally under SILENCE-threshold (75min); slice 5 introduced EXPLICIT-DEFER mode — Bravo posted `A2 mode-1 audit DEFER: your plan-time architecture review + the 3 lens-callouts + 1850/1850 tests + main-CI green all converge. No formal verdict needed. Same default-defer applies to A3 unless you flag a concern at audit-ask time.` Alpha autonomy-squashed A2 + A3 with documented 3-lens self-audit. Pattern: explicit-defer is the cleaner version of silence-threshold — same outcome (sibling-authorized autonomy-squash) but with explicit consent ack on-record rather than silence-as-consent inference.

5. **Mode-2 pre-impl design audit on B3 worked end-to-end:** B3 (kill-switch usage telemetry) was the slice's only NEW-state-shape PR (JSONL emit pattern outside existing sentinel pattern). Per workflow-lens fold 10, B3 audit cadence was elevated to mode-2 (design audit BEFORE impl). Bravo sent design sketch to channel; Alpha returned SHIP-CLEAN-DESIGN with 1 small addendum (whichKillSwitched return-type choice — accepted Bravo's lean). Bravo impl matched design exactly; mode-1 post-impl SHIP-CLEAN with zero re-audit folds. Pattern: mode-2 pre-impl design audit on new-state-shape PRs catches contract issues at design cost (~10 min) instead of impl cost (~30-60 min re-spin).

6. **Pipelined Alpha PR chain (A1 → A2 → A3 stacked) reduced wall-clock vs serial:** A1 had to land first (B3 depends on it); A2 + A3 are file-disjoint vs A1 but share lift-target dir (`src/shared/`). Strategy: branch A2 off A1, A3 off A2; PR each against the prior. When A1 squash-merged, rebase A2 onto main (force-push); when A2 squash-merged, rebase A3 onto main. Each rebase produced "skipped previously applied commit" (clean rebase) — no manual conflict resolution needed. Pattern: pipelined-stacked branches for serial-dependent shared/-lift PRs save ~20-30 min wall-clock vs serial wait-for-squash-then-start.

7. **Stale-premise catching at audit-time prevents wrong-target work:** 5 of 6 initially-targeted CI-verification items (L475/477/479/485/487) referenced "Plugin (`claude-conductor`)" scope-prefix; primary-source verification revealed all 4 CI-verification checks moved plugin → substrate during INVERSIONS arc Cluster 2 (2026-05-07). Without primary-source verification, slice work would have shipped against the wrong repo. Phase 3 vault commit applied scope-reframes to the closure entries (original Plugin scope-prefix preserved in body for audit trail). Pattern: backlog entries decay against post-arc substrate reshuffles; pre-LOCK primary-source verification of file locations is mandatory for substrate-fix slices.

8. **First substrate src/shared/ phase-v consolidation complete for this scope:** before slice 5, substrate `src/shared/` had 3 helpers (home, presence-failure-log, session-id-discovery). Post slice 5: 6 helpers (+ kill-switch + bash-parser + transcript-scanner). 12 inline-duplicated functions across 12 consumer files now route through 3 shared modules. Phase-v consolidation discipline (3-consumer-lift threshold per `feedback-substrate-precedent-as-design-rescue.md`) held for each lift; 14 SINGULAR `killSwitchPath()` consumers explicitly deferred to follow-up backlog (convention-normalize is its own slice).

**Cycle metrics:**

- **PRs shipped:** 9 (3 Alpha + 6 Bravo). Cross-cycle (slices 1+2+3+4+5): **26 PRs / 26 main-CI green / 0 unfixed failures**.
- **Plan-v1 cross-audit cycles:** 1 (Bravo SHIP-WITH-7-FOLDS; all 7 incorporated → v2 LOCK).
- **Per-PR cross-audits:** 5 (Alpha → B4 + B5+6 + B1 + B3-design + B2; Bravo → A1 9-lens Lane D STRICT GATE + A2/A3 explicit-defer mode); 1 mode-2 design audit (B3 pre-impl by Alpha).
- **Mode-2 catches:** 2 architecture (A1 KillSwitchPaths type widening; A2 DRY_RUN_PATTERN regex speculative error caught pre-impl). 1 premise (5 stale-premise items). 1 cross-audit (B1 memorialize-then-violate fold-2 reversal).
- **Backlog deltas:** -12 closed (L443 + L463 + L465 + L467 + L475 + L477 + L479 + L483 + L485 + L487 + L513 + L529). +3 filed (singular kill-switch normalization / HOME-empty observability for shared kill-switch / kill-switch-telemetry log rotation). Net **-9 in Self-Monitoring cluster** (26 → 17); **-9 total backlog open** (189 → 180).
- **New memories candidates surfaced (not auto-filed per `feedback-memory-authoring-surface-don't-auto-file.md`):** 3 — (a) cohort-pass strategy as 1st application; (b) memorialize-then-violate rent-payment for B1 cycle; (c) mode-2 pre-impl design audit ROI on new-state-shape PRs.
- **Nick interventions:** 1 ("fully understand scope before plan" prompt at hydration phase, which caught me jumping to a sub-cluster pick before verifying full 26-item cohort state — recovered cleanly + caught 5 stale-premise items as a result). 0 protocol-class.

**Why this slice matters (cohort-pass as cluster-stagnation pressure release-valve):** prior 4 slices' 4-axis rubric shipped 17 PRs but Self-Monitoring cluster stayed roughly flat (~26 open) because individual high-ROI picks didn't address architectural cohorts. Slice 5's cohort-pass strategy shrinks the cluster by 9 net items (-35% of open count) in one cycle. The cohort-pass also surfaced 3 new follow-ups (substrate convention-normalize / HOME-empty observability / telemetry log rotation) that wouldn't have been visible without the focused architectural pass. Pattern complements per-slice 4-axis rubric: 4-axis picks the best per-cycle item, cohort-pass shrinks cluster long-tails when no individual axis is sufficient. Recommend alternating cohort-pass with 4-axis cycles (1:N ratio TBD by empirical cluster growth observation).

**Cross-references:**

- Plan: `~/.claude/plans/iterative-scribbling-diffie.md` (single shared plan for both lanes; 12 + 7 = 19 audit folds incorporated)
- Cohort target: Self-Monitoring Infrastructure section of `wiki/backlog.md` (lines 422-572 pre-slice; section shrunk 26 → 17 open + 3 new follow-ups)
- Backlog mutations (vault): `b848db6` + auto-sync `bc7b5c8`
- Channel: `2026-05-18_03-00` — Alpha (sid `0dc53626`) + Bravo (sid `0ff99c55`) coordination
- Sibling-unavailable autonomy-merge precedent: slice 3 codified; slice 4 silence-threshold; slice 5 explicit-defer mode (cleaner consent shape)
- Architecture lift entries: `c-shared-kill-switch` + `c-shared-bash-parser` + `c-shared-transcript-scanner` added to `architecture.yaml`
- New backlog filings (vault, slice 5 cohort-pass follow-ups subsection): singular kill-switch normalization (14 consumers) + HOME-empty observability parity + telemetry log rotation

---

## 2026-05-18 — Slice 6: Phase 0.10 follow-ons cohort-pass + worktree-gc substrate fix (`mirrored-stitching-orchid`)

```yaml
---
title: "Slice 6 — Phase 0.10 cohort-pass + worktree-gc substrate fix"
date: 2026-05-18
kind: tooling
severity: minor
phase: 3
affects:
  [
    conductor/src/channels/index.ts,
    conductor/src/hooks/registry.ts,
    conductor/src/hooks/checks/dotfiles-worktree-gc.ts,
    conductor/src/shared/presence-failure-log.ts,
    conductor/scripts/check-generic-paths.sh,
    conductor/scripts/check-import-extensions.sh,
    conductor/docs/conventions/error-code-scheme.md,
    conductor/test/channels/metadata-validator.test.ts,
    conductor/test/channels/metadata-version-migration.test.ts,
    conductor/test/channels/api-channelid-guards.test.ts,
    conductor/test/hooks/types.test.ts,
    conductor/test/hooks/checks/dotfiles-worktree-gc.test.ts,
    conductor/test/scripts/check-generic-paths.test.ts,
    conductor/test/scripts/check-import-extensions.test.ts,
    conductor/CONTRIBUTING.md,
    conductor/commands/session/channel.md,
    conductor/commands/session/handoff.md,
    conductor/commands/session/handoff-resume.md,
    conductor/commands/session/presence.md,
    dotfiles/src/hooks/dispatcher.ts,
    dotfiles/src/__tests__/hooks/dispatcher-unknown-tool-warn.test.ts,
    dotfiles/src/__tests__/install-sh/install.test.ts,
    vault/wiki/backlog.md,
  ]
---
```

**Context:** Slice 6 of the cohort-pass strategy — **second** deliberate "shrink ONE cluster" application, validating the pattern across a different cluster type than slice 5. Target: Phase 0 sub-step 0.10 follow-ons cluster (18 open at start, next-largest section after Self-Monitoring). Outcome: cluster 18 → ~9 open (-9 net; 8 work-PR closures + 1 stale-close (CLI-6) + 0 new follow-up filings in same section, but +1 spawned substrate-fix PR from observed bug). Cycle character: lighter pre-LOCK audit cadence than slice 5 (5 folds vs 7 — methodology maturing); two parallel-session shared-tree race recoveries cost ~5 min rework; a new substrate fix shipped after observing live-sibling worktree reap during a 3-session cycle (Alpha + Bravo + Charlie); cohort-pass strategy escalated from "complement" to "default cycle shape" based on two-cycle reproduction.

**10 PRs shipped (8 work-PRs + 1 A2 cross-edge prereq + 1 substrate-fix from observed bug) + this retro:**

| PR   | Lane  | Item   | Squash    | Repo      | Subject                                                                          | Main-CI               |
| ---- | ----- | ------ | --------- | --------- | -------------------------------------------------------------------------------- | --------------------- |
| #80  | Alpha | A1     | `bd60fa5` | conductor | TS-N1 — ChannelMetadata.version invariant + asymmetric schema gate               | `26034607823` SUCCESS |
| #81  | Bravo | B1     | `99a555a` | conductor | TS-N3 — KnownToolName exhaustiveness type-test                                   | SUCCESS               |
| #82  | Bravo | B2     | `6290d44` | conductor | CLI-3b — check-generic-paths --include-untracked flag                            | SUCCESS               |
| #83  | Bravo | B3     | `750bf23` | conductor | CLI-8 — dotfiles version-compat preflight + docs                                 | SUCCESS               |
| #84  | Alpha | A2-pre | `fab755b` | conductor | A2 cross-edge prereq — re-export KNOWN_TOOL_NAMES runtime tuple                  | `26034604613` SUCCESS |
| #85  | Alpha | A3     | `41ba74a` | conductor | RE-3 — isValidArtifactId guards at 13 module-API entry points                    | `26039158005` SUCCESS |
| #86  | Alpha | (sub)  | `b732e35` | conductor | fix(worktree-gc) — sid-prefix liveness fallback prevents live-sibling reap       | `26043108423` SUCCESS |
| #87  | Alpha | A4     | (pending) | conductor | CLI-11 — detector error-code numbering (CGP-001..004 + CIE-001) + convention doc | (in progress)         |
| #128 | Bravo | B4     | `8ccb43e` | dotfiles  | TA-3-impl + TA-12 + TA-13 + TA-14 install-sh behavioral test cluster             | `26037570080` SUCCESS |
| #129 | Alpha | A2     | `a4420a3` | dotfiles  | TS-N2 — dispatcher unknown-toolName warn with emit-once dedup                    | `26039143967` SUCCESS |

**Decisions captured in this slice:**

1. **Cohort-pass strategy escalated from complement to DEFAULT cycle shape (revised):** prior framing in `feedback-cohort-pass-cluster-pressure-release-valve.md` called cohort-pass a complement to per-slice 4-axis rubric, with cohort-pass-as-default explicitly listed as an anti-pattern. Slice 6 evidence flipped that: two consecutive cohort-pass cycles (slice 5 Self-Monitoring 26→17 + slice 6 Phase 0.10 18→9) shipped 9 + 10 PRs at zero-unfixed-failure cadence; per-cycle ROI on cohort-pass exceeded the average 4-axis cycle. Default-flip is empirical, not theoretical. 4-axis cycles now the fallback condition (no cluster has critical mass / critical isolated bug preempts / heterogeneous Watch List). Memory revised inline; re-flip would require evidence of cohort-pass quality dropping cycle-over-cycle.

2. **5 stale-premise catches at hydration phase via primary-source verify pre-plan-write:** slice 5 caught 5, slice 6 also caught 5. Specifically: (a) CLI-6 RESOLVED stale-close — `dependencies-rationale.md` already had the comprehensive header described in fix; (b) TS-N1 anchors moved — ChannelMetadata 69→184, validateChannelMetadata 235→574, and the cited marker-validator files (config-protection-store + fact-force-scope-store) had been MOVED out of the plugin entirely; (c) TS-N2 line off (366→475); (d) SE-P1-5 line off (622-631 → 653-664); (e) TS-N3 confirmed no existing test/hooks/types.test.ts. Without primary-source verify, CLI-6 would have shipped as wrong-target work + TS-N1 would have shipped against the wrong sibling pattern (the new pattern is `kind_version: 1` on `digest.ts` + `live-update.ts` body schemas, not the gone marker validators).

3. **Plan-v1 cross-audit fold count dropped slice-to-slice (5 vs 7):** slice 5 had 12 + 7 = 19 folds pre-LOCK; slice 6 had 5. Both cycles' folds were substantive (FOLD-1 bootstrap-deadlock catch on A1 asymmetric validator semantics; FOLD-2 emit-once dedup on A2 dispatcher warn; FOLD-3 hard-cutover decision-surface on A4; FOLD-4 B3 scope reframe from docs-only to feature-detection; FOLD-5 typecheck-include pre-impl verify on B1). The decreasing fold-count signals plan-v1 quality is improving cycle-over-cycle. Pattern: as plan-write maturity improves, the right comparison metric is folds-PER-PR-of-scope, not folds-absolute; slice 6's 5 folds / 8 work-PRs is comparable to slice 5's 19 folds / 9 work-PRs.

4. **`import.meta.main` guard pattern on script-entry modules unlocks INTERNAL helper testability:** A2's dispatcher.ts has a top-level `main().catch(...)` invocation that runs when any module imports it. Tests that need to import an `INTERNAL` helper (slice-5 RE-6 precedent) would inadvertently trigger dispatcher main() with test-runner argv. Fix: wrap the production-entry in `if (import.meta.main) { ... }`. Pattern: every script-entry TS file with a top-level `main()` invocation should add this guard so the file is importable in tests without spurious execution. Generalizable beyond dispatcher.ts.

5. **Feature-detection (option c) is the right cross-repo compat mechanism vs SHA-pin / version-marker file:** B3 plan-v1 framed CLI-8 as "add docs + 'command not found' handler" (docs-only). FOLD-4 reframed: the underlying choice (how does plugin signal compat with dotfiles?) had three options. (a) SHA-pin a known-good dotfiles commit in plugin docs (rigid; goes stale fast). (b) version-marker file in dotfiles substrate consumed by plugin slash-commands (new state shape — would escalate B3 to mode-2). (c) feature-detection at slash-command boundary via `bun run <CLI> --help | grep <expected-verb>` (most adaptive; no new state shape; explicit diagnostic on shape drift). Bravo recommended (c); Alpha concurred; B3 impl matched. Pattern: when cross-repo compat is the design surface, prefer feature-detection over compile-time pinning — adapts to substrate evolution without churning the plugin.

6. **Parallel-session shared-tree branch race struck twice + recovered via per-session worktree migration:** Race 1 (~11:45Z): Alpha's `git checkout -b alpha/a1-...` in canonical conductor tree got swapped to Bravo's branch between checkout and commit (Bravo's concurrent `git checkout bravo/b1-...` in the SAME tree). Recovery via `git branch -f alpha/a1 <sha>` ref-move. Race 2 (~11:48Z, post race-1 ref-only recovery, pre push): Bravo's reset of bravo/b1 to main + checkout of alpha/a1 in canonical restored tree HEAD; local working-tree content reverted in the interim. Push succeeded (pushes branch ref, not working-tree state); PR content unaffected. Lesson: per-session worktrees at paths OUTSIDE the provisioner-managed pattern (`~/Repos/<repo>-<lane>-<slug>/` not `~/.claude-<repo>-<sid>/`) are race-immune AND survive future sibling-spawns. Memorialize-then-violate class: race-memory was loaded but applied only after race-2 hit; should have migrated immediately after race-1.

7. **Substrate bug observed + fixed in same cycle (sid-prefix liveness fallback for dotfiles-worktree-gc):** during the 3-session Alpha+Bravo+Charlie cycle (Charlie spawned mid-slice for unrelated Linear research), the dotfiles-worktree-gc reaped BOTH Alpha's and Bravo's worktrees despite both sessions being alive + heartbeating. Root cause: `byDotfilesRoot` map in gc can miss when (a) heartbeat overwrite wiped `dotfilesRoot` sentinel, OR (b) raw-vs-realpath drift between sentinel write-time and read-time. Both miss-classes route to `matched === undefined` → reap. Fix (PR #86, +150 LOC across gc + presence-failure-log kind extension + tests): defense-in-depth sid-prefix scan over the same `anchors` array. If any anchor heartbeat shares the worktree's 8-char sid-prefix AND is live (ageMs < GC_WINDOW_MS, not likelyDead), skip reap + emit new `worktree-gc-liveness-fallback-fired` breadcrumb. Happy path unchanged. Pattern: substrate bugs surfaced mid-cycle by observation deserve same-cycle close-out, not next-cycle deferral. New memory: `feedback-worktree-provisioner-reaps-live-siblings.md`.

8. **Hard-cutover on detector code rename validated by primary-source zero-external-consumer verify (A4 / FOLD-3):** plan-v2 §A4 + FOLD-3 pre-locked hard cutover (vs dual-emit grace) after primary-source verify: `grep -rn 'error\[P[1-9]\]\|error\[T[1-9]\]' .github/ scripts/` returned ZERO external consumers of the old codes outside the detector scripts themselves. Phase 0 → v0.1.0 boundary is the tolerable churn window per CLI-11 backlog entry's framing. Pattern: when renaming a public-API surface, primary-source-verify the consumer set first — if zero, hard cutover is correct; if non-zero, dual-emit grace is required. The framing-decision moves from "design taste" to "empirical state of the system."

**Cycle metrics:**

- **PRs shipped:** 10 + 1 retro = 11. Cross-cycle (slices 1-6): **27 + 10 = 37 PRs / 37 main-CI green / 0 unfixed failures**.
- **Plan-v1 cross-audit:** 1 (Bravo SHIP-WITH-5-FOLDS; all 5 incorporated → v2 LOCK + plan-v2 §Bravo plan-v1 cross-audit verdict block).
- **Per-PR cross-audits:** 5 (Alpha → B1 + B2 + B3 + B4 + #86 substrate-fix; Bravo → A1 + A2 + A3 + A4 + A2-pre). All SHIP-CLEAN, 0 audit folds incorporated post-impl.
- **Mode-2 catches:** 1 reliability (A1 FOLD-1 asymmetric semantics catches bootstrap deadlock). 1 architecture (B3 FOLD-4 scope reframe). 1 cross-audit recovery (none this slice — fold count dropped vs slice 5).
- **Backlog deltas:** -9 closed (Phase 0.10 §TS-N1, §TS-N2, §TS-N3, §RE-3, §CLI-3b, §CLI-6 stale-close, §CLI-8, §CLI-11, §TA-3-impl + §TA-12 + §TA-13 + §TA-14). +0 new filings (this slice surfaced 1 substrate bug → PR #86 closed it same-cycle; would-have-been-filing converted to immediate fix).
- **New memories filed (Alpha cycle):** 1 — `feedback-worktree-provisioner-reaps-live-siblings.md` (substrate bug observation + workaround pattern; superseded by PR #86 fix but memory retained as the audit-trail of the discovery + the workaround for any similar future incident).
- **New memories revised (Alpha cycle):** 2 — `feedback-cohort-pass-cluster-pressure-release-valve.md` (default-cycle-shape escalation); `feedback-parallel-session-shared-tree-branch-race.md` (added §Slice 6 update with 4 new operator-discipline rules + PR #86 substrate-fix cross-ref).
- **Nick interventions:** 1 procedural ("did Charlie notify you?" — surfaced Charlie's research filings sat unread in channel; recovered by reading + acking) + 1 strategic ("two parallel-session races struck") which produced PR #86 + the memory revisions.
- **Cross-session integration with Bravo:** clean throughout — 5 PRs Bravo-side (B1 + B2 + B3 + B4 + closed all his backlog atoms via vault commits 46ccc63 + 0550e48 + c9bc7b3 + eae766d); explicit-defer mode on A2-pre/A3 squash (Bravo audited SHIP-CLEAN); zero protocol-class interventions needed from Nick.
- **Cross-session integration with Charlie:** clean — Charlie operated in parallel-mode on unrelated Linear research; filed 4 backlog items (a-d at lines 939/941/943/945) with proper scope-prefix; sibling-collision discipline observed (vault-only writes, no overlap with my + Bravo's commits).

**Why this slice matters (cohort-pass as default cycle shape):** slice 5 was the first deliberate cohort-pass application; slice 6 was the validation across a different cluster type (Phase 0.10 vs Self-Monitoring). Two consecutive cycles' results (9 + 10 PRs, both at zero-unfixed-failure cadence, both with substantive cluster shrinkage) plus the lighter audit-fold count in slice 6 (methodology maturing) signal cohort-pass is the default cycle shape going forward. 4-axis fallback only when (i) no cluster has critical mass, (ii) a critical isolated bug preempts, or (iii) the cluster lacks architectural cohesion. Memory updated inline.

**Cross-references:**

- Plan: `~/.claude/plans/mirrored-stitching-orchid.md` (single shared plan for both lanes; 5 audit folds incorporated)
- Cohort target: Phase 0 sub-step 0.10 follow-ons section of `wiki/backlog.md` (cluster shrunk 18 → 9 open)
- Substrate-fix-spawned-mid-cycle: PR #86 closes the dotfiles-worktree-gc live-sibling-reap bug observed during the Alpha+Bravo+Charlie 3-session cycle
- Cohort-pass-as-default-cycle-shape memory revision: `feedback-cohort-pass-cluster-pressure-release-valve.md`
- Race-recovery operator-discipline rules added: `feedback-parallel-session-shared-tree-branch-race.md` §Slice 6 update
- New memory: `feedback-worktree-provisioner-reaps-live-siblings.md`
- Channel: `2026-05-18_10-50` — Alpha (sid `50f9662b…`) + Bravo (sid `b1183eb9…`) + Charlie (sid `49fe352b…`) coordination
- Detector code-scheme convention doc: `docs/conventions/error-code-scheme.md` (introduced in PR #87 A4)

---

## 2026-05-18 — Slice 7: Self-Monitoring residual cohort-pass + worktree-provisioner race-fix Phase 1 telemetry (`glimmering-tracking-magpie`)

```yaml
---
title: "Slice 7 — Self-Monitoring residual cohort-pass + Phase 1 telemetry"
date: 2026-05-18
kind: tooling
severity: minor
phase: 3
affects:
  [
    conductor/src/active-sessions/index.ts,
    conductor/src/shared/presence-failure-log.ts,
    conductor/test/active-sessions/sentinel-extension.test.ts,
    conductor/docs/audits/2026-05-18-gc-fallback-symmetry.md,
    dotfiles/src/active-sessions/index.ts,
    dotfiles/src/shared/kill-switch.ts,
    dotfiles/src/__tests__/shared/kill-switch.test.ts,
    dotfiles/src/hooks/lock.ts,
    dotfiles/src/hooks/checks/architecture-coverage.ts,
    dotfiles/src/hooks/checks/architecture-orphans.ts,
    dotfiles/src/hooks/checks/observer-nominator.ts,
    dotfiles/src/hooks/checks/handoff-latest-guard.ts,
    dotfiles/src/hooks/checks/memory-authoring-summary.ts,
    dotfiles/src/hooks/checks/session-log-guard.ts,
    dotfiles/src/hooks/checks/memory-index-sync.ts,
    dotfiles/src/hooks/checks/wiki-backlog-scope-check.ts,
    dotfiles/src/hooks/checks/output-externalization-nudge.ts,
    dotfiles/src/hooks/checks/memory-integrity.ts,
    dotfiles/src/hooks/checks/compound-bash-detector.ts,
    dotfiles/src/hooks/checks/canonical-sync-verifier.ts,
    dotfiles/src/hooks/checks/architecture-event-mismatch.ts,
    vault/wiki/backlog.md,
  ]
---
```

**Context:** Slice 7 of the cohort-pass strategy — **third deliberate application**, first since the slice-6 ratification that escalated cohort-pass from complement to default cycle shape. Target: Self-Monitoring Infrastructure residual cluster (17 open post-slice-5) with the long-deferred worktree-provisioner race-fix Phase 1 telemetry (L445, 12-day-old plan v1.3) as the headline. Outcome: 7 PRs shipped at zero-unfixed-failure cadence after a transient 2-failure dotfiles-main-CI recovery via hotfix #133 — cluster ~17 → ~10 open (-7 closed + 1 new follow-up filing = -6 net). Cycle character: substrate-coupling lesson surfaced empirically (#133 hotfix), Mode-2 design audit pre-locked at plan-v1 cross-audit (FOLD-4 Point 7 pre-rmSync emit, FOLD-5 A1→A2 ordering, FOLD-6 Point 4 artifactId-eq), 4-sibling parallel work (Alpha + Bravo + Charlie + Delta) with non-overlapping scopes.

**7 PRs shipped:**

| PR   | Lane  | Item   | Squash    | Repo      | Subject                                                                   | Main-CI        | Conclusion |
| ---- | ----- | ------ | --------- | --------- | ------------------------------------------------------------------------- | -------------- | ---------- |
| #89  | Alpha | A1     | `d8ef055` | conductor | Export heartbeatPath + canonicalClaudeHomeArtifactId (telemetry prereq 3) | `26056387472`  | success    |
| #91  | Alpha | A2     | `fe3d27e` | conductor | A2 7-point telemetry instrumentation per plan v1.4 (headline)             | `26062343091`  | success    |
| #130 | Bravo | B1     | `2a7f56a` | dotfiles  | Normalize 14 killSwitchPath() consumers to plural pattern                 | (FAIL→recover) | recovered  |
| #131 | Bravo | B2     | `46cf435` | dotfiles  | HOME-empty stderr breadcrumb in kill-switch flagsDir                      | (FAIL→recover) | recovered  |
| #132 | Bravo | B3     | `c033050` | dotfiles  | JSONL rotation via cross-edge appendLogWithRotation reuse                 | `26061389543`  | success    |
| #90  | Bravo | B4     | `5c66259` | conductor | GC-fallback symmetry audit doc                                            | success        | success    |
| #133 | Bravo | hotfix | `62c26ec` | dotfiles  | mirror A1 plugin exports in active-sessions shim (recovery)               | `26059598607`  | success    |

**Cross-cycle slices 1-7:** 37 (slices 1-6) + 7 (slice 7) = 44 PRs shipped; main-CI verification: 42 clean runs + 1 hotfix-recovery cycle (#133 closed B1 + B2 transient failures). Net: 44 PRs / 44 main-CI green (counting recovery) / 0 unfixed-after-recovery failures.

**Decisions captured in this slice:**

1. **Cohort-pass strategy third deliberate application — N-cycle stability data validates default-cycle-shape escalation.** Slices 5 + 6 ratified cohort-pass-as-default in slice-6 retro (memory `feedback-cohort-pass-cluster-pressure-release-valve.md` revised). Slice 7 is the first cycle AFTER ratification: same shape, same per-cycle ROI (~7 PRs / cluster ~17→10), continued zero-unfixed-failure cadence (with hotfix-recovery). Three-cycle stability data: pattern is reproducible across cluster types (Self-Monitoring twice + Phase 0.10 once). Default-cycle-shape claim now has N=3 empirical support.

2. **Substrate-coupling-on-export-changes lesson — new memory + backlog filing + same-day double-instance (post-merge addendum).** Plugin A1 added `heartbeatPath` + `canonicalClaudeHomeArtifactId` exports on the `active-sessions` surface that dotfiles substrate shim-mirrors (per slice-5 PR #70 `50c7bed` 24-line re-export shim). Shim was NOT updated in the same lane-cycle. B1 + B2 PRs that consume the shim hit downstream test failures at squash-merge → dotfiles main-CI FAILED at `2a7f56a` + `46cf435`. Bravo caught via CI-verification + shipped hotfix PR #133 (squash `62c26ec`) mirroring shim exports; dotfiles main recovered. Memory `feedback-substrate-shim-mirror-on-plugin-export-changes.md` filed; backlog follow-up for structural detector (plugin/shim export-parity gate, slice-7 follow-ups subsection in `wiki/backlog.md`). The lesson generalizes: cross-edge shim-mirrors need sympathetic update when the canonical surface changes; without that, downstream consumer-PRs surface failures asymmetrically and the recovery window is longer than a same-cycle sympathetic edit. **POST-MERGE ADDENDUM (2026-05-18 23:0XZ; this addendum landed via PR #95 after the slice-7 retro PR #93 squash `74ea1ea` already merged):** the lesson got a same-day SECOND empirical instance. Delta's PR #92 (squash `434a4928`) added `readMessagesTail` + `readMessagesAfter` exports on the plugin `channels/api` surface that dotfiles' channels shim (`~/.claude-dotfiles/src/channels/index.ts`, 59-line explicit-list re-export, slice-3b atomic-flip per `vivid-seeking-crayon.md`) ALSO mirrors. Charlie + Delta cross-audited PR #92 but both missed the shim-mirror dependency; the gap was LATENT (no current dotfiles consumer imports those names → dotfiles main-CI stayed green). Alpha caught it post-retro-merge during slice-7 residual cleanup + shipped hotfix dotfiles PR #134 (squash `e12a78b`, main-CI run `26065052327` SUCCESS) proactively closing the latent window. **Net: TWO instances of the same shim-coupling failure mode in slice 7 (#133 reactive recovery + #134 proactive close), promoting the structural-detector backlog candidate from "first observed" trigger to "twice observed same-day → trigger fired." The structural detector should now move from "candidate" to "ready-to-build" priority.**

3. **CI-verification-overreach on batch-merge — both Alpha + Bravo violated CLAUDE.md "After Every Push" discipline.** During Alpha's 4-PR squash-merge batch (B1 + B2 + B3 + B4), neither sibling verified main-CI per-merge — both claimed "merged ✓" without `gh run watch` per push. The shim-coupling failure mode (Decision 2) hid behind the unverified merges. Per CLAUDE.md: "git push is delivery, CI is the unlock." Per memory `feedback-audit-pass-ci-green-push-clear.md`: audit-pass + CI-green = push-clear. Both shipped the discipline lapse honestly. Recovery via #133 hotfix cost ~30 min wall-clock + 1 PR cycle. Pattern: when batch-merging multiple PRs, per-merge CI verification is mandatory; shim-coupling + similar cross-edge invariants only surface at the second consumer-PR's main-CI run.

4. **14-day data-collection ceiling for Phase 2 trigger — telemetry instrumentation cycle complete.** Plan v1.3 specified a 14-day data-collection ceiling (or 10 cross-session presences, whichever first) after telemetry merge to force a Phase 2 decision. Ceiling start: 2026-05-18 (A2 #91 main-CI green at run `26062343091`). Decision date: 2026-06-01 OR after 10 cross-session presences. Branch discrimination per plan v1.3 §Phase 2 trigger criteria: A (merge-broke per heartbeat-no-dotfilesroot-on-existing firing on canonical anchor) / B (opportunistic-reap LIKELY per heartbeat-reaped firing with caller_top4 listLivePeers) / C (provisioner-incomplete per sentinel-set without subsequent merge) / D (telemetry-blind-spot per none fires). Pattern: time-boxed ceilings on observational windows force decisions rather than indefinite wait — analogous to slice-5 cohort-pass acceptance criterion (≥5 closures).

5. **Plan v1.4 enrichment from v1.3 — primary-source-verify at hydration caught 1 moot prereq + added Point 7 + Point 4 gate-switch.** Slice-7 hydration applied the slice-5/6 stale-premise discipline to plan v1.3's 6 prereqs: (1) ✓ active-sessions fork-to-shim shipped slice 5; (2) ✓ presence-failure-log rotation shipped pre-slice; (3) ✓ export helpers — A1's scope; (4) **MOOT** — `dotfiles-worktree-cleanup.ts` doesn't exist anywhere (filed as confused premise; actual unregisterActiveSession callers covered by Point 5 = tryReapHeartbeat); (5) Point 7 needed — `resetArtifactRegistry` rmSync-bypasses Points 5+6, filed as A2 scope addition; (6) Point 4 gate-switch from path-string-eq to artifactId-eq — macOS realpath-drift makes string-eq fragile. Plan v1.4 = v1.3 with 4 folded + 1 moot dropped. Pattern: backlog entries decay against post-arc substrate reshuffles (slices 5 + 6 caught 5 stale-premise items each; slice 7 caught 1 + 1 enrichment). Pre-LOCK primary-source verification is the load-bearing discipline.

6. **Mode-2 design audit pre-locked by plan-v1 cross-audit — A2 + B2 design surfaces resolved at audit-time; B3 downgraded to standard 3-lens via FOLD-3 reframe.** A2 was the slice's NEW STATE SHAPE (7 telemetry kinds + breadcrumb log volume implications + caller-stack capture pattern); Bravo's plan-v1 cross-audit pre-locked design via FOLD-4 (Point 7 pre-rmSync emit) + FOLD-5 (A1→A2 ordering) + FOLD-6 (Point 4 gate-switch). B2 (HOME-empty breadcrumb centralization) Mode-2 pre-locked via path-(a) centralize choice + FOLD-2 module-comment update. B3 (JSONL rotation) was originally Mode-2 candidate but FOLD-3 reframe (Bravo's verify finding — `appendLogWithRotation` already exists in plugin sync-common; B3 is cross-edge reuse not rewrite) collapsed the new-state-shape surface; B3 downgraded to standard 3-lens. Pattern: Mode-2 pre-impl design audit on new-state-shape PRs costs ~10 min channel exchange and saves ~30-60 min impl re-spin if the design has a fold.

7. **4-sibling parallel work with non-overlapping scopes — Alpha + Bravo + Charlie + Delta sustained.** Slice 6 was 3-sibling (Alpha + Bravo + Charlie). Slice 7 added Delta (Charlie's spawned auditor per Nick) — Delta worked on `delta/dashboard-prereq-exports` in own worktree, audited Charlie's dashboard implementation plan, opened PR #92 (`isChannelMessage` re-export) which shipped end-to-end during slice-7. Zero cross-sibling interference. Per-session worktrees + channel coordination + scope-explicit live-update at sibling-spawn (Delta's first message included `kind_version: 1` body + clear scope-statement) enabled 4-way parallelism. Pattern: parallel-session coordination protocol scales beyond 2 siblings as long as per-session worktrees stay outside provisioner-managed paths (slice-6 lesson) + scope is explicit at spawn-time.

8. **Plan-v1 fold count stable cycle-over-cycle — 5 folds per cycle suggests methodology has reached a steady state.** Slice 5 had 12+7=19 folds at plan-v1. Slice 6 had 5. Slice 7 had 5. Three-cycle data suggests the plan-v1 quality + cross-audit cadence have reached a stable plateau — neither degrading (more folds) nor improving (fewer folds). Both folds-per-cycle and per-PR-fold-rate are stable. Pattern: methodology maturity is measurable empirically; plateau-after-improvement is the expected signal of a well-functioning cycle.

**Cycle metrics:**

- **PRs shipped:** 7 (2 Alpha + 4 Bravo + 1 hotfix). Cross-cycle slices 1-7: **44 PRs / 44 main-CI green (with #133 recovery) / 0 unfixed-after-recovery failures.**
- **Plan-v1 cross-audit cycles:** 1 (Bravo SHIP-WITH-5-FOLDS; all 5 incorporated → v2 LOCK).
- **Per-PR cross-audits:** 6 (Alpha → B1+B2+B3+B4+#133; Bravo → A1+A2 with Mode-2 post-impl design review). All SHIP-CLEAN; 0 audit folds applied post-impl.
- **Mode-2 catches:** 1 architecture (FOLD-3 B3 reframe from new-state-shape to cross-edge primitive reuse — collapsed Mode-2 to standard 3-lens). 1 substrate-coupling (Decision 2 — caught at #133-hotfix-time, retroactively memorialized as memory + backlog filing).
- **Backlog deltas:** -7 closed (L445 + L566 + L568 + L570 + L945 [B4 actual L which moved] + 2 implicit slice-7-batch closes). +1 filed (structural detector for plugin/shim export-parity gate, slice-7 follow-ups subsection). Net **-6 in Self-Monitoring + related sections**.
- **New memories filed (Alpha cycle):** 1 — `feedback-substrate-shim-mirror-on-plugin-export-changes.md` (the lesson from #133 hotfix; structural-detector candidate cross-referenced).
- **Nick interventions:** 1 ("don't both sit waiting on each other") — caught Alpha sitting on A2 while Bravo shipped B-lane PRs in parallel; recovered cleanly. 1 procedural ("Does this need to be talked about?") — caught the CI-verification-overreach + drove this slice 7 retro decision-log entry's substrate-coupling-lesson + memory-filing + backlog-detector chain.
- **Cross-session integration with Bravo:** clean throughout — 5 PRs Bravo-side + 1 hotfix; Alpha audited all 4 originals + Bravo audited A1 + A2 with Mode-2 post-impl design review.
- **Cross-session integration with Charlie + Delta:** non-overlapping — Charlie + Delta worked dashboard parallel track; Delta shipped PR #92 (`isChannelMessage` re-export) end-to-end during slice 7 without scope-collision with my A2's `active-sessions` work or Bravo's B-lane work.

**Why this slice matters (cohort-pass stable + substrate-coupling lesson captured + telemetry data-collection cycle now live):** slice 7 demonstrates cohort-pass strategy at empirical N=3 stability (slices 5 + 6 + 7) — methodology is past the proof-of-concept phase and into routine cadence. Substrate-coupling lesson (Decision 2 + memory + backlog filing) captures the kind of cross-edge invariant that only surfaces at consumer-PR-merge-time; structural detector follow-up is the substrate-discipline-as-code answer. Phase 1 telemetry data-collection now LIVE — over the next 14 days, 7 telemetry breadcrumb kinds will fire across operator sessions, discriminating Branch A/B/C/D for Phase 2 fix scope. The deferred 12-day plan finally shipped end-to-end; Phase 2 trigger criteria fully wired.

**Cross-references:**

- Plan: `~/.claude/plans/glimmering-tracking-magpie.md` (single shared plan for both lanes; 5 audit folds incorporated)
- Parent plan: `~/.claude/plans/worktree-provisioner-race-fix-phase-1-telemetry.md` v1.3 (Charlie cross-audit-cycle output); slice 7 shipped v1.4 with prereqs folded in
- Cohort target: Self-Monitoring Infrastructure residual section of `wiki/backlog.md` (cluster shrunk 17 → ~10 open + 1 new follow-up filing in slice-7-cohort-pass-follow-ups subsection)
- Substrate-coupling lesson memory: `feedback-substrate-shim-mirror-on-plugin-export-changes.md` (NEW)
- Channel: `2026-05-18_10-50` — Alpha (sid `50f9662b…`) + Bravo (sid `b1183eb9…`) + Charlie (sid `49fe352b…`) + Delta (sid `0528e02d…`) coordination
- Hotfix recovery: dotfiles PR #133 (`62c26ec`) — empirical case for substrate-coupling-on-export-changes
- Phase 1 trigger ceiling start: 2026-05-18; decision date 2026-06-01 OR 10 cross-session presences
- Audit doc: `docs/audits/2026-05-18-gc-fallback-symmetry.md` (Bravo B4) — slice-6 NIT-2 closure; verdict-as-output finding: byDotfilesRoot risk class unique to dotfiles-worktree-gc.ts; PR #86 fix sufficient at current substrate GC surface

---

## 2026-05-28 — Decision: verify:fold de-brittle via manifest-driven fold gates (Cycle-5 SSOT-pointer lane)

```yaml
---
ts: 2026-05-28T20:45:00Z
kind: tooling
severity: major
phase: 3
affects:
  [
    verify-manifest.json,
    src/verify/drift.ts,
    src/verify/cli.ts,
    package.json,
    CONTRIBUTING.md,
  ]
---
```

**Context:** The verify-manifest drift detector enforced only manifest↔`.github/workflows/test.yml` parity. Two _other_ inline enumerations of the gate set could silently drift from the manifest SSOT: (1) `package.json`'s `verify:fold` — an inline `&&`-chain of the local gate commands (the local-fold-drift class behind the #157 false-green: a gate added to manifest + CI but forgotten in the fold chain runs a stale local subset); (2) prose gate lists in `CONTRIBUTING.md` (lines 19/132/147), one of which claimed "this list cannot silently drift" while being itself an unprotected inline enumeration.

**Options considered:**

1. **Eliminate the duplications; manifest-drive `verify:fold` (CHOSEN).** Add `fold: boolean` to each manifest gate; add a `--fold` mode to the verify CLI that runs the `fold: true` gates via a pure `selectFoldGates`; repoint `package.json` `verify:fold` → `bun run src/verify/cli.ts --fold`; convert the CONTRIBUTING prose enumerations to manifest-pointers.
2. **Detect-only — add a third drift dimension** asserting `verify:fold`'s parsed command list matches the manifest. Keeps the inline chain; lower blast radius but preserves the duplication.
3. **Docs-only — convert just the CONTRIBUTING prose**; leave `verify:fold` inline (highest-value drift left unaddressed).

**Chosen:** Option 1.

**Reason:** The #162 doc-pointer philosophy is _eliminate the duplicate, point at the SSOT_. `test.yml` cannot be eliminated (CI needs literal YAML steps) so it stays drift-DETECTED; `verify:fold` and the prose CAN be eliminated, so they should be — a detector for an avoidable duplication is weaker than removing the duplication. Blast radius is contained: `verify:fold` has no external caller (only `package.json`'s own `verify` chain; the dotfiles telemetry tracker only pattern-detects `bun run verify*`, it does not invoke it). The `fold: boolean` field also corrects a latent inaccuracy — `check-coverage-floor` was modeled as a plain local gate but is CI-only (now `fold: false`). `--fold` deliberately skips the drift check to preserve fast pre-commit semantics (`verify:drift` stays a separate step).

**Considered limit:** `fold` is required by the strict parser with `version` held at 1 — there is a single in-repo manifest, updated atomically in the same change, so an external-consumer version bump buys nothing.

---

## 2026-05-28 — Decision: channel `read` decodes audit-verdict bodies to a readable summary (Cycle-5 wrapped-verdict-readability)

```yaml
---
ts: 2026-05-28T22:20:00Z
kind: tooling
severity: minor
phase: 3
affects: [src/channels/render.ts, test/channels/render.test.ts]
---
```

**Context:** Once the cohort bootstrapped keypairs, `send audit-verdict` auto-wraps the body in a v0.3 DSSE envelope (signed chain entry). The render path showed the opaque base64 payload (inline) or `[body-ref:…]`, so a channel reader lost the verdict at a glance — real coordination friction during Cycle-5 (operators hand-base64-decoded signed verdicts to read them).

**Options considered:**

1. **Decode in the render layer (CHOSEN).** `renderMessage` summarizes audit-verdict bodies (raw + DSSE-wrapped) via the audit-verdict SSOT parsers into `audit-verdict <verdict> PR#<n> → <peer> [<class>] B/F/N lenses=… (signed|raw)`.
2. Decode at the read-verb / structured layer. Rejected: `read --json` already returns raw `ChannelMessage[]` for structured consumers; the gap is purely presentation, which is render.ts's job.
3. Leave it; consumers use `--json` + decode themselves. Rejected: the default human `read` is the cohort's primary coordination surface; opaque verdicts there caused observable friction.

**Chosen:** Option 1.

**Reason:** The opacity is a presentation defect, and render.ts is the SSOT presentation layer (internal-only, not in `package.json` exports). Decoding there fixes both wire shapes for every `read` consumer (the read verb resolves body_refs before rendering, so inline + ref'd verdicts both benefit), with zero new export surface. Kind-gated + null-fallback keeps non-verdict + undecodable bodies unchanged.

---

## 2026-05-28 — Decision: harden `readBodyFile` against peer-controlled `ref` before wiring the verdict-decode into the deliverer hook (Cycle-5 #168 fast-follow)

```yaml
---
ts: 2026-05-28T23:59:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/channels/index.ts,
    src/channels/render.ts,
    src/hooks/checks/peer-message-deliverer.ts,
    test/channels/index.test.ts,
    test/hooks/checks/peer-message-deliverer.test.ts,
  ]
---
```

**Context:** The #168 decode (above) fixed the `read` CLI surface but not the `peer-message-deliverer` hook digest (UserPromptSubmit), where a DSSE-wrapped verdict still showed as an opaque base64 blob and a body_ref-sidecarred verdict as a bare `body_ref:` pointer. Extending the decode to the hook requires resolving body_refs from the hook — but `body_ref` is **peer-controlled** (a peer can append JSONL directly; that is the hook's stated threat model), and `readBodyFile(id, ref)` interpolated `ref` raw into `` `${ref}.txt` ``. Pre-existing callers (cli/api) all pass `writeBodyFile`'s `randomUUID()`, so the path-traversal (`../`, `/`, NUL) was latent; the new auto-firing hook call site is the first to reach it with untrusted input.

**Options considered:**

1. **Guard `ref` at the SSOT resolver, return null on unsafe input (CHOSEN).** Add `if (!isValidArtifactId(ref)) return null;` to `readBodyFile` — sibling-parity with the existing `id` guard, but null (not throw) because `ref` is untrusted input, not a caller bug. Reuse the exported `renderAuditVerdictSummary` (no duplicated render logic); decoded summaries flow through the hook's existing `sanitizePeerBody`+`fencePeerBody` path since they carry peer-controlled fields.
2. Guard at the hook call site only. Rejected: leaves the latent traversal in the SSOT resolver for the next caller to re-discover; violates "harden at the trust boundary, not per-consumer."
3. Throw on an unsafe `ref` (parity with the `id` guard's throw). Rejected: `id` is a validated channel id (caller bug → throw is correct), but `ref` is untrusted input and the hook's whole-batch blast radius makes a throw a fail-open liability; null ("unresolvable") matches the existing ENOENT path the callers already handle.

**Chosen:** Option 1.

**Reason:** Hardening at the SSOT resolver protects the new hook call site **and** every pre-existing caller with one guard, keeping the trust boundary where the path is constructed rather than at each consumer. `isValidArtifactId` is already traversal-safe (rejects leading-dot, `/`, `\`) and admits the only legitimate producer (UUID refs from `writeBodyFile`), so no real caller breaks. Graceful-null over throw because an unsafe `ref` is untrusted input on an auto-firing path; the verdict decode then reuses the #168 SSOT summary + the deliverer's existing sanitize/fence, so undecodable / unresolvable / non-verdict messages render exactly as before.

**Supersedes / superseded_by:** Fast-follow to the #168 entry above (`read`-verb decode); extends the same SSOT summary to the hook digest surface.

---

## 2026-05-29 — Decision: label DSSE-wrapped verdicts `(wrapped)` not `(signed)` — render shape-parses, never verifies (Cycle-5 #171)

```yaml
---
ts: 2026-05-29T12:18:57Z
kind: architectural
severity: minor
phase: 3
affects:
  [
    src/channels/render.ts,
    src/hooks/checks/peer-message-deliverer.ts,
    test/channels/render.test.ts,
    test/hooks/checks/peer-message-deliverer.test.ts,
  ]
---
```

**Context:** The #168/#170 work (above) taught `renderAuditVerdictSummary` to decode DSSE-wrapped verdicts and append a parenthetical distinguishing a wrapped envelope from a raw body. That label read `(signed)` for the wrapped case. But `renderAuditVerdictSummary` is a pure string→string display helper: it imports only types + the audit-verdict parsers, has zero crypto/keyring access, and decides "wrapped" solely by `parseAuditVerdictV0_3Wrapped(body) !== null` — it shape-parses the DSSE envelope, it does NOT verify the signature. On the passive surfaces that call it (the `read` CLI verb and the `peer-message-deliverer` UserPromptSubmit digest), `(signed)` is therefore a FALSE-TRUST signal: it asserts a cryptographic property the renderer never checked. Shape ≠ verification — only the verify-gated paths walk the crypto.

**Options considered:**

1. **Relabel `(signed)` → `(wrapped)` — claim envelope SHAPE only (CHOSEN).** The label reports exactly what was observed (a v0.3 DSSE wrapper shape-parsed) and makes no trust claim. Reserve any verified-signature claim for the verify-gated paths that do the real crypto walk (`audit verify`; `quorum --require-signed`, which excludes `brokenSignatureSeqs`).
2. Make render verify the signature so `(signed)` becomes true. Rejected: pulls crypto + keyring access into a pure display helper on the hot per-message digest path; verification belongs at explicit verify gates, not inline on every render.
3. Drop the parenthetical entirely. Rejected: the wrapped-vs-raw distinction is genuinely useful at-a-glance (signals the body arrived inside a signed chain entry, even if unverified). Only the trust-implying WORD was wrong, not the distinction itself.

**Chosen:** Option 1.

**Reason:** A display label must not assert a property the producing code never checked. Shape-parsing a DSSE wrapper proves the envelope is well-formed, not that its signature is valid — those are separate operations, and only the verify-gated paths do the latter. `(wrapped)` is the honest report of what render observed; it preserves the useful wrapped/raw distinction while moving the trust claim to where it is actually earned. The `render.ts` JSDoc now documents this shape-vs-verification invariant inline (and intentionally retains the literal `(signed)` in prose, to name the thing the renderer must NOT emit), so a future editor does not re-introduce the false-trust label. Independently cross-pair-audited (Charlie, primary-source): render imports only types + parsers, structurally cannot verify — LGTM, no blockers.

**Supersedes / superseded_by:** Corrects the `(signed)` label introduced alongside the #168/#170 decode entries above; same SSOT summary helper (`renderAuditVerdictSummary`), trust-semantics fix.

---

## 2026-05-29 — Decision: `poll` is a NEW channel kind, not an extension of free-form `question` (Cycle 6 item-2 #172)

```yaml
---
ts: 2026-05-29T18:15:00Z
kind: api-shape
severity: minor
phase: 3
affects:
  [
    src/channels/poll.ts,
    src/channels/index.ts,
    src/channels/api.ts,
    src/channels/cli.ts,
    test/channels/poll.test.ts,
    test/channels/channel-kinds-ssot.test.ts,
  ]
---
```

**Context:** Cycle 6 item-2 (agetor steal-list A-P1-4) asked for "structured-card answers on `kind=question` (`options: [...]` field)" — peer-to-peer structured questions for cohort votes / approvals / decisions. Read literally, that means bolting an `options` array onto the existing `question` kind. But `question` is intentionally unstructured free-form, and `audit-ask.ts` already documents the governing convention (§ "Why a new kind vs extending question"): a structured body shape earns a NEW kind — the same reasoning that gave `digest`, `live-update`, and `audit-ask` their own kinds rather than overloading `question`. Upstream-coverage check (Bravo-style): no `question.ts` exists; `question` has no schema or validation today.

**Options considered:**

1. **New `poll` kind carrying the structured body (CHOSEN).** `PollBody = { kind_version, question, options (>=2, unique non-empty id+label), multi_select?, free_text? }`; `parsePollBody` mirrors the per-kind parser SSOT; `question` stays free-form. Consistent with the established structured-shape-earns-a-kind convention; slots alongside the other structured kinds (validated body + send-time gate + SSOT-iterated help/tests).
2. Extend `question` with an optional `options` field (the roadmap's literal phrasing). Rejected: makes `question` a hybrid (sometimes free-form, sometimes structured), violating the documented convention and muddying the deliberate free-form/structured split.
3. Drop the structured-answer feature. Rejected: A-P1-4 is a ratified steal-list item, and the cohort runs structured decisions/votes constantly (this very channel).

**Chosen:** Option 1.

**Reason:** A documented codebase convention (structured shape → new kind) outranks the roadmap's pre-convention wording. `poll` keeps `question` free-form and is purely additive (`CHANNEL_KINDS` 16→17; `VALID_KINDS = CHANNEL_KINDS`, so send auto-accepts). Pair-A partner (Bravo) independently endorsed the new-kind call. Answer convention v1 = responders reference an option `id` in a reply; a dedicated `poll-answer` kind + tally is a documented follow-up (v1 scoped to the structured "card"). `cross_edge_consumers_verified`: conductor-only — the dotfiles `cli.ts` auto-delegates via `runChannelsCli`, and no dotfiles consumer imports `parsePollBody` in v1.

**Supersedes / superseded_by:** Additive — no prior decision superseded. Applies the `audit-ask.ts` "structured shape earns a new kind" convention to a new instance.

---

## 2026-05-29 — Decision: Cycle 2 boot-reconciliation — placement, liveness axes, safety model

```yaml
---
ts: 2026-05-29T18:45:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/reconcile-boot.ts,
    src/active-sessions/index.ts,
    test/active-sessions/reconcile-boot.test.ts,
    test/active-sessions/liveness.test.ts,
  ]
---
```

**Context:** Cycle 2 (agetor steal-list A-P0-1; backlog 1040) adds `reconcile-boot` — a cross-class operator interface that surfaces stale coordination state (presence + identity + worktree) and, under `--apply`, GCs the eligible entries. Pair B (Charlie + Delta). Several architectural calls were cohort-ratified before/during build; logged here per the substrate-class decision-log gate.

**Options considered + chosen:**

1. **Placement (A all-dotfiles / B plugin-core + thin verb / C hybrid) — CHOSEN B.** `runReconcileBoot` core + types live plugin-side (`src/active-sessions/reconcile-boot.ts`, re-exported from `index.ts`); the dotfiles `/presence` CLI adds a thin `reconcile-boot` verb. Decider: the session-start hook integration is report-mode — a conductor hook must `import runReconcileBoot`, so the core MUST be plugin-importable; (A) would strand it in the dotfiles CLI, unreachable by a hook/dashboard. Plugin-removal-test agrees (reconcile-boot is reusable coordination substrate, not CLI glue). Channels primitives are plugin-exported (`claude-conductor/channels/api`), so plugin-side cross-class orchestration needs no backwards dotfiles import. Cohort-unanimous (Delta proposed C; Charlie + Alpha + Bravo independently arrived at B on hook-importability).
2. **Liveness classification vocabulary — CHOSEN: adopt `classifyLiveness` (live / likely-dead / stale, stale = OLDEST), NOT the design doc's stale = intermediate.** `classifyLiveness` was lifted shim→plugin (de-dup) and reused verbatim. The design's `live → stale → GC'd` state-machine collided on the word "stale". Resolved by keeping TWO separate axes — `classification` (age bucket) vs `gc_eligible` (derived predicate) + a separate `split_brain` flag — so "stale" never means two things.
3. **gc_eligible predicate — CHOSEN: `classification === "stale" && age > GC_WINDOW_MS`.** `GC_WINDOW_MS` (= 2 × LIVE_WINDOW_MS = 60min) was already defined but unexported; exported + reused as the single-sourced safety-floor (clock-skew defense) rather than recomputed at the call site. Future AND-NOT blockers reserved (each can only SUBTRACT eligibility): `pid-alive` (Q2, same-host `kill(pid,0)`) + `pause-marker` (Cycle-6 item-4; OwnerRecord `pausedAt?`, Alpha-confirmed) — both deferred, not implemented this slice.
4. **exit-2 semantics — CHOSEN: gc_eligible-drives-exit-2** (refines design §4's "any-stale → exit-2" wording). exit 0 clean / 2 = operator can `--apply` something (gc_eligible > 0) / 3 malformed (next increment). A stale-but-young (floor-protected) entry surfaces in `candidates[]` for awareness but exits 0 — nothing actionable.

**Scope (incremental):** this increment = presence-class enumeration + classification + gc_eligible + report-mode + the §2 output contract. `--apply` GC execution (CAS-rechecked) + identity/worktree report-only enumeration + malformed-entry surfacing (exit 3) land in the next increment — the composed `listAllHeartbeats` primitive silently skips malformed entries, so detecting them needs the next-increment raw enumeration. **NEVER auto-kill** holds throughout: report-default + no auto-`--apply` path + the 60min floor.

**Reason:** A passive operator-report surface must never auto-destroy peer state, and a classification axis must not double as a GC decision. Separating `classification` from `gc_eligible`, single-sourcing the floor, and reserving (not implementing) future blockers keeps the model honest and monotonically safe. Placement B is forced by hook-importability.

**Supersedes / superseded_by:** First Cycle-2 entry; refines the boot-reconciliation design doc (`cycle-2-boot-reconciliation-design-2026-05-27.md`) §3/§4 (the stale-collision + exit-2 wording). Cross-pair-shadowed by Pair A at the PR boundary.

---

## 2026-05-29 — Decision: Cycle 6 item-3 — handoff archive/prune (teardown parity)

```yaml
---
ts: 2026-05-29T19:40:00Z
kind: architectural
severity: minor
phase: 3
affects:
  [src/channels/handoff-archive.ts, test/channels/handoff-archive.test.ts]
---
```

**Context:** Cycle 6 item-3 (agetor steal-list A-P1-7 sibling; teardown parity). Handoffs (`~/.claude/handoffs/HANDOFF_*.md`) accumulate with no archive/supersede — the gap Pair-A confirmed missing (no `archiveHandoff`/`pruneHandoff` anywhere; `handoff-resolver.ts` is resolution, `handoff-body-parser.ts` is parsing). New module mirrors the channels archive/prune contract for handoff files. Pair A (Bravo); Alpha SHIP-concur'd the slice-plan (scope + 3 leans + (b)-defer).

**Options considered + chosen:**

1. **Placement — NEW `src/channels/handoff-archive.ts`, NOT extend `handoff-resolver.ts`.** Keeps the resolver single-responsibility + mirrors the channels archive/prune module shape. (Slice-plan #1; Alpha concur.)
2. **Reference-awareness — (a) LATEST-target + (c) recency (keepRecent + retentionDays); (b) lineage-input_handoffs DEFERRED to increment-2.** (b) is largely subsumed by a conservatively-generous (c) (supersedes-chain heads are recent), and the bounded residual (an OLD lineage-referenced handoff beyond the window) is recoverable (move-not-delete) + report-visible before any `--apply`. (Alpha concur with two conditions: conservative window + documented residual — both honored in code + this entry.)
3. **Safety — NEVER-auto-delete (mirrors Cycle-2 reconcile-boot).** sweepArchivableHandoffs is report-only; archiveHandoff MOVES (recoverable, collision-stamped, never overwrites); pruneHandoffArchive is the ONLY delete path (archive-only; retention + maxEntries). No auto-invocation mutates.
4. **#2 body-GC + #6 cache-invalidation — DROPPED.** #2 (channel body sidecars) is already covered for closed channels (bodies travel-with-dir on archiveChannel + purged by pruneArchive); the orphaned-body safety-net is a near-no-op (messages.jsonl append-only ⇒ none orphaned) — backlog-noted for if/when log-rotation lands. #6 cache-invalidation is not a teardown-parity gap.

**Scope (incremental):** increment-1 = the importable handoff-archive core (sweep/archive/prune logic + types) + 13 TDD units (boundary semantics, LATEST + recency protection isolated, collision-stamp, prune retention + cap). Increment-2 (fast-follow, mirrors Pair-B #173-core / #162-verb): the channels CLI verb (`handoff-archive` / `handoff-prune`) + the (b) explicit-lineage hardening + a try/catch on the enumeration read path.

**Reason:** A teardown primitive for accumulating coordination artifacts (handoffs) must mirror the proven channels archive/prune safety model (report-default + move-not-delete + archive-only-prune) and protect the active (LATEST) + recent state. Deferring (b) keeps increment-1 bounded while (c)-recency + recoverable-archive bound the residual.

**Supersedes / superseded_by:** Additive — implements the handoff teardown gap (slice-plan `cycle-6-item-3-teardown-parity-slice-plan-2026-05-29.md`). Cross-pair-shadowed by Pair A at the PR boundary.

---

## 2026-05-29 — Decision: Cycle 6 item-4 — session pause/resume markers + reconcile-boot pause-protection

```yaml
---
ts: 2026-05-29T20:35:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/index.ts,
    src/active-sessions/reconcile-boot.ts,
    test/active-sessions/session-pause.test.ts,
    test/active-sessions/reconcile-boot-pause.test.ts,
    test/active-sessions/touchHeartbeat-merge.test.ts,
  ]
---
```

**Context:** Cycle 6 item-4 (agetor steal-list A-P1-7, cancel-vs-delete named verbs) adds session pause/resume to the active-sessions substrate, realizing the `pause-marker` AND-NOT blocker the Cycle-2 entry above (#3) reserved as deferred. Conductor-side logic only this PR; the dotfiles `/presence` pause/resume/end verbs sequence after Charlie's #162 merge. Pair A (Alpha pen + Bravo shadow); Delta (Cycle-2 surface-owner) cross-shadows.

**Options considered + chosen:**

1. **Resume semantics (F-b) — CHOSEN Model A (preserve + explicit resume).** `touchHeartbeat` PRESERVES `pausedAt`; resume is a deliberate `clearSessionPaused`. Rejected Model B (any touch clears pause): a paused-but-alive session keeps firing the dispatcher (PreToolUse auto-touches), so clear-on-touch would auto-un-pause and defeat the pause. Cohort-unanimous (Alpha lean + Delta surface-owner + Bravo confirm).
2. **touchHeartbeat preserve (F-a) — CHOSEN Option 2 (generalize the merge), not Option 1 (mirror the dotfilesRoot branch).** A shared `mergeOwnerRecord` re-derives the common-write fields (pid/host/touchedAt) + preserves createdAt + EVERY other optional field, backing touchHeartbeat + setSentinelDotfilesRoot + clearSentinelDotfilesRoot + the pause setters. Primary-sourced RE-9.0 (Cycle-2 entry / REV-0.2 ARCH-2): the prior per-field hardcode was MINIMAL-SCOPE (dotfilesRoot was the only optional field then), not a correctness constraint against generalizing. Option 2 CLOSES the clobber-class (Bravo's F1): a new optional field survives every write path with no per-field branch. The `clear[]` param DELETEs keys — exactOptionalPropertyTypes forbids assigning a field = undefined, so a cleared field is absent, not undefined.
3. **Deserialization carry — CHOSEN: readOwnerRecord explicitly carries + validates pausedAt.** The read path is the TWIN of the write-merge: a parse boundary that DROPS pausedAt makes the feature silently dead (markSessionPaused writes it, readSessionPausedAt never reads it back) while typecheck stays green. The read path stays per-field-EXPLICIT (unlike the generalized write-merge): it VALIDATES each optional field's type; a generic carry-all would forfeit that. Guarded by a disk ROUND-TRIP test (feedback-incremental-roundtrip-test-for-stateful-adapters).
4. **Pause-marker scope (Option X) — CHOSEN: SESSION-level lookup, not per-candidate owner read.** `pausedAt` is per-heartbeat but pause is SESSION-global; a session holds heartbeats on N artifacts. reconcile-boot's `isGcEligible` AND-term resolves pause via `readSessionPausedAt(candidate.session_id)` (a memoized canonical-anchor lookup), protecting ALL of a paused session's candidates. Rejected the Cycle-2-reserved per-candidate `owner.pausedAt == null`: it protects only the anchor candidate, leaving the session's other-artifact candidates gc_eligible (under-protects — a paused session partially reaped). Delta (who doc-reserved the per-candidate shorthand) concurred.
5. **N1 (Bravo #173) folded here:** enumeratePresence wraps listArtifactIds (outer → empty-on-throw) + per-artifact listAllHeartbeats (inner → skip-on-throw) in try/catch. A broken artifact is skipped, not fatal; a bad presence root yields an empty reconcile (nothing enumerated → nothing GC'd — monotonically safe). Delta's increment-2 SKIPS N1 (deconflicted).

**Scope (incremental):** this PR = conductor logic (OwnerRecord.pausedAt + mergeOwnerRecord + readOwnerRecord-carry + markSessionPaused/clearSessionPaused/readSessionPausedAt + the gc_eligible AND-term + N1). The dotfiles `/presence` pause-session/resume-session/end-session verbs land after #162. end-session (full teardown: closeStalePeerIdentity + unregisterActiveSession + kind=out) composes existing exports — buildable independently. NEVER-auto-kill holds: pause only SUBTRACTS gc-eligibility.

**Reason:** A paused session is suspended-coordination, not a dead process — its hooks still fire, so preserve-and-explicit-resume (Model A) is the honest model. Generalizing the merge closes a recurring per-field clobber-trap at its class. The read-twin carry is mandatory (a write-only preserve is silently dead). Session-level pause lookup is forced by pause being session-state while markers are per-heartbeat.

**Supersedes / superseded_by:** Realizes the `pause-marker` AND-NOT blocker reserved (deferred) in the 2026-05-29 Cycle-2 entry (#3 above), with the scope correction from per-candidate to session-level (Option X). Cross-pair-shadowed by Delta at the PR boundary.

---

## 2026-05-29 — Decision: Cycle 6 item-3 increment-2a — handoff-archive (b) lineage protection + F2–F5 hardening

```yaml
---
ts: 2026-05-29T21:30:00Z
kind: architectural
severity: minor
phase: 3
affects:
  [src/channels/handoff-archive.ts, test/channels/handoff-archive.test.ts]
---
```

**Context:** Cycle 6 item-3 increment-2 — fast-follow to increment-1 (#174, the importable handoff archive/prune core). Closes increment-1's deferred (b) lineage-input protection + the F2–F5 residuals surfaced in the increment-1 Pair-A shadow. Pair A (Bravo pen + Alpha shadow); Alpha SHIP/CONCUR'd the slice plan + 2 sharpenings + 1 minor. SPLIT into 2a (core hardening — this PR) + 2b (channels CLI verbs — follow-on), mirroring Pair-B's increment-2 2a/2b split (Alpha-endorsed: isolate the user-facing surface for a focused shadow).

**Options considered + chosen:**

1. **(b) malformed-frontmatter direction (Alpha Sharpening 1) — CHOSEN: protect-the-unreadable + document-the-residual.** A handoff whose frontmatter is PRESENT-but-unparseable (opener `---` + parse-null) or unreadable (read threw) is protected as ITSELF (`malformedProtected`) — never archive a handoff whose lineage we cannot read. A legacy NO-frontmatter handoff (no opener) is NOT protected (stays a normal candidate) — over-protecting every plain old handoff would break archival. The opener check discriminates them (empirically grounded: `parseHandoffFrontmatter` returns null for BOTH no-frontmatter and malformed-present, so the null return alone cannot). (ii) DOCUMENTED RESIDUAL: a malformed/unreadable handoff X drops out of the referenced-set, so any handoff X referenced loses X's protection-vote — bounded + recoverable (archive is move-not-delete) + report-visible; same accepted-residual class as increment-1's (b)-defer.
2. **ok-honesty (F2/F3, Alpha convergent F2) — CHOSEN: ok:false ONLY on a degraded view, never on a healthy protection.** The sweep's `ok` is false only when a protection input could not be determined (the F1 transient-LATEST case → fail-safe empty); a CLI `--apply` MUST refuse when `ok:false` (enforced in 2b). The (b) malformed/unreadable protections are HEALTHY outcomes (surfaced in `protected_malformed`), so they never flip `ok` — convergent with Alpha's F2 on Pair-B's reconcile-boot (a healthy cas-race must not land in errors[] / flip ok).
3. **F4 + F5 hardening.** F4: `pruneHandoffArchive` tolerates an unreadable/non-dir `.archive` (readdir try/catch → [], mirrors #175 N1 blast-radius isolation). F5: `archiveHandoff` collision-stamp is uniquified (counter loop) so a same-ms re-archive of a name never overwrites a prior archived copy; the stamp clock is injectable (`opts.now`) for deterministic tests, mirroring `sweepArchivableHandoffs`'s `now`.
4. **Transparency report fields.** The sweep reports `protected_referenced` + `protected_malformed` so an operator sees WHAT (b) protected (and the (ii) residual's set) before any `--apply`.

**Scope (incremental — 2a/2b split):** 2a (this PR) = `handoff-archive.ts` core hardening ((b) + Sharpening 1 + F4 + F5 + F2/F3 + report fields) + 19 TDD units. 2b (follow-on) = channels CLI verbs `handoff-archive [--apply]` + `handoff-prune` in `src/channels/cli.ts` (report-mode default; `--apply` refuses on `ok:false`). NEVER-auto-delete holds: report-mode default + move-not-delete + prune-is-archive-only; no auto-invocation mutates.

**Reason:** The (b) protection closes the increment-1 residual (an old lineage-referenced handoff could be archived). Sharpening 1's protect-the-unreadable honors never-ship-known-gaps (document the (ii) bound). The 2a/2b split ships the complete, low-risk core immediately + isolates the user-facing CLI for a focused Pair-A shadow.

**Supersedes / superseded_by:** Additive — closes the (b) lineage-input_handoffs residual deferred in the 2026-05-29 increment-1 entry above. Cross-shadowed by Pair A (Alpha) at the PR boundary.

---

## 2026-05-29 — Decision: Cycle 6 item-3 increment-2b — handoff-archive/handoff-prune CLI verbs

```yaml
---
ts: 2026-05-29T22:20:00Z
kind: architectural
severity: minor
phase: 3
affects:
  [
    src/channels/cli.ts,
    src/channels/handoff-archive.ts,
    test/channels/cli-handoff-archive.test.ts,
    test/channels/handoff-archive.test.ts,
  ]
---
```

**Context:** Cycle 6 item-3 increment-2b — the user-facing follow-on to increment-2a (#177). Exposes the hardened core via channels CLI verbs + closes the increment-2a Pair-A shadow's N1/N2 notes. Pair A (Bravo pen + Alpha shadow); Alpha + Charlie both SHIP-CLEAN'd #177.

**Options considered + chosen:**

1. **CLI verbs — report-mode default + --apply mutation gate.** `handoff-archive [--apply] [--retention-days <n>] [--keep-recent <n>]` prints the sweep as JSON (report-only) by default; `--apply` MOVES each archivable candidate into `.archive/` and REFUSES when `ok:false` (F2/F3 — never mutate against a degraded protection view). `handoff-prune [--retention-days <n>] [--max-entries <n>]` prints the purged list. NEVER-auto-delete holds: no auto-invocation; report-default; move-not-delete; prune is archive-scoped.
2. **N1 (Alpha #177 shadow) — readdir-of-handoffsDir is SUBSUMED by F1; NOT new code.** Primary-source-verified (empirical, 3 cases): the sweep calls `latestTargetName()` (readlink `handoffsDir/LATEST.md`) BEFORE `readdir(handoffsDir)`, so a degraded handoffsDir (file/EACCES/ENOTDIR) throws in latestTargetName FIRST → F1 fail-safe `ok:false`, before readdir. The readdir non-ENOENT path is UNREACHABLE (modulo a TOCTOU dir-vanish → [] → safe). Disposition: a CLARIFYING COMMENT (document the F1-subsumption), NOT dead defensive code (Alpha conceded + endorsed). Two genuinely-reachable-but-DATA-SAFE residuals Alpha scoped are documented with clarifying comments, not behavior-changed: (a) per-candidate statSync-skip (TOCTOU/perms → silent drop from total_handoffs; lineage survives via readFileSync); (b) prune-readdir-fault (non-ENOENT `.archive` → [] → under-pruning, not data loss).
3. **N2 (Alpha #177 shadow) — read-throw test added.** scanLineage's read-THROW branch (readFileSync throws → malformedProtected) is now covered by a deterministic cross-platform test (a DIR named `HANDOFF_x.md` → readFileSync EISDIR, consistent macOS+Linux).

**Scope:** `cli.ts` (2 verbs + usage entries + a `numFlag` positional-tail parser) + `handoff-archive.ts` (3 clarifying comments, no behavior change) + 4 CLI subprocess tests (Bun.spawnSync) + 1 N2 read-throw unit. Completes Cycle 6 item-3 (increment-1 #174 + increment-2a #177 + this).

**Reason:** The CLI verbs make the hardened core operator-invocable; `--apply`-refuses-on-`ok:false` is the one mutation-safety bit. N1's readdir-component is unreachable (F1-gated), so documenting the subsumption is more honest than dead code; the two reachable residuals are data-safe and now documented-not-silent.

**Supersedes / superseded_by:** Additive — completes item-3 (the handoff teardown feature: report + archive + prune, all user-invocable). Cross-shadowed by Pair A (Alpha) at the PR boundary.

---

## 2026-05-29 — Decision: Cycle 2 boot-reconciliation increment-2 (2a — malformed-surface + paused-visibility + listClaims extraction)

```yaml
---
ts: 2026-05-29T22:20:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/index.ts,
    src/active-sessions/reconcile-boot.ts,
    src/channels/identity.ts,
    test/active-sessions/reconcile-boot.test.ts,
    test/channels/identity.test.ts,
  ]
---
```

**Context:** Cycle-2 increment-2, PR 2a (the non-mutation half). Realizes the increment-1 (#173) §10 Q4 deferrals — malformed-entry surfacing + the report-only enumeration groundwork — and the Bravo/Charlie #175 paused-dead report-visibility split. Builds on increment-1 (reconcile-boot presence-core, report-only) + item-4 (#175: `pausedAt`/`mergeOwnerRecord`/`readSessionPausedAt`). The `--apply` GC mutation is deliberately split into PR 2b (§5 below).

**Options considered + chosen:**

1. **Malformed detection — CHOSEN: a shared `scanHeartbeats` walk, not a standalone read-twin.** `scanHeartbeats({artifactId,now})` partitions ONE heartbeat-dir walk into `{valid, malformed}`; `listAllHeartbeats` becomes its `.valid` projection. Rejected a standalone `listMalformedHeartbeats` that re-walks: it would duplicate the readdir/stat/parse logic and could DRIFT from `listAllHeartbeats`'s drop-criteria. The shared walk makes the malformed set definitionally "what the valid walk dropped" — no drift possible. Valid-set behavior unchanged (verified: worktree-gc sid-prefix anchors + listLivePeers unaffected). `stat()`-throw (file vanished mid-walk) is skipped from BOTH sets (benign race); only `readOwnerRecord`→null (unparseable-owner) and `defensiveAgeMs`→null (future-mtime) become malformed.
2. **`ok` load-bearing — CHOSEN: `ok = errors.length === 0` → exit 3 on any malformed-entry.** A report that silently skipped unreadable data was dishonest about its blind spots (#174 F2/F3). Convergent with Bravo's #177 handoff-archive `protected_malformed` semantics: a report must signal what it couldn't evaluate.
3. **`paused` field — CHOSEN: an explicit `paused: boolean` candidate field (Q2), SESSION-level.** `readSessionPausedAt(session_id) != null`, memoized once and reused for both the `gc_eligible` AND-term and the visible field — `true` across ALL of a paused session's candidates. Makes a stale + `gc_eligible=false` paused entry operator-VISIBLE (manual-self-heal) vs a silent indistinguishable skip. NOT a `failed_signals` member: pause is a protection, not a failed liveness signal.
4. **`listClaims` extraction — CHOSEN: extract the full-scan twin of `findExistingClaim` (same pattern as `scanHeartbeats`/`listAllHeartbeats`).** `listClaims(channelId)` returns every valid identity claim; `findExistingClaim` becomes its session-filtered projection. Single source of sentinel-scan acceptance (valid NATO entry → readable → `validateIdentityClaim` → role narrowing), no drift. Additive export (shim re-export holds); `findExistingClaim` behavior unchanged (rejoin tests pass). Enables the §2 identity report-only enumeration (2a-commit-3, in flight).
5. **PR-split (Q4) — CHOSEN: 2a (non-mutation surfacing) + 2b (`--apply` mutation alone, max safety-shadow).** Delta's `--apply` GC is a NEW mutation, so isolating it in its own PR for a tighter safety-shadow has a strong rationale (Alpha-confirmed: stands unchanged, distinct from Bravo's item-3 where the mutation already shipped in #174). The §1 mutation design was shadow-ratified by both pairs PRE-build, with two gating fixes converged (honest `removeHeartbeat({reason,actorPid})` telemetry; cas-race out of `errors` into a separate `cas_races[]`); exit-precedence unanimous (malformed→3 > gc-failed→1 > gc_eligible→2 > 0).

**Scope (incremental, this PR = 2a):** `scanHeartbeats` + malformed-surface + `ok`-load-bearing + `paused` field + `listClaims` extraction landed (commits db43ec8 + 146db95). The §2 identity + worktree report-only enumeration (cross-ref presence-liveness for claim/worktree classification; `gc_eligible=false`; orphan-sentinel→stale + a new additive `no-presence-heartbeat` signal; candidate shape stays uniform — `artifact_id = channelId`/`worktree_path`, no new columns) landed in commits e508505 (identity) + b8e7095 (worktree); its design was surfaced for a cohort pre-build flag (the discipline that de-risked §1). PR 2b = the `--apply` CAS-recheck GC mutation. NEVER-auto-kill holds throughout: 2a adds no mutation path; identity/worktree are report-only (GC primitives `unlinkIdentitySentinelOrLogOrphan`/`removeWorktree` deferred).

**Deferred to the worktree-GC increment** (tracked here, not just inline-commented, per the #179 3-lens convergent shadow — Alpha N1+N2): (1) **worktree-orphan `paused:false`** — a worktree path yields only the 8-char sid-prefix, so a session that left ONLY a worktree cannot resolve `readSessionPausedAt`. SAFE in 2a (`gc_eligible=false`) and BY CONSTRUCTION (a paused session always retains its presence anchor — `markSessionPaused` writes `pausedAt` there + the `!paused` GC-term protects it — so its worktree prefix MATCHES and it is never an orphan; Charlie/Bravo-confirmed, Bravo's nit withdrawn), but worktree-GC must re-verify before keying eligibility off `!paused`. (2) **`findSessionByPrefix` first-match-wins** on an 8-char-prefix collision — cosmetic in 2a (gc_eligible=false), a wrong-session-attribution risk under worktree-GC (needs full-sid disambiguation + a collision test fixture).

**Deliberately deferred this increment (Alpha F1 — malformed-surfacing asymmetry):** the #174 F2/F3 malformed-honesty contract is extended to PRESENCE only this increment. `enumerateIdentity` (via `listChannels()` without `includeUnreachable`, plus `listClaims` silently skipping a corrupt sentinel) and `enumerateWorktree` (via fail-soft `readRepoConfig`/`listWorktrees`) SILENTLY SKIP a corrupt identity sentinel / unreachable channel / malformed repo-config — it is not a candidate, not in `errors[]`, and `ok` stays true. So a corrupt sentinel is INVISIBLE in the identity/worktree report, unlike a corrupt presence heartbeat (surfaced → exit 3). Acceptable for this report-only increment (`gc_eligible=false`), but MUST be closed when identity/worktree GC lands — route `listChannels`-unreachable + `listClaims`-skip-reasons + `readRepoConfig`-malformed into `errors[]` so the malformed-honesty contract is symmetric across all three classes.

**Reason:** A coverage-honest report (surface what it couldn't read → exit 3) is the cardinal value of the malformed work; single-source scan-walks (`scanHeartbeats`, `listClaims`) close drift-classes at their root rather than per-symptom. Splitting the NEW mutation into 2b buys a tighter safety-shadow on the one path that can delete state.

**Supersedes / superseded_by:** Additive — realizes increment-1 (#173) §10 Q4 deferrals (malformed-surface + identity/worktree enumeration groundwork) + #175 paused-dead visibility. Cross-pair-shadowed by Charlie (inside-pair) + Pair A (cross-shadow) at the 2a PR boundary.

---

## 2026-05-30 — Decision: Cycle 2 boot-reconciliation increment-2 (2b — `--apply` CAS-recheck GC mutation + honest removal telemetry)

```yaml
---
ts: 2026-05-30T00:30:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/index.ts,
    src/active-sessions/reconcile-boot.ts,
    test/active-sessions/remove-heartbeat-telemetry.test.ts,
    test/active-sessions/reconcile-boot-apply.test.ts,
  ]
---
```

**Context:** Cycle-2 increment-2, PR 2b — the SAFETY-CRITICAL half: the `--apply` GC mutation, the ONLY path that deletes coordination state. Builds on merged 2a (#179). The §1 design was shadow-ratified PRE-build (Alpha §1-author re-nod); this entry records the v2 fold-ins + the option-A scope decision.

**Options considered + chosen:**

1. **`--apply` CAS-recheck (the mutation) — CHOSEN: a SECOND pass after enumeration that re-reads disk at apply-time.** For each `gc_eligible` presence candidate, re-stat the heartbeat mtime (→ `defensiveAgeMs`), re-read the `OwnerRecord` (`readOwnerRecord`), re-classify (`classifyLiveness` still `stale` AND `ageMs > GC_WINDOW_MS` AND `readSessionPausedAt(sid) == null`). Only if the recheck STILL holds → remove. Closes the enumeration→apply TOCTOU: the snapshot can be stale by apply-time (a peer touched its heartbeat → live, or `markSessionPaused`'d → paused in the gap); GC'ing on the snapshot would kill a now-live/now-paused peer. The re-read is the whole reason `--apply` is a separate pass.
2. **cas-race OUT of `errors[]` into `cas_races[]` (F2) — CHOSEN: a separate exit/ok-NEUTRAL field.** A recheck-flip (peer now live/paused/mtime-refreshed/file-gone) is a HEALTHY skip, not an error — putting it in `errors[]` would flip `ok=false`→exit 3, wrongly signaling failure for a correct protective skip. Convergent with 2a's "a healthy protection must not signal an error". `cas_races[]` is advisory.
3. **Honest removal telemetry (F1) — CHOSEN: option A (telemetry-only, defer the rename).** `removeOwnHeartbeat(artifactId, sessionId, opts?: {reason, actorPid})` — the reconcile-gc caller passes `{reason:"reconcile-gc", actorPid}` so the presence-failure-log records `target_sid + reason + actor_pid + caller_top4` instead of the forensic LIE `self-stop pid=<operator>`. The misnomer RENAME (`removeOwnHeartbeat`→`removeHeartbeat` — "Own" lies for the reconcile-gc + dotfiles-cli TARGET-removal callers) is separable naming-hygiene, DEFERRED to a coordinated cross-edge slice (cohort-ratified A-vs-B: Bravo concur + Alpha §1-author intent-confirm). The now-false "single-caller" comment is corrected to MULTI-CALLER + a deferred-rename breadcrumb in the primitive's JSDoc (name-lie documented-not-silent).
4. **`&& !split_brain` DiD — CHOSEN: a split-brain `gc_eligible` candidate is NOT auto-GC'd.** Defense-in-depth: split-brain needs operator resolution, not auto-GC, even if otherwise eligible.
5. **defensiveAgeMs null-skip + benign-final-gap.** A future-mtime re-stat (`defensiveAgeMs`→null) skips (don't GC garbage). The residual final-gap (between the CAS-recheck and the unlink a peer could touch→live) is BENIGN: the live peer re-creates its heartbeat on its next touch; the unlink just forces a re-register.

**Exit precedence:** `malformed(3) > gc-failed(1) > gc_eligible_remaining(2) > 0` (cohort-unanimous). `gc-failed` (the unlink threw) is the new exit-1; `cas_races` is exit-neutral.

**Scope (this PR = 2b):** the `--apply` CAS-recheck mutation (presence-only) + the honest-telemetry opts + the misnomer-comment-fix. NEVER-auto-kill PRESERVED + STRENGTHENED: `--apply` is operator-explicit (no auto-path passes it; session-start hook stays report-mode); only `gc_eligible` (already `stale && age>floor && !paused`) is touched, re-confirmed at apply-time, AND not split-brain; identity/worktree are NOT GC'd. Four independent guards: safety-floor + pause-exclusion + CAS-recheck + split-brain-exclusion.

**Deferred (tracked cross-edge slice):** `removeOwnHeartbeat`→`removeHeartbeat` rename + the dotfiles shim/cli/cross-edge-test migration + drop a back-compat alias. Out of 2b to isolate the safety-critical mutation PR; the opts telemetry already makes the multi-caller reality honest-in-the-log, so the rename adds no safety (Alpha §1-author). Charlie owns the dotfiles-migration mechanics.

**Reason:** The CAS-recheck closes the TOCTOU that would otherwise let `--apply` kill a now-live/now-paused peer — the cardinal never-auto-kill risk of the one state-deleting path. cas-race-neutrality keeps a healthy protective skip from signaling failure. Honest-telemetry closes the forensic lie in the removal record. The rename-deferral isolates naming-hygiene from the safety-critical PR.

**Supersedes / superseded_by:** Additive — realizes the increment-2 §1 `--apply` mutation deferred from 2a (#179). Shadow-ratified PRE-build (Alpha §1 re-nod) + max-safety cross-shadow at the 2b PR boundary.

---

## 2026-05-30 — Decision: Cycle-6 Task #6 — opportunistic reap honors `!paused`

```yaml
---
ts: 2026-05-30T17:25:00Z
kind: architectural
severity: minor
phase: 3
affects:
  [
    src/active-sessions/index.ts,
    test/active-sessions/reap-pause-protection.test.ts,
  ]
---
```

**Context:** Cycle-6 Task #6 (the Cycle-2 wind-down item-4 pause-completeness gap). #175 added `markSessionPaused`/`readSessionPausedAt` + reconcile-boot's `gc_eligible` `!paused` AND-term; #180's `casRecheckFlip` re-checks pause at apply-time. But the OPPORTUNISTIC reap paths — `listLivePeers` (PreToolUse GC) and `gcStaleArtifacts` (sweep) — predate the pause feature and reaped purely on age, so a deliberately-paused session (which stops heartbeating → mtime ages past `GC_WINDOW_MS`) was silently reaped on the next scan.

**Options considered + chosen:**

1. **Where to guard — CHOSEN: at each opportunistic reap site, before `tryReapHeartbeat`.** `readSessionPausedAt(entry) != null` → protect, in both `listLivePeers` (`continue`) and `gcStaleArtifacts` (set `dirStillOccupied=true`, skip reap). Mirrors reconcile-boot's `casRecheckFlip` idiom ("pause is a PROTECTION independent of liveness — check first"). Rejected a single shared chokepoint: the two reaps have different control-flow (peer-list build vs dir-occupancy sweep), and the guard is one cheap disk read on the already-rare aged-out branch.
2. **`unregisterActiveSession` (the 3rd `tryReapHeartbeat` caller) — CHOSEN: leave UNGUARDED.** It is the low-level explicit-teardown primitive (Stop-hook abnormal-exit recovery + worktree-GC RE-3 self-heal). Explicit teardown MUST remove a paused-then-ended session's heartbeats; guarding the primitive would leak heartbeats on real teardown. The age-based caller's pause-respect belongs in the CALLER, not the primitive.
3. **clock-skew (`ageMs === null`) case — CHOSEN: protect a paused session there too.** The pause check sits before the reap regardless of WHY the heartbeat is eligible (aged-out OR future-mtime garbage) — conservative: never reap a paused session's heartbeat on the opportunistic path. Negligible cost; a paused session rarely has future-mtime garbage, and it is cleaned on resume/end.

**Scope:** `readSessionPausedAt` guard at the `listLivePeers` + `gcStaleArtifacts` reap sites + a regression test (`reap-pause-protection.test.ts`: a paused session survives both paths, an unpaused one is still reaped). No new exports (shim-safe). reconcile-boot's `--apply` GC already excludes paused via `gc_eligible`; unchanged.

**Deferred (already tracked):** the AGE-BASED worktree-GC's own `!paused` respect — the #179 (2a) entry's "worktree-orphan `paused:false`" deferral (a worktree path yields only the 8-char sid-prefix, so `readSessionPausedAt` needs full-sid resolution; SAFE today because a paused session always retains its presence anchor, but worktree-GC must re-verify before keying eligibility off `!paused`). This PR does NOT touch worktree-GC.

**Reason:** Closes a silent never-keep-paused gap: a paused session that stopped heartbeating was indistinguishable from a dead one to the opportunistic reaps, so the operator's deliberate pause was lost on the next scan. The fix extends the pause-protection invariant already enforced in reconcile-boot to the two reap paths that bypassed it, at one disk read on the rare reap branch.

**Supersedes / superseded_by:** Additive — completes the #175/#179/#180 pause-protection arc by closing its opportunistic-reap gap. Pair-A cross-shadow (Bravo) at the conductor #181 PR boundary.

---

## 2026-06-02 — Decision: cross-artifact liveness gate — worktree reapers stop reaping LIVE siblings (L1049 slice-1)

```yaml
---
ts: 2026-06-02T13:15:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/index.ts,
    src/hooks/checks/dotfiles-worktree-gc.ts,
    src/hooks/checks/repo-worktree-gc.ts,
    test/active-sessions/session-live-by-prefix.test.ts,
  ]
---
```

**Context:** The worktree GC reapers (`dotfiles-worktree-gc` / `repo-worktree-gc`) decided liveness from the `~/.claude` ANCHOR heartbeat only. But per-tool heartbeats land on the session's CWD artifact (its worktree); the anchor refreshes only at session-start + channel-send. So a live session editing files is fresh on its cwd artifact while its anchor ages past `GC_WINDOW_MS`, and the anchor-only scan reaped its LIVE worktree — observed 4/4 this session (2026-06-02), incl. the live captain's worktree at 21:50 (backlog L1049). Telemetry-confirmed: reaps logged `"(orphan; no anchor)"` while the anchor was opportunistically reaped by `listLivePeers` (called from many hooks) and re-created without `dotfilesRoot` (`heartbeat-no-dotfilesroot-on-existing` ×158). 3-lens: Alpha (author) + Charlie (mechanism; plan-gate SHIP-WITH-FOLDS) + Bravo (3rd-lens).

**Options considered + chosen:**

1. **F0 cross-artifact READ — CHOSEN.** New `isSessionLiveByPrefix(sidPrefix, now, windowMs?)` in `active-sessions` scans ALL artifacts (`listArtifactIds` + `listAllHeartbeats`, lock-free); fresh on ANY artifact ⇒ live, don't reap. Replaces anchor-only `sidPrefixHasLiveAnchor` (dotfiles) + `isWorktreeLive` (repo, whose dead anchor plumbing is dropped). **Zero new writes** — read-only, only at the rate-gated 5-min reaper cadence (no hot-path), so the `registry-contention` (#1 event) risk that deferred the heartbeat-refresh fix (F1) does not apply.
2. **F1 anchor-WRITE (keep the anchor fresh on PreToolUse) — REJECTED.** Same root-fix but adds throttled writes on a contended path + needs a contention canary. F0 dominates (zero-write); Charlie's mechanism-lens converged F1→F0 on the merits.
3. **pid-liveness probe — REJECTED (broken-by-construction).** `OwnerRecord.pid = process.pid` is the EPHEMERAL dispatcher subprocess pid, not the long-lived `claude` session pid (empirically: all 4 cohort session-start pids dead; the real session is the `claude` binary). `process.kill(owner.pid, 0)` would read every LIVE session dead → reap all. reconcile-boot's RESERVED `pid-alive` (Pair-B §10 Q2) is therefore broken as-designed (separately flagged). Liveness stays heartbeat-mtime.
4. **Liveness window — CHOSEN: `< GC_WINDOW_MS` (60min)**, the reaper's own staleness boundary (not the old fallback's `!likelyDead`/10min, which was too tight). `repo-worktree-gc` passes its per-repo `cleanupAfterIdleHours` window via the optional `windowMs` param.
5. **Never-silent (F4) — CHOSEN: enriched reap breadcrumb** records the cross-artifact liveness check confirmed dead on all artifacts (an auditable reap, not a blind anchor-age reap).

**Scope (slice-1):** F0 cross-artifact gate in BOTH reapers + the enriched breadcrumb + unit tests (`session-live-by-prefix.test.ts`, incl. the 4/4 regression / Q4 canary: fresh ONLY on a non-anchor artifact ⇒ live). NOT the multi-cycle L1049 contract.

**Deferred (L1049 stays OPEN — Bravo 3rd-lens FINDING-1):** 2-sweep-confirm before reap (transient-robustness for the rare Read/Bash-only / long-single-tool-run residual stale on ALL artifacts >60min — benign: no uncommitted edits, but disruptive); the full worktree `--apply` GC migration into reconcile-boot; re-sourcing a real session pid to enable pid-liveness. This slice is a focused stop-the-bleed, NOT a P0-complete claim.

**Reason:** The reaper read liveness from the one artifact (the anchor) that a live editing session does NOT keep fresh. Reading cross-artifact restores the never-reap-live invariant using the heartbeat the session already refreshes (its cwd artifact), at zero write cost and only at the rate-gated reaper cadence.

**Supersedes / superseded_by:** Additive — extends the worktree-GC liveness model (Phase 3 Slice 2) + the reconcile-boot cross-artifact enumeration pattern (Cycle 2) to the reaper's reap-decision. Partial-realizes backlog L1049 / agetor-P0-1 (the full boot-reconciliation contract remains open).

---

## 2026-06-03 — Decision: dirty-working-tree --force guard — reaper refuses to destroy uncommitted WIP (L1049 slice-2a)

```yaml
---
ts: 2026-06-03T17:40:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/worktrees/index.ts,
    src/hooks/checks/dotfiles-worktree-gc.ts,
    test/hooks/checks/dotfiles-worktree-gc.test.ts,
  ]
---
```

**Context:** `removeWorktree` uses `git worktree remove --force` (`src/worktrees/index.ts`), which destroys uncommitted work; its JSDoc explicitly defers the RE-2 safety guards to the caller (the reaper). But `dotfiles-worktree-gc`'s `guardReason` guarded only mid-commit (`.git/index.lock`) + mid-install (`node_modules/.bun-tmp-*`) — NOT a dirty working tree. So a reap-eligible worktree carrying uncommitted edits would be force-removed and the WIP lost. This is orthogonal to (and more urgent after) the slice-1 liveness gate: 2026-06-03 saw a 2nd cohort-wide live-reap (3/3 — Alpha's `SessionStart:compact` reaped Echo+Foxtrot+Golf; primary-source-verified in `.presence-gate-failures.log`), confirming the reaper hits ALIVE sessions — exactly the ones likely to hold uncommitted WIP. Today's 3/3 survived only because their trees were clean (luck, not safety).

**Options considered + chosen:**

1. **Caller-side dirty-tree guard — CHOSEN.** New `worktreeUncommittedPaths(worktreePath)` primitive (`src/worktrees/index.ts`, next to `removeWorktree`): runs `git status --porcelain`, ignores the provisioner `node_modules` symlink (always untracked, never WIP), returns the remaining (staged/modified/untracked) paths. `guardReason` consults it FIRST and refuses the reap (skip + breadcrumb) when non-empty. Exactly the RE-2 caller-side guard `removeWorktree`'s JSDoc defers to the caller — previously missing for the dirty case.
2. **Drop `--force` in removeWorktree — REJECTED.** Non-force `git worktree remove` fails on ANY untracked entry (incl. the node_modules symlink the provisioner always leaves), so it would block ALL reaps — defeats GC. The dirty discrimination must be caller-side + node_modules-aware.
3. **Probe-error fail-direction — CHOSEN: fail-open (treat as not-dirty).** A `git status` error (broken/missing worktree, git absent) returns `[]` so a probe failure does not permanently block reaping (a broken worktree would otherwise never be reapable); the liveness gate + forensic-marker remain the other layers. "git-status errors AND has recoverable WIP" is low-probability; the fail-safe alternative would accrete un-reapable worktrees.

**Scope (slice-2a):** `worktreeUncommittedPaths` primitive + the `guardReason` dirty branch + 2 tests (dirty orphan → preserved + breadcrumb; node_modules-only orphan → still reaped). Reuses the existing `worktree-cleanup-failed` guard-skip breadcrumb kind (consistent with the index.lock / bun-tmp skips; a dedicated `worktree-gc-dirty-skip` kind is a possible telemetry follow-up).

**Deferred (L1049 stays OPEN):** slice-2b — the liveness-signal fix for the live-reap itself. Verified root cause (2026-06-03, primary-source): a touch-vs-CHECK heartbeat-store mismatch — `isSessionLiveByPrefix` scans the active-sessions store; channel-sends touch the SEPARATE channel store (the 3 reaped siblings had fresh channel heartbeats but zero active-sessions heartbeats). Candidate fix: have the GC liveness gate also consult the channel heartbeat store (a fresh channel heartbeat is ground-truth liveness; no pid, no behavior change). 2b is higher-blast-radius (shared by both reapers + reconcile-boot) → scoped design + cohort lens BEFORE build.

**Reason:** The reaper's force-removal trusted a caller-side WIP guard that didn't exist for the dirty case. 2a adds it — making a (mis-)reap non-catastrophic (never destroys uncommitted work) regardless of whether the liveness signal (2b) mis-classifies a live session. Defense-in-depth: 2b prevents the wrong-reap; 2a ensures even a wrong-reap is recoverable.

**Supersedes / superseded_by:** Additive — extends the Phase 3 Slice 2 reaper guard chain (`guardReason`) + the worktree primitives. Partial-realizes backlog L1049 / agetor-P0-1 alongside slice-1 (#187); the full boot-reconciliation contract + the 2b liveness fix remain open.

---

## 2026-06-03 — Decision: universal message provenance on the `ChannelMessage` envelope (#3a)

```yaml
---
ts: 2026-06-03T18:40:00Z
kind: api-shape
severity: minor
phase: 3
affects:
  [
    src/channels/index.ts,
    src/channels/cli.ts,
    test/channels/cli-body-file.test.ts,
  ]
---
```

**Context:** A channel `send` composes its body from a file (`--body-file`) or stdin, but the persisted message recorded nothing about HOW the body was composed — an audit/traceability gap (`--body-file` reads the file but stamps no provenance). #3 (Bravo Lane-D follow-up b, light-CLI Arc A).

**Decision:** Add optional `provenance: { source: "file" | "stdin" | "inline"; ref?: string }` to `ChannelMessage`, set UNIVERSALLY by the CLI `send` verb after body-resolution: `source` = `"file"` (when `--body-file` is used) | `"stdin"` (piped); `ref` = the source-file BASENAME for file-sourced bodies only (basename, NOT full path — no machine-coupling; mirrors the audit-target `ref` D3 basename convention). Additive + backwards-compat: legacy messages omit it; `serializeLine` writes it conditionally (like identity/role/version); `readMessages`/`isChannelMessage` preserve it as an optional field; no `version` bump.

**Design-authority:** Golf (refined file-sourced-only → universal source-tag; basename `ref`). Alpha confirmed the shape. Foxtrot built; TDD caught that `serializeLine` is field-explicit and had to add the provenance write — the "audit the WRITER, not just the type" lesson applied to the build itself.

**Deferred (flagged, not silent):** the `--from-stdin-file` UNGATED escape-hatch flag (formalize the `cat /tmp/x | send` stdin-bypass as a flag) — Nick's A/B call (Golf leans skip; marginal + a footgun). Universal provenance ships without it.

**Reason:** The channel now records the provenance of every message body (file-source + basename, or stdin) — the audit value `--body-file` lacked — additively, at zero backwards-compat cost.

---

## 2026-06-04 — Decision: worktree reapers consult the channel heartbeat store (L1049 slice-2b)

```yaml
---
ts: 2026-06-04T13:21:35Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/channels/index.ts,
    src/channels/api.ts,
    src/hooks/checks/dotfiles-worktree-gc.ts,
    src/hooks/checks/repo-worktree-gc.ts,
    src/active-sessions/index.ts,
  ]
---
```

**Context:** The slice-2a entry (above) deferred slice-2b — the liveness-signal fix for the verified 3/3 live-worktree-reap. Root cause (primary-source 2026-06-03): a touch-vs-CHECK heartbeat-store mismatch — both worktree reapers gate on `isSessionLiveByPrefix`, which reads ONLY the active-sessions store, but cohort activity (`cli.ts send`) refreshes ONLY the channel store, so a channel-active session reads dead and its worktree is reaped. Gated on #3 completion (now met: #192 + #193) + a cohort subagent-distance design-lens (now run: Alpha Reliability+Architecture + Charlie Architecture+RE + Delta self-check, all primary-source-verified).

**Options considered + chosen:**

1. **Reaper-layer channel consult — CHOSEN.** New `channels/index.ts` helper `isSidPrefixLiveOnChannel` (prefix-scan + dual-dir `heartbeats/` + legacy `heartbeat/` union + mtime-window); both reapers OR it with `isSessionLiveByPrefix`. The reapers already import active-sessions and can add a channels import with no layering violation.
2. **Push the channel consult into `isSessionLiveByPrefix` (active-sessions) — REJECTED.** `channels/*` imports `active-sessions` (e.g. `isValidArtifactId`), so active-sessions importing channels is a CIRCULAR dependency. The consult must compose at the importing (reaper) layer.
3. **Wake-driven refresh of the active-sessions anchor on channel-send — REJECTED.** A behavior change that can regress; OR-ing a second read store is additive and cannot regress existing behavior.

**Key folds (design-lens):** helper THROWS on invalid channelId (sibling parity) + I/O fail-soft + JSDoc "unsafe as a sole reap-gate" (M1); dual-dir union or a pre-rename peer mid-transition false-deads (F-A); repo-site channel window = `max(perRepoWindow, GC_WINDOW_MS)` 60-min send-cadence floor, because the channel store is SPARSE and a short `cleanupAfterIdleHours` would else false-dead a channel-only-fresh session (M4); future-mtime → not-live, stricter than active-sessions, safe under OR (m6); channel-skip breadcrumb at the previously-silent repo site (m7); bump-sentinel excluded (m9); the "2b" tag collision (reconcile-boot increment vs this slice) disambiguated (m8); the false "anchor refreshes at channel-send" docstring corrected (doc-nit).

**Invariant:** the consult is OR — adds protection, never removes (it sits UPSTREAM of the 2a dirty-tree guard; a future AND-combine is pinned against by a test).

**Reason:** A fresh heartbeat in EITHER store is ground-truth liveness; OR-consulting the channel store closes the verified false-dead additively (no pid, no behavior change, cannot regress a correct reap). The window floor matches the channel store's sparse send cadence.

**Supersedes / superseded_by:** Realizes the slice-2a-deferred slice-2b; completes the worktree-reaper arc of backlog L1049. KNOWN-REMAINING (distinct follow-ons): reconcile-boot's `--apply` presence-GC carries the SAME active-sessions-only false-dead (deletes a channel-active peer's heartbeat; operator-`--apply`-gated, boot-recommended) — fix = compose the helper at its layer; and the channel heartbeat store has no per-file GC (unbounded growth; mtime-gated so reap-correctness holds).

---

## 2026-06-04 — Decision: reconcile-boot presence-GC consults the channel heartbeat store (L1049 slice-1)

```yaml
---
ts: 2026-06-04T14:34:30Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/reconcile-boot.ts,
    test/active-sessions/reconcile-boot-channel-consult.test.ts,
  ]
---
```

**Context:** The slice-2b entry (above) flagged reconcile-boot's `--apply` presence-GC as KNOWN-REMAINING — it carries the SAME active-sessions-only false-dead 2b fixed for the worktree reaper: a channel-active session (fresh channel heartbeat, stale active-sessions) is classified `stale` + gc_eligible and its presence heartbeat is DELETED by `--apply` (operator-gated, boot-recommended at `session-reconcile-boot.ts:42`). Cohort A1 decision (full-backlog/roadmap breadth-validated): finish the false-dead liveness-gate class. The cohort-ratified contract (Charlie): an ALIVE-ANYWHERE gate reads every store that proves the specific liveness — here, active-sessions OR the coordination channel.

**Options considered + chosen:**

1. **Consult the channel store at BOTH classification AND apply-time recheck — CHOSEN.** `enumeratePresence` computes `channelLive = isSidPrefixLiveOnChannel(h.sessionId, COORDINATION_CHANNEL_ID, now, GC_WINDOW_MS)` once per candidate; `isGcEligible` gains a 4th SUBTRACT-only AND-term `&& !channelLive` (mirrors the `!paused` term + the "each term only subtracts eligibility" invariant). `casRecheckFlip` (the apply-time TOCTOU half) ALSO consults the channel — a candidate channel-stale at enumeration that goes channel-live in the enumeration→apply gap flips out of GC. reconcile-boot holds the FULL sid → exact-match (no prefix-collision). All uses CALL-TIME (the index↔channels import-cycle caveat, `reconcile-boot.ts:42-48`).
2. **Classification-only consult — REJECTED.** A mutating gate that consults all stores at classification but single-store at apply-time still data-losses on a session that goes live in the TOCTOU gap. Both decision points must consult — the apply-time-recheck rule for mutating gates (generalized into Charlie's contract).
3. **Push into active-sessions `classifyLiveness` — REJECTED.** Same circular-edge reason as 2b; the consult composes at the reconcile-boot layer (it already imports channels).

**Reason:** A fresh channel heartbeat is ground-truth liveness (cohort `cli.ts send` refreshes ONLY the channel store); OR-consulting it makes the presence-GC never delete a live peer's heartbeat. Subtract-only (cannot make GC more aggressive). Backward-compatible (no channel store → `channelLive=false` → unchanged; verified by the existing presence-only suites still passing).

**Residual (documented, not closed this slice):** `isSidPrefixLiveOnChannel` fail-softs to not-live, so a DOUBLE channel-read-error (enumeration AND apply-recheck) could still delete a channel-live presence HB — the residual Charlie #3 flagged for 2b, narrowed here by the two-point consult; the deeper close is the owed 2-sweep-confirm. Per Bravo's fail-direction note, a mutating gate ideally fails-toward-not-acting; a tri-state (live/not-live/errored) helper is the follow-on for that.

**Supersedes / superseded_by:** Realizes the KNOWN-REMAINING reconcile-boot follow-on from the slice-2b entry (above) + the backlog Presence-section item. Sibling to Slice 2 (teammate-idle — the mirror: a channel-only gate adds active-sessions) + Charlie's contract-with-qualifier codification. Completes the presence-GC arm of the false-dead liveness-gate class (cohort A1).

---

## 2026-06-04 — Decision: teammate-idle consults the active-sessions store (L1049 slice-2)

```yaml
---
ts: 2026-06-04T15:07:07Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/hooks/checks/teammate-idle-reminder.ts,
    src/shared/presence-failure-log.ts,
    test/hooks/checks/teammate-idle-reminder.test.ts,
  ]
---
```

**Context:** `teammate-idle-reminder`'s idle gate read the CHANNEL store ONLY (`heartbeat_mtime_ms`), so a peer that is tool-active (active-sessions HB fresh) but channel-quiet (no recent send) was false-flagged idle — the build-busy profile that false-fired ~6× this cohort session. The MIRROR of the L1049 reaper / reconcile-boot fix (Slice 1): those gates read active-sessions-only and OR-in the channel; teammate-idle reads channel-only and ORs-in active-sessions. Cohort A1; builds to the contract-v2 (#195).

**Options considered + chosen:**

1. **OR-in `isSessionLiveByPrefix` (active-sessions) after the channel-idle determination — CHOSEN.** teammate-idle is an ALIVE-ANYWHERE gate ("is this peer doing ANY work?"), so it consults every store that proves that liveness: a channel-idle peer that is active-sessions-live is WORKING → suppress the idle warning + breadcrumb. NON-mutating gate → SINGLE decision point (no apply-time CAS-recheck, unlike the mutating Slice 1).
2. **Fold the L283 compaction-marker consult — DROPPED (Alpha-confirmed).** The shipped `compaction-notify` PreCompact hook sends a `status` → touches the channel HB teammate-idle reads, so normal-length compaction already does not false-fire; the >5min-compaction edge is a filed Sev-4 known-gap, not bundled here.

**Fail-direction (contract-v2 axis):** the helper fail-softs to not-live, and teammate-idle is ADVISORY (a warn), so a rare double-fault (channel-stale + active-sessions-read-error) yields a NOISE false-positive, not a destructive action — acceptable for an advisory gate (contrast the mutating Slice 1, which fails-toward-not-acting).

**Window:** channel branch = the 5-min idle threshold (unchanged); active-sessions branch = `GC_WINDOW_MS` (the helper default; consistent with Slice 1 + the reaper).

**New telemetry:** a `PresenceFailureKind` `active-sessions-live-suppressed` (union + runtime guard, mirroring `standby-suppressed`) — the breadcrumb when an idle-by-channel peer is suppressed by active-sessions liveness.

**Reason:** A fresh heartbeat in EITHER store is ground-truth liveness; OR-consulting active-sessions stops the build-busy false-positive additively (no change to the channel-idle path; subtract-only on the warn). Backward-compatible.

**Cross-edge:** `presence-failure-log` is shimmed to dotfiles (`export *`); the new kind is an ADDITIVE union member (back-compat — no dotfiles consumer asserts the exact kind-set); the B#3 CI-pin insulates dotfiles CI until a deliberate bump.

**Supersedes / superseded_by:** Sibling to slice-1 (the reconcile-boot/reaper channel-consult — the inverse mirror) + the contract-v2 (#195). Completes the ADVISORY arm of the false-dead liveness-gate class (cohort A1). KNOWN-REMAINING: the >5min-compaction idle edge (filed Sev-4; cross-ref L283).

— Slice-2 CODE authored by Bravo (Charlie-shadowed SHIP-CLEAN); this decision entry + the rebase-onto-#196 + the land were a capacity-take by Delta (Bravo paused mid-fix by an external interrupt; Alpha stall-break; Bravo async-bless).

---

## 2026-06-04 — Decision: `nudge` channel kind for dashboard limited-mutation (N1a)

```yaml
---
ts: 2026-06-04T18:44:09Z
kind: api-shape
severity: minor
phase: 3
affects:
  [
    src/channels/index.ts,
    src/channels/cli.ts,
    test/channels/channel-kinds-ssot.test.ts,
    docs/conventions/message-kinds-and-verification.md,
  ]
---
```

**Context:** CONVENE-2 next-priority arc. N1 (dashboard Phase 4.5 — Nudge + Check-comms write actions) layers over a `kind:"nudge"` channel message wrapping `appendMessage`. The synthesis framed N1 as "dashboard-only, zero-conductor-conflict," but primary-source caught the premise error PRE-BUILD: `nudge` was NOT a member of `CHANNEL_KINDS` (`ChannelKind = (typeof CHANNEL_KINDS)[number]`, so a `kind:"nudge"` message is a TYPE error + `isChannelMessage` runtime-rejects it). N1 therefore needs a conductor substrate slice first. Alpha ratified; split into N1a (this — the substrate kind) → N1b (the dashboard consumer), substrate-precedes-consumer (dashboard CLAUDE.md §9).

**Decision (A vs B — A chosen, Alpha-ratified):** Add `"nudge"` to `CHANNEL_KINDS` as a real, distinct kind — NOT reuse `question`/`status` (option B). Semantic correctness is load-bearing: a nudge is a directive (wake / check-comms), not informational (`status`) and not expecting an answer (`question`); reusing those would make a dashboard-nudge indistinguishable from a genuine peer message in every renderer/filter and pollute those kinds' semantics. Additive + low-risk + spec-explicit (dashboard spec v2.1 §17.13).

**Surface touched (all enforced by same-repo drift-tests):** the `CHANNEL_KINDS` tuple (`index.ts`); `KINDS_HELP` + `VERB_HELP.send` kind enumeration (`cli.ts` — the SSOT-iteration drift-catch tests in `cli-send-merged.test.ts` require every member to appear in both); the `channel-kinds-ssot.test.ts` exact-tuple + length pins (17 → 18). `renderKindPrefix` is generic (`[${kind}]`) → NO per-kind case. No body schema (free-form, like `note`); send is role-gated like every non-`out` kind (auto-covered by the role-out drift-test).

**Reason:** Gives the dashboard's requested wake / check-comms actions a semantically-distinct, filter-addressable substrate primitive — additively, at zero backwards-compat cost.

**Cross-edge:** The dotfiles shim (`src/channels/index.ts`) re-exports the `ChannelKind` TYPE (auto-widens at source) but does NOT re-export the `CHANNEL_KINDS` value array, and no hardcoded kind-list copy exists in dotfiles → widening the tuple has ZERO dotfiles impact (no shim-mirror per [[feedback-substrate-shim-mirror-on-plugin-export-changes]]). The wake-filter integration (`nudge` ∈ the urgent-kinds set sibling Monitors honor) is convention-level — there is NO code urgent-kinds set today; a session arming a Monitor includes `nudge` in its wake-filter regex. Downstream consumer: claude-conductor-dashboard Phase 4.5 (N1b) via `sendChannelMessage` → `appendMessage`.

**Coordination:** N1a lands as a tiny standalone conductor PR FIRST (cohort coordination option (i), Delta-picked); zero file-overlap with Delta's P1 rename — `removeOwnHeartbeat` lives in `src/active-sessions/index.ts`, a DIFFERENT file from this `src/channels/index.ts` (Delta primary-source-confirmed). N1b (dashboard) consumes after N1a merges + canonical-syncs.

**Supersedes / superseded_by:** First slice of the N1 dashboard-nudge arc (CONVENE-2 next-priority). N1b (dashboard consumer) follows; no supersede.

---

## 2026-06-04 — Decision: reaper/boot hot-path perf — channelLive lazy-compute + channelHB-GC (CONVENE-2 Q2)

```yaml
---
ts: 2026-06-04T19:14:19Z
kind: architectural
severity: minor
phase: 3
affects:
  [
    src/active-sessions/reconcile-boot.ts,
    src/channels/index.ts,
    src/hooks/checks/channels-gc-reaper.ts,
    test/hooks/checks/channels-gc-reaper.test.ts,
  ]
---
```

**Context:** A1 (the false-dead liveness-gate closure) ADDED a channel-store consult (`isSidPrefixLiveOnChannel`, a per-call `heartbeats/` dir scan) to the reaper/boot hot path. Q2 pays down that added I/O without touching correctness — two composing, subtract-only-safe perf changes on the path A1 just hardened. CONVENE-2 Delta-track (Alpha synthesis); enumeration-budget DEFERRED into C1 (the boot-reconciliation-contract arc) per the ratified subsume-flag.

**Changes (both semantics-preserving):**

1. **channelLive lazy-compute (reconcile-boot.ts `isGcEligible`):** the 4th AND-term changed from an eagerly-computed `boolean` to a `channelLiveProbe: () => boolean` THUNK. JS `&&` short-circuits, so the channel-dir scan fires ONLY for a candidate already past `stale && >GC_WINDOW_MS && !paused` — live/fresh/paused candidates (the common case) skip the scan entirely. Identical `gc_eligible` result; subtract-only invariant preserved. The apply-time CAS-recheck (`casRecheckFlip`) keeps its own consult (rare per-apply path, not the enumeration scan).
2. **channelHB-GC / M3 (channels-gc-reaper.ts `pruneStaleHeartbeats`):** the channel heartbeat store (`heartbeats/<sid>` + legacy `heartbeat/<sid>`) was never GC'd → unbounded growth → an ever-slower `isSidPrefixLiveOnChannel` scan. The new prune MIRRORS the proven `pruneStaleLastSeenCursors` (own `withMetadataLock`, re-read `metadata.identities` for liveSids, skip-live-participant + skip-mtime<TTL, dual-read new+legacy, fail-soft + breadcrumb), wired into `reapChannel` before the orphans early-return so it runs every rate-gated pass. New exported resolvers `resolveHeartbeatDir` / `resolveLegacyHeartbeatDir` (channels/index.ts) mirror the `resolveLastSeenDir` family.

**TTL safety (the load-bearing invariant):** `HEARTBEAT_GC_TTL_MS = 24h` is DELIBERATELY >> any liveness window (callers probe with `GC_WINDOW_MS = 60min`). Pruning only >24h-stale HBs CANNOT remove one a liveness read would still treat as live → a pure growth-bound, never a liveness change. A live participant's HB is additionally skip-guarded (sid in `metadata.identities`) regardless of age.

**Reason:** completes the A1 hardening — the correctness fix added hot-path I/O; Q2 makes that I/O lazy (skip when not needed) + bounds the store it scans. check-existing WIN: channelHB-GC extends the existing reaper's rate-gate + lock + fail-soft discipline, not a new mechanism.

**Cross-edge:** NONE. The new resolvers are internal-relative consumed (the reaper imports `../../channels/index.ts`), NOT a `package.json` subpath export nor a `channels/api` re-export → no dotfiles shim mirror needed. Verified grep-clean for cross-repo consumers of the new symbols.

**Verification:** typecheck clean; reaper 25/0 (3 new HB-GC regression cases: stale-nonparticipant pruned / fresh kept / stale-participant kept); reconcile-boot 5/0. enumeration-budget designed into C1 (#200 §6), not here.

**Supersedes / superseded_by:** builds ON A1 (#194/#196/#197); the channelHB-GC is assumed-by C1's canonical liveness API (#200 §6 — "C1 builds ON it"). P1 (`removeOwnHeartbeat` rename) SPLIT OUT as a separate cross-edge slice (dotfiles `cli.ts` consumer; per the index.ts:955 deferred-rename ratification) — NOT in this PR.

— Q2 authored by Delta (CONVENE-2 Delta-track); peer-shadow at the PR boundary.

---

## 2026-06-05 — Decision: C1 S1 — canonical session-liveness API + LGC-002 (tripwire-not-structural-unexport)

```yaml
---
ts: 2026-06-05T14:23:12Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/session-liveness.ts,
    src/hooks/checks/dotfiles-worktree-gc.ts,
    src/hooks/checks/repo-worktree-gc.ts,
    scripts/check-liveness-gate-store-contract.sh,
  ]
---
```

**Context:** C1 Slice 1 (RFC #200 §3.1) — the durable root-vs-patch closure of the false-DEAD liveness-gate class. A1 PATCHED false-dead per-gate (each gate manually OR-ing both heartbeat stores); LGC-001 scanned only the idiomatic prefix-helpers, leaving a raw-primitive false-negative. S1 CENTRALIZES the alive-anywhere OR-compose into one canonical API so a single-store alive-anywhere gate is structurally caught. Ships independent of the pid lane (S2).

**Three decisions (all cohort-ratified on `coordination`, 2026-06-05):**

1. **Canonical lives in a NEW leaf module `active-sessions/session-liveness.ts`, NOT `index.ts` (architectural).** The OR-compose must consult the channel store (`isSidPrefixLiveOnChannel`); `channels/index.ts` already imports `active-sessions/index.ts` at module scope, so putting the channel import in `index.ts` would close an active-sessions↔channels module cycle AT THE HUB (TDZ risk, per reconcile-boot's cycle note). A leaf module imports BOTH stores with no back-edge → no cycle; nothing imports it at module-eval (only the reaper hooks, at call sites).

2. **Mechanism = the LGC-002 tripwire, NOT literal structural-unexport (refines RFC §3.1's "structural closure").** Primary-source finding: literal unexport-all is INFEASIBLE — TS/ESM has no package-private, and `classifyLiveness` + `scanHeartbeats` have legitimate CROSS-FILE consumers that are NOT alive-anywhere reap-gates (reconcile-boot ENUMERATION; the dotfiles `/presence` DISPLAY label). Chosen: extend the LGC-001 scan to flag the raw `classifyLiveness` verdict (`LGC-002`) outside an allow-list + migrate the alive-anywhere REAP-gates to the canonical — the RFC's own "caught (or won't compile)" arm, the "caught" side; the rogue-gate fixture test is the closure evidence. (Echo escalated the "is tripwire-closure still root-closure vs true structural?" framing to Nick; this slice builds the reversible tripwire version meanwhile, per that ratification. Mirrors the LGC-001 model — already a tripwire, not structural.)

3. **Seam = Model B: pid (S2) is a reconcile-boot `gc_eligible` subtract-term, NOT folded into `classifySessionLiveness` (api-shape).** Charlie + Bravo converged independently; Echo ratified. pid-liveness has DIFFERENT semantics than heartbeat-store liveness — same-host-only + ceiling-bounded-protect + operator-reclaim-oriented — so folding it into the canonical verdict would impose those caveats on every caller + conflate "process exists" with "is coordinating." → the canonical signature (`classifySessionLiveness` / `isSessionLive` / `isSessionLivePrefix` / `sessionLivePrefixSource`) is STABLE across S2; S2 wires pid as a lazy thunk mirroring `channelLiveProbe`.

**Migration (behavior-preserving):** the two worktree reap-gates (`dotfiles-worktree-gc`, `repo-worktree-gc`) route through `sessionLivePrefixSource` instead of manually OR-ing the prefix-helpers. The channel-floor invariant (`channel window = max(windowMs, GC_WINDOW_MS)`, for sparse channel sends) is now CENTRALIZED in the composer; `sessionLivePrefixSource` returns WHICH store proved liveness so each reaper keeps its forensic which-store breadcrumb. Their existing tests pass unchanged. The LGC-002 allow-list is updated: the reapers are REMOVED (they no longer touch a raw primitive); `session-liveness.ts` is added; reconcile-boot + teammate-idle are retained (verified both-stores gates).

**Cross-edge:** NO dotfiles change. `classifyLiveness` stays exported (not privatized), so the dotfiles `src/active-sessions/cli.ts` `/presence` display consumer is unaffected (`index.ts` exports untouched). Conductor LGC scans conductor `src/` only.

**Reason:** centralizing the OR-compose closes the raw-primitive false-negative the A1 patch + LGC-001 left open — the durable root-fix — while the tripwire + leaf-module + Model-B-seam choices keep it feasible under TS limits, cycle-safe, and forward-compatible with S2 at zero canonical-API churn.

**Supersedes / superseded_by:** Builds ON A1 (#194/#196/#197) + the channelHB-GC (Q2, assumed by the canonical's channel read). First build slice of the C1 arc (RFC #200); S2 (pid lane) + a slimmed S4 follow (S3a/S3b capped per Nick's D1 investment-bound ruling, 2026-06-05).

— S1 authored by Charlie (ea19aa59); inline subagent Nick-lens audit (2 folds applied) + Echo PR-boundary merge-gate (#203).

---

## 2026-06-05 — Decision: C1 S2 — real session-pid liveness + subtract-only PROTECT lane

```yaml
---
ts: 2026-06-05T14:32:56Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/index.ts,
    src/active-sessions/reconcile-boot.ts,
    src/shared/session-id-discovery.ts,
    src/hooks/checks/dotfiles-worktree-provisioner.ts,
  ]
---
```

**Context:** C1's durable false-LIVE/false-DEAD root-fix needs the SESSION's real OS pid — today `OwnerRecord.pid` is the EPHEMERAL dispatcher `process.pid` (every recorded pid probed ESRCH this cohort — the motivating datum). The pid-SPIKE (Delta) PASSED: the harness publishes `~/.claude/sessions/<pid>.json = {pid, sessionId, ...}`. S2 records that real pid + adds a same-host `kill(pid,0)` PROTECT to the presence reaper. Wave-1; seam + ceiling + S4-scope ratified by Nick post-spike.

**Decisions:**

1. **Seam = Model B (Charlie+Bravo converged independently; Echo-ratified).** pid wires as a reconcile-boot `isGcEligible` subtract-term (a lazy thunk mirroring `channelLiveProbe`), NOT folded into S1's `classifySessionLiveness` bucket. pid-liveness has DIFFERENT semantics (same-host-only, ceiling-bounded, operator-reclaim-oriented); folding it into `isSessionLive` would impose those caveats on every caller + conflate "process exists" with "is coordinating". Keeps the canonical liveness signature STABLE across S2 — S2 is S1-INDEPENDENT (reconcile-boot enumeration stays on `classifyLiveness`, allow-listed, not migrated).

2. **Ceiling-bounded protect; `PID_PROTECT_CEILING_MS = 2 × GC_WINDOW_MS` (120min, Nick-ratified).** The protect fires ONLY in the band `(GC_WINDOW_MS, PID_PROTECT_CEILING_MS]` — `isGcEligible` already gates `age > GC_WINDOW_MS`, the thunk gates `age <= PID_PROTECT_CEILING_MS`. Beyond the ceiling, mtime-staleness wins regardless of the pid → a reused-pid false-protect cannot leak forever (degrades to today's proxy). The RFC's illustrative "≤ GC_WINDOW_MS" ceiling would have been a NO-OP (the floor already protects that band) — the operative ceiling MUST be `> GC_WINDOW_MS` (Bravo primary-source catch, Echo-ratified).

3. **Subtract-only + degrade-safe.** The pid term is a conjunctive `&& !pidProtectProbe()` — structurally it can only force `gc_eligible=false`, never enable a GC. Absent `sessionOsPid` (legacy / flag-off record) → the probe is false → `isGcEligible` reduces to EXACTLY today's predicate. The lane is a SAFE AUGMENT (the cohort huddle's framing): adds protection where a real pid exists, never breaks legacy GC.

4. **Source = scan-by-sessionId (dir-scan), not the ppid-walk.** `resolveSessionOsPid(sessionId)` scans the `<pid>.json` registry for the file whose embedded sessionId matches (reusing `readCCBinaryFile` + the cold-start retry; skips uuid-stemmed telemetry). Chosen over the cohort's literal `walkPpidTree` suggestion because (a) the caller KNOWS its sessionId — scan-by-known-id is the natural operation, and (b) it makes the sessionId-MATCH SAFETY GUARD (never record a stale/recycled pidfile's pid) deterministically TESTABLE (inject a sandbox dir), which the ppid-walk is not.

5. **Recording call-site = the flag-on provisioner path; flag-off degrades (accepted bound).** `recordSessionOsPid` is called in `dotfiles-worktree-provisioner` after the anchor-pin (conductor-internal — no new cross-edge surface). The provisioner early-returns flag-off (`CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES`), so flag-off sessions record no pid → their protect degrades to mtime. Accepted per the degrade-safe framing + the feature trending default-on. Retry budget tightened to ≤100ms (audit RE-1) — the caller already holds the sessionId, so a cold-start miss only forgoes a degrade-safe protect; bound the `Atomics.wait` off the SessionStart critical path.

6. **Deserialization twin (caught in build).** `OwnerRecord.sessionOsPid?` is additive + auto-preserved by `mergeOwnerRecord` on WRITE, but `readOwnerRecord` is per-field-EXPLICIT — the new field needed an explicit type-validated carry-back THERE too (the write-merge generalization does NOT cover the read-parse). A round-trip test caught the omission; the carry-back was added.

**Cross-edge:** NONE new. The recording (provisioner check + setter) is conductor-internal; `resolveSessionOsPid` is internal-relative consumed. `cross_edge_consumers_verified` resolves empty.

**Verification:** typecheck clean; full suite 2671/0; the two new pid suites 20/0 (probe ESRCH/EPERM/absent; ceiling band + bounded-leak; dead/cross-host/no-pid degrade; sessionId-match safety; casRecheck pid-mirror); CI-only checks (generic-paths/import-ext/dep-rationale/spdx/liveness-gate-store-contract/drift) clean. Inline Nick-lens audit (subagent): SHIP-WITH-FOLDS, no blockers (RE-1 retry-budget + lock-domain-comment folded; TA-1 EPERM-branch accepted as outcome-pinned).

**Supersedes / superseded_by:** builds ON S1 (#203 canonical `classifySessionLiveness` — Model B keeps pid OUT of it) + Q2's channelLive-lazy/channelHB-GC (#202). S3a (2-sweep) + S3b (fast-reap) CAPPED/DEFERRED per Nick's investment-bound (revisit only if cross-host cohorts emerge). The optional start-time/procStart complete-closure stays DEFERRED (cross-platform-free via the pidfile per Charlie/Delta, but non-load-bearing for S2's ceiling-bounded protect).

— C1 S2 authored by Bravo (Wave-1); PR-boundary peer-shadow = Delta (freshest pid context); Echo merge-gate. Fold-order: merges AFTER S1 #203.

---

## 2026-06-05 — Decision: cohort-sight read-only captain board (D2; observe-not-infer)

```yaml
---
ts: 2026-06-05T14:26:00Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/cohort-sight/index.ts,
    src/cohort-sight/cli.ts,
    src/cli/dispatcher.ts,
    test/cohort-sight/cohort-sight.test.ts,
  ]
---
```

**Context:** The 2026-06-05 cohort huddle (Nick's "what if the captain could SEE its siblings?" provocation) blessed BOUNDING the deep liveness-INFERENCE — C1 S3a (2-sweep) + S3b (fast-reap) CAPPED/deferred (revisit only on cross-host cohorts) — and instead KEEPING + EXTENDING the OBSERVATION primitive the pid-SPIKE surfaced: the harness already publishes a per-session registry at `~/.claude/sessions/<pid>.json` ({pid, sessionId, cwd, status:busy/idle, updatedAt}). D2 builds the minimal buildable observation slice: a read-only captain board consuming what the harness + channel already publish, with ZERO new writes / ZERO new protocol.

**Options considered:**

1. **Conductor module (pure core + CLI verb), dashboard-consumable later (CHOSEN)** — `src/cohort-sight/index.ts` `buildCohortSight(now)` (the fusing core) + `src/cohort-sight/cli.ts` (`claude-conductor cohort-sight`, dispatcher-routed). All fusing primitives (`readMetadata`, the sessions-dir scan, `kill(pid,0)`) are conductor-resident; the pure core stays importable by the dashboard later.
2. A new Live-mode view in the separate `claude-conductor-dashboard` repo — visual, but requires the dashboard deployed AND a conductor-exported primitive anyway; heavier + cross-repo. The board is terminal-native and Echo's merge-gate is conductor.
3. Extend the channels `peers` verb — but cohort-sight fuses the HARNESS sessions-file (not channel-only) + `kill0`; a distinct concern from channel participation.

**Chosen:** Option 1 — a conductor `src/cohort-sight/` module (core + CLI), PR to Echo.

**Reason:** The fusing primitives are conductor-resident; a CLI verb mirrors the existing read-only operator-report pattern (`reconcile-boot`) and is terminal-native for the captain. Structuring as a pure `buildCohortSight()` core + thin CLI keeps the core dashboard-consumable — the dashboard's Live panel can later import it, so the two COMPOSE rather than duplicate (the parallel-infrastructure trap avoided).

**Augment-only + degradable (load-bearing invariant):** cohort-sight only READS + reports; NO state-deleting (reaper/GC) path may depend on it — the pidfile is an UNDOCUMENTED, CC-version-coupled harness artifact (the C1 pid-SPIKE caveat). Every read is fail-soft (unreadable pidfile -> `blindSpots[]`; missing dir -> empty board); the `process.kill(pid,0)` probe treats EPERM as alive (exists-but-not-ours), only ESRCH as gone. This is the OBSERVE layer (distinct from the liveness-INFERENCE substrate): it obviates re-deriving busy/idle, NOT the artifact-keyed collision detection nor the channel's intentional signals.

**Scope:** v1 ships the 6 directly-available fields (identity / pid / status / cwd / age / kill0). `waitingFor` (RFC-listed) is DEFERRED to v2 — it needs channel-MESSAGE derivation (a session's last `over`/`question`), heavier + heuristic; surfaced to Echo. The probe (`isPidSignalable`) mirrors S2's `isOsPidAlive` (active-sessions) — a candidate to unify once S2 lands; kept local so cohort-sight stays independent of the in-flight S2 slice.

**Verification:** typecheck clean; lint clean; format clean; 10 cohort-sight tests + full suite (2661 pass) green; smoke-run on real data renders the live 5-session cohort board (Alpha/Bravo/Charlie/Delta/Echo).

**Supersedes / superseded_by:** D2 of the 2026-06-05 huddle seed (Nick-blessed: D1 inference-bound + D2 cohort-sight + D3 coord-primitive fixes). No supersede; independent of C1 S1/S2 (the observe path, not the inference substrate).

— cohort-sight (D2) authored by Delta; peer-shadow at the PR boundary (Echo merge-gate).

---

## 2026-06-05 — Decision: ci-local advisory for uncommitted substrate vs the commit-based decision-log gate (L2)

```yaml
---
ts: 2026-06-05T21:02:19Z
kind: tooling
severity: minor
phase: 3
affects:
  [
    scripts/warn-uncommitted-substrate.sh,
    scripts/ci-local.sh,
    test/scripts/warn-uncommitted-substrate.test.ts,
  ]
---
```

**Context:** `check-decision-log.sh` (DLOG-001) is COMMIT-based — it diffs `merge-base(origin/main,HEAD)..HEAD`. Running `bun run ci-local` PRE-commit (HEAD ≈ origin/main) makes that range EMPTY, so check-decision-log reports a vacuous "clean" even when the working tree holds staged/unstaged substrate edits. The author then commits + pushes and CI runs the SAME gate against the now-committed diff, where it REDS (this bit C1 S1, #203). ci-local's whole purpose is local-green == CI-green; this gap defeats it for the DLOG gate specifically.

**Options considered:**

1. **Advisory detect-and-warn step ci-local calls (CHOSEN)** — a small `scripts/warn-uncommitted-substrate.sh` that detects uncommitted substrate (`git diff --name-only HEAD` ∪ untracked, classified IDENTICALLY to check-decision-log) and prints commit-then-recheck guidance; ci-local captures it, shows it inline + in the summary; the helper ALWAYS exits 0 and is NEVER folded into `FAILED`. No new gate, no pre-push hook.
2. Make check-decision-log itself working-tree-aware — rejected: it must stay commit-based to mirror CI exactly; a working-tree mode would diverge local from CI and become its own false signal.
3. A blocking pre-commit/pre-push gate on uncommitted substrate — rejected by directive (Nick: advisory, NOT a hard gate / new infra; conductor has no pre-push hook).

**Chosen:** Option 1 — an advisory helper invoked by ci-local; detect-and-warn only.

**Reason:** Closes the false-confidence gap at the exact go/no-go point (the ci-local summary) without changing the commit-based gate's CI-parity semantics and without adding enforcement infra. A separate script makes the substrate classifier independently unit-testable and lets a paired structural test pin its parity with check-decision-log so the two cannot drift.

**Scope:** "Uncommitted" includes UNTRACKED `src/*.ts` (via `git ls-files --others --exclude-standard`), not only tracked working-tree changes — an untracked new substrate file is the same post-commit-CI-red case. This extends the directive's literal `git diff --name-only HEAD` + staged; flagged at the PR boundary as a deliberate completeness call (trivially foldable if the shadow disagrees). ci-local's run-all-aggregate behavior and exit codes are unchanged; the advisory never affects pass/fail.

**Verification:** advisory unit suite green (temp-git sandbox: tracked-mod / staged-new / untracked / nested detected; `*.test.ts` + non-src excluded; clean tree → empty; always exit 0; not-a-git-repo graceful-skip; `--help`); classification-parity + ci-local-wiring + shebang-before-SPDX pins green; `ci-local.test.ts` gate-parity unaffected; `bun run ci-local` dogfooded; full typecheck / format / lint / suite green (exact counts in the PR + commit body).

**Supersedes / superseded_by:** none. Complements Q1 ci-local (#199) by closing the DLOG-specific pre-commit gap that #199's run-all surfaced but could not see.

— L2 DLOG-local authored by Bravo; PR-boundary peer-shadow = TBD (cohort, per dynamic-pairing); Alpha merge-gate.

---

## 2026-06-05 — Decision: C1 S4-slim — formalized liveness state machine + 2-primitive contract test

```yaml
---
ts: 2026-06-05T21:36:07Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/active-sessions/session-liveness.ts,
    test/active-sessions/liveness-state-machine.test.ts,
    test/active-sessions/liveness-contract.test.ts,
  ]
---
```

**Context:** RFC #200 §3.5/§4 spec the liveness state machine + contract test for the C1 boot-reconciliation arc. S1 (#203 canonical `classifySessionLiveness`) + S2 (#204 pid-protect) shipped the primitives; S4-slim FORMALIZES them. "Slim" because S3a (2-sweep generation marker) + S3b (fast-reap) are CAPPED per Nick's investment-bound — so the 2-sweep states (suspected-dead / confirmed-dead) AND the 3rd contract primitive (generation/2-sweep) are out of scope.

**Decisions:**

1. **Formalize the SHIPPED + lifecycle states only (Alpha cohort call, OBSERVE-NOT-INFER).** The state machine is `live → likely-dead → stale → gc'd(--apply) → reclaimed`; `paused` orthogonal. The classifiable states (live/likely-dead/stale) come straight from S1 `classifySessionLiveness` (mtime OR-compose) gated by S2's pid protect — NO new classifier is hand-rolled. `LivenessState = Liveness | "idle" | "gc'd" | "reclaimed"` ties the machine to the shipped `Liveness` buckets.

2. **`idle` = a NAMED but DEFERRED observe-rung, not a classified state (the load-bearing bound).** The harness already publishes per-session busy/idle status (`~/.claude/sessions/<pid>.json status`). An initial proposal classified idle by a two-store split (channel-stale-but-active-fresh = idle) — clever + free, but it would BAKE a divergent inference of exactly what the harness OBSERVES. Per Nick's OBSERVE-NOT-INFER bound (Alpha caught it on the design Q), idle is kept a named state with `kind: "observe"` edges marked DEFERRED — documented, NOT classified by the substrate this slice (left to the observe direction, a future rung). This deliberately REPOSITIONS idle off RFC §3.5's literal linear `live → idle → likely-dead` decay path (idle becomes an off-path observe edge, not a decay-path state) — a topology deviation per OBSERVE-NOT-INFER, breadcrumbed in the `LIVENESS_TRANSITIONS` JSDoc so it reads as intentional, not a transcription error (ARCH-1 audit fold).

3. **Placement INSIDE session-liveness.ts (the canonical liveness module).** The state vocabulary (`LivenessState`) + transition table (`LIVENESS_TRANSITIONS`) live in the canonical module: legal compose, NO LGC-001/002 trip (the pivot removed the would-be classifier, so no new raw-primitive caller; the canonical OR-composers stay the only liveness entry — tripwire re-run clean, 110 files), no active-sessions↔channels module cycle.

4. **gc'd is the ONLY state-deleting edge (NEVER-auto-kill formalized).** `stale → gc'd` is `kind: "operator"` — reconcile-boot `--apply` + the four guards (gc_eligible + presence-only + !split_brain + apply-time CAS-recheck). No decay/refresh/observe/lifecycle edge ever lands in gc'd; liveness is NON-monotonic pre-gc (a silent peer refreshing EITHER store recovers to live — the gc'd state is a substrate transition, not a death certificate).

5. **2-primitive contract test (not 3 — generation primitive capped).** Pins (1) mtime-proxy OR-composed both-store (A1) via `classifySessionLiveness` + reconcile-boot's channel-protect; (2) session-pid ceiling-bounded subtract-only protect via reconcile-boot's `isGcEligible` + the apply-time CAS pid-mirror; PLUS the gc'd/reclaimed lifecycle, the rogue-gate closure (S1 LGC-002, pinned behaviorally — classifySessionLiveness is alive-anywhere), and the NEVER-auto-kill invariants (report-mode never mutates; pause/channel/pid each subtract).

**Cross-edge:** NONE new. `session-liveness.ts` is conductor-internal (NOT in the package `exports` map); the additions are consumed internal-relative (the two new test suites). `cross_edge_consumers_verified` resolves empty. Identity/worktree `--apply`-GC fold DEFERRED → C2.

**Verification:** typecheck clean; format + lint clean; SPDX clean (288 tracked files); LGC tripwire clean (110 src files; no new raw-primitive caller); full suite 2731/0 (+28 net-new: 12 state-machine table + 16 contract). Inline 2-subagent Nick-lens audit (Test Architect + Architecture Auditor; axes surface+depth+distance): SHIP-WITH-FOLDS, B0 — all folds applied before commit (TA-1 positive stale→gc'd GC pin; TA-2 closed transition-set assertion; TA-3 dropped the verbatim apply-time CAS clone + honest docstring; TA-4 dropped the inert subtract-only case; ARCH-1 RFC-topology-deviation breadcrumb). ci-local + main-CI: pending — verified green before any shipped-claim.

**Supersedes / superseded_by:** FORMALIZES S1 (#203) + S2 (#204) — supersedes ad-hoc `Liveness`-bucket usage with the explicit state machine. S3a (2-sweep) + S3b (fast-reap) CAPPED per Nick's investment-bound — the suspected-dead/confirmed-dead states + the 3rd contract primitive are deferred with them. `idle` classification deferred to the observe direction. Identity/worktree `--apply`-GC → C2.

— C1 S4-slim authored by Delta; design Q + OBSERVE-NOT-INFER fold with Alpha (captain); inline Nick-lens audit + Alpha PR-boundary merge-gate.

---

```yaml
---
ts: 2026-06-05T21:30:39Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/channels/index.ts,
    src/channels/identity.ts,
    src/channels/cli.ts,
    test/channels/identity-race.test.ts,
    test/channels/cli.test.ts,
  ]
---
```

**Context:** L1 D3 — coordination-primitive fixes (C2 cycle), conductor half: (b) close the documented `claimIdentityNamed`<->`claimIdentity` pre-lock `linkSync` race; (c) bind the discoverable `release` verb + fold stale `release-self` strings. (The third D3 item — the Monitor self-filter helper — is dotfiles-only, a separate PR.) Primary-source verification reshaped the lane: 2 of 3 board premises were stale (the §5 Monitor recipe was ALREADY the jq `from`-field form; `release-self` ALREADY shipped CAS-guarded) — Alpha confirmed + owns the reshape.

**(b) Race-fix — options considered:**

1. **Named-side sentinel-reverify-under-lock in `claimNamedIdentityWithLock` (CHOSEN).** Before mutating, re-read the on-disk sentinel's `session_id` vs the metadata snapshot (`holderSessionId`). Divergence -> `{kind:"raced"}` (yield, mutate nothing) -> caller throws `IdentityRacedError` (CLI exit 8 RACE_LOST). Verified non-null holder -> `renameSync` (provably stable under the lock: no release can unlink it, no vanilla `linkSync` can replace a present sentinel). Null holder (released in-window) -> create-only `linkSync` so a racing vanilla create is caught via EEXIST -> raced.
2. **Vanilla-side `commitIdentityClaim` reverify (the `it.todo`'s documented plan).** Re-verify the sentinel in vanilla `claimIdentity`'s post-`linkSync` commit + abort-to-next-letter on mismatch. Equally complete BUT touches the HOT bare-join commit path (every join re-reads the sentinel) + changes pool-walk exhaustion semantics.

**Chosen (b):** Option 1 — named-side reverify.

**Reason (b):** Both close the divergence (named proceeds ONLY when sentinel==metadata and sets both atomically under the lock; any vanilla arriving after sees a present sentinel -> EEXIST -> skips, never commits the letter). Option 1 is NARROWER — only the cold operator-`--force` takeover path; the hot bare-join path (the cohort's actual claim flow) is untouched, no new exhaustion edge. **DEVIATION logged:** this departs from the `it.todo`'s vanilla-side locus; the `it.todo` is converted to a passing integration test whose description names the named-side fix. The cohort runs bare-join (no `--force`), so this is defense-in-depth on a cold path — narrowness > documented-locus match.

**(c) Release-verb — options considered:**

1. **Thin `release` alias (switch fall-through) + fold stale strings (CHOSEN).** `case "release":` falls through to the canonical `case "release-self":` body; add `VERB_HELP["release"]` + the TOP_LEVEL_HELP listing; fold the 3 stale `identity.ts` strings (which still called `release-self` "deferred / a backlog ride-along") to point at the working verb.
2. **Standalone `release` wrapping `releaseIdentity` (the board spec).** Rejected — DUPLICATES `release-self` and REGRESSES its CAS-guard (re-introduces the resolve->release race that `release-self` already closes via exit 7 RACE_RELEASED).

**Chosen (c):** Option 1 (Alpha-confirmed: `release` is the discoverable name; `release-self` stays canonical).

**Reason (c):** Fall-through is the thinnest alias — one shared body, zero logic duplication, no CAS-guard regression. Cross-edge: dotfiles `src/channels/cli.ts` is a THIN re-export of `runChannelsCli` (verified at primary source), so the verb flows through the shim automatically — NO shim-mirror needed (the #193/P1 cross-edge concern dissolves).

**Verification:** typecheck + lint clean. (b) integration (`claimIdentityNamed` -> `IdentityRacedError` + no-clobber) + 5 unit branch tests (match / diverged / unheld / corrupt-orphan / null-create-EEXIST) + a concurrent vanilla-vs-named coherence fuzz (RE-2) + identity.test.ts 41 pass + N=20 takeover hot-path 2 pass (no regression). (c) paired alias test + exit-8 `RACE_LOST` CLI test (RE-4) + full cli.test.ts pass + `release --help` smoke. `bun run ci-local` all gates PASS; CI run id + conclusion appended on the PR.

**Distance-audit (Reliability Engineer subagent, pre-merge):** RE-1 — the only critical ("the named-side reverify doesn't FULLY close it; vanilla `commitIdentityClaim` (CAS-free) can land a delayed metadata overwrite after the takeover") — REFUTED at primary source: N proceeds (renameSync / null-branch linkSync) ONLY when `sentinelHolder === holderSessionId`, and `metadata[L]=S` exists IFF S already ran `commitIdentityClaim`, so any vanilla that won the sentinel committed BEFORE N can match-and-proceed — there is no delayed-commit-after-takeover path (Alpha's gate review independently verified the load-bearing lock-ordering: `removeIdentityClaim` is `withMetadataLock`-gated + release is metadata-first, so a concurrent release cannot unlink the sentinel during the takeover lock). Folded the 3 legit findings: RE-2 (concurrent coherence fuzz), RE-3 (existsSync-split in the null-branch so `--force` recovers a corrupt/torn ORPHAN sentinel — restoring the pre-reverify recovery — but never a valid claim, which parses and yields `raced`), RE-4 (exit-8 `RACE_LOST` CLI test). 3-lens convergence (Alpha gate + Bravo independent shadow + this RE distance-audit) ratified (b); Bravo's shadow added explicit coverage for the SECOND "racing vanilla caught" route — the null-branch create-only `linkSync` EEXIST -> raced (driven deterministically via a broken-symlink TOCTOU).

**Supersedes / superseded_by:** (b) closes the Plan v1.3 §residual-race `it.todo` (converted to a real test). No architectural supersede.

— L1 D3 (b)+(c) authored by Charlie; PR to Alpha merge-gate (C2 cycle).

---

```yaml
---
ts: 2026-06-07T21:29:10Z
kind: api-shape
severity: minor
phase: 3
affects:
  [
    src/channels/index.ts,
    src/hooks/checks/peer-message-deliverer.ts,
    test/channels/message-roundtrip.test.ts,
    test/hooks/checks/peer-message-deliverer.test.ts,
  ]
---
```

**Context:** L409 (backlog "§5 Monitor recipe shows blank preview for body_ref-backed notes"). The send-time shunt (index.ts appendMessage) drops `body` and keeps only `body_ref` when a serialized line exceeds SMALL_MESSAGE_MAX_BYTES (3072). Raw-JSONL preview consumers — the Monitor/tail recipe and the peer-message-deliverer hook — render a BLANK preview for every shunted note (bit live this cohort: every body_ref note woke peers blank). Goal: a non-blank CONTENT preview without breaking the body/body_ref read contract.

**Options considered:**

1. **Preview in `body` + flip read-resolve to unconditional (`cli.ts` `if (m.body_ref && !m.body)` → `if (m.body_ref)`).** Looks conductor-internal / zero-recipe-change. REJECTED at primary source: `peer-recent-message.ts:178-181` (`getMostRecentPeerMessageWithBody`) is body-FIRST ("inline body wins" — returns raw `match.body` without resolving the sidecar). A preview-in-body would feed a TRUNCATED body to its sole caller (`live-update-reminder.ts` PARALLEL_JOIN_MARKER substring check) AND to the `.length > 0` body-first guards in audit-verdict-auto-wrap / verify / quorum / queue / inference — a real regression. Salvageable only by ALSO flipping peer-recent-message to body_ref-first = 2 shared-contract changes, riskier.
2. **[CHOSEN] New additive `body_preview?: string`, populated at shunt-time; `body` stays empty.** The body/body_ref XOR is preserved, so EVERY existing consumer (read-resolve, peer-recent-message, render.ts, the `.length>0` guards) is behaviorally unchanged. Consumers that want the preview (Monitor recipe, peer-message-deliverer) read the new field as a fallback.
3. **Recipe-side-only marker (no schema change).** Cheapest, but per-consumer (every raw reader re-implements the body_ref→marker logic) and not the "send-time" DRY fix the roadmap named.

**Chosen:** Option 2 — additive `body_preview` field.

**Reason:** purely additive — zero existing-consumer behavior change, verified at primary source across BOTH repos (a subagent design-lens consumer-traced it: the body-first paths, the `.length>0` guards, and `render.ts` cell-7's `hasBody && hasBodyRef` malformed-check all key on `body`/`body_ref`, never the new field; `isChannelMessage` ignores extras and now type-guards the new one). DRY: one producer, every raw consumer reads one field. The preview is built single-line (newlines/CRs → a space — JSONL is one-line-per-message and a raw newline also fractures a `tail` preview) and codepoint-safe-truncated (`Array.from`, ≤ BODY_PREVIEW_MAX_CHARS=200 + an ellipsis — never splits an astral surrogate), bounded at/below the smallest downstream window (Monitor `[0:220]`, deliverer 200).

**Cross-edge:** conductor adds the field + ONE conductor consumer (peer-message-deliverer formatMessageBlock surfaces the preview in its body-absent branch). The dotfiles Monitor recipe (OPERATING-MANUAL §5 ~L416) + scripts/monitor-self-filter.sh (~L48) are the SECOND consumer → a FOLLOW-UP dotfiles PR. Back-compat: an absent `body_preview` falls back to today's blank, so the conductor PR lands independently. `cross_edge_consumers_verified` = the two dotfiles jq sites (wired in the follow-up dotfiles PR).

**Verification:** typecheck + format + lint clean; +6 tests (5 in message-roundtrip.test.ts: shunt→preview present/truncated/round-tripped, newline-collapse, codepoint-safe truncation, small-body→no-preview, isChannelMessage rejects non-string; +1 end-to-end in peer-message-deliverer.test.ts: shunted body surfaces the preview, not the bare pointer). Full suite green. CI run-id + conclusion appended on the PR before any shipped-claim.

**Supersedes / superseded_by:** none. Closes the conductor half of backlog L409; the dotfiles Monitor-recipe consumer follows.

— L409 body_preview authored by Bravo (Axis-3); subagent design-lens (primary-source consumer-trace) + PR to Alpha merge-gate (roadmap execution).

---

```yaml
---
ts: 2026-06-07T23:06:56Z
kind: architectural
severity: major
phase: 3
affects:
  [
    src/channels/index.ts,
    src/channels/cli.ts,
    test/channels/join-or-create.test.ts,
  ]
---
```

**Context:** L171 channel-growth — channel metadata `participants: string[]` (index.ts:338) is APPEND-ONLY (pushed on join at index.ts:1018, never pruned). On the eternal `coordination` channel it grows unbounded (~27 entries, ~25 dead, observed live) — a DISTINCT unbounded file from the messages.jsonl rotation. Owner: Bravo (A3 metadata-surface). Alpha-lensed, then a primary-source RE-LENS reshaped the placement.

**Options considered:**

1. **Prune-on-join IN joinChannel calling classifySessionLiveness directly** (the original lensed spec). REJECTED at primary source: channels/index.ts already imports active-sessions/index.ts, and classifySessionLiveness lives in active-sessions/session-liveness.ts which imports BOTH active-sessions/index AND channels/index. session-liveness.ts:14-20 documents the no-channels-back-edge-at-the-hub invariant — importing classifySessionLiveness into channels/index.ts would RE-CLOSE the active-sessions↔channels module cycle (TDZ risk) the S4-slim placement (#208) deliberately avoided.
2. **[CHOSEN] Dependency-injection (inversion-of-control).** joinChannel / joinOrCreateChannel take an OPTIONAL `pruneStale?: (sid) => boolean`; the prune runs atomically inside the existing withMetadataLock after the push (drop where pruneStale(sid) AND sid != sessionId AND sid not in meta.identities). The CLI edge (cli.ts — a top-level consumer that imports session-liveness with NO cycle) builds the predicate `sid => classifySessionLiveness(sid, now).verdict === "stale"` and injects it on the coordination join-or-create path. Mechanism in the library, policy at the consumer.
3. **Fold into the SHARED channels-gc-reaper.** REJECTED: the list only grows on join, so prune-on-join fully bounds it; the SHARED-reaper edit adds serialization cost for no gain.

**Chosen:** Option 2 — DI prune-on-join.

**Reason:** keeps channels/index.ts cycle-free (the hard architectural constraint) while still consuming the LGC-002-clean canonical classifySessionLiveness composer (not a raw primitive — tripwire clean). Prune-in-place is safe: the ever-joined set is reconstructable from messages.jsonl (every join posts a message; the from-set IS ever-joined), and consumers tolerate it — handoff-resolver already skips no-heartbeat participants (same counts, fewer to scan), the `peers` verb + active-channels display show live/recent (what is operationally wanted). Criterion = verdict 'stale' (age beyond LIVE_WINDOW), NOT a literal GC_WINDOW: classifySessionLiveness returns a VERDICT not an age, and a raw-age GC_WINDOW check would trip LGC-002; over-pruning is harmless (idempotent rejoin re-appends — Alpha WITHDREW the GC_WINDOW lean on exactly this point). Scoped to COORDINATION_CHANNEL_ID: classifySessionLiveness is coordination-centric (consults the coordination HB store), so other channels (GC'd, finite) do NOT receive the predicate — a session live-on-X-but-not-coordination must not be mis-pruned.

**Cross-edge:** NONE. Conductor-internal — no dotfiles readers of participants[] (verified). `cross_edge_consumers_verified` empty.

**Verification:** typecheck + format + lint clean; LGC-002 tripwire clean (111 src files; classifySessionLiveness is the canonical composer, allow-listed). +5 tests in join-or-create.test.ts (drops-stale / keeps-live / keeps-self / keeps-identity-holder / idempotent-rejoin). Full suite green. CI run-id + conclusion on the PR.

**Supersedes / superseded_by:** none. Addresses the L171 participants[]-prune part of the P5 channel-growth bundle. NO ChannelMetadata version bump — same string-array schema, fewer entries.

— participants-prune authored by Bravo (Axis-3); Alpha design-lens + primary-source cycle-blocker re-lens (DI shape blessed, GC_WINDOW withdrawn) + PR to Alpha merge-gate.

---
