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
