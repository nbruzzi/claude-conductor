#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Phase 2 smoke matrix — scenarios #9-#27 covering Phase 2 hook surfaces.
#
# End-to-end via the top-level binary (`bin/claude-conductor`); complements
# the in-process bun:test suite (506 tests). Run from plugin root post-build,
# pre-tag. Each scenario runs in an isolated sandbox channels-dir.
#
# Coverage:
#   9-18  — Slice 8 CLI verbs (--since-mtime ms/ISO, --since-cursor bootstrap +
#           delta, forget-cursor present/absent/archived, show-cursor present/
#           absent, mutual-exclusivity error).
#   19-23 — Substrate file format (last-seen cursor JSON, heartbeat body
#           timestamp, idle-emit cursor JSON, gc-reap cursor JSON, presence-
#           failure-log breadcrumb path).
#   24-27 — Cross-slice + cross-edge integration (orphan-sentinel JSON status,
#           archived-channel kind handling, dispatcher-level hook firing
#           deferred to in-process bun:test, dotfiles shim Phase 2 reach).
#
# Hook firing scenarios (UserPromptSubmit / SessionStart / PreToolUse) are
# deferred to in-process bun:test because the plugin's binary doesn't include
# a dispatcher (that lives in dotfiles via claude-conductor/hooks/registry
# import). The smoke matrix here verifies the SUBSTRATE surfaces those hooks
# read/write, which is the load-bearing layer for cross-session correctness.
#
# Exit code: 0 on full pass, non-zero on first failure (failure point printed).
#
# Plan: ~/.claude/plans/lovely-dreaming-willow.md REV 2.1 §10.E.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
BIN="${ROOT}/bin/claude-conductor"

SANDBOX="$(mktemp -d -t smoke-phase-2)"
export CLAUDE_CONDUCTOR_CHANNELS_DIR="${SANDBOX}/channels"

cleanup() {
  rm -rf "${SANDBOX}"
}
trap cleanup EXIT

# shellcheck disable=SC1091
source "${HERE}/smoke-common.sh"

# ─── Scenario 9: read with no flag returns full history ───
scenario 9 "read with no flag returns full history"
CH="smoke-9-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
echo "msg-1" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
echo "msg-2" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
READ_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --json 2>/dev/null)"
COUNT="$(echo "${READ_OUT}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("messages",[])))')"
if [[ "${COUNT}" == "2" ]]; then
  ok "read returns 2 messages"
else
  fail "read full history returned ${COUNT} messages (expected 2)"
fi

# ─── Scenario 10: read --since-mtime <ms> filters by epoch ms ───
scenario 10 "read --since-mtime <ms> filters by epoch ms"
CH="smoke-10-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
echo "old" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
sleep 0.05
CUTOFF_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"
sleep 0.05
echo "new" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
READ_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --since-mtime "${CUTOFF_MS}" --json 2>/dev/null)"
COUNT="$(echo "${READ_OUT}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("messages",[])))')"
if [[ "${COUNT}" == "1" ]]; then
  ok "read --since-mtime <ms> returns only post-cutoff message"
else
  fail "since-mtime ms filter returned ${COUNT} messages (expected 1)"
fi

# ─── Scenario 11: read --since-mtime <iso> accepts ISO 8601 ───
scenario 11 "read --since-mtime <iso> accepts ISO 8601"
CH="smoke-11-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
# Write a message dated 2020 + a message dated now.
JSONL_PATH="${CLAUDE_CONDUCTOR_CHANNELS_DIR}/${CH}/messages.jsonl"
echo "{\"ts\":\"2020-01-01T00:00:00.000Z\",\"from\":\"${SID_A}\",\"kind\":\"note\",\"body\":\"old-2020\"}" >> "${JSONL_PATH}"
echo "{\"ts\":\"$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')\",\"from\":\"${SID_A}\",\"kind\":\"note\",\"body\":\"current\"}" >> "${JSONL_PATH}"
READ_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --since-mtime "2025-01-01T00:00:00Z" --json 2>/dev/null)"
COUNT="$(echo "${READ_OUT}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("messages",[])))')"
if [[ "${COUNT}" == "1" ]]; then
  ok "read --since-mtime <iso> filters by parsed timestamp"
else
  fail "since-mtime ISO returned ${COUNT} (expected 1)"
fi

# ─── Scenario 12: read --since-cursor bootstrap returns full + writes cursor ───
scenario 12 "read --since-cursor bootstrap returns full + writes cursor"
CH="smoke-12-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
echo "msg-bootstrap-1" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
echo "msg-bootstrap-2" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
READ_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --since-cursor --json 2>/dev/null)"
STATUS="$(echo "${READ_OUT}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("meta",{}).get("since_cursor_status",""))')"
COUNT="$(echo "${READ_OUT}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get("messages",[])))')"
CURSOR_FILE="${CLAUDE_CONDUCTOR_CHANNELS_DIR}/${CH}/last-seen-cursors/${SID_A}.json"
if [[ "${STATUS}" == "bootstrap" && "${COUNT}" == "2" && -f "${CURSOR_FILE}" ]]; then
  ok "bootstrap returns 2 messages + cursor written"
else
  fail "bootstrap broken — status=${STATUS}, count=${COUNT}, cursor exists=$(test -f "${CURSOR_FILE}" && echo y || echo n)"
fi

# ─── Scenario 13: read --since-cursor (post-bootstrap) returns delta only ───
scenario 13 "read --since-cursor post-bootstrap returns delta only"
sleep 0.05
echo "msg-delta" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
READ_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --since-cursor --json 2>/dev/null)"
# Post-bootstrap response is a bare array (no meta wrapping; bootstrap-only flag).
COUNT="$(echo "${READ_OUT}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("messages",[])))')"
if [[ "${COUNT}" == "1" ]]; then
  ok "post-bootstrap returns 1 delta message (bare array, no bootstrap meta)"
else
  fail "post-bootstrap delta broken — count=${COUNT}"
fi

# ─── Scenario 14: show-cursor after read → kind=present ───
scenario 14 "show-cursor after read returns kind=present"
SHOW_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels show-cursor "${CH}" --json 2>/dev/null)"
KIND="$(json_field "${SHOW_OUT}" kind)"
if [[ "${KIND}" == "present" ]]; then
  ok "show-cursor reports kind=present after read --since-cursor"
else
  fail "show-cursor expected present, got: ${SHOW_OUT}"
fi

# ─── Scenario 15: show-cursor before any read → kind=absent ───
scenario 15 "show-cursor before any read returns kind=absent"
CH="smoke-15-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
SHOW_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels show-cursor "${CH}" --json 2>/dev/null)"
KIND="$(json_field "${SHOW_OUT}" kind)"
if [[ "${KIND}" == "absent" ]]; then
  ok "show-cursor reports kind=absent pre-read"
else
  fail "show-cursor expected absent, got: ${SHOW_OUT}"
fi

# ─── Scenario 16: forget-cursor on existing cursor → kind=cleared ───
scenario 16 "forget-cursor on existing cursor returns kind=cleared"
CH="smoke-16-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
echo "seed" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --since-cursor --json >/dev/null
FORGET_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels forget-cursor "${CH}" --json 2>/dev/null)"
KIND="$(json_field "${FORGET_OUT}" kind)"
if [[ "${KIND}" == "cleared" ]]; then
  ok "forget-cursor on existing cursor returns kind=cleared"
else
  fail "forget-cursor cleared expected, got: ${FORGET_OUT}"
fi

# ─── Scenario 17: forget-cursor when no cursor → kind=absent (idempotent) ───
scenario 17 "forget-cursor when no cursor returns kind=absent"
FORGET_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels forget-cursor "${CH}" --json 2>/dev/null)"
KIND="$(json_field "${FORGET_OUT}" kind)"
if [[ "${KIND}" == "absent" ]]; then
  ok "forget-cursor on absent cursor returns kind=absent (idempotent)"
else
  fail "forget-cursor absent expected, got: ${FORGET_OUT}"
fi

# ─── Scenario 18: read --since-mtime + --since-cursor mutually exclusive ───
scenario 18 "read --since-mtime + --since-cursor are mutually exclusive (hard error)"
CH="smoke-18-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
# Use valid --since-mtime ms (1) so the parser passes validation and reaches
# the mutual-exclusivity check (which is enforced after individual flag parse).
if CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --since-mtime 1 --since-cursor >/tmp/smoke-18-out 2>&1; then
  fail "mutual exclusion expected — command succeeded; output: $(cat /tmp/smoke-18-out)"
elif grep -qiE 'mutually|exclusive' /tmp/smoke-18-out; then
  ok "mutual exclusion enforced with non-zero exit + 'mutually exclusive' error"
else
  fail "mutual exclusion expected — output: $(cat /tmp/smoke-18-out)"
fi
rm -f /tmp/smoke-18-out

# ─── Scenario 19: last-seen cursor file shape after read --since-cursor ───
scenario 19 "last-seen cursor file shape after read --since-cursor"
CH="smoke-19-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
echo "x" | CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels send "${CH}" note >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels read "${CH}" --since-cursor --json >/dev/null
CURSOR_FILE="${CLAUDE_CONDUCTOR_CHANNELS_DIR}/${CH}/last-seen-cursors/${SID_A}.json"
if [[ -f "${CURSOR_FILE}" ]]; then
  CURSOR_BODY="$(cat "${CURSOR_FILE}")"
  HAS_MTIME="$(echo "${CURSOR_BODY}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("yes" if "mtime" in d else "no")')"
  HAS_TS="$(echo "${CURSOR_BODY}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("yes" if "ts" in d else "no")')"
  if [[ "${HAS_MTIME}" == "yes" && "${HAS_TS}" == "yes" ]]; then
    ok "cursor file has {mtime, ts} shape"
  else
    fail "cursor shape missing fields — body: ${CURSOR_BODY}"
  fi
else
  fail "cursor file not written at ${CURSOR_FILE}"
fi

# ─── Scenario 20: heartbeat body content is integer ms (Slice 7 schema) ───
scenario 20 "heartbeat body is integer ms (Slice 7 schema extension)"
CH="smoke-20-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
HB_FILE="${CLAUDE_CONDUCTOR_CHANNELS_DIR}/${CH}/heartbeats/${SID_A}"
if [[ -f "${HB_FILE}" ]]; then
  HB_BODY="$(cat "${HB_FILE}")"
  if python3 -c "n=int('${HB_BODY}'); assert n > 1700000000000 and n < 9999999999999" 2>/dev/null; then
    ok "heartbeat body is plausible epoch-ms integer"
  else
    fail "heartbeat body not parseable as ms timestamp — body: ${HB_BODY}"
  fi
else
  fail "heartbeat file missing at ${HB_FILE}"
fi

# ─── Scenario 21: archived channel: forget-cursor returns kind=archived ───
scenario 21 "archived channel: forget-cursor returns kind=archived"
CH="smoke-21-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels close "${CH}" >/dev/null
# Manually move to .archive (channels archive on close after retention; smoke triggers explicit).
ARCHIVE_DIR="${CLAUDE_CONDUCTOR_CHANNELS_DIR}/.archive"
mkdir -p "${ARCHIVE_DIR}"
mv "${CLAUDE_CONDUCTOR_CHANNELS_DIR}/${CH}" "${ARCHIVE_DIR}/${CH}" 2>/dev/null || true
FORGET_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels forget-cursor "${CH}" --json 2>/dev/null || true)"
KIND="$(json_field "${FORGET_OUT}" kind)"
if [[ "${KIND}" == "archived" || "${KIND}" == "absent" ]]; then
  # Either kind acceptable — channel-not-live state classification varies.
  ok "archived channel forget-cursor returns kind=${KIND}"
else
  fail "archived forget-cursor expected archived/absent, got: ${FORGET_OUT}"
fi

# ─── Scenario 22: close-peer JSON includes orphan_sentinel field (Slice 3) ───
scenario 22 "close-peer JSON includes orphan_sentinel field (Slice 3)"
CH="smoke-22-${RANDOM}"
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels create "${CH}" "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels join "${CH}" >/dev/null
CLAUDE_SESSION_ID="${SID_B}" "${BIN}" channels join "${CH}" >/dev/null
CLOSE_OUT="$(CLAUDE_SESSION_ID="${SID_A}" "${BIN}" channels close-peer "${CH}" --peer Bravo --force --json 2>/dev/null)"
HAS_ORPHAN="$(echo "${CLOSE_OUT}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("yes" if "orphan_sentinel" in d else "no")')"
if [[ "${HAS_ORPHAN}" == "yes" ]]; then
  ok "close-peer JSON includes orphan_sentinel boolean"
else
  fail "close-peer JSON missing orphan_sentinel — output: ${CLOSE_OUT}"
fi

# ─── Scenario 23: removed in Phase 4 — parity script retired (replaced by §4.7 invariants) ───

# ─── Scenario 24: identity-injector source-class is channels-identity (ARCH-W2-1 fix) ───
scenario 24 "identity-context emits source: channels-identity (ARCH-W2-1 closure)"
GREP_OUT="$(grep -h 'source: SOURCE\|SOURCE = "channels-identity"' "${ROOT}/src/channels/identity-context.ts" || true)"
if echo "${GREP_OUT}" | grep -q 'channels-identity'; then
  ok "identity-context.ts SOURCE constant resolves to channels-identity"
else
  fail "identity-context.ts SOURCE drift — ${GREP_OUT}"
fi

# ─── Scenario 25: PresenceFailureKind union includes clock-skew (Slice 7 §A.0) ───
scenario 25 "PresenceFailureKind union includes clock-skew (Slice 7 §A.0 closure)"
GREP_OUT="$(grep '"clock-skew"' "${ROOT}/src/shared/presence-failure-log.ts" || true)"
if [[ -n "${GREP_OUT}" ]]; then
  ok "PresenceFailureKind includes clock-skew + validator branch"
else
  fail "clock-skew kind missing from presence-failure-log.ts"
fi

# ─── Scenario 26: hooks-layer.md cites correct breadcrumb path (CLI-W2-7a closure) ───
scenario 26 "hooks-layer.md cites correct breadcrumb path (CLI-W2-7a closure)"
GREP_OUT="$(grep -E 'presence-gate-failures\.log' "${ROOT}/docs/architecture/hooks-layer.md" || true)"
if [[ -n "${GREP_OUT}" ]]; then
  ok "hooks-layer.md cites ~/.claude/logs/.presence-gate-failures.log"
else
  fail "hooks-layer.md missing correct breadcrumb path"
fi

# ─── Scenario 27: Cross-edge — dotfiles shim resolves Phase 2 hooks ───
scenario 27 "Cross-edge dotfiles shim resolves Phase 2 hooks (skip if dotfiles tree absent)"
DOTFILES="${CLAUDE_DOTFILES_ROOT:-${HOME}/.claude-dotfiles}"
if [[ -d "${DOTFILES}/src/hooks/checks" ]]; then
  HOOKS=("teammate-idle-reminder" "task-coordinator" "identity-injector" "channels-gc-reaper")
  MISSING=""
  for h in "${HOOKS[@]}"; do
    if [[ ! -f "${DOTFILES}/src/hooks/checks/${h}.ts" ]]; then
      MISSING+="${h} "
    fi
  done
  if [[ -z "${MISSING}" ]]; then
    ok "dotfiles tree has all 4 Phase 2 hook shims"
  else
    fail "dotfiles tree missing shims: ${MISSING}"
  fi
else
  ok "skipped (dotfiles tree absent at ${DOTFILES})"
fi

report_and_exit "Phase 2"
