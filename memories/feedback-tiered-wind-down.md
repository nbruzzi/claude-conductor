---
name: Two-tier wind-down — Quick vs Full
description: Wind-down has two tiers. Quick (CI + handoff + SESSION_LOG) for short sessions; Full (complete checklist) for substantive sessions. Pick by session character.
type: feedback
cadence: stable
scope: global
updated: 2026-05-06
origin: extracted
---

Wind-down has two tiers. Pick based on session character — don't default to one for everything.

**Why:** Full wind-down has grown comprehensive (right for substantive multi-PR / audit-cycle / plan-mode sessions, overkill for short single-edit / read-only sessions). Forcing Full on short sessions burns budget; skipping Full on substantive sessions loses context. Two tiers preserve both ends.

**How to apply:**

**QUICK wind-down (~5–10 min)** — for read-only sessions, single-edit fixes, low-blast work:

- CI verification block (only if anything was pushed)
- Brief handoff write (3–5 line summary; Failed Approaches can be "None this session")
- SESSION_LOG.md append
- LATEST.md symlink update
- (Skip: backlog sweep, todo file, Monitor/channel teardown, host substrate's commit-summary regen)

**FULL wind-down (~15–30 min)** — for multi-PR sessions, substrate work, audit cycles, plan-mode work, parallel-session collab:

- All Quick steps, plus:
- **Backlog scan + consolidate** (per `memories/feedback-wind-down-backlog-consolidation.md`)
- Memory anchor review (any session-fresh patterns / corrections / decisions worth memorializing?)
- Todo file write (`bun run src/todos/cli.ts write <handoff-id>`)
- Host substrate's commit-summary write (if applicable)
- Monitor + channel teardown — ONLY on explicit stop signal (per `memories/feedback-wind-down-ordering.md`)

**Tier selection heuristic:**

- **FULL** if any of: ≥1 PR landed, plan authored, audit cycle run, parallel-session collab active, infrastructure / hooks / skills modified, structural changes per `memories/feedback-plan-mode-for-structural-changes.md`
- **QUICK** if all of: read-only or ≤1 small edit, no PRs, no plan, no peer coordination, work was a quick fix or status check

If borderline (e.g., 1 trivial PR with no audit), default FULL. The cost asymmetry favors over-recording: Quick that should have been Full loses context; Full that should have been Quick costs ~10 min.

**Pairs with:**

- `memories/feedback-wind-down-backlog-consolidation.md` — backlog sweep step
- `memories/feedback-wind-down-ordering.md` — handoff-first vs cleanup-first ordering
- `memories/feedback-signoff-checklist.md` — never bare handoff
- `memories/feedback-encode-while-context-fresh.md` — memorialize while context is loaded
