<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Release cycle runbook

How to ship a Phase-N tag (`v<X>.<Y>.<Z>-phase-N`) end-to-end. This is the canonical
playbook used at Phase 1 close (2026-04-29, `v0.1.0-phase-1` at Lane B `44cfff4`); future
Phase 2/3 closes should follow the same sequence with phase-specific substitutions.

## Preconditions

- All implementation slices for the phase are merged into the lane branch (e.g., `phase-1-lane-b-binary` for Phase 1).
- Phase audit (Wave N) personas have returned with verdicts.
- Inline closures landed for any CRITICAL / IMPORTANT findings.
- Peer (Bravo / future co-author) verification round VERDICT: **SHIP** posted to the coordination channel.
- Local gates green: `bun run typecheck` + `bun run format` + `bun run lint` + `bun run test`.
- Smoke matrix (`bash scripts/smoke-phase-1.sh` or successor) passes 100%.

If any precondition is unmet → STOP. The verification gate exists to prevent untested releases.

## Sequence (plugin)

Run from plugin root.

```bash
# 1. Switch to lane branch + sync with remote
git checkout phase-1-lane-b-binary
git pull --ff-only origin phase-1-lane-b-binary

# 2. Merge the audit-closure slice with --no-ff (preserves slice boundary in history)
git merge --no-ff phase-1-slice-8-terminal-audit -m "merge: Slice 8 (...) into Lane B
<commit body documenting audit verdicts + carry-over backlog>"

# 3. Cap CHANGELOG: edit [Unreleased] → [<version>] — <date>; update compare links.
#    The version section flip is its own commit so the tag points at a clean release boundary.
${EDITOR} CHANGELOG.md
git add CHANGELOG.md
git commit -m "release: cap CHANGELOG for <version>"

# 4. Tag with annotated message documenting the phase scope + audit cadence
git tag -a v0.1.0-phase-1 -m "Phase 1 — <one-line summary>
<body summarizing slices, commit count, test count, audit cycles>"

# 5. Push branch + tag together
git push origin phase-1-lane-b-binary
git push origin v0.1.0-phase-1
```

## Sequence (dotfiles cross-edge closure)

If the phase included cross-edge work (Phase 1 had Slice 3a/3b shim conversions + ARCH-W2-1 session-id-discovery shim closure):

```bash
cd ${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}

# 1. Merge the dotfiles closure branch
git checkout main
git pull --ff-only
git merge --no-ff phase-1-slice-8-dotfiles-session-id-shim -m "merge: ... closure into main"

# 2. Restore CI sibling-checkout ref to plugin main (was pinned to lane during phase work
#    per feedback-cross-repo-ci-pin-drift.md). One-line workflow edit.
sed -i.bak 's|^          ref: phase-1-lane-b-binary$|          ref: main|' .github/workflows/test.yml
rm .github/workflows/test.yml.bak
git add .github/workflows/test.yml
git commit -m "ci: restore claude-conductor sibling pin to main post <tag>"
git push origin main
```

## Recovery artifact cleanup

After the tag is on origin and CI is green, drop any pre-shim recovery artifacts:

```bash
# Drop pre-shim rollback tag (local + remote)
git tag -d pre-channels-shim-rollback
git push origin :refs/tags/pre-channels-shim-rollback

# Remove pre-shim worktree
git worktree remove /tmp/dotfiles-pre-3b
```

## Post-tag

- Update `decisions/phase-<N+1>.md` with carry-over backlog (deferred RE/ARCH/CLI-DX findings + Phase-N+1 entry-point).
- Signal peers via channel with the tag SHA + tag-message excerpt.
- Mark phase-related TaskList entries `completed` with a SHIPPED-on-DATE annotation.

## Rollback (if a finding surfaces post-tag)

- **Pre-tag-push (rare)**: `git tag -d v0.1.0-phase-N`, fix on lane branch, retry from sequence step 4.
- **Post-tag-push (more common)**: do NOT rewrite the tag (other instances may have pinned the SHA). Instead:
  - Land the fix on a `phase-N-followup-<finding>` branch.
  - Tag a follow-on `v0.1.<Y+1>-phase-N` (or use `phase-N.5` per the Slice 8.5 precedent if the work is bounded enough to ship as a parallel slice).
  - Update CHANGELOG with the patch entry.
  - Per `feedback-merge-commit-across-instances.md`: prefer merge commits over rebase to keep peer-pinned SHAs stable.

## Reference: Phase 1 close (2026-04-29)

For posterity — actual sequence executed at v0.1.0-phase-1:

| Step                      | Plugin                                         | Dotfiles                                                   |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Merge audit-closure slice | `8a1e8a0` (Slice 8 → Lane B)                   | `9d54260` (shim closure → main)                            |
| CHANGELOG cap             | `44cfff4` (`[Unreleased]` → `[0.1.0-phase-1]`) | n/a (CHANGELOG cap was plugin-only)                        |
| Tag                       | `v0.1.0-phase-1` annotated on `44cfff4`        | n/a                                                        |
| CI ref restore            | n/a                                            | `ec8de93` (`phase-1-lane-b-binary` → `main`)               |
| Drop recovery             | n/a                                            | `pre-channels-shim-rollback` tag + `/tmp/dotfiles-pre-3b/` |

Audit verdict trail captured in `decisions/phase-1.md` (Decisions A–H + RESOLVED pending section). Phase 2 carry-over backlog in `decisions/phase-2.md`.
