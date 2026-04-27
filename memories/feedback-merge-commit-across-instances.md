---
name: Merge-commit when another instance may have pinned SHAs
description: In any multi-instance coordination scenario (parallel sessions, handoffs naming commits, channel messages referencing SHAs, peer memory), prefer merge commits over rebase — rebase rewrites SHAs and silently breaks references held by other instances
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When merging work in a multi-instance environment, prefer merge commits (`git merge --no-ff`, `gh pr merge --merge`) over rebase. Rebase rewrites SHAs; any SHA reference another instance is holding — in a todo body, a handoff's git-state section, a channel message, or peer memory — will silently break.

**Why:** SHA references routinely cross the process boundary in normal coordination flow. The plugin's todo store keeps task descriptions that may include them. Handoffs include `git log --oneline` excerpts in Git State sections. Channel messages cite commits ("filed on `<short-sha>`", "cherry-picked `<short-sha>`"). Peer memory captures "resolved via a referenced commit." The referencing instance has no way to learn about a rebase-rewrite — the old SHA silently 404s, no one notices until someone tries to use the reference (usually the next session, usually in a hurry).

Observed in a real instance: a multi-instance ingest project explicitly chose `--merge` over `--rebase` specifically because three other artifacts named SHAs on the merging branch. That per-decision call should be a standing rule.

**How to apply:**

- Any PR that touches a branch visible to other instances: `gh pr merge --merge`, not `--rebase` or `--squash`.
- Any manual merge of a feature branch in a multi-session environment: `git merge --no-ff <branch>`.
- Do NOT `git rebase` a branch whose commits have been named in todos / handoffs / channel messages / peer memory.
- Do NOT `git commit --amend` a commit that has been referenced externally. The one exception is a pre-commit-hook failure — the original commit didn't actually happen, so nothing can reference it yet.
- Rebase is still fine for strictly local, not-yet-published, not-yet-referenced work.
- If in doubt: merge. The DAG cost of a merge commit is far cheaper than the coordination cost of a silently broken SHA reference.
