#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Advisory: warn when the working tree has UNCOMMITTED substrate changes that the
# commit-based decision-log gate (scripts/check-decision-log.sh, DLOG-001) cannot
# see yet.
#
# WHY (the false-confidence this closes): check-decision-log is COMMIT-based — it
# diffs MERGE_BASE..HEAD where MERGE_BASE = git merge-base origin/main HEAD, i.e.
# committed history ONLY. Run `bun run ci-local` PRE-commit with HEAD ~ origin/main
# and that range is EMPTY, so check-decision-log reports a VACUOUS "clean"
# (substrate_changed=0) even though your working tree has staged/unstaged substrate
# edits. You then commit + push and CI re-runs the SAME gate against the now-
# committed diff, where it REDS. (This bit C1 S1, PR #203.) This advisory detects
# that pre-commit gap and prints the commit-then-recheck remedy.
#
# ADVISORY ONLY — this is NOT a gate. It NEVER fails the build, adds NO CI gate,
# and adds NO pre-push hook. It only prints guidance; ci-local surfaces that
# guidance but never folds it into pass/fail. (Lane L2; Nick-decided Option 1.)
#
# Substrate classification is IDENTICAL to check-decision-log.sh: a path is
# substrate iff it matches `src/*.ts` (bash `case`: `*` spans `/`, so the match is
# recursive) and NOT `*.test.ts` (co-located tests are not substrate; checked
# first). That parity is pinned by test/scripts/warn-uncommitted-substrate.test.ts
# so the two classifiers cannot drift apart.
#
# "Uncommitted" = anything not yet in a commit: tracked working-tree changes vs
# HEAD (staged + unstaged, via `git diff --name-only HEAD`) PLUS untracked files
# (`git ls-files --others --exclude-standard`). An untracked new src/*.ts is
# uncommitted substrate too — it becomes the exact post-commit CI-red case.
#
# Run:    bash scripts/warn-uncommitted-substrate.sh
# Output: human-readable advisory on STDOUT when uncommitted substrate is found;
#         EMPTY stdout when there is none (a brief note goes to STDERR). Setup
#         errors (not a git repo) -> STDERR.
# Exit:   0 ALWAYS — advisory; a caller must never treat its exit code as pass/fail.
#
# Bash 3.2+ portable (macOS default bash): no mapfile, no associative arrays.

set -u
set -o pipefail
# Deliberately NOT `set -e`: an advisory must never abort or fail its caller.

# --- --help ---
for arg in "$@"; do
  case "$arg" in
    --help | -h)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
      exit 0
      ;;
    *) : ;; # advisory: ignore unknown args rather than erroring (never block)
  esac
done

# --- resolve repo root (advisory: on any error, note to stderr + exit 0) ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "warn-uncommitted-substrate: not in a git repo — advisory skipped." >&2
  exit 0
}
cd "$REPO_ROOT" || exit 0

# --- collect uncommitted paths: tracked-vs-HEAD (staged+unstaged) + untracked ---
TRACKED="$(git diff --name-only HEAD 2>/dev/null || true)"
UNTRACKED="$(git ls-files --others --exclude-standard 2>/dev/null || true)"
CHANGED="$(printf '%s\n%s\n' "$TRACKED" "$UNTRACKED")"

# --- classify (rule IDENTICAL to check-decision-log.sh step 4) ---
SUBSTRATE=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # bash `case`: `*` matches `/`, so `src/*.ts` is recursive. Order matters —
  # the `*.test.ts` arm is checked FIRST so co-located tests are excluded.
  case "$f" in
    *.test.ts) continue ;;
    src/*.ts) SUBSTRATE="${SUBSTRATE}${f}"$'\n' ;;
  esac
done <<<"$CHANGED"

# --- output: advisory on STDOUT only when there IS uncommitted substrate ---
if [ -n "$SUBSTRATE" ]; then
  printf 'check-decision-log (DLOG-001) is COMMIT-based: it diffs merge-base(origin/main,HEAD)..HEAD,\n'
  printf 'so it CANNOT see the following UNCOMMITTED substrate change(s) in your working tree:\n'
  printf '%s' "$SUBSTRATE" | sed 's/^/  - /'
  printf '\nPre-commit, that gate may therefore report a VACUOUS "clean"; once you commit + push,\n'
  printf 'CI runs the same gate against the committed diff and may RED.\n'
  printf 'Fix (commit-then-recheck): COMMIT the substrate change — add a decisions/ entry\n'
  printf '(a `ts:` frontmatter line) OR a "Decision-log: none (<reason>)" commit trailer — THEN\n'
  printf 're-run `bun run ci-local` so check-decision-log evaluates the real committed diff.\n'
else
  echo "warn-uncommitted-substrate: no uncommitted substrate — decision-log gate result is trustworthy this run." >&2
fi

exit 0
