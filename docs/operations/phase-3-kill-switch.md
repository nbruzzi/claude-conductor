<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Phase 3 — `CLAUDE_CONDUCTOR_DISABLE_HOOKS` operator runbook

Phase 3 Slice 1 ships the universal **dispatcher kill-switch**: the `CLAUDE_CONDUCTOR_DISABLE_HOOKS` environment variable, an emergency-stop primitive for operators in a multi-hook wedge or cascading-failure incident. This runbook is the operator reference for the env-var's syntax, semantics, composition with profile-filter and `--check=NAME` isolation, debug breadcrumbs, recovery scenarios, and footguns.

**Audience:** operators triaging hook failures during a Claude Code session — when an individual hook is misbehaving, when multiple hooks are wedged, or when the operator wants to disable a class of hooks for a specific workflow without editing config files.

**Prerequisites:**

- Phase 2 mental model: see [`phase-2-hooks.md`](phase-2-hooks.md) for the hook lifecycle, failure-mode classification, and per-hook recovery procedures.
- Architecture: see [`../architecture/hooks-layer.md`](../architecture/hooks-layer.md) for firing-order taxonomy + composition rules.

---

## Syntax

```
export CLAUDE_CONDUCTOR_DISABLE_HOOKS=<hook-name>[,<hook-name>...]
```

- **Comma-separated** list of hook names.
- **Whitespace-tolerant**: `" foo , bar , "` parses identically to `"foo,bar"`.
- **Trailing-comma tolerant**: `"foo,bar,"` parses identically to `"foo,bar"`.
- **Case-sensitive**: hook names are identifiers (e.g., `destructive-cmd` not `Destructive-Cmd`).
- **Re-read per-fire**: every Claude Code hook event spawns a fresh dispatcher process, so updating the env var via `export` mid-session takes effect on the next hook fire (subject to shell-inheritance — Claude Code's spawn-parent shell determines visibility).
- **Empty / unset**: same effect — no hooks disabled. Setting to an empty string or commas-only (`""` / `","` / `",,,"`) is treated as a misconfiguration and surfaces a fail-loud breadcrumb (see §Empty-list semantics).

## What it does

When the dispatcher boots for any hook event, the parser reads the env var, validates each name against the full sealed registry (union across all events), and:

1. **Adds matching names to `disabled`** — the dispatcher skips those hooks for this event invocation, surfacing the skip via `--verbose` and the `[env-disabled]` tag in `--list` / `--dry-run`.
2. **Reports unknowns + cross-event mismatches** — names that don't match any check, or match a check on a different event than the current dispatcher invocation, go to stderr + breadcrumb (see §Debug breadcrumbs). The dispatcher continues with whatever valid disables it found (**fail-OPEN with breadcrumb**, never exit-2).
3. **Emits a louder per-dispatch warning when blocking hooks are env-disabled** — `destructive-cmd`, `pre-commit`, `task-coordinator`, etc. (`canBlock=true`). The kill-switch allows this — emergency disable is unfettered — but the warning is loud on every dispatch as the audit trail substitute. See §Blocking-hook policy.

## Composition rule (canonical)

The env-var-disable list composes with profile-filter and `--check=NAME` isolation in this order:

1. **Profile-filter applies first** (set by `HOOK_PROFILE` env var — `minimal` / `standard` / `strict`).
2. **Env-var-disable applies second** (set by `CLAUDE_CONDUCTOR_DISABLE_HOOKS`).
3. **`--check=NAME` isolation applies third** (manual CLI only — see below).

A check is skipped if **any** of (1), (2), (3) excludes it. Tag-stacking in `--list`: a check that is BOTH profile-disabled AND env-disabled shows `[disabled by profile,env]` (not just `[disabled]`) so the operator can disambiguate which filter applies.

**File-toggle kill-switches** (`~/.claude/<hook-name>-off`, `~/.claude/test-gate-on`) compose orthogonally — each individual hook checks them in its own `check()` body. The env-var-disable list **trumps these**: if the env var lists `test-gate`, the dispatcher skips it before the hook's `check()` body runs, so the file-toggle is never read.

## `--check=NAME` override scope (manual CLI only)

`--check=NAME` is a CLI flag that **Claude Code does NOT pass** when invoking the dispatcher for live hook events. The override semantic ONLY applies to manual operator invocations like:

```bash
bun run ~/.claude-dotfiles/src/hooks/dispatcher.ts pre-tool-use --check=channels-gc-reaper --tool=Bash
```

**Live Claude Code traffic re-reads the env var and applies kill-switch normally.** To run an env-disabled hook against live traffic, unset the env var (or remove that hook from its comma list).

## Blocking-hook policy

Blocking hooks (`canBlock=true`) include:

| Hook                          | Event        | What it gates                                  |
| ----------------------------- | ------------ | ---------------------------------------------- |
| `destructive-cmd`             | pre-tool-use | `rm -rf`, force-push, etc.                     |
| `sensitive-files`             | pre-tool-use | Writes to `.env` / `credentials.json`          |
| `pre-commit`                  | pre-tool-use | Typecheck/format/lint/tests before commit      |
| `branch-enforcement`          | pre-tool-use | 4th protected-branch edit without scope        |
| `handoff-symlink-write-guard` | pre-tool-use | Writes to handoff symlinks                     |
| `fact-force`                  | pre-tool-use | Fact-force scope discipline                    |
| `config-protection`           | pre-tool-use | Writes to `~/.claude/` config                  |
| `session-collision-gate`      | pre-tool-use | Tool dispatch under conflicting active session |
| `task-coordinator`            | pre-tool-use | Task dispatch under role=out                   |

The kill-switch **allows disabling these** — emergency disable is unfettered. When a blocking hook is env-disabled, the dispatcher emits a **louder per-dispatch stderr warning** (repeated on every dispatch until the env var is cleared) plus a persistent breadcrumb at `~/.claude/logs/.presence-gate-failures.log` with `kind: "kill-switch"` for post-incident audit.

If you want to disable a blocking hook **with explicit acknowledgement** (audit trail in the filesystem rather than env state), use the per-hook file kill-switch:

```bash
touch ~/.claude/destructive-cmd-off    # hook reads this in check()
```

The per-hook file approach leaves a durable file in your home directory that you (or future-you) will see when listing `~/.claude/`. The env-var approach is ephemeral — clear the env var, hook is back.

## Debug breadcrumbs via `appendPresenceFailure`

Every misuse of the kill-switch is logged as a breadcrumb event. Operators can tail the log to debug what their env var is doing:

- **Log location:** `~/.claude/logs/.presence-gate-failures.log` (JSONL — one event per line).
- **Per-line shape:** `{timestamp, sessionId, source, kind, artifactPath, detail}`. Paths are HOME-redacted to `~/...` form before write so the log can travel across hosts safely.
- **Source = `"dispatcher"`** for all kill-switch breadcrumbs (Phase 3 Slice 1 added this `PresenceFailureSource` variant).
- **Kind = `"kill-switch"`** for all kill-switch breadcrumbs (Phase 3 Slice 1 added this `PresenceFailureKind` variant).

### Reading the kill-switch breadcrumbs

```bash
# Live tail of dispatcher kill-switch events:
tail -f ~/.claude/logs/.presence-gate-failures.log | jq 'select(.source == "dispatcher" and .kind == "kill-switch")'

# Last 10 kill-switch events:
tac ~/.claude/logs/.presence-gate-failures.log | jq -r 'select(.source == "dispatcher" and .kind == "kill-switch") | "\(.timestamp) \(.detail)"' | head

# Group by detail content (recurring misconfigs):
tail -100 ~/.claude/logs/.presence-gate-failures.log | jq -r 'select(.kind == "kill-switch") | .detail' | sort | uniq -c | sort -rn
```

### Breadcrumb taxonomy

The dispatcher emits one breadcrumb per error class encountered (not per env-var set). For a single env value `"foo,bar,destructive-cmd"` where `foo` is unknown, `bar` is cross-event, and `destructive-cmd` is blocking:

- 1 breadcrumb for unknown(s): `unknown hook name(s): foo`
- 1 breadcrumb for cross-event: `cross-event hint(s) for current event "<event>": bar`
- 1 breadcrumb for blocking: `BLOCKING hook(s) disabled by env var: destructive-cmd`

## How to spot a malformed `CLAUDE_CONDUCTOR_DISABLE_HOOKS` (Bravo's visibility section)

Operators not in the habit of tailing the breadcrumb log won't notice a stale-malformed env var that was set ages ago. Plus stderr in a noisy session can scroll past unseen.

**Symptom**: hooks you expected to be disabled are still firing, OR hooks you didn't intend to disable seem to be skipped (partial-success parse where some names are valid + some are unknown).

**Diagnose:**

```bash
# What's currently set?
echo "$CLAUDE_CONDUCTOR_DISABLE_HOOKS"

# Recent kill-switch parse-failures (from the dispatcher source):
tail -50 ~/.claude/logs/.presence-gate-failures.log | jq 'select(.source == "dispatcher")'

# What is kill-switch currently filtering for THIS event?
bun run ~/.claude-dotfiles/src/hooks/dispatcher.ts pre-tool-use --list 2>&1 | grep '\[env-disabled\]'
```

**Recover:**

```bash
# Re-set with corrected names (no spaces, exact names, comma-separated):
export CLAUDE_CONDUCTOR_DISABLE_HOOKS="prefer-bun,fact-force"

# OR: clear entirely:
unset CLAUDE_CONDUCTOR_DISABLE_HOOKS
```

**Verify:**

```bash
bun run ~/.claude-dotfiles/src/hooks/dispatcher.ts pre-tool-use --list
# → [env-disabled] tags appear on the intended subset only.
# → No new "dispatcher / kill-switch" breadcrumb in the next dispatch.
```

## Empty-list semantics (fail-loud)

Setting `CLAUDE_CONDUCTOR_DISABLE_HOOKS` to an empty value or commas-only (`""` / `","` / `",,,"`) defeats the loud-fail premise — the operator might think they "armed" the kill-switch when nothing is disabled. The parser detects this and emits:

```
[dispatcher] CLAUDE_CONDUCTOR_DISABLE_HOOKS is set but resolved to empty disable list (after trim/split).
  No hooks disabled. Set to a comma-separated list of hook names or unset the variable.
```

Plus a breadcrumb with `detail` matching that line. Recovery: either set a valid comma-separated list or `unset` the variable.

## Cross-event hint

When the env var contains a hook name that's valid in the registry but doesn't run on the dispatcher's current event, the parser surfaces a hint:

```
[dispatcher] CLAUDE_CONDUCTOR_DISABLE_HOOKS contains "channels-gc-reaper" but it does not run on the current event "pre-tool-use".
  This name is valid for: session-start.
  No effect on this event; the disable will apply when dispatcher fires for session-start IF the env var is still set at that time.
```

The hint emits to stderr **on every event dispatch** where it applies (one per dispatcher process; per-event re-read). Operators who find this noisy after recognizing the placement can either remove the cross-event name from the env list or redirect dispatcher stderr in their session. The breadcrumb log preserves the cross-event signal regardless of stderr filtering.

## Recovery scenarios (depth-3: symptom / diagnose / recover / verify)

### Scenario 1 — multi-hook wedge during incident

**Symptom:** Multiple hooks are misbehaving (e.g., `pre-commit` + `branch-enforcement` + `fact-force` are all blocking unrelated edits during an emergency hotfix). Per-hook recovery (`touch ~/.claude/<name>-off` for each) is too slow.

**Diagnose:** confirm which hooks are firing by running

```bash
bun run ~/.claude-dotfiles/src/hooks/dispatcher.ts pre-tool-use --list
```

**Recover:**

```bash
export CLAUDE_CONDUCTOR_DISABLE_HOOKS="pre-commit,branch-enforcement,fact-force"
```

Take the action (the hotfix). Then:

```bash
unset CLAUDE_CONDUCTOR_DISABLE_HOOKS
```

**Verify:** run the dispatcher again with `--list`; the `[env-disabled]` tags should be gone. The next live edit should re-engage the blocking hooks.

### Scenario 2 — unknown name typo (fail-open)

**Symptom:** You set the env var but the expected hook is still firing. Stderr on **every dispatch** (every tool call, every SessionStart, every Stop event) shows `unknown hook name` — the warning repeats per-fire because the dispatcher re-reads the env var per process. Re-checking via `--list` is faster than waiting for the next event.

**Diagnose:** the parser logs all unknown names + Levenshtein-1 fuzzy "did you mean" suggestions. Re-read the stderr or check breadcrumbs:

```bash
tail -10 ~/.claude/logs/.presence-gate-failures.log | jq 'select(.kind == "kill-switch") | .detail'
```

**Recover:** correct the typo:

```bash
export CLAUDE_CONDUCTOR_DISABLE_HOOKS="channels-gc-reaper"   # was "channels-gc-reapr"
```

**Verify:** the stderr no longer shows the unknown-name warning; `--list` shows `[env-disabled]` on the intended hook.

### Scenario 3 — cross-event mismatch

**Symptom:** You set `CLAUDE_CONDUCTOR_DISABLE_HOOKS=channels-gc-reaper` but tool calls are still triggering the cross-event hint message in stderr.

**Diagnose:** the hook runs on `session-start`, not `pre-tool-use`. The dispatcher fires per-event; on `pre-tool-use` invocations, `channels-gc-reaper` is correctly cross-event-hinted (won't fire there anyway, since it doesn't run on that event). On `session-start` invocations, it's actually disabled.

**Recover:** if the noise is undesired, accept the hint as informational. If you want to silence the per-dispatch line, you can `unset` and rely on the per-hook file kill-switch (`touch ~/.claude/channels-gc-reaper-off`) which is event-scoped.

**Verify:** run a session-start dispatch (`/resume`) and confirm `channels-gc-reaper` shows `[env-disabled]` in `--list`.

### Scenario 4 — empty env var leaves you confused

**Symptom:** `--list` shows no `[env-disabled]` tags despite you having set the env var.

**Diagnose:** run `echo "$CLAUDE_CONDUCTOR_DISABLE_HOOKS"`. If empty, the parser correctly didn't disable anything. Check breadcrumbs for "set but resolved to empty disable list" — that's the fail-loud signal.

**Recover:** set the env to a real comma-separated list, OR `unset` if you didn't mean to set it.

**Verify:** `--list` should now show the intended `[env-disabled]` tags.

## Operational notes

- **Env var is process-level, not session-level.** Every `bun run dispatcher.ts ...` is a new process; env is read fresh each time. To make a kill-switch persist for the duration of your session, `export` it. To make it survive `/resume`, set it in your shell profile (`~/.zshrc` / `~/.bashrc`) — but be careful: a persistent kill-switch in your profile is easy to forget about and can mask production hook behavior for weeks.
- **Stderr emits on every dispatch.** When the env var is malformed (typo, cross-event, blocking-disable, empty-after-trim), the warning repeats on every hook fire — every tool call, every SessionStart, every Stop. This is intentional ("loud-on-every-fire" — fail-open with persistent visibility). If you have a real typo and are editing 50 files in 30 seconds, you'll see 50× repeated stderr; this is by design, not a bug. To silence repeated noise, fix the env var or `unset` it. A future `CLAUDE_CONDUCTOR_DISABLE_HOOKS_QUIET=1` opt-out is filed in the Phase 3 polish backlog.
- **CI exposure**: if your CI workflow inadvertently inherits this env var (from a runner image or agent env), pre-commit / test-gate / branch-enforcement could be silently disabled in CI. Phase 3 polish backlog includes a `CI=true` loud-warning enhancement; until then, audit your CI env explicitly.
- **Telemetry / observability**: deferred to Phase 3 polish backlog. No metric currently tracks how often the kill-switch is engaged.

## References / See also

- **Phase 1+2 mental model:** [`docs/operations/phase-2-hooks.md`](phase-2-hooks.md) §Per-hook recovery + §Debug breadcrumbs.
- **Architecture:** [`docs/architecture/hooks-layer.md`](../architecture/hooks-layer.md) §Firing order + §Failure-mode classification.
- **Decision log:** [`decisions/phase-3.md`](../../decisions/phase-3.md) — Decision A (env-var primitive choice) + Decision B (composition + emergency-disable policy + catalog discoverability) + Decision C (parser-vs-dispatcher cross-edge split).
- **Plan:** `~/.claude/plans/curious-whistling-sparrow.md` REV 1.1 — full Phase 3 Slice 1 spec.
- **Source:**
  - Parser primitive: [`src/shared/disable-hooks.ts`](../../src/shared/disable-hooks.ts)
  - Tests: [`test/shared/disable-hooks.test.ts`](../../test/shared/disable-hooks.test.ts)
  - Registry primitives: [`src/hooks/registry.ts`](../../src/hooks/registry.ts) (`allCheckNames` / `allBlockingNames` / `nameToEvents`)
  - Dotfiles dispatcher integration: `~/.claude-dotfiles/src/hooks/dispatcher.ts`
- **Presence-failure log schema:** [`src/shared/presence-failure-log.ts`](../../src/shared/presence-failure-log.ts) — Phase 3 Slice 1 added `"dispatcher"` source + `"kill-switch"` kind.
- **File an issue:** https://github.com/nbruzzi/claude-conductor/issues with the relevant breadcrumb log + the env-var value attached.
