---
name: Surface branch/merge strategy decisions before acting
description: When a process reason makes merging to main look right, surface the decision to the user with reasoning first — don't just do it
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

Default to working on a branch. If process reasons make merging to main seem necessary (e.g., "baseline needs representative main usage"), **surface the decision to the user with the reasoning before merging, not after.**

**Why:** The capturing user is fine with well-reasoned merges, but wants the strategy choice raised explicitly so they can course-correct before the merge lands. In a real instance: the assistant squash-merged a Phase-0 timing-instrumentation PR to main, reasoning that baseline needed to collect from representative main usage. The reasoning held up, but the user flagged that the _choice_ should have been brought to them first — merges to main are a strategy-level decision, not a routine tactical one.

**How to apply:** Any time the assistant is about to merge to main (especially during a multi-slice refactor where the default is a long-lived branch), stop and ask: "This is one merge-to-main vs stay-on-branch, here's why I'd lean toward merging — do you want to proceed?" The cost of a one-sentence check-in is tiny compared to the cost of an unwanted main-ward move that then needs reverting.
