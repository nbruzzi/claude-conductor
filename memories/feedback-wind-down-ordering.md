---
name: Wind-down sequencing — checklist first, handoff last (default); early snapshot handoff is the exception for long/risky sessions
description: Three composing rules for the wind-down phase — (1) DEFAULT — complete the wind-down checklist FIRST so issues found during cleanup land in the handoff; (2) EXCEPTION — for long/high-risk sessions, write an early snapshot handoff for durability + a second final handoff at the end; (3) don't tear down active infrastructure (Monitor, channel, background tasks) until the operating user explicitly signals stop.
type: feedback
cadence: stable
scope: global
updated: 2026-05-06
origin: extracted
---

Wind-downs have three composing rules. The first is the DEFAULT; the second is the EXCEPTION case the original rule was designed for; the third gates infrastructure cleanup behind explicit stop.

## Rule 1 (DEFAULT) — Wind-down checklist first; handoff is the LAST artifact

For routine sessions, complete the wind-down checklist BEFORE writing the handoff:

1. Commit + push remaining work-output (durable, can't be lost from here)
2. Run any verification or polish steps (CI watch, recap evidence capture, follow-up fixes if surfaced)
3. THEN write the handoff — captures the complete final state including anything surfaced during cleanup

**Why:** wind-down activities themselves often surface issues that need resolution (CI failure on push, format drift, a missed backlog item, a degraded substrate revealed by a final check). If handoff fires first, those discoveries land AFTER the handoff and require a SECOND handoff to capture — which is process duplication. The default "checklist first" pattern means one handoff captures everything cleanly.

**How to apply:** treat handoff as the bookend, not the opening move. Write it after every other deterministic action has completed. The handoff documents WHAT IS, not WHAT WILL BE — so it earns its keep by writing last.

## Rule 2 (EXCEPTION) — Early snapshot handoff for long/high-risk sessions

For sessions that meet ANY of these criteria, write an EARLY snapshot handoff in addition to the final handoff:

- Session has been running > ~2 hours of substantive work
- Session contains audit cycles, multi-persona reasoning, or convergent findings that would be hard to reconstruct
- Environment is risky (unstable network, system updates pending, known SSH drop history, low battery)
- Work-in-progress includes decisions/rejected-approaches that exist only in conversation history

In this case, run TWO handoffs:

1. **Early snapshot** — preserves session-specific reasoning (decisions, audit findings, deferred backlog items, rationale) so a session-death between snapshot and final handoff doesn't lose context
2. **Final handoff** at the end — captures the complete final state per Rule 1

The early-snapshot pattern was the original Rule 1 of this memory; reframed as the exception case. The asymmetry-of-loss argument still applies: certain-loss-of-context vs. trivial-to-replay-actions. But it applies STRONGER to long sessions where reasoning takes time to reconstruct, and weaker to routine sessions where checklist-first delivers cleaner final-state capture.

**How to apply:** ask "if this session died right now, would the loss be > 30 min of work-to-reconstruct?" If yes → early snapshot. If no → wind-down checklist first per Rule 1. The threshold is operator judgment; err toward early snapshot for any session that involved audit cycles, multi-persona reasoning, or peer-session coordination.

## Rule 3 — Don't tear down infrastructure before explicit stop signal

When work appears done but the operating user has not explicitly signaled wind-down, do NOT preemptively shut down active session infrastructure: persistent Monitor tasks, open channels, background bash processes, watchers, working-tree branches not yet merged. Wait for explicit "we're done" / "winding down" / "shipping it" / "let's wind-down and handoff" before tearing them down. Asking "what's next?" while simultaneously closing the channel is a sequencing mistake — if the operating user picks "keep working," cycles burned to undo the cleanup.

**Why:** Caught live mid-session: after a peer-session task completion landed and the work was shipped, an instance (a) ran `TaskStop` on a long-running channel Monitor, (b) immediately offered "wind down or work on a deferred item?" The Monitor would have remained useful for any further peer communication during the deferred-item work. Operating-user observation: "shouldn't you have waited to shut down the monitor? 'I'm gonna spend time/tokens on shutting this down now, but also, do you want to keep working?' — The smart thing would have been to wait on closing it." Same shape as the efficiency-without-compromise principle (optimize aggressively, but never at the cost of having to undo work) applied to action sequencing.

**How to apply:**

1. Distinguish work-output (committed files, pushed branches, sent messages) from session-infrastructure (Monitors, open channels, background watchers, persistent task lists, working-tree branches not yet merged).
2. Commit/push/send work-output as soon as it's verified (Rule 1 territory).
3. Tear down session-infrastructure ONLY AFTER the operating user has explicitly signaled session end. If the signal hasn't landed, leave infrastructure standing.
4. Boundary case: if asked "what's next?" and you guess wind-down, ASK before tearing down. The cost of asking is one short message; the cost of un-tearing-down is multiple tool calls plus restored state may not be exactly equivalent (timestamps, registries, JSONL append positions all differ post-restart).
5. Order: durable work first, ephemeral cleanup last. The Monitor going one extra turn costs almost nothing; restarting a closed Monitor mid-work costs a setup cycle and any events that arrived in the gap are lost.

## Composed sequence (DEFAULT — Rule 1 + Rule 3)

For routine session wind-downs:

1. Commit + push remaining work-output
2. Wait for explicit stop signal from the operating user (Rule 3)
3. Run any verification or polish steps the wind-down checklist surfaces (CI watch, follow-up fixes, recap evidence capture)
4. Write the handoff (Rule 1 — bookend artifact, captures complete final state)
5. Then: infrastructure tear-down (close channels, stop Monitors, etc.) per Rule 3

## Composed sequence (EXCEPTION — Rule 1 + Rule 2 + Rule 3)

For long/high-risk sessions:

1. Commit + push remaining work-output
2. Write EARLY SNAPSHOT handoff (Rule 2)
3. Wait for explicit stop signal (Rule 3)
4. Run any verification or polish steps
5. Write FINAL handoff (Rule 1 — captures everything since the snapshot)
6. Then: infrastructure tear-down per Rule 3

The default holds for routine sessions. Skip Rule 2 unless the session genuinely qualifies as long/high-risk by the > 30-min-reconstruction threshold.

**Pairs with:**

- `memories/feedback-signoff-checklist.md` — never bare handoff; always walk the checklist
- `memories/feedback-tiered-wind-down.md` — Quick vs Full tier selection
- `memories/feedback-wind-down-backlog-consolidation.md` — backlog scan as wind-down step
