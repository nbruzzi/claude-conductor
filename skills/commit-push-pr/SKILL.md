---
name: commit-push-pr
description: Commit staged changes, push to remote, and open a pull request. Use when ready to ship a change.
---

Run `git status` and `git diff --staged` to understand the current state.

Using that context:

1. Write a concise, descriptive commit message based on what changed
2. Commit the staged changes
3. Push to the current branch
4. Open a pull request with a clear title and description
5. Link to any related issues found in the branch name or recent commits

Never commit if there are unstaged changes that seem related — ask first.
