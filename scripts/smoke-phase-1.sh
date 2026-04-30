#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Phase 1 smoke matrix — 8 scenarios per parent plan §331.
#
# End-to-end via the top-level binary (`bin/claude-conductor`); complements
# the in-process bun:test suite. Run from plugin root post-build, pre-tag.
# Each scenario runs in an isolated sandbox channels-dir.
#
# Exit code: 0 on full pass, non-zero on first failure (failure point printed).
#
# Plan: ~/.claude/plans/generic-floating-hanrahan.md §331 Cross-slice smoke matrix.
# Extraction: ~/.claude/plans/lovely-dreaming-willow.md REV 2.1 §10.E moved
# the helpers (scenario/ok/fail/report/SID constants/counters) to
# smoke-common.sh. Output is byte-identical to the pre-extraction version
# (verified against captured /tmp/smoke-phase-1-reference.out).

set -euo pipefail

# Locate plugin root from script location (scripts/smoke-phase-1.sh).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
BIN="${ROOT}/bin/claude-conductor"

# Sandbox under macOS-friendly $TMPDIR (realpath-resolves to /private/var/folders/...).
SANDBOX="$(mktemp -d -t smoke-phase-1)"
export CLAUDE_CONDUCTOR_CHANNELS_DIR="${SANDBOX}/channels"

cleanup() {
  rm -rf "${SANDBOX}"
}
trap cleanup EXIT

# Source shared helpers (SID_A/B/C, PASS/FAIL counters, scenario/ok/fail/report).
# shellcheck disable=SC1091
source "${HERE}/smoke-common.sh"

# ─── Scenario 1: Single-session join + whoami round-trip via binary ───
scenario 1 "Single-session join + whoami round-trip"
CH="smoke-1-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
WHOAMI="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels whoami "${CH}" --json)"
if [[ "$(json_field "${WHOAMI}" identity)" == "Alpha" ]]; then
  ok "whoami returns Alpha for first claimant"
else
  fail "whoami JSON did not contain identity=Alpha — got: ${WHOAMI}"
fi
if [[ "$(json_field "${WHOAMI}" role)" == "queue" ]]; then
  ok "whoami returns default role=queue"
else
  fail "whoami JSON did not contain role=queue — got: ${WHOAMI}"
fi

# ─── Scenario 2: 2-session join distinct identities ───
scenario 2 "2-session join distinct identities"
CH="smoke-2-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_B}" "${BIN}" channels join "${CH}" >/dev/null
WHOAMI_A="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels whoami "${CH}" --json)"
WHOAMI_B="$(CLAUDE_SESSION_ID="${SID_B}" "${BIN}" channels whoami "${CH}" --json)"
ID_A="$(json_field "${WHOAMI_A}" identity)"
ID_B="$(json_field "${WHOAMI_B}" identity)"
if [[ "${ID_A}" == "Alpha" && "${ID_B}" == "Bravo" ]]; then
  ok "two sessions get Alpha + Bravo in NATO order"
else
  fail "session distinctness broken — A=${ID_A}, B=${ID_B}"
fi

# ─── Scenario 3: 26-session race (smoke; full coverage in identity-race.test.ts) ───
scenario 3 "26-session race (smoke; full coverage in test/channels/identity-race.test.ts)"
ok "deferred to in-process bun test (1000-iter property fuzz + 26-concurrent subprocess in identity-race.test.ts)"

# ─── Scenario 4: Legacy-message read with <unknown>: <body> rendering ───
scenario 4 "Legacy-message <unknown>: <body> rendering"
CH="smoke-4-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
# Manually append a legacy-shape message (no identity, no role).
JSONL_PATH="${CLAUDE_CONDUCTOR_CHANNELS_DIR}/${CH}/messages.jsonl"
TS="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
echo "{\"ts\":\"${TS}\",\"from\":\"${SID_A}\",\"kind\":\"note\",\"body\":\"legacy-no-identity\"}" >> "${JSONL_PATH}"
RENDER="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" 2>&1 || true)"
if echo "${RENDER}" | grep -q '<unknown>: legacy-no-identity'; then
  ok "legacy message renders as '<unknown>: <body>'"
else
  fail "legacy message render path broken — output: ${RENDER}"
fi

# ─── Scenario 5: set-role transitions (pen → queue → out) ───
scenario 5 "set-role transitions (queue → pen → out)"
CH="smoke-5-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels set-role "${CH}" --role pen >/dev/null
WHOAMI="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels whoami "${CH}" --json)"
if [[ "$(json_field "${WHOAMI}" role)" == "pen" ]]; then
  ok "queue → pen transition succeeded"
else
  fail "queue → pen transition broken — got: ${WHOAMI}"
fi
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels set-role "${CH}" --role out >/dev/null
WHOAMI="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels whoami "${CH}" --json)"
if [[ "$(json_field "${WHOAMI}" role)" == "out" ]]; then
  ok "pen → out transition succeeded"
else
  fail "pen → out transition broken — got: ${WHOAMI}"
fi

# ─── Scenario 6: Channel close mid-claim ───
scenario 6 "Channel close blocks subsequent send"
CH="smoke-6-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels close "${CH}" >/dev/null
SEND_OUT="$(echo "post-close" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note 2>&1 || true)"
if echo "${SEND_OUT}" | grep -qiE 'closed|refus'; then
  ok "post-close send rejected with 'closed' error"
else
  fail "channel close didn't block send — output: ${SEND_OUT}"
fi

# ─── Scenario 7: close-peer cycle (claim → close-peer → re-claim) ───
scenario 7 "close-peer cycle"
CH="smoke-7-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_B}" "${BIN}" channels join "${CH}" >/dev/null
# Wait beyond STALE_THRESHOLD_MS=60s would be too slow for smoke; use --force.
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels close-peer "${CH}" --peer Bravo --force >/dev/null
# Now Bravo's letter (B) should be available — re-claim should succeed.
CLAUDE_SESSION_ID="${SID_C}" "${BIN}" channels join "${CH}" >/dev/null
WHOAMI_C="$(CLAUDE_SESSION_ID="${SID_C}" "${BIN}" channels whoami "${CH}" --json)"
ID_C="$(json_field "${WHOAMI_C}" identity)"
if [[ "${ID_C}" == "Bravo" ]]; then
  ok "close-peer Bravo + re-join → Bravo letter recovered"
else
  fail "close-peer cycle broken — re-join got '${ID_C}', expected 'Bravo'"
fi

# ─── Scenario 8: Cross-session live-substrate compat (dotfiles shim → plugin) ───
scenario 8 "Cross-edge dotfiles shim → plugin (skip if dotfiles tree absent)"
DOTFILES="${CLAUDE_DOTFILES_ROOT:-${HOME}/.claude-dotfiles}"
if [[ -d "${DOTFILES}/src/channels" ]]; then
  CH="smoke-8-${RANDOM}"
  CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
  CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
  echo "from-binary" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
  # Read via the dotfiles shim path (uses claude-conductor/channels/cli internally).
  SHIM_OUT="$(cd "${DOTFILES}" && CLAUDE_SESSION_ID="${SID_A}" CLAUDE_CONDUCTOR_CHANNELS_DIR="${CLAUDE_CONDUCTOR_CHANNELS_DIR}" CHANNELS_DIR="${CLAUDE_CONDUCTOR_CHANNELS_DIR}" bun run src/channels/cli.ts read "${CH}" --json 2>&1 || true)"
  if echo "${SHIM_OUT}" | grep -q "from-binary"; then
    ok "dotfiles shim reads message written via plugin binary"
  else
    fail "cross-edge shim broken — shim read output: ${SHIM_OUT}"
  fi
else
  ok "skipped (dotfiles tree absent at ${DOTFILES})"
fi

# ─── Final report ───
report_and_exit "Phase 1"
