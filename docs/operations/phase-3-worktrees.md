<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Phase 3 Slice 2 — per-session dotfiles worktrees

Phase 3 Slice 2 substrate-bakes the per-session dotfiles worktree
pattern that Bravo manually dogfooded during Slice 1. Every Claude
session, when the feature flag `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=1`
is set, gets its own `git worktree` of `~/.claude-dotfiles` at
`~/.claude-dotfiles-<sid-prefix-8>/`. This eliminates the shared-tree-bleed
class (`feedback-parallel-session-shared-tree-branch-race.md`) in which
two concurrent Claude sessions stomp each other's branch checkouts and
staged files.

This runbook covers what fires when, the verbatim error drafts each hook
emits, and the 10 operator scenarios for working with the substrate.

**Audience:** operators running Claude with per-session worktrees,
debugging a stuck worktree, or recovering from a Stop-hook miss.

**Prerequisites:**

- Phase 2 hooks runbook (`docs/operations/phase-2-hooks.md`) for the
  baseline hook firing-order + breadcrumb + presence-failure-log
  conventions.
- Phase 3 Slice 1 kill-switch runbook (`docs/operations/phase-3-kill-switch.md`)
  for the env-var disable model the FFF flag composes with.

**Default state:** OFF. The feature flag must be explicitly set to `"1"`
to provision worktrees. The default-on flip is a separate follow-up
commit on main, scheduled after Bravo's first-dogfood ack.

---

## Architecture (1-minute read)

Three new bundled hooks fire on the lifecycle:

```
session-start  → dotfiles-worktree-provisioner   (provisions + anchor-pins)
session-start  → dotfiles-worktree-gc            (reaps orphans)
stop           → dotfiles-worktree-cleanup       (removes session's worktree)
```

The provisioner writes a sentinel into the **canonical-claude-home
heartbeat body** (`~/.claude/active-sessions/<canonical-claude-home>/heartbeats/<sid>`)
recording `dotfilesRoot: <worktree-path>`. The resolver (`src/shared/dotfiles-root.ts`)
reads this sentinel via the 4-tier precedence chain:

1. `CLAUDE_DOTFILES_ROOT` (operator override; highest priority)
2. heartbeat-body sentinel (per-session worktree)
3. `DOTFILES_ROOT` (legacy; deprecated, breadcrumb emitted once)
4. `${HOME}/.claude-dotfiles` (default)

Slash commands prepend an `eval` of `claude-conductor session
resolve-dotfiles-root` so they `cd` to the same worktree the hooks
resolve to (D-ARCH5).

---

## Verbatim error drafts

Each hook emits breadcrumbs to the shared presence-failure log
(`~/.claude/logs/.presence-gate-failures.log`). Format: symptom /
diagnose / recover.

### E-1 — `git worktree add` failure: branch already checked out

```
[worktree-provisioner] Cannot provision ~/.claude-dotfiles-<sid>/:
  symptom:    `git worktree add` exited 128 — "fatal: '<branch>' is already checked out"
  diagnose:   another worktree (likely a stale orphan) holds this branch.
              `git worktree list` shows the conflicting entry.
  recover:    `git worktree remove <orphan-path>` from the canonical, then
              re-run session-start. Or set CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=0
              for this session to fall back to canonical.
```

### E-2 — `git worktree add` failure: disk full

```
[worktree-provisioner] Cannot provision ~/.claude-dotfiles-<sid>/:
  symptom:    `git worktree add` exited 128 — "fatal: ENOSPC: no space left on device"
  diagnose:   df -h shows < 1 GB free on the volume hosting `~`.
  recover:    free disk space; or `claude-conductor worktrees gc --force` to
              reap stale worktrees. Session continues against canonical.
```

### E-3 — `git worktree add` failure: lock conflict

```
[worktree-provisioner] Cannot provision ~/.claude-dotfiles-<sid>/:
  symptom:    `git worktree add` exited 128 — "fatal: cannot lock ref '<ref>'"
  diagnose:   another git operation in canonical holds the ref. Look for
              stale `.git/index.lock`.
  recover:    wait 30s; or `rm <canonical>/.git/index.lock` if no live
              process holds it (verify via `lsof`).
```

### E-4 — `git worktree add` failure: dirty canonical

```
[worktree-provisioner] Cannot provision ~/.claude-dotfiles-<sid>/:
  symptom:    canonical is mid-rebase / mid-merge / has stale lock.
  diagnose:   `cd ~/.claude-dotfiles && git status` shows merge / rebase
              in progress.
  recover:    complete the operation (commit / abort / continue); re-run
              session-start. Worktree provisioning refuses while canonical
              is in a transitional state.
```

### E-5 — heartbeat-body sentinel write fail

```
[worktree-provisioner] Worktree provisioned, but sentinel write failed.
  symptom:    setSentinelDotfilesRoot() threw EACCES / EIO / EDQUOT.
  diagnose:   `ls -la ~/.claude/active-sessions/` — verify writable + space.
  recover:    session continues; resolveDotfilesRoot() falls through to env
              / default. Worktree exists but session won't auto-resolve to
              it. Fix permissions and re-fire session-start, or set
              CLAUDE_DOTFILES_ROOT manually.
```

### E-6 — GC reaper sweep error

```
[dotfiles-worktree-gc] Sweep error on <worktree-path>:
  symptom:    `git worktree remove` exited non-zero, OR safety guard
              refused, OR forensic marker active.
  diagnose:   guard message names the trigger (.git/index.lock /
              node_modules/.bun-tmp-* / forensic marker).
  recover:    forensic marker — rm `~/.claude/session-state-forensic/<sid>`
              when inspection done. Lock files — wait or verify via `lsof`.
              True error — `claude-conductor worktrees gc --force` overrides
              guards (operator-acknowledged risk).
```

### E-7 — Stop-hook cleanup error

```
[dotfiles-worktree-cleanup] Cleanup failed for ~/.claude-dotfiles-<sid>/:
  symptom:    removeWorktree() returned kind: "error" with detail.
  diagnose:   common cause: operator has open shell or editor in the
              worktree (busy fd).
  recover:    close shells/editors; GC reaper retries on next session-start.
              Or `claude-conductor worktrees gc --force` to reap immediately.
```

### E-8 — heartbeat-body parse failure

```
[dotfiles-root-resolver] Sentinel JSON parse failed for session <sid>:
  symptom:    JSON.parse(heartbeatBody) threw; resolver fell through to
              env / default; emit kind: "sentinel-corrupt".
  diagnose:   inspect ~/.claude/active-sessions/<canonical-claude-home>/heartbeats/<sid>
              — corrupt or partial write.
  recover:    delete the malformed heartbeat file; touchHeartbeat() rebuilds
              on next dispatcher fire. Session may briefly resolve to
              canonical until heartbeat re-establishes.
```

---

## Runbook scenarios

10 depth-3 scenarios covering common operator situations.

### 1. Disable for this session (operator override)

**Symptom:** operator wants to skip the worktree for this session (testing,
diagnosing a substrate issue, etc.).

**Diagnose:** verify the flag state via `env | grep CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES`.

**Recover:**

```bash
unset CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES
export CLAUDE_DOTFILES_ROOT=$HOME/.claude-dotfiles
# Then start Claude. Both kill switches stack — flag-off OR explicit
# env-override land you at canonical.
```

### 2. Wedged worktree recovery

**Symptom:** worktree exists but git ops in it fail unpredictably.

**Diagnose:**

```bash
cd ~/.claude-dotfiles-<sid>
git status
claude-conductor worktrees show <sid>   # full state inspector
```

**Recover:**

```bash
# Force-remove from canonical:
git -C ~/.claude-dotfiles worktree remove --force ~/.claude-dotfiles-<sid>
# Clear the registry entry:
claude-conductor unregister-active <sid>   # or wait for GC reaper next session-start
```

### 3. Missed cleanup (manual GC trigger)

**Symptom:** Stop-hook didn't fire (kill -9, OOM kill, sudden power loss).

**Diagnose:** stale worktree dirs in `~/`, no live session owning them.

**Recover:**

```bash
claude-conductor worktrees gc --force
# OR wait for next session-start auto-sweep (5-min rate-gate; up to 60min
# heartbeat-stale threshold for the worktree to become eligible for reap).
```

### 4. Migrate uncommitted work from worktree to canonical

**Symptom:** session ended with uncommitted work in the worktree, want to
preserve it.

**Recover:**

```bash
cd ~/.claude-dotfiles-<sid>
git stash push -u "session <sid> uncommitted"
cd ~/.claude-dotfiles
git stash list   # find the entry from above
# If branches share state:
git stash pop
# Else (worktree had its own branch named worktree/<sid-prefix>):
git checkout worktree/<sid-prefix>
git stash pop
# Then merge or cherry-pick into your target branch.
```

### 5. SID collision (provisioning to existing path)

**Symptom:** provisioner reports `kind: "exists"` and the operator didn't
expect a worktree at that path.

**Diagnose:**

```bash
cat ~/.claude-dotfiles-<sid-prefix>/.git/HEAD   # shows the branch
git -C ~/.claude-dotfiles worktree list         # confirms registration
```

**Recover:**

- If from a prior crashed session of the same SID — reuse via the existing
  worktree (the provisioner's idempotent re-run path).
- If unrelated, rename and re-provision:

```bash
git -C ~/.claude-dotfiles worktree move ~/.claude-dotfiles-<sid-prefix> ~/.claude-dotfiles-<sid-prefix>-archived
# Then re-fire session-start.
```

### 6. Provision failure

**Symptom:** session-start emits a `[worktree-provisioner]` breadcrumb;
session continues against canonical.

**Diagnose:** match the breadcrumb against E-1 / E-2 / E-3 / E-4 / E-5
above.

**Recover:** per the matching error draft.

### 7. GC-reaped while active (forensic recovery)

**Symptom:** operator wants to inspect a worktree that the GC reaper might
sweep before they're done.

**Recover:**

```bash
mkdir -p ~/.claude/session-state-forensic
touch ~/.claude/session-state-forensic/<sid-prefix>
# Now inspect freely — reaper sees the marker and skips.
# When done:
rm ~/.claude/session-state-forensic/<sid-prefix>
# Next reaper pass cleans up the worktree.
```

### 8. Feature-flag flip-revert recovery

**Symptom:** Nick reverts the default-on flip; live worktrees orphan.

**Recover:**

```bash
unset CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES   # in shell rc + current session
claude-conductor worktrees gc --force          # reap orphans + clear sentinels
# If the flag is exported in shell rc, edit and source it.
```

### 9. Working from a second terminal

**Symptom:** operator opens a second terminal mid-session, types
`cd ~/.claude-dotfiles && git status`, sees canonical state — panics
("where did my changes go?").

**Diagnose + recover:**

```bash
# Find the session's worktree:
claude-conductor worktrees show <sid>
# OR query the resolver directly:
eval "$(bun run ~/claude-conductor/src/cli/resolve-dotfiles-root.ts --session-id <sid>)"
echo $CLAUDE_DOTFILES_ROOT_RESOLVED
cd $CLAUDE_DOTFILES_ROOT_RESOLVED
```

The Stop-hook epilogue echoes a similar pointer in the session-end output:

```
[dotfiles-worktree-cleanup] removed ~/.claude-dotfiles-<sid>/. If you have
other terminals in that path, see runbook §"Working from a second terminal"
for recovery.
```

**Polish backlog:** `worktree-shell-ps1-hint` adds a prompt indicator when
CWD is a worktree.

### 10. Fresh-install bootstrap

**Symptom:** first run on a new machine.

**Recover:**

```bash
# install.sh creates ~/.claude/active-sessions/ and other coordination
# substrate. First session-start writes the heartbeat which carries the
# dotfilesRoot sentinel field.
~/.claude-dotfiles/install.sh
# Verify after first session-start:
claude-conductor worktrees show <sid>
```

If the active-sessions dir doesn't exist at first session-start, the
provisioner's setSentinelDotfilesRoot creates it on the fly.

---

## Operational notes

### Time Machine exclusion (macOS)

Sibling-at-home worktrees scale Time Machine backup volume linearly with
worktree count (each worktree's working copy gets backed up every hour).
Recommend excluding to keep backups tractable:

```bash
tmutil addexclusion -p $HOME/.claude-dotfiles-*
# Glob may need iteration; verify via:
tmutil isexcluded ~/.claude-dotfiles-94a8058c
```

The canonical `~/.claude-dotfiles` is NOT excluded — that holds your
real configuration history.

### Path-walk discipline

Tools that detect "I'm in a dotfiles-shaped dir" should rely on git-root
walk + repo-name match, NOT a hardcoded `~/.claude-dotfiles/` literal.
Hardcoded literal-path checks misbehave inside a worktree because the
worktree path differs from canonical. The Slice 2 dotfiles-sync.ts drift
fix (per Bravo B7) replaces a literal-path read with `dotfilesRoot()` to
avoid this class of bug.

### Hard-vs-soft ceiling

The provisioner emits a soft-ceiling reminder at 20 live worktrees but
proceeds. The hard guarantee is GC reaper steady-state convergence:
worktrees that age past 60 minutes without an active heartbeat are
swept on the next session-start (rate-gated 5-min). Steady-state count
converges to live-session count + max ~1 grace tick.

If operators consistently hit the soft ceiling, the polish backlog item
`worktree-ceiling-configurable` exposes the limit as
`CLAUDE_CONDUCTOR_WORKTREE_CEILING` env var.

### Mixed flag-state across concurrent sessions

If the provisioner detects live peers without `dotfilesRoot` sentinels
(i.e., they're running with the flag off while we're running with the
flag on), it emits an informational reminder. The runbook recommendation:
**set the flag globally in shell rc; do not toggle mid-day.** Mixed-state
sessions don't break each other but produce confusing behavior — peers
edit different working trees with no shared lock domain.

---

## Where the breadcrumbs land

All worktree-related breadcrumbs go through `appendPresenceFailure` →
`~/.claude/logs/.presence-gate-failures.log`. Filter by `kind`:

| `kind`                        | Source hook(s)                                  |
| ----------------------------- | ----------------------------------------------- |
| `worktree-provision-failed`   | provisioner                                     |
| `worktree-gc-reaped`          | gc reaper                                       |
| `worktree-cleanup-failed`     | gc reaper, cleanup (skip-on-guard + true error) |
| `worktree-cleanup-incomplete` | gc reaper, cleanup (reconciliation guard)       |
| `sentinel-corrupt`            | resolver (heartbeat-body parse fail)            |
| `deprecation`                 | resolver (legacy DOTFILES_ROOT, emit-once)      |

Filter:

```bash
tail -200 ~/.claude/logs/.presence-gate-failures.log | grep '"kind":"worktree-'
```

Phase-2 SessionStart briefing surfaces recent failures automatically.

---

## Cross-references

- Plan: `~/.claude/plans/curious-whistling-sparrow.md` REV 0.2.
- Worktree primitive: `src/worktrees/index.ts`.
- Resolver: `src/shared/dotfiles-root.ts`.
- Hooks: `src/hooks/checks/dotfiles-worktree-{provisioner,gc,cleanup}.ts`.
- CLI verbs: `src/cli/resolve-dotfiles-root.ts`, `src/cli/worktrees-show.ts`.
- Active-sessions extensions: `src/active-sessions/index.ts` §Phase 3
  Slice 2 (4 new exports + OwnerRecord schema).
- Decisions: `decisions/phase-3.md` (D-ARCH1 / D-ARCH3 / D-ARCH5 /
  D-CLIDX3 / D-CLIDX4 / D-RE6).
- Memory: `feedback-parallel-session-shared-tree-branch-race.md`
  (RESOLVED 2026-04-30 — substrate prevents the failure mode).
