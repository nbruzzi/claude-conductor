# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Common smoke-matrix helpers shared by smoke-phase-1.sh + smoke-phase-2.sh.
#
# This file is sourced (not executed) — no shebang, no `set -euo pipefail`
# at this level (the sourcing scripts own their own strict-mode setup).
#
# Provides:
#   - HERE / ROOT / BIN path discovery
#   - SANDBOX setup with auto-cleanup trap
#   - Standard UUID-shape session ids (SID_A, SID_B, SID_C)
#   - PASS / FAIL counters + FAILED_SCENARIOS array
#   - scenario / ok / fail / report helpers
#   - jq-free JSON field extractor (uses python3 — same approach as
#     smoke-phase-1.sh did inline; lifted here for reuse)
#
# Plan: ~/.claude/plans/lovely-dreaming-willow.md REV 2.1 §10.E (RE-14
# closure: extraction must preserve smoke-phase-1's identical pre-extraction
# output character-for-character — captured to /tmp/smoke-phase-1-reference.out
# before this script existed, asserted byte-for-byte after).

# ─── Path discovery (caller sets BASH_SOURCE pointer pre-source) ──
_smoke_here() {
  cd "$(dirname "${BASH_SOURCE[1]}")" && pwd
}

_smoke_root() {
  cd "$(_smoke_here)/.." && pwd
}

# ─── Standard UUID-shape session ids (UUID-strict per Phase 1 contract) ──
SID_A="11111111-1111-4111-8111-111111111111"
SID_B="22222222-2222-4222-8222-222222222222"
SID_C="33333333-3333-4333-8333-333333333333"

# ─── Counters ──
PASS=0
FAIL=0
FAILED_SCENARIOS=()

# ─── Output helpers ──
scenario() {
  local n="$1"
  local desc="$2"
  echo ""
  echo "──── Scenario ${n}: ${desc} ────"
}

ok() {
  echo "  ✓ $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  ✗ $1" >&2
  FAIL=$((FAIL + 1))
  FAILED_SCENARIOS+=("$1")
}

# ─── Final report (caller invokes after all scenarios) ──
# Args:
#   $1 — phase label ("Phase 1", "Phase 2")
report_and_exit() {
  local label="$1"
  echo ""
  echo "──────────────────────────────"
  echo "  ${label} smoke matrix: ${PASS} pass / ${FAIL} fail"
  echo "──────────────────────────────"
  if [[ ${FAIL} -gt 0 ]]; then
    echo ""
    echo "Failed scenarios:"
    for s in "${FAILED_SCENARIOS[@]}"; do
      echo "  - ${s}"
    done
    exit 1
  fi
  exit 0
}

# ─── JSON field extractor (avoids jq dep; uses python3 stdlib only) ──
# Args:
#   $1 — JSON string
#   $2 — top-level key
# Stdout: value as string (empty if missing)
json_field() {
  python3 -c "import json,sys;print(json.load(sys.stdin).get(\"$2\",\"\"))" <<<"$1"
}
