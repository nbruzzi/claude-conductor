#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Decision-log presence gate (DLOG-001).
#
# For PRs that modify substrate source, require a corresponding decision-log
# entry (a change under decisions/) in the same diff range — OR an explicit
# opt-out trailer in a commit message.
#
# Per CONTRIBUTING.md "Decision-log discipline" + the INSTRUCTION-vs-ENFORCEMENT
# boundary: substrate-modifying PRs are expected to log within-phase decisions.
# This gate converts that convention-by-vigilance item into a CI gate.
# Schema: docs/conventions/decision-log-schema.md.
#
# Run:    bun run check-decision-log
#         bash scripts/check-decision-log.sh [<base-ref>]
# Args:
#   <base-ref>  Git ref to diff against (default: origin/main). PR-scope diff is
#               computed from the merge-base of <base-ref> and HEAD.
# Opt-out:  for a substrate change that genuinely warrants no decision entry
#           (e.g. a pure mechanical rename), include a trailer line
#               Decision-log: none (<reason>)
#           in any commit message in the diff range.
# Exit:   0 = clean (no substrate change, OR decision entry present, OR opt-out)
#         1 = violation (substrate changed; no decision entry; no opt-out)
#         2+ = error (not a git repo / base ref unresolvable / no merge-base)
#
# Output: compiler-style `error[DLOG-001]` to stderr; clean line to stdout.
# Under GITHUB_ACTIONS=true also emits a `::error::` workflow annotation.
# Error-code convention: see docs/conventions/error-code-scheme.md.
#
# Bash 3.2+ portable (do NOT use mapfile).

set -e
set -u
set -o pipefail

ERR_CODE="DLOG-001"

# --- 0. --help + base-ref arg ---
BASE_REF="origin/main"
for arg in "$@"; do
  case "$arg" in
    --help | -h)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
      exit 0
      ;;
    -*)
      echo "check-decision-log: error: unknown flag '$arg' (try --help)" >&2
      exit 2
      ;;
    *)
      BASE_REF="$arg"
      ;;
  esac
done

# --- 1. resolve repo root regardless of cwd ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-decision-log: error: not in a git repo (run from inside a git checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# --- 2. resolve base ref + merge-base (fail LOUD if unresolvable — never skip-pass) ---
if ! git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null 2>&1; then
  echo "check-decision-log: error: base ref '$BASE_REF' not found." >&2
  echo "  In CI, ensure the base branch is fetched (actions/checkout fetch-depth: 0," >&2
  echo "  or an explicit 'git fetch origin main'). Locally: 'git fetch origin main'." >&2
  echo "  Or pass an explicit base ref: bash scripts/check-decision-log.sh <ref>." >&2
  exit 2
fi
MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null)" || {
  echo "check-decision-log: error: no merge-base between '$BASE_REF' and HEAD" >&2
  exit 2
}

# Local-staleness caveat (cross-pair NIT, PR #161): CI is authoritative — its
# checkout fetches a fresh origin/main (fetch-depth: 0), so the merge-base is
# correct. A LOCAL run against a stale (un-fetched) origin/main resolves an OLDER
# merge-base -> a wider diff range than the true PR scope. We deliberately do NOT
# auto-fetch (offline-hostile; would slow every local run); instead the output
# prints the resolved base SHA so a stale local ref is visible.

# --- 3. changed files in PR scope (merge-base..HEAD) ---
CHANGED="$(git diff --name-only "$MERGE_BASE" HEAD)"

# --- 4. classify changed files ---
# Substrate source = production .ts under src/ (excluding *.test.ts).
# PROVISIONAL (pending cohort ratify — see channel mechanism-fork post): the
# trigger is ALL src/ production .ts rather than a curated primitive-dir
# allowlist. Broad-by-default + explicit opt-out trailer = deny-list direction
# (per cohort convention) and avoids allowlist drift as src/ grows (21 dirs and
# counting). A curated allowlist is the considered alternative; revisit at audit.
SUBSTRATE_CHANGED=0
DECISION_CHANGED=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # bash `case` patterns: `*` matches `/`, so `src/*.ts` is recursive.
  case "$f" in
    *.test.ts) : ;; # co-located tests are not substrate changes
    src/*.ts) SUBSTRATE_CHANGED=1 ;;
  esac
  case "$f" in
    decisions/*.md) DECISION_CHANGED=1 ;;
  esac
done <<<"$CHANGED"

# --- 5. opt-out trailer scan over commit messages in range ---
OPT_OUT=0
if git log "$MERGE_BASE..HEAD" --format='%B' 2>/dev/null \
  | grep -qiE '^[[:space:]]*Decision-log:[[:space:]]*none'; then
  OPT_OUT=1
fi

# --- 6. verdict ---
if [ "$SUBSTRATE_CHANGED" -eq 1 ] && [ "$DECISION_CHANGED" -eq 0 ] && [ "$OPT_OUT" -eq 0 ]; then
  MSG="substrate source changed under src/ but no decisions/ entry was added and no 'Decision-log: none (<reason>)' opt-out trailer was found"
  echo "check-decision-log: error[$ERR_CODE]: $MSG" >&2
  echo "  Fix: add a decision entry to decisions/phase-<N>.md" >&2
  echo "       (schema: docs/conventions/decision-log-schema.md)," >&2
  echo "       OR add a commit trailer 'Decision-log: none (<reason>)' if no decision is warranted." >&2
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error title=check-decision-log [$ERR_CODE]::$MSG"
  fi
  exit 1
fi

echo "check-decision-log: clean (substrate_changed=$SUBSTRATE_CHANGED decision_entry=$DECISION_CHANGED opt_out=$OPT_OUT; base=$BASE_REF @ ${MERGE_BASE} — 'git fetch origin main' if this base looks stale locally)"
exit 0
