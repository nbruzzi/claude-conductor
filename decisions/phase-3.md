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
