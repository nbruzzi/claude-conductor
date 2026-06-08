#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# ci-local — run the CI gate set (.github/workflows/test.yml) locally, in CI
# order, so a developer gets local-green == CI-green BEFORE pushing.
#
# Why this exists: the pre-commit gate runs a fast SUBSET (typecheck / format /
# lint / convention-checks / scope-filtered test). Some CI gates are NOT in that
# subset — notably check-decision-log (DLOG-001, a PR-RANGE gate pre-commit
# cannot run per-commit) and verify:drift — so "local clean" did not imply "CI
# clean". That gap cost repeated fix-amend-repush cycles. This script closes it:
# one command that mirrors every CI gate.
#
# Modes:
#   (default)        RUN ALL gates — full CI parity (local-green == CI-green).
#   --fast           RUN the FAST CI gates only. Defined by SUBTRACTION: every
#   --pre-push         gate EXCEPT the slow trio {test+coverage,
#                      check-coverage-floor, actionlint} (which need the full
#                      suite or an external binary). NOT a hand-maintained
#                      allow-list — a new fast CI gate added below auto-flows into
#                      --fast unless it is explicitly slow-gated (deny-list
#                      direction; matches pre-commit.ts CONVENTION_CHECK_DENY_LIST
#                      + feedback-deny-list-over-allow-list-for-skip-gates). This
#                      is the set the pre-push hook enforces; the suite stays in CI.
#   --list           PRINT the gate plan (one name per line, in run order) for the
#   --list-gates       selected mode, then EXIT 0 WITHOUT running anything.
#                      Composes with --fast (`--fast --list` prints the fast plan).
#                      The drift-guard test uses this to assert the --fast
#                      subtraction BEHAVIORALLY (full plan MINUS the slow trio).
#
# Behavior: RUN-ALL, not fail-fast. Every gate runs even if an earlier one
# fails; results are aggregated into a summary and the script exits non-zero if
# ANY gate failed. This surfaces ALL failures in a single pass (fix everything
# once) instead of one-failure-per-run.
#
# Gate parity is drift-guarded by test/scripts/ci-local.test.ts: every
# `bun run <gate>` step in test.yml is invoked here (full), AND --fast is asserted
# to run exactly the full set MINUS the slow trio — so neither a new CI gate nor a
# mis-scoped fast/slow split can silently resurrect the false-confidence tax.
#
# Run:    bun run ci-local                  # full CI parity
#         bash scripts/ci-local.sh --fast   # the pre-push fast subset
#         bash scripts/ci-local.sh --list   # print the gate plan, run nothing
# Exit:   0 = all gates passed (or --list / --help)
#         1 = one or more gates failed (see the summary)
#         2 = harness error (not a git repo / unknown flag)
#
# Bash 3.2+ portable (macOS default bash): no associative arrays, portable
# mktemp template form.

set -u
set -o pipefail
# Deliberately NOT `set -e`: we run every gate and aggregate, so a failing gate
# must not abort the script.

# --- arg parse: --fast/--pre-push (skip the slow trio), --list (print plan only),
# --help. Unknown flag fails LOUD (exit 2) rather than silently running full. ---
FAST=0
LIST_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --fast | --pre-push) FAST=1 ;;
    --list | --list-gates) LIST_ONLY=1 ;;
    --help | -h)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ci-local: error: unknown flag '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ci-local: error: not in a git repo (run from inside the checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# Parallel name/status arrays (Bash 3.2 has no associative arrays).
NAMES=()
STATUSES=()
FAILED=0
# Gate plan in run order — recorded by run_gate + the slow block, printed by --list.
PLAN=()
DLOG_ADVISORY=""

run_gate() {
  # $1 = display name; remaining args = the command to run.
  local name="$1"
  shift
  PLAN+=("$name")
  if [ "$LIST_ONLY" -eq 1 ]; then
    return 0
  fi
  printf '\n=== %s ===\n' "$name"
  if "$@"; then
    NAMES+=("$name")
    STATUSES+=("PASS")
  else
    NAMES+=("$name")
    STATUSES+=("FAIL")
    FAILED=1
  fi
}

# --- Fast gates: the SUBTRACTION BASE. Run in BOTH default and --fast modes, in
# test.yml order (the `bun run <gate>` steps that are fast enough for a pre-push
# gate). Anything added here automatically runs under --fast too — that is the
# whole point of subtraction (no allow-list to keep in sync). ---
run_gate "typecheck" bun run typecheck
run_gate "verify:drift" bun run verify:drift
run_gate "format:check" bun run format:check
run_gate "lint" bun run lint
run_gate "check-generic-paths" bun run check-generic-paths
run_gate "check-import-extensions" bun run check-import-extensions
run_gate "check-dep-rationale" bun run check-dep-rationale
run_gate "check-spdx-headers" bun run check-spdx-headers
# --- advisory (NOT a gate): surface UNCOMMITTED substrate the COMMIT-based
# decision-log gate below cannot see. check-decision-log diffs committed history
# (merge-base..HEAD), so run PRE-commit it can report a vacuous "clean" while the
# working tree holds staged/unstaged substrate edits — then CI reds post-commit.
# Captured here so that false pre-commit confidence is surfaced; NEVER folded into
# FAILED (advisory only — Lane L2). The helper prints its own remedy + always
# exits 0. See scripts/warn-uncommitted-substrate.sh. Skipped under --list (it
# inspects the working tree, not the gate plan).
if [ "$LIST_ONLY" -ne 1 ]; then
  DLOG_ADVISORY="$(bash "$REPO_ROOT/scripts/warn-uncommitted-substrate.sh")"
  if [ -n "$DLOG_ADVISORY" ]; then
    printf '\n=== advisory: uncommitted substrate (decision-log) ===\n'
    printf '%s\n' "$DLOG_ADVISORY"
  fi
fi
run_gate "check-decision-log" bun run check-decision-log
run_gate "check-liveness-gate-store-contract" bun run check-liveness-gate-store-contract

# --- Slow trio: SUBTRACTED by --fast (deferred to full `bun run ci-local` + CI).
# {test+coverage, check-coverage-floor, actionlint} need the full suite or an
# external binary — too slow / not-always-present for a pre-push gate. This `if`
# IS the subtraction boundary: everything ABOVE runs under --fast; only this block
# is gated off. Adding a fast gate needs no edit here. ---
if [ "$FAST" -ne 1 ]; then
  if [ "$LIST_ONLY" -eq 1 ]; then
    PLAN+=("test")
    PLAN+=("check-coverage-floor")
  else
    # Test + coverage: CI runs `bun test --coverage` ONCE, tees the output, and the
    # floor gate reads it via --from-file (single suite run). Mirror that exactly.
    COV_FILE="$(mktemp "${TMPDIR:-/tmp}/ci-local-coverage.XXXXXX")"
    trap 'rm -f "$COV_FILE"' EXIT
    printf '\n=== test (with coverage) ===\n'
    if bun test --coverage 2>&1 | tee "$COV_FILE"; then
      NAMES+=("test")
      STATUSES+=("PASS")
    else
      NAMES+=("test")
      STATUSES+=("FAIL")
      FAILED=1
    fi
    run_gate "check-coverage-floor" bun run check-coverage-floor -- --from-file "$COV_FILE"
  fi

  # actionlint (CI "Lint workflows"): a non-bun binary. Run it if installed;
  # otherwise warn + record SKIP. Most PRs don't touch .github/workflows, and CI
  # still enforces it — so a missing local binary must not block the local run.
  if [ "$LIST_ONLY" -eq 1 ]; then
    PLAN+=("lint:workflows (actionlint)")
  elif command -v actionlint >/dev/null 2>&1; then
    run_gate "lint:workflows (actionlint)" actionlint
  else
    printf '\n=== lint:workflows (actionlint) ===\n'
    echo "ci-local: actionlint not installed — SKIPPED (CI still runs it)." >&2
    echo "  install: https://github.com/rhysd/actionlint" >&2
    NAMES+=("lint:workflows (actionlint)")
    STATUSES+=("SKIP")
  fi
fi

# --- --list: print the gate plan (one per line, run order) + exit. No gate runs;
# no side effects. This is the behavioral source the drift-guard test reads. ---
if [ "$LIST_ONLY" -eq 1 ]; then
  for g in "${PLAN[@]}"; do
    printf '%s\n' "$g"
  done
  exit 0
fi

# --- Summary ---
printf '\n=== ci-local summary ===\n'
SKIPPED=0
i=0
while [ "$i" -lt "${#NAMES[@]}" ]; do
  printf '  %-40s %s\n' "${NAMES[$i]}" "${STATUSES[$i]}"
  [ "${STATUSES[$i]}" = "SKIP" ] && SKIPPED=$((SKIPPED + 1))
  i=$((i + 1))
done

# Advisory footer (NOT a gate): if uncommitted substrate was detected above, the
# check-decision-log result in this summary did NOT cover it (commit-based gate).
# Surfaced here at the go/no-go point so the summary can't read as "all clear".
if [ -n "$DLOG_ADVISORY" ]; then
  printf '\nci-local: ADVISORY — uncommitted substrate detected; the check-decision-log result above\n'
  printf '  did NOT evaluate it (commit-based gate). Commit-then-recheck before pushing — see the\n'
  printf '  "uncommitted substrate (decision-log)" advisory above for the exact remedy.\n'
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\nci-local: FAIL — fix the above before pushing (CI will reject otherwise).\n' >&2
  exit 1
fi

# --fast: ran the fast CI gates only; the slow trio is deferred BY DESIGN. Do NOT
# assert local-green == CI-green (the deferred gates still gate in CI + full
# ci-local) — that over-assertion is the exact false-confidence class this tool
# exists to kill.
if [ "$FAST" -eq 1 ]; then
  printf '\nci-local: --fast — all fast CI gates passed. DEFERRED to `bun run ci-local` (full) + CI: test+coverage, check-coverage-floor, actionlint. local-fast-green does NOT assert CI-green for those.\n'
  exit 0
fi

# Only assert "== CI-green" when NO gate was SKIPPED locally. A SKIPPED gate
# (e.g. actionlint absent) still runs in CI, so local-green does NOT prove
# CI-green for it — caveat rather than over-assert. Asserting it unconditionally
# would be the exact false-confidence class this tool exists to kill
# (Charlie #199 F1, Contract lens).
if [ "$SKIPPED" -ne 0 ]; then
  printf '\nci-local: all RUN gates passed; %d gate(s) SKIPPED locally — CI still enforces those, so this does NOT assert local-green == CI-green for them. Install the skipped tooling for full parity.\n' "$SKIPPED"
  exit 0
fi
printf '\nci-local: all gates passed — local-green == CI-green.\n'
exit 0
