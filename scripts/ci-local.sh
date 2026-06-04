#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# ci-local — run the FULL CI gate set (.github/workflows/test.yml) locally, in
# CI order, so a developer gets local-green == CI-green BEFORE pushing.
#
# Why this exists: the pre-commit gate runs a fast SUBSET (typecheck / format /
# lint / test). Several CI gates are NOT in that subset — notably
# check-decision-log (DLOG-001) and the coverage floor — so "local clean" did
# not imply "CI clean". That gap cost repeated fix-amend-repush cycles. This
# script closes it: one command that mirrors every CI gate.
#
# Behavior: RUN-ALL, not fail-fast. Every gate runs even if an earlier one
# fails; results are aggregated into a summary and the script exits non-zero if
# ANY gate failed. This surfaces ALL failures in a single pass (fix everything
# once) instead of one-failure-per-run.
#
# Gate parity is drift-guarded by test/scripts/ci-local.test.ts, which asserts
# every `bun run <gate>` step in test.yml is invoked here — so a future CI gate
# can't be silently omitted (which would resurrect the false-confidence tax).
#
# Run:    bun run ci-local
#         bash scripts/ci-local.sh
# Exit:   0 = all gates passed
#         1 = one or more gates failed (see the summary)
#         2 = harness error (not a git repo)
#
# Bash 3.2+ portable (macOS default bash): no associative arrays, portable
# mktemp template form.

set -u
set -o pipefail
# Deliberately NOT `set -e`: we run every gate and aggregate, so a failing gate
# must not abort the script.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ci-local: error: not in a git repo (run from inside the checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# Parallel name/status arrays (Bash 3.2 has no associative arrays).
NAMES=()
STATUSES=()
FAILED=0

run_gate() {
  # $1 = display name; remaining args = the command to run.
  local name="$1"
  shift
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

# --- Gates in test.yml order (the `bun run <gate>` steps) ---
run_gate "typecheck" bun run typecheck
run_gate "verify:drift" bun run verify:drift
run_gate "format:check" bun run format:check
run_gate "lint" bun run lint
run_gate "check-generic-paths" bun run check-generic-paths
run_gate "check-import-extensions" bun run check-import-extensions
run_gate "check-dep-rationale" bun run check-dep-rationale
run_gate "check-spdx-headers" bun run check-spdx-headers
run_gate "check-decision-log" bun run check-decision-log
run_gate "check-liveness-gate-store-contract" bun run check-liveness-gate-store-contract

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

# actionlint (CI "Lint workflows"): a non-bun binary. Run it if installed;
# otherwise warn + record SKIP. Most PRs don't touch .github/workflows, and CI
# still enforces it — so a missing local binary must not block the local run.
if command -v actionlint >/dev/null 2>&1; then
  run_gate "lint:workflows (actionlint)" actionlint
else
  printf '\n=== lint:workflows (actionlint) ===\n'
  echo "ci-local: actionlint not installed — SKIPPED (CI still runs it)." >&2
  echo "  install: https://github.com/rhysd/actionlint" >&2
  NAMES+=("lint:workflows (actionlint)")
  STATUSES+=("SKIP")
fi

# --- Summary ---
printf '\n=== ci-local summary ===\n'
i=0
while [ "$i" -lt "${#NAMES[@]}" ]; do
  printf '  %-40s %s\n' "${NAMES[$i]}" "${STATUSES[$i]}"
  i=$((i + 1))
done

if [ "$FAILED" -ne 0 ]; then
  printf '\nci-local: FAIL — fix the above before pushing (CI will reject otherwise).\n' >&2
  exit 1
fi
printf '\nci-local: all gates passed — local-green == CI-green.\n'
exit 0
