#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Repo-wide line-coverage FLOOR gate. Runs `bun test --coverage`, reads the
# aggregate "All files" line-coverage percentage, and fails if it is below
# COVERAGE_FLOOR. A regression-guard: CI fails when overall line coverage
# drops beneath the floor.
#
# Reframe note (why repo-wide, not per-phase): CONTRIBUTING originally
# specified PER-PHASE coverage floors (Phase 0 = 100% on extracted code,
# etc.). But "phase" is a retired single-session build-plan concept with no
# runtime/CI signal — zero phase-detection constants in src/, smoke:phase-*
# are manually-invoked scripts, and CI cannot know "which phase" a PR is in.
# A literal per-phase-ordinal gate is therefore unbuildable. This gate
# enforces the load-bearing intent — coverage must not regress — as a
# repo-wide line floor.
#
# Floor: 84 (% lines). Current measured: 84.45 (set just below current as a
# regression-guard with a small buffer). Tunable via the COVERAGE_FLOOR env
# var (e.g. COVERAGE_FLOOR=85 to ratchet up).
#
# Run:    bun run check-coverage-floor
#         bash scripts/check-coverage-floor.sh
#         COVERAGE_FLOOR=85 bash scripts/check-coverage-floor.sh
#         bash scripts/check-coverage-floor.sh --from-file <coverage-output>
#           (parse a pre-captured `bun test --coverage` text dump instead of
#            re-running the suite; used by the paired unit tests)
# Exit:   0 = line coverage >= floor
#         1 = below floor OR the test suite failed
#         2+ = error (not a git repo / no "All files" row / parse failure)
#
# Output: compiler-style `coverage:1:1: error[CCF-001]: <msg>` to stderr on
# shortfall; clean line to stdout. Under GITHUB_ACTIONS=true, also emits a
# `::error title=CCF-001::` workflow annotation.
# Error-code convention: <DETECTOR-PREFIX>-<NNN>; see
# docs/conventions/error-code-scheme.md.
#
# NOTE (CI fold): in CI the "Test" step runs `bun test --coverage` once and
# tees the output; this gate then reads it via --from-file (see test.yml), so
# the suite runs once per CI job, not twice. Invoked WITHOUT --from-file (the
# default — e.g. local/non-CI runs), it re-runs the suite with coverage
# instrumentation itself: self-contained and still correct, just not reusing
# a prior run.
#
# Bash 3.2+ portable.

set -e
set -u
set -o pipefail

FLOOR="${COVERAGE_FLOOR:-84}"
FROM_FILE=""

# --- 0. Arg parsing (--help / --from-file <path>) ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help | -h)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
      exit 0
      ;;
    --from-file)
      shift
      if [[ $# -eq 0 ]]; then
        echo "check-coverage-floor: error: --from-file requires a path" >&2
        exit 2
      fi
      FROM_FILE="$1"
      ;;
    *)
      echo "check-coverage-floor: error: unknown argument '$1' (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

# --- 1. Obtain coverage output (from a file, or by running the suite) ---
COV_OUT=""
if [[ -n "$FROM_FILE" ]]; then
  if [[ ! -f "$FROM_FILE" ]]; then
    echo "check-coverage-floor: error: --from-file path not found: $FROM_FILE" >&2
    exit 2
  fi
  COV_OUT="$(cat "$FROM_FILE")"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "check-coverage-floor: error: not in a git repo (run from inside a git checkout)" >&2
    exit 2
  }
  cd "$REPO_ROOT"
  if ! COV_OUT="$(bun test --coverage 2>&1)"; then
    echo "check-coverage-floor: error: 'bun test --coverage' failed (tests failing or runner error)" >&2
    printf '%s\n' "$COV_OUT" | tail -20 >&2
    exit 1
  fi
fi

# --- 2. Extract the aggregate "All files" line-coverage percentage ---
# Bun's text coverage reporter prints:
#   File        | % Funcs | % Lines | Uncovered Line #s
#   All files   |   88.43 |   84.45 |
ALL_FILES_ROW="$(printf '%s\n' "$COV_OUT" | grep -E '^All files' | head -1 || true)"
if [[ -z "$ALL_FILES_ROW" ]]; then
  echo "check-coverage-floor: error: no 'All files' aggregate row in coverage output (did 'bun test --coverage' run?)" >&2
  exit 2
fi

# Third pipe-delimited field is "% Lines". Strip spaces.
PCT_LINES="$(printf '%s\n' "$ALL_FILES_ROW" | awk -F'|' '{gsub(/[ \t]/, "", $3); print $3}')"
if [[ -z "$PCT_LINES" || ! "$PCT_LINES" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "check-coverage-floor: error: could not parse % Lines from row: $ALL_FILES_ROW" >&2
  exit 2
fi

# --- 3. Numeric compare (awk; bash lacks float arithmetic) ---
BELOW="$(awk -v p="$PCT_LINES" -v f="$FLOOR" 'BEGIN { print (p + 0 < f + 0) ? "1" : "0" }')"
GHA="${GITHUB_ACTIONS:-}"

if [[ "$BELOW" == "1" ]]; then
  msg="repo-wide line coverage ${PCT_LINES}% is below the floor of ${FLOOR}% — add tests, or justify lowering COVERAGE_FLOOR (regression-guard per CONTRIBUTING coverage policy)"
  printf 'coverage:1:1: error[CCF-001]: %s\n' "$msg" >&2
  if [[ "$GHA" == "true" ]]; then
    printf '::error title=CCF-001::%s\n' "$msg" >&2
  fi
  exit 1
fi

echo "check-coverage-floor: clean (line coverage ${PCT_LINES}% >= floor ${FLOOR}%)"
exit 0
