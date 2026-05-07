---
name: Never a bare handoff — always walk the wind-down checklist
description: Sessions don't end with a bare `/handoff`. They walk a wind-down checklist covering every base (uncommitted work, unsynced memory, unfiled backlog) before handoff fires.
type: feedback
cadence: stable
scope: global
updated: 2026-05-06
origin: extracted
---

A session does not wrap by just invoking `/handoff`. The operating user walks a complete wind-down checklist first — every repo touched, every uncommitted change, every unpushed commit, every unsynced memory, every backlog/wiki/note addition, every in-flight piece of state — and confirms each is reconciled before closing out.

**Why:** Handoff is the _last_ step after all in-flight state is accounted for. A bare `/handoff` skips the accountability pass. The operating user's framing: never simply "handoff" ("signoff..."); always work through the checklist and cover all bases / make sure everything is accounted for.

**How to apply:** When a session reaches a natural pause, do not suggest `/handoff` as the next step. Proactively enumerate what's in flight — repos with unsynced changes, memory updates, backlog edits, pending commits — and offer to reconcile them. Only after every base is covered is the handoff appropriate. Even small/trivial-seeming items count; the discipline is the point.

**Pairs with:**

- `memories/feedback-wind-down-ordering.md` — three composing rules (DEFAULT checklist-first, EXCEPTION early snapshot, ALWAYS no infra teardown before stop)
- `memories/feedback-tiered-wind-down.md` — Quick vs Full tier selection
- `memories/feedback-wind-down-backlog-consolidation.md` — backlog scan as wind-down step
