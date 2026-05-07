---
description: Create a session handoff document — captures completed work, decisions, failed approaches, and next steps so a fresh Claude session can seamlessly continue.
---

# /handoff — Create a session handoff document

Generate a structured handoff document that captures everything a fresh Claude session needs to seamlessly continue this work.

---

## Wind-down rules

Three composing rules govern wind-down. Read these before any action.

**Rule 1 (DEFAULT)** — the wind-down checklist runs first; the handoff is the LAST artifact. Composed sequence:

1. Commit + push remaining work-output (durable, can't be lost from here)
2. Wait for explicit stop signal from the operating user (Rule 3)
3. Run any verification or polish steps the wind-down checklist surfaces (CI watch, follow-up fixes, recap evidence capture)
4. Write the handoff (bookend artifact, captures complete final state)
5. Then: infrastructure tear-down (close channels, stop Monitors, etc.) per Rule 3

**Rule 2 (EXCEPTION)** — for long/high-risk sessions where reconstruction-loss > ~30 min, run `/handoff` TWICE — once early (before resuming long-running work, between audit cycles, or whenever session-fresh reasoning becomes hard to reconstruct) AND once at the end per Rule 1. The early invocation captures decisions, rejected approaches, and audit findings that exist only in conversation history; the final invocation captures complete final state. Triggers: ≥2h substantive work; audit cycles or multi-persona reasoning; risky environment; decisions/rejected-approaches that exist only in conversation history.

**Rule 3 (ALWAYS)** — do not tear down active session infrastructure (Monitors, open channels, background bash, watchers, working-tree branches not yet merged) until the operating user explicitly signals stop. Asking "what's next?" while simultaneously closing the channel is a sequencing mistake. Boundary case: if asked "what's next?" and you guess wind-down, ASK before tearing down.

For deeper rationale: see `memories/feedback-wind-down-ordering.md`.

---

## Step 0: Determine wind-down tier (Quick vs Full)

Default to FULL. Choose QUICK only when ALL of these hold:

- read-only or ≤1 small edit
- no PRs, no plan, no peer coordination
- session was a quick fix or status check

Borderline = FULL; cost asymmetry favors over-recording — Quick that should have been Full loses context; Full that should have been Quick costs ~10 min.

If FULL, run Step 0.5 next. If QUICK, skip directly to Step 1 (Steps 0.5 and 0.6 are FULL-only).

**FULL tier runs:**

- Steps 0.5 → 1–8
- Memory anchor review (any session-fresh patterns / corrections / decisions worth memorializing?)
- Todo file write
- Host substrate's commit-summary write (if applicable)
- Monitor + channel teardown — ONLY on explicit stop signal per Rule 3

**QUICK tier runs:**

- Step 1 (analyze)
- Step 2.5 (CI verification block — only if anything was pushed)
- Step 4 (brief 3–5 line summary)
- Step 5 (SESSION_LOG append)
- Step 6 (LATEST.md symlink)
- Skips: backlog scan, todo file, Monitor/channel teardown, host substrate's commit-summary regen

If ambiguity remains after applying the criteria, surface the chosen tier to the operating user before proceeding to Step 0.5/Step 1.

For tier criteria detail: see `memories/feedback-tiered-wind-down.md`.

---

## Step 0.5: Backlog consolidation (FULL tier only)

Before any handoff-document step fires, scan the project's backlog artifact (whichever tracks debt — `wiki/backlog.md`, `~/backlog.md`, GitHub Issues, etc.) for items related to today's work.

**Search keywords:**

- file paths from today's git diff
- memory file names from today's `entries_touched` (telemetry)
- PR numbers + commit SHAs
- plan file basenames + audit doc basenames
- slice/item identifiers from today's queue

**For each match:**

- **Resolved** → mark `[x]` + prefix with `RESOLVED <date> via <PR/SHA evidence>`. Existing convention: prepend a HIGH-PRIORITY UPDATE block above older content, do not delete the original (preserves evidence trail).
- **Sibling touched** → cross-link new artifact, update prerequisite language (e.g., `~~prereq~~ CLEARED <date>`).
- **New debt surfaced** → file new entry referencing today's audit doc / plan / PR. Cross-reference back from existing entries that should know about it.

For deeper rationale: see `memories/feedback-wind-down-backlog-consolidation.md`.

---

## Step 0.6: Sanity check before proceeding

Before continuing to Step 1, confirm Step 0 has been answered (and Step 0.5 has run if tier=FULL). If either is missing, run them now.

---

## Step 1: Analyze the conversation

Review the full conversation and extract:

- **Goal**: What task or feature was being worked on
- **Completed work**: Specific files created, modified, or deleted — with paths and what each change does
- **Decisions**: Key choices made and why, including alternatives that were considered and rejected
- **Failed approaches**: What was tried and didn't work, and why (this section is **mandatory** — write "None this session" if nothing failed)
- **Current state**: What's working, what's broken or incomplete
- **Open questions**: Anything unresolved or blocked
- **Next steps**: Prioritized, actionable items with specific files/commands where possible

## Step 2: Capture git state

If the working directory is a git repo, run:

```bash
echo "=== Branch ===" && git branch --show-current
echo "=== Uncommitted ===" && git status --short
echo "=== Recent commits ===" && git log --oneline -10
```

Include the results in the handoff. Skip this step if not in a git repo.

## Step 2.5: Capture CI state — MANDATORY when this session pushed any branch

If this session ran `git push` to any branch with an open PR (or pushed to `main`), CI verification is part of the handoff payload. The handoff must answer "did this code actually land green?" not just "was it transmitted?" — see CLAUDE.md §"After Every Push — CI verification is mandatory."

For each branch this session pushed:

```bash
gh run list --branch <branch> --limit 1 --json databaseId,status,conclusion,headSha \
  --jq '{branch: "<branch>", run: .[0].databaseId, sha: .[0].headSha, status: .[0].status, conclusion: .[0].conclusion}'
```

Include the JSON output in the handoff under a "## CI verification" section. If `status` is anything other than `completed` (e.g., `in_progress`, `queued`), the handoff is **NOT READY TO WRITE** — wait for completion via `gh run watch <id> --exit-status`, then capture the conclusion. **Do not write the handoff in a "CI pending" state without flagging it loudly to the user as an unverified claim.**

If `conclusion` is anything other than `success` (e.g., `failure`, `cancelled`, `timed_out`), the handoff must:

- Title-line the failure: "Phase / Slice X — CI RED on <branch> at <sha>"
- Document the failing job + first error in the handoff body's failure section
- Treat any "shipped / merged / landed / done" claim about the affected commits as PROVISIONAL until the failure is resolved

Skip this entire step if no `git push` was issued this session.

## Step 3: Read session telemetry

If `~/.claude/sessions/<session_id>.json` exists (written by the `session-telemetry-tracker` PostToolUse hook), read it and include its fields as YAML frontmatter at the top of the handoff file (before the `# Handoff:` title). This gives the next session a machine-readable snapshot of what was touched and which verifications ran.

Fields to emit:

- `session_id` — passthrough
- `started_at` — passthrough
- `ended_at` — set to the handoff write timestamp (ISO-8601)
- `entries_touched` — list of memory files modified this session (relative paths)
- `verifications_run` — list of `{cmd, ts, exit_code?}` entries

Skip the frontmatter entirely if the telemetry file is missing or unreadable — this must never block handoff creation.

## Step 4: Write the handoff document

Write the handoff to `~/.claude/handoffs/HANDOFF_YYYY-MM-DD_HH-MM.md` using the current timestamp.

The **Next Steps** block must point to the durable todo file written in Step 4.5, not duplicate its contents. Use a single marker line like:

```markdown
## Next Steps

<!-- generated, edit ~/.claude/todos/<handoff-id>.md instead -->

See: `~/.claude/todos/<handoff-id>.md` (active items authoritative there)
```

This prevents drift between the handoff body and the todo file — the todo file is the single source of truth.

Use this template — **adapt to the session**. Sections with nothing to report get a single line ("None"), not an empty scaffold. Omit the Git State section entirely if not in a repo. Include the telemetry YAML frontmatter (from Step 3) only when telemetry data exists.

```markdown
---
session_id: <id>
started_at: <iso-8601>
ended_at: <iso-8601>
entries_touched:
  - path/to/memory-file.md
verifications_run:
  - { cmd: "bun test", ts: "<iso-8601>", exit_code: 0 }
---

# Handoff: [Brief Descriptive Title]

**Date:** YYYY-MM-DD HH:MM
**Working directory:** /path/to/project
**Branch:** branch-name

## Summary

2-3 sentences: what we were doing and where we got to.

## Completed

- `/path/to/file.ts` — description of what was done and why
- `/path/to/other.sh` — description...

## Decisions

| Decision       | Rationale | Alternatives Rejected      |
| -------------- | --------- | -------------------------- |
| Chose X over Y | reason    | Y because..., Z because... |

## Failed Approaches

- Tried X -> didn't work because Y
  (Mandatory — write "None this session" if nothing failed)

## Current State

**Working:** what's functional right now
**Broken/incomplete:** what still needs work

## Git State

- Branch: `branch-name`
- Uncommitted changes: list or "clean"
- Recent commits: last 3-5 relevant commits

## Next Steps

1. First priority — specific and actionable
2. Second priority
3. Third priority

## Open Questions

- Unresolved question or decision...
```

## Step 4.5: Write the durable todo surface

Derive the handoff ID from the filename: `HANDOFF_2026-04-19_11-30.md → 2026-04-19_11-30`.

Build a `TodoFile` JSON payload from the final TaskList state at end-of-session:

- `handoffId` — the ID above (must match the argv passed in step 2 of the write).
- `active` — items still open (TaskList entries where status ∈ { `pending`, `in_progress` }).
- `done` — items completed in this session (status `completed`).
- `generatedBy` — `"/handoff @ <ISO-8601 timestamp>"`.

Write it via the CLI (atomic temp+rename under the hood):

```bash
eval "$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --session-id "${CLAUDE_SESSION_ID:-}" 2>/dev/null || true)"
cd "${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}"
echo "$JSON_PAYLOAD" | bun run src/todos/cli.ts write "<handoff-id>"
```

Then verify the file exists and the active count round-trips:

```bash
bun run src/todos/cli.ts count-active "<handoff-id>"
```

**Failure modes — fail loud, do not swallow:**

- CLI non-zero: surface stderr to the user and abort the handoff. Do not proceed to Step 5 with a half-written todo file.
- Count mismatch: report the discrepancy verbatim and stop.

The todo file survives context compaction and is the single source of truth that `/handoff-resume` reads next session.

## Step 4.6: Post channel closing message (if a channel is live)

If the session has been participating in a channel whose ID equals `<handoff-id>`, post a final `status` message so any peer sees the handoff marker before the channel ages into GC:

```bash
printf '%s' "session wrapping up — handoff written at ~/.claude/handoffs/HANDOFF_<handoff-id>.md; todo file at ~/.claude/todos/<handoff-id>.md" \
  | CLAUDE_SESSION_ID="<session-id>" bun run src/channels/cli.ts send "<handoff-id>" status
```

Skip silently if no channel exists for this handoff ID — not every session uses the parallel workflow.

This step MUST NOT close the channel (`channel close`). GC will archive it after 72h of silence; an explicit close is the peer's call, not the handoff's.

## Step 5: Append to SESSION_LOG.md

Read `~/.claude/handoffs/SESSION_LOG.md` (create it if it doesn't exist). Append a condensed entry at the bottom:

```markdown
---

## YYYY-MM-DD HH:MM — [Brief Title]

**Dir:** /path/to/project | **Branch:** branch-name
What was done. Key decisions and why. What failed (or "nothing failed").
What's queued next. [Full handoff →](HANDOFF_YYYY-MM-DD_HH-MM.md)
```

Rules:

- **Append only** — never overwrite or modify existing entries
- **3-5 lines** per entry, focused on outcomes, decisions, and failures
- Link to the full handoff file for drill-down
- No empty sections — if the session was trivial, the entry can be 2 lines
- Write as if someone will read this 3 months from now to understand the arc of work

## Step 6: Update LATEST.md

`LATEST.md` is a symlink, not a file. It must be managed exclusively via the Bash tool with `ln -sf` (which does an atomic unlink+symlink when the target exists). Do NOT use the Write or Edit tools on `LATEST.md` — those write through the symlink and silently overwrite whichever handoff it currently points to, corrupting the previous session's handoff.

```bash
rm -f ~/.claude/handoffs/LATEST.md
ln -sf "/path/to/HANDOFF_YYYY-MM-DD_HH-MM.md" ~/.claude/handoffs/LATEST.md
```

The unconditional `rm -f` is belt + suspenders: `ln -sf` alone is sufficient for regular files and symlinks, but `rm -f && ln -sf` is defensive against any state (including directory or hardlink) the path could land in.

This is what `/handoff-resume` reads by default.

**Why this matters:** an earlier /handoff run treated `LATEST.md` as a content file and clobbered the previous handoff through the symlink (filed as instance 5 of the [[Coordination Substrate Gaps]] cluster, 2026-04-21). A PreToolUse hook enforces this rule by refusing Write/Edit on symlinked paths under `~/.claude/handoffs/`, but the skill must still express the invariant clearly.

## Step 7: Write the dotfiles session summary

Write a condensed 2-4 sentence version of the summary to `${CLAUDE_DOTFILES_ROOT_RESOLVED:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}/.session-summary`. This gets used as the git commit message body when the dotfiles Stop hook runs.

## Step 8: Confirm

Tell the user:

- The handoff file path
- A one-line summary of what was captured
- Remind them: "Run `/handoff-resume` in a new session to pick up where we left off."

**DO NOT tear down channel/Monitor/background tasks unless the operating user has explicitly signaled stop. See Wind-down rules Rule 3.**

After the operating user signals stop (and not before), proceed to: close any open channels via `/channel close`, stop Monitors, terminate background bash. The skill is "done" at that point.

---

## Constraints

- Be specific: file paths, function names, line numbers — not vague descriptions
- Be concise: every word should earn its place. Target under 1000 words unless the session truly warrants more.
- Show code only when a snippet is essential for the next session to understand context (API shape, error message, config value)
- Never include full file contents — the next session can read them
- Failed approaches are the most valuable section — they prevent wasted effort. Do not skip or minimize this.
- Never run `/handoff` without first completing Step 0 (tier) + Step 0.5 (backlog if FULL).

---

## See also

Paths below are plugin-rooted; resolve via `${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/`. (Bundled memories use "Pairs with" for the same concept; this skill uses "See also" per `decisions/phase-5.md` Decision F.)

- `memories/feedback-signoff-checklist.md` — discipline rationale (never bare `/handoff`)
- `memories/feedback-wind-down-ordering.md` — full ordering rules + 5-step composed sequence
- `memories/feedback-tiered-wind-down.md` — tier criteria detail
- `memories/feedback-wind-down-backlog-consolidation.md` — backlog scan procedure
- `memories/feedback-encode-while-context-fresh.md` — already plugin-bundled; pairs with Full-tier memory anchor review
