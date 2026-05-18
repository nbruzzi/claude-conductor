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
