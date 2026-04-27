---
name: Sibling-parity check at merge time, not just audit time
description: When a feature PR sits open while main lands a sibling-pattern PR, the original audit's lens (diff vs base) doesn't catch the parity gap. Add a sibling-parity recheck at merge time as a separate lens.
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When a feature PR is audited green at one point in time and then sits open while main keeps moving, a sibling-pattern PR landing on main can silently put the open PR out of sync with its sibling. The PR's own audit history will not catch this — terminal full-diff audits use the lens "diff vs base," which by then includes the sibling's changes (so the sibling looks present on the base branch), but never compares "this PR's component against the sibling component on main as it now stands."

**Why (load-bearing example, generic shape):** A multi-phase feature PR was approved with a Phase 6 terminal full-diff audit that caught two real production hazards. Days later, a sibling-pattern PR landed on main, adding presence-aware deferral to one half of a parallel-trio component (the substrate's dotfiles-side of a sync trio, in the originating substrate). The other half of the trio (the parallel sibling) was the equivalent pattern and should have gotten the same treatment, but didn't — the gap emerged AFTER both audits closed, between merge windows. At resume time, an inline sibling-parity audit caught the missing presence check before squash-merge; without that check, two concurrent sessions touching the sibling artifact would silently cross-attribute commits via the shared sentinel — exactly the bug the sibling PR closed for the other half of the trio.

**How to apply:** Before merging any feature PR that has been open for more than one main-branch advance, run a sibling-parity check as a separate lens:

1. Identify the PR's sibling-pattern components (the parallel-trio architecture: any pair of sibling components that share an integration shape).
2. Compare each PR-changed component against its current sibling on main: same imports, same helper signatures, same observability tags, same deferral semantics.
3. If main has moved with sibling-pattern changes since the PR was last audited, run a fresh inline parity audit (Reliability + Architecture lenses minimum). Don't trust the PR's own audit history — it didn't have visibility into the sibling drift.

This is a different lens than terminal full-diff (which catches accumulation hazards within the branch). Sibling-parity catches drift INTRODUCED ON MAIN while the branch was open. Both are required for ceiling-standard merges of long-open PRs.

Captured backlog items from a real instance of the missed audit lens (deferred to follow-up): a `checkLivePeers` V2 lift to a `sync-common`-style primitives module when a `SyncTarget` registry lands, a test env-scrub helper naming asymmetry between `noLeakEnv` and `baseEnv`, and a warn-detail observability tag (`kind=live-peer-deferral`) with no test pinning the format.
