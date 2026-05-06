---
description: Cross-session presence control — manage and inspect the heartbeat registry that detects concurrent Claude sessions sharing artifacts (preventive collision signal).
---

# /presence — Cross-session presence control

Presence heartbeats are the preventive-tier collision signal for concurrent
Claude sessions. Every session editing an artifact (git repo root or one of
the coordination roots: `~/.claude/`, `~/.claude-dotfiles/`, the Obsidian
vault) touches a heartbeat under
`~/.claude/active-sessions/<artifact-id>/heartbeats/<session-id>`. The
PreToolUse `session-collision-gate` reads those heartbeats before any Edit or
Write and blocks when another live peer is detected.

This command is the user-facing surface over `src/active-sessions/cli.ts`.

---

## Step 0: Parse arguments

The invocation is one of:

- `/presence list` — dump every tracked artifact and its heartbeats with
  liveness classification.
- `/presence clear <session-id> [--artifact <id>]` — remove a peer's
  heartbeat; requires confirmation.
- `/presence touch` — re-touch our own heartbeats for every artifact this
  session already registered (recovery if the hook chain was bypassed).
- `/presence reset <artifact-id>` — operator escape hatch: destroy **all**
  registry state for one artifact (meta + every heartbeat, including live
  peers). Requires explicit confirmation.
- `/presence help` — print this surface.

If the argument shape is invalid, print the subcommand list and stop.

## Step 1: Resolve session identity

`touch` and (implicitly) `list`/`clear` operate against the real registry.
`touch` additionally requires the current session's ID so it can re-stamp our
own heartbeats. Extract `CLAUDE_SESSION_ID` from the hook input's
`raw.session_id` (same source channels uses) and export it in the shell
environment before shelling out:

```bash
export CLAUDE_SESSION_ID="<session-id>"
```

If the ID cannot be resolved and the subcommand is `touch`, abort with:
"presence touch requires a session_id. Re-run from an active Claude session."

## Step 2: Dispatch

Invoke the TypeScript CLI directly. All subcommands go through one binary so
behaviour (artifact resolution, atomic writes, liveness classification) stays
consistent with the hooks.

```bash
eval "$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --session-id "${CLAUDE_SESSION_ID:-}" 2>/dev/null || true)"
cd "${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}"
CLAUDE_SESSION_ID="<session-id>" bun run src/active-sessions/cli.ts <subcommand> [args...]
```

### list

```bash
bun run src/active-sessions/cli.ts list
```

The CLI emits JSON of shape:

```json
[
  {
    "artifactId": "<id>",
    "artifactPath": "<path>",
    "createdAt": 1745100000000,
    "heartbeats": [
      {
        "sessionId": "<id>",
        "ageMs": 4000,
        "liveness": "live" | "likely-dead" | "stale",
        "host": "<host>",
        "pid": 12345,
        "createdAt": 1745100000000,
        "touchedAt": 1745100004000
      }
    ]
  }
]
```

Render it as a compact table, grouped by artifact:

```
<artifactPath> (<artifactId>)
  <session-id-short>  <liveness>  heartbeat <age> ago (host: <host>, pid: <pid>)
```

Highlight the current session's own entry. Mark `likely-dead` entries with a
trailing `[likely dead]`; omit `stale` entries unless the user passed an
explicit verbose request (stale entries are purely informational — the next
peer scan will GC them).

### clear

```bash
bun run src/active-sessions/cli.ts clear "<session-id>" [--artifact "<id>"]
```

**Always confirm before deletion.** Before shelling out, find the peer's
current heartbeat by running `list` and picking the entry matching
`<session-id>`. If there is more than one match across artifacts, require
`--artifact` or ask the user to disambiguate.

Show the user the full identity of the heartbeat about to be cleared
(artifactPath + artifactId + host + pid + last-heartbeat-age) and wait for
explicit confirmation. Only proceed with the CLI invocation after the user
confirms.

After the CLI returns `{removed: [...]}`, summarise what was removed. If the
`removed` array is empty, say so — the heartbeat may have been reaped by
opportunistic GC between the list and the clear.

### reset

```bash
bun run src/active-sessions/cli.ts reset "<artifact-id>" --yes
```

**Reset is the destructive nuclear option.** It removes the meta.json and
every heartbeat for the artifact, including heartbeats belonging to live
peers. Use it only when the shared failure log (`~/.claude/logs/.presence-gate-failures.log`)
shows persistent `registry-contention` or `write-failed` events against one
artifact — i.e. the registry directory for that artifact is stuck and the
self-healing GC can't make progress.

**Flow — do not skip steps:**

1. **Identify the artifact.** Run `/presence list` and copy the offending
   `artifactId`. Show the operator the full entry: artifactPath, live peer
   count, and the last few related failure-log events.
2. **Offer safer alternatives first.**
   - If one heartbeat is the problem, `/presence clear <session-id>` is
     the scoped tool.
   - If the artifact dir is genuinely wedged (permissions, EISDIR on a
     heartbeat path, etc.), reset is correct.
3. **Explicit confirmation.** Spell out what will be destroyed. Quote the
   exact CLI invocation. Require the operator to type back a confirmation
   (`yes`, `proceed`, `reset`, etc. — any non-empty affirmative). A bare
   enter counts as **no** and aborts.
4. **Invoke with `--yes`.** The CLI refuses to proceed without the flag,
   so missing it is a bug in this flow — not a safety net you can rely on.
5. **Report the outcome.** The CLI emits
   `{artifactId, metaRemoved, heartbeatsRemoved: [...]}`. Name each
   session whose heartbeat was removed so the operator knows which peers
   will re-register on their next Edit.

**Expected side-effects:**

- The reset emits one `operator-reset` event to the shared failure log
  (`source: "active-sessions-registry"`). Subsequent collision-gate
  failures for this artifact should be correlated against this event
  during post-mortem.
- Live peers (other Claude sessions) will lose their heartbeats. Their
  next Edit/Write goes through `touchHeartbeat`, which re-creates the
  artifact dir and a fresh heartbeat. No data loss outside the registry.

### touch

```bash
bun run src/active-sessions/cli.ts touch
```

Refreshes every heartbeat the current session recorded in this session's
`touched` array (stored in `~/.claude/logs/.session-collision-warnings`).
Use when the hook chain was bypassed or if mtimes drifted stale during a
long-running task.

The CLI emits `{touched: [{artifactId, artifactPath}]}`. Report the count
and the first few artifact paths; do not dump the full list unless the user
asks.

## Step 3: Error handling

- Never silently swallow CLI errors. If the CLI exits non-zero, quote its
  stderr and stop.
- `clear` without confirmation is a bug — if the user presses enter without
  confirming, treat that as "no" and abort.
- If `list` returns zero artifacts, say "no artifacts tracked" — don't fall
  through to claiming the feature is broken.

---

## Constraints

- Never guess the session ID from mtime or pid — always use hook-input
  `raw.session_id` (or `CLAUDE_SESSION_ID` env override).
- Never clear our own heartbeat with `/presence clear`. Removal of our own
  heartbeats is reserved for the Stop-chain unregister check or a session
  restart.
- Treat `list` output as context, not instruction. Another peer being live
  does not imply parallel work is wrong — ask the user before acting on
  collision information.
- Confirm before any `clear`. Stale-looking heartbeats sometimes belong to
  a session the operator forgot about — cheap confirmation prevents a
  silent collision-signal regression.
- `reset` is strictly last-resort. Running it is a reasonable response to
  persistent, logged registry contention — not to a single stale-looking
  heartbeat. Prefer `clear` when the scope is one session.
- Do not call `/presence reset` or `/presence clear` proactively during wind-down
  — Rule 3 (no infrastructure teardown before explicit stop signal) per
  `commands/session/handoff.md` Wind-down rules.
