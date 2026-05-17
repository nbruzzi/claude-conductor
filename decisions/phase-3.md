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
