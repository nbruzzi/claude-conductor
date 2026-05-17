---
description: Resume from a previous session's handoff — reads LATEST handoff, checks for git drift, briefs the user, supports parallel-mode for cross-session coordination.
---

# /handoff-resume — Resume from a previous session's handoff

Pick up where a previous session left off using a handoff document.

---

## Step 0: Parse arguments

Check for a mode argument on the slash-command invocation.

- **`parallel`** — the user is opening a secondary window while another session is actively working elsewhere (same repo or a different one). The purpose is **context-only**: load memories, brief the user, then stop. Do NOT execute next steps, do NOT propose fixes for drift, do NOT touch files. Explicitly acknowledge the parallel session in the briefing and in the final ask.
- **no arg** (default) — standard resume. Continue with Steps 1–5 as written.

Other args are ignored (warn the user once, then proceed as default).

Set a local flag for the rest of the skill:

- `MODE = "parallel"` if the arg is `parallel`
- `MODE = "default"` otherwise

### Step 0a: Pre-load common deferred tools

The Claude Code harness defers most tool schemas — only tool names appear in the session-start system prompt; full schemas must be loaded via `ToolSearch` before the tool is callable. Skills that ALWAYS enter plan mode and manage TaskList shouldn't have to ask for those schemas after-the-fact. Make a single `ToolSearch` call up front to pre-load the common batch:

- **Default mode** — call `ToolSearch` with this exact query:

  ```
  select:EnterPlanMode,ExitPlanMode,TaskCreate,TaskUpdate,TaskList,LSP
  ```

  Six tools: plan-mode scoping (`EnterPlanMode` / `ExitPlanMode`), TaskList rehydration in Step 5a (`TaskCreate` / `TaskUpdate` / `TaskList`), and code intelligence (`LSP`, per CLAUDE.md's "LSP-first over Grep" tool-priority rule).

- **Parallel mode** — same six PLUS `Monitor` (single call, seven tools total):

  ```
  select:EnterPlanMode,ExitPlanMode,TaskCreate,TaskUpdate,TaskList,LSP,Monitor
  ```

  The `Monitor` schema is loaded here so Step 4a can arm it without a round-trip once peer presence is confirmed. **Step 0a does NOT arm Monitor.** Arming follows the rule in `feedback-arm-symmetric-monitor-at-resume.md`: arm AFTER determining a peer is on the channel, which happens in Step 4a (`channel meta` / `peers`). Pre-loading the schema here is purely an optimization for the eventual arming call.

**Response handling — what success looks like:**

- A `ToolSearch` response containing schemas for one or more tools is success. Proceed to Step 1.
- A response of `"No matching deferred tools found"` (or an equivalent empty result) is ALSO success — it just means every name in the `select:` list was either already loaded or unrecognized by the current harness version. Do NOT retry, do NOT abort; proceed to Step 1.
- A genuine transport/network error from `ToolSearch` (rare): log briefly and proceed to Step 1 anyway. The skill works without the pre-load; degraded performance is preferable to abort. Any tool that failed to pre-load falls back to the original after-the-fact `ToolSearch` pattern when that tool is first called.

**Silent batch load — no chat output, no progress message, no "loading tools..." announcement.** Setup, not signal. Proceed directly to Step 1.

---

## Step 1: Find the handoff and load history

Check for `~/.claude/handoffs/LATEST.md`.

- If it exists, read it silently.
- If it doesn't exist, list all files in `~/.claude/handoffs/` and ask the user which one to resume from.
- If the directory is empty or doesn't exist, tell the user: "No handoffs found. Nothing to resume."

Also read `~/.claude/handoffs/SESSION_LOG.md` if it exists. This is a running log of all past sessions — use it for broader context. Don't dump the whole log in the briefing, but note how many prior sessions are logged and reference any past entries that are relevant to the current handoff's work.

### Step 1a (default only): Concurrent-pair detection

`LATEST.md` is a single symlink — if two sessions end within minutes of each other on different work, whichever wrote last wins and the other is silently buried. Step 1a catches that case and offers a picker before proceeding.

**Skip this step entirely when `MODE == "parallel"`** — the user has explicitly declared another session is live, so LATEST is treated as historical context and the picker semantics don't apply.

**Error discipline (safety net).** The entire Step 1a scan runs under a try/catch equivalent. Any unexpected exception (YAML parse failure, race with a peer rename, unreadable file, filesystem oddity) is logged as a single line — `handoff-resume: Step 1a scan error — falling back to LATEST (<reason>)` — and the skill proceeds exactly as it would have before Step 1a existed. Step 1a is a safety net; it must never make `/handoff-resume` worse than the single-session baseline.

**LATEST sanity check.** Before any scan:

1. Resolve `~/.claude/handoffs/LATEST.md`. If the symlink is broken (target missing) or resolves outside `~/.claude/handoffs/`, skip Step 1a and fall through to Step 1's "list all handoffs, ask user" path.
2. Verify the resolved target is a regular readable file.

**Anchor selection.** Read LATEST's frontmatter. Two paths, both valid — no silent skip:

- **Frontmatter path (strong rule).** LATEST carries valid `session_id`, `ended_at` (ISO-8601 parseable via `Date.parse`), and `entries_touched` (an array, possibly empty). Use these as the anchor.
- **Degraded mtime path.** Any required field missing, unparseable, or wrong type → fall back to a scan anchored on LATEST's **file mtime**. This is the dominant legacy case — every handoff before `2026-04-18_10-06.md` has zero frontmatter, and the write path still tolerates missing telemetry. Silently skipping in that case would reintroduce the exact silent-burial bug Step 1a was written to fix. Announce the degraded mode in the picker header. Disjointness cannot be evaluated without `entries_touched` → treat all mtime-window candidates as vacuously disjoint (over-flag is the safe direction).

**Candidate scan.** List `~/.claude/handoffs/HANDOFF_*.md` whose mtime is within the last 6 hours (cheap pre-filter only; authoritative window is `ended_at` ±10 min when present). Cap at the 10 most-recent by mtime. Exclude LATEST's resolved target from the candidate set.

For each candidate:

1. **Torn-read guard.** If the candidate's mtime is within the last 5 seconds, a mid-write race is likely. Wait 250ms and re-read frontmatter once before deciding.
2. Parse frontmatter inside a try/catch. A parse failure on a single candidate skips that candidate (logged via the safety-net line) but never aborts the scan.
3. **Qualify as a concurrent peer when ALL hold:**
   - **session** — on frontmatter path: `session_id` is present, parseable, and differs from LATEST's; on degraded path: treat every mtime-window candidate as potentially concurrent (over-flag accepted).
   - **time** — on frontmatter path: `ended_at` is within **10 minutes** of LATEST's `ended_at` in either direction; on degraded path: candidate mtime is within 10 minutes of LATEST mtime.
   - **disjointness** — on frontmatter path: `entries_touched` is disjoint from LATEST's (no path appears in both sets; empty sets count as disjoint — vacuously); on degraded path: treat as disjoint by default.

**Behavior when at least one peer qualifies.** Present a picker listing LATEST and every qualifying peer.

- **Ordering.** LATEST is always `[1]`. Peers follow in `ended_at` descending order (most recently finished peer at `[2]`); on degraded path, ordering falls back to mtime descending.
- **Per-row fields:**
  - **Title** — first `# Handoff:` heading from the file (or filename if missing).
  - **dir** — value of the `**Working directory:**` field in the handoff body.
  - **next** — first item of the `## Next Steps` section, trimmed to one line (≤80 chars).
  - **touched** — 2–3 file basenames from `entries_touched` (if present), comma-separated. This is the disambiguation axis: two peers with similar titles are distinguished by the files they worked on. Omit on degraded path or when `entries_touched` is empty.
  - **ended** — frontmatter `ended_at`; on degraded path, label the row `mtime:` instead and use the file mtime.

Format (frontmatter path):

```
Two recent handoffs look like parallel sessions (different work, finished around the same time). Which were you in?

[1] <title>
    dir: <working-dir>
    next: <first-next-step>
    touched: <basename1, basename2, basename3>
    ended: <ended_at>

[2] <title>
    dir: <working-dir>
    next: <first-next-step>
    touched: <basename1, basename2>
    ended: <ended_at>

[0] None of these — list all handoffs and let me pick manually

Which one?
```

Degraded-path header reads instead: `Recent handoffs without telemetry — possible parallel sessions. Which were you in?` and row labels use `mtime:` in place of `ended:`.

**Handling the user's pick.**

- `[N]` where 1 ≤ N ≤ row count → that row's handoff becomes the **active handoff**.
- `[0]` → fall through to Step 1's "list all files in `~/.claude/handoffs/`, ask user which one to resume from" path. The user is now outside the picker and in full control.
- Any other response → re-display the picker once with a one-line nudge: `Pick a number [0–N].` Do NOT auto-substitute on a second off-pattern response; keep asking.

**Active-handoff binding.** Once picked, rebind the variables the rest of the skill uses so downstream steps operate on the picked handoff, not on LATEST:

- `active_handoff = handoffs[N].path`
- `HANDOFF_DATE = handoffs[N].ended_at` (or `handoffs[N].mtime` on degraded path) — this is the value Step 2's `git log --since="HANDOFF_DATE"` substitutes.
- `HANDOFF_BRANCH = <read from the handoff body's **Branch:** field>` — used by Step 2's drift check.

Step 2 drift check, Step 3 briefing, and Step 5 TaskList rehydration all operate on `active_handoff`.

**Step 3 briefing addendum.** When Step 1a fired (the user saw the picker), prepend one line to the Step 3 briefing so the pick is visible and auditable:

> **Picked:** [N of M] — `<active handoff title>`. Others: `<sibling titles, comma-separated>`.

**Behavior when no peer qualifies.** Proceed silently with LATEST as the active handoff — no picker, no user interruption. The default single-session flow is unchanged.

**Why these thresholds:**

- **10 minutes** matches observed evidence — concurrent-session handoffs on 2026-04-19 were ~60s apart; 10 min gives margin for slow handoff writes on either side.
- **6-hour mtime pre-filter** bounds scan cost without tying the primary qualification to mtime (which syncs/touches can bump). `ended_at` is authoritative when present.
- **Degraded mtime path is load-bearing, not a fallback** — every legacy handoff lacks frontmatter and the write path keeps producing frontmatter-less files when telemetry is unavailable at session end. Silently skipping in that case reintroduces the original silent-burial bug; the degraded path is the whole point of Step 1a robustness.
- **Disjoint `entries_touched`** is the strongest positive signal — two handoffs touching the same files are almost certainly a same-session retry, not a concurrent pair. Empty-set counts as disjoint (vacuously): over-flag (user picks trivially) beats silent burial.

## Step 2: Check for drift

If the handoff references a git repo and we're in one, check whether the state has changed since the handoff was written:

```bash
echo "=== Current branch ===" && git branch --show-current
echo "=== Uncommitted ===" && git status --short
echo "=== Commits since handoff date ===" && git log --oneline --since="HANDOFF_DATE"
```

Flag any drift:

- Different branch than the handoff expected
- New commits not mentioned in the handoff
- Uncommitted changes not documented in the handoff

**If `MODE == "parallel"`:** drift is **informational only** — assume another session is the cause. Report it in Step 3 framed as observation, never as a problem to fix.

## Step 3: Brief the user

Present a concise summary:

> **Resuming: [Handoff Title]**
> **From:** [date]
> **Goal:** [1-sentence goal from handoff]
> **Status:** [X of Y items completed]
> **Next up:** [first item from Next Steps]
> **Drift:** [any drift detected, or "None — state matches handoff"]

**If `MODE == "parallel"`:** prepend `**Mode:** parallel — context load only, no actions will be taken.` to the briefing, and reframe drift as `Observed (likely parallel session): …` rather than flagging it as something to reconcile.

## Step 4: Wait for confirmation

**If `MODE == "default"`:** ask "Resume from here, or would you like to adjust the plan?" — Do NOT start working until the user confirms.

**If `MODE == "parallel"`:** ask "Context loaded. I won't touch anything while your other session is active. What would you like to work on?" — then stop and await the user's next message. Do NOT proceed to Step 5.

### Step 4a (parallel only): open / join the channel

Before waiting on the user, derive `channel-id = channelIdFromHandoff(handoff-path)` and open a channel for coordination with the other session. Only run after confirming parallel mode.

```bash
eval "$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --session-id "${CLAUDE_SESSION_ID:-}" 2>/dev/null || true)"
cd "${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}"

# L141 — resolve the handoff to its active channel.
# Emits JSON {kind, ...} discriminating four outcomes:
#   - derived-active: derived channel has live peers; join it.
#   - derived-empty-no-body-refs: nothing live; create/join the derived id.
#   - mismatch-body-has-live-alternative: closeout-handoff case — surface the
#     mismatch to the user so they can switch to the live channel.
#   - derive-failed: handoff missing or malformed; abort Step 4a.
resolution="$(bun run src/channels/cli.ts resolve-handoff "$handoff_path")"
resolution_kind="$(printf '%s' "$resolution" | python3 -c 'import sys, json; print(json.load(sys.stdin)["kind"])')"

case "$resolution_kind" in
  derived-active | derived-empty-no-body-refs)
    channel_id="$(printf '%s' "$resolution" | python3 -c 'import sys, json; print(json.load(sys.stdin)["channelId"])')"
    ;;
  mismatch-body-has-live-alternative)
    # Render warning + candidate list. Default action: join the derived id
    # anyway (preserves single-flow happy path); user can switch manually.
    derived_id="$(printf '%s' "$resolution" | python3 -c 'import sys, json; print(json.load(sys.stdin)["derivedChannelId"])')"
    printf '\n⚠ Step 4a: derived channel `%s` has no live peers, but the handoff body\n' "$derived_id"
    printf '  names channels with live peers:\n\n'
    printf '%s' "$resolution" | python3 -c '
import sys, json
data = json.load(sys.stdin)
for c in data["candidateChannels"]:
    print(f"    - `{c[\"id\"]}` ({c[\"peers\"]} live peer{\"\" if c[\"peers\"] == 1 else \"s\"})")
'
    printf '\n  Joining the derived channel anyway (current default).\n'
    printf '  To switch: `/channel join <id>` (pick one of the above).\n\n'
    channel_id="$derived_id"
    ;;
  derive-failed)
    printf '\n⚠ Step 4a: handoff resolution failed — skipping channel open.\n%s\n\n' "$resolution"
    channel_id=""  # signals "no channel open" to the downstream guards below
    ;;
  *)
    printf '\n⚠ Step 4a: unexpected resolution kind `%s`; falling back to from-handoff.\n' "$resolution_kind"
    channel_id="$(bun run src/channels/cli.ts from-handoff "$handoff_path")"
    ;;
esac

# Skill markdown isn't a single shell invocation — each fenced block is
# reasoned about separately. Guard create/join + status-post on a non-empty
# channel_id so a `derive-failed` resolution (channel_id="") doesn't try to
# meta/create/join an empty id. Step 4a aborts cleanly; downstream Step 4b
# still runs but with no channel context.
if [ -n "$channel_id" ]; then
  if ! CLAUDE_SESSION_ID="$session_id" bun run src/channels/cli.ts meta "$channel_id" > /dev/null 2>&1; then
    CLAUDE_SESSION_ID="$session_id" bun run src/channels/cli.ts create "$channel_id" "$channel_id"
  else
    CLAUDE_SESSION_ID="$session_id" bun run src/channels/cli.ts join "$channel_id"
  fi

  # Post a "status: joined — parallel context load" message so any peer sees us.
  printf '%s' "joined channel in parallel context-load mode; no writes this session" \
    | CLAUDE_SESSION_ID="$session_id" bun run src/channels/cli.ts send "$channel_id" status
fi
```

Surface the channel ID in the briefing: "Channel `<id>` — peer status: `<live|online|stale|unknown>` (from `/channel peers`)." If channel creation fails, flag the error and continue — the parallel briefing still completes.

**L141 mismatch — what to render in the briefing.** When `resolve-handoff` returns `mismatch-body-has-live-alternative`, the bash block prints a warning + candidate list before joining the derived channel. Reproduce that warning in the parallel-mode briefing (Step 3 output) so the user sees the mismatch clearly when they read your reply. The default action is to join the derived channel anyway; the user's call is whether to issue `/channel join <id>` against an alternative.

**Identity continuity (P2 — `--as <Identity>`).** When this resume should preserve a NATO identity letter from a prior cycle (the prior session's audit threads, handoff body, or channel artifacts named a specific letter — Alpha, Bravo, etc.), pass `--as <Identity>` to the join call above instead of bare `join`. If the named letter is held by another session (the prior holder's heartbeat is still alive but their session ended), add `--force` to take over via atomic sentinel replacement. Optional `--from-session <prior-uuid>` adds a CAS check so the takeover refuses if the holder isn't the expected session. See `commands/session/channel.md` `### join` → "Recovery flow for parallel-session resume" for the full flag matrix; the legacy 4-step recovery dance is documented there too for substrate-pinned CLI versions older than `--as`.

### Step 4b (parallel only): expect a `live-update` from the active peer

After posting the `joined` status in Step 4a, **wait briefly for the active peer (the session that wrote the handoff and is still alive) to post a `kind: live-update` message on the channel.** That message carries the live state-of-the-world the handoff cannot — what the active peer is doing right now, what scope you should pick up, what's hands-off — bridging the long-arc handoff (frozen at write-time) and the live channel.

The active peer's `handoff` skill (the writer side) and a `live-update-reminder` UserPromptSubmit hook prompt them to post this within seconds of seeing your `joined`. You should:

1. Wait ~30s after Step 4a for the live-update to arrive (poll the channel; do not start work yet).
2. When it lands, parse the body via `parseLiveUpdateBody` (importable as `claude-conductor/channels/live-update`). Treat the parser-returned `LiveUpdateBody` as the **authoritative scope assignment** for this resume — NOT the handoff body, which cannot anticipate which sibling picks up which slice.
3. If no live-update arrives within ~30s, post a `kind: question` on the channel asking the active peer to specify your scope. Do not guess.

**Why this matters:** the handoff is the long-arc structured record; the channel is live coordination; before L152 there was no protocol step bridging them at sibling-join. Without `live-update`, work-division falls back to Nick relaying via cross-window screenshot-shuttle — the failure mode `feedback-pipeline-is-recursive-research-at-every-level.md` and `[[Parallel Session Coordination Convention]]` are designed to remove. Per the verification-budget convention: trust the SHAPE the parser returns; primary-source-verify any SHA / PR / backlog citation in the fields before acting on them.

**Body schema (4 keys, JSON-serialized):**

- `kind_version: 1`
- `since_handoff` (string or null) — commits / memories / decisions / scope-shifts since handoff write-time
- `current_focus` (non-empty string) — what active peer is doing right now
- `your_scope` (non-empty string) — what the sibling should pick up first
- `hands_off` (non-empty string; use `"none"` literal when nothing is off-limits) — what NOT to touch

## Step 5: Execute with context

**Skipped entirely when `MODE == "parallel"`.**

### Step 5a: Rehydrate the durable todo surface

Derive `handoff-id` from the filename (strip `HANDOFF_` and `.md`). Before picking up any next-step item, rehydrate the TaskList from the todo file:

```bash
eval "$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --session-id "${CLAUDE_SESSION_ID:-}" 2>/dev/null || true)"
cd "${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}"
handoff_id="<derived-id>"

if bun run src/todos/cli.ts exists "$handoff_id"; then
  bun run src/todos/cli.ts read-active "$handoff_id"
fi
```

**Imperative rehydration — exhaustive, verbatim, no summarization:**

> Parse the output line by line. For **every** line emitted by `read-active`, emit exactly **one** `TaskCreate` call using the line text verbatim as the `subject`. Do NOT summarize, merge, paraphrase, or skip items. Do NOT infer priority order beyond file order. If the text contains markdown, keep the markdown.

**Reconciliation — fail loud on mismatch:**

```bash
bun run src/todos/cli.ts count-active "$handoff_id"   # expected
```

After all `TaskCreate` calls, count the tasks you just created. If `created != expected`, abort the resume with:

> Rehydrate incomplete: `<N>` items expected, `<M>` created. Todo file preserved at `~/.claude/todos/<handoff-id>.md`. Re-run `/handoff-resume` or hand-edit the file before proceeding.

If `read-active` or `count-active` fails (exit non-zero, unreadable file, etc.): do **not** start with an empty TaskList. Surface:

> Todo file at `~/.claude/todos/<handoff-id>.md` unreadable. Hand-inspect before continuing.

**Mid-session contract:** once rehydration completes, the TaskList is authoritative. All mutations go through `TaskCreate` / `TaskUpdate`. The todo file is not read or written mid-session; the next `/handoff` overwrites it from final TaskList state.

### Step 5b: Proceed with next steps

Once confirmed (default mode only):

- Start with the first item in the rehydrated TaskList (which mirrors **Next Steps**)
- Respect **Failed Approaches** — do not retry anything documented as failed unless the user explicitly asks
- Respect **Decisions** — do not revisit choices unless the user raises them
- If **Open Questions** exist, raise them early before they become blockers
- Read any files referenced in **Completed** to rebuild your understanding of the current code state

---

## Constraints

- Never start working before the user confirms
- If drift is significant (different branch, major new commits), warn clearly and ask how to proceed — **except in `parallel` mode, where drift is always informational**
- Treat the handoff as context, not gospel — if something in it contradicts what you see in the code, trust the code and flag the discrepancy
- In `parallel` mode: no writes, no commits, no branch changes, no fixes. Observation + context only.
