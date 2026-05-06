---
name: Wind-down includes backlog consolidation
description: Wind-down includes a backlog scan for topical/affiliated items — mark resolved, cross-link siblings, file new debt entries — BEFORE handoff write.
type: feedback
cadence: stable
scope: global
updated: 2026-05-06
origin: extracted
---

Wind-down must include scanning the project's backlog artifact (whichever tracks debt for the project — `wiki/backlog.md`, `~/backlog.md`, GitHub Issues, etc.) for items related to the session's work BEFORE writing the handoff.

**Why:** Without an explicit wind-down sweep, backlog items remain `[ ]` open even after sessions close them — drift becomes invisible debt. Reactive consolidation (when prompted "consolidate the backlog") should be proactive default at wind-down time, not interactively triggered.

**How to apply:**

1. At wind-down (after build/verify/test gates pass, BEFORE handoff write), grep the project's backlog artifact for keywords matching today's work — file names touched, slice / PR numbers, memory anchors filed today, plan paths cited.
2. For each match:
   - **Resolved** → mark `[x]` + prefix with `RESOLVED <date> via <PR/SHA evidence>`; existing convention is to prepend a HIGH-PRIORITY UPDATE block above older content, not delete the original (preserves evidence trail).
   - **Sibling touched** → cross-link new artifact, update any prerequisite language (e.g., `~~prereq~~ CLEARED <date>`).
   - **New debt surfaced** → file a new entry referencing today's audit doc / plan / PR. Cross-reference back from existing entries that should know about it.
3. Then continue with handoff write per `commands/session/handoff.md` skill.

**Search keywords to grep at wind-down:**

- File paths from today's git diff
- Memory file names from today's `entries_touched` (telemetry)
- PR numbers + commit SHAs
- Plan file basenames
- Audit doc basenames
- Slice/Item identifiers from today's queue

**Pairs with:**

- `memories/feedback-signoff-checklist.md` — full wind-down checklist (never bare handoff)
- `memories/feedback-wind-down-ordering.md` — handoff-first vs cleanup-first sequencing
- `memories/feedback-tiered-wind-down.md` — Quick vs Full tier selection (Quick may skip backlog sweep)

Aligns with the self-sufficient-notes principle: durable backlog entries must be stand-alone — a future session picks them up with zero re-research.
