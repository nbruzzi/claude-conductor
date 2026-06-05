#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Liveness-gate store-contract enforcement
# (docs/conventions/liveness-gate-store-contract.md).
#
# TRIPWIRE: any src/ (non-test) file that reads a RAW single-store liveness
# primitive must be on the ALLOWLIST below — a gate already classified +
# verified against the store contract. Two primitive classes, two error codes:
#   - LGC-001: a liveness PREFIX-HELPER (isSessionLiveByPrefix /
#     isSidPrefixLiveOnChannel) — a single-STORE alive-anywhere probe.
#   - LGC-002 (C1 S1): the raw classifyLiveness single-LISTING verdict — a
#     single-store liveness bucket. The canonical OR-composer
#     (active-sessions/session-liveness.ts: classifySessionLiveness /
#     isSessionLive / sessionLivePrefixSource) reads ALL stores; a NEW gate must
#     route through it, NOT a raw primitive. RFC #200 §3.1 — the structural
#     root-vs-patch closure: a single-store alive-anywhere gate is CAUGHT here.
# A NEW caller is flagged, forcing the author to CLASSIFY the gate:
#   - alive-anywhere ("is this session alive / doing ANY work?") -> route through
#     the canonical OR-composer (it consults ALL stores), OR if it is a verified
#     both-stores gate, classify it + add to ALLOWLIST;
#   - store-specific (a participation-in-ONE-store liveness, e.g. reclaim) -> the
#     one store that defines that participation; add to ALLOWLIST.
#
# SCOPE (honest): this tripwires the prefix-helper probes + the classifyLiveness
# verdict — the alive-anywhere-DECISION primitives. A gate that reads a store via
# another raw primitive (heartbeat_mtime_ms / scanHeartbeats / newestHeartbeatMtime)
# is NOT auto-caught here: those are ENUMERATION / field reads, not a single-store
# alive-anywhere VERDICT, and the written contract + the PR-boundary review cover
# them. The allow-list IS the human-verified both-stores gate set; this tripwire
# makes adding a NEW un-classified single-store gate impossible-to-do-silently.
#
# Run:    bun run check-liveness-gate-store-contract
#         bash scripts/check-liveness-gate-store-contract.sh
# Exit:   0 = clean   1 = violations   2+ = error (e.g. not in a git repo)
# Output: compiler-style `<file>:<line>:<col>: error[LGC-00N]: <msg>` to stderr;
#         clean message to stdout. Under GITHUB_ACTIONS=true also emits
#         `::error file=...,line=...::` annotations. Error-code convention:
#         <DETECTOR-PREFIX>-<NNN>; see docs/conventions/error-code-scheme.md.
#
# Bash 3.2+ portable (do NOT use mapfile).

set -e
set -u
set -o pipefail

for arg in "$@"; do
  case "$arg" in
    --help | -h)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "check-liveness-gate-store-contract: error: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-liveness-gate-store-contract: error: not in a git repo (run from inside a checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# Files ALLOWED to reference the raw liveness primitives. Categories:
#   THE CANONICAL OR-COMPOSER (C1 S1) — reads the raw primitives to COMPOSE them:
#     - active-sessions/session-liveness.ts (classifySessionLiveness /
#       isSessionLive / sessionLivePrefixSource; consults BOTH stores). The path
#       every NEW gate must route through.
#   CLASSIFIED GATES / ENUMERATORS (store-contract-verified, A1 + C1):
#     - reconcile-boot presence-GC — alive-anywhere enumerator; classifyLiveness
#       over its OWN scanHeartbeats enumeration + isSidPrefixLiveOnChannel.
#     - teammate-idle-reminder — alive-anywhere; isSessionLiveByPrefix (active)
#       OR-ed with its existing heartbeat_mtime_ms channel idle-read (a verified
#       both-stores gate via a different channel primitive — WHY the tripwire is
#       allow-list-gated, not "calls both helpers").
#   HELPER SOURCES (define / re-export the primitives; not gates):
#     - active-sessions/index.ts (defines isSessionLiveByPrefix + classifyLiveness),
#       channels/index.ts (defines isSidPrefixLiveOnChannel),
#       channels/api.ts (re-exports isSidPrefixLiveOnChannel).
# NOTE: the worktree reapers (dotfiles-worktree-gc / repo-worktree-gc) are NO
# LONGER listed — C1 S1 migrated them to route through session-liveness.ts's
# sessionLivePrefixSource, so they no longer touch a raw primitive directly.
# A NEW src/ caller not listed here is a new liveness gate -> route through the
# canonical OR-composer, or classify + add.
ALLOWLIST=(
  "src/active-sessions/session-liveness.ts"
  "src/active-sessions/reconcile-boot.ts"
  "src/hooks/checks/teammate-idle-reminder.ts"
  "src/active-sessions/index.ts"
  "src/channels/index.ts"
  "src/channels/api.ts"
)

HELPER_REGEX='isSessionLiveByPrefix|isSidPrefixLiveOnChannel|classifyLiveness'

# Tracked src/ files, excluding tests (*.test.ts + any __tests__/).
FILES=()
while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(git ls-files -z -- 'src' ':(exclude)*.test.ts' ':(exclude)src/**/__tests__/**')

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "check-liveness-gate-store-contract: clean (0 src files to scan)"
  exit 0
fi

# Single grep pass for the raw-primitive names. Direct file args (NOT xargs) so
# the tristate exit (0=match / 1=no-match / 2+=error) is grep's, not xargs' 123.
# NOTE the regex is substring (no \b): isSessionLiveByPrefix does NOT match the
# canonical isSessionLivePrefix, and classifyLiveness does NOT match the canonical
# classifySessionLiveness — the canonical functions are deliberately never hits.
GREP_EXIT=0
RAW_HITS=$(grep -HnE "$HELPER_REGEX" "${FILES[@]}" 2>&1) || GREP_EXIT=$?
if [[ $GREP_EXIT -ge 2 ]]; then
  echo "check-liveness-gate-store-contract: error: grep failed (exit $GREP_EXIT)" >&2
  echo "$RAW_HITS" >&2
  exit 2
fi

# Filter: drop comment-narration lines (a mention, not a call) + allow-listed
# files. What survives is a CALL to a raw primitive in a non-allow-listed file.
ALLOW_STR=$(IFS=,; echo "${ALLOWLIST[*]}")
VIOLATIONS=$(printf '%s\n' "$RAW_HITS" | awk -v allow="$ALLOW_STR" '
  BEGIN { n = split(allow, arr, ","); for (i = 1; i <= n; i++) m[arr[i]] = 1 }
  /^$/ { next }
  {
    match($0, /^[^:]+:[0-9]+:/)
    if (RLENGTH <= 0) next
    prefix = substr($0, 1, RLENGTH)
    content = substr($0, RLENGTH + 1)
    split(prefix, p, ":")
    file = p[1]
    # Comment-narration (a mention, not a call): JSDoc continuation ` * `, a
    # block-comment opener ` /* `, and a line comment ` // `. There is deliberately
    # NO bash `#` rule: the scan set is .ts-only, where a leading `#` is a PRIVATE
    # FIELD (e.g. `#live = isSessionLiveByPrefix(...)`), not a comment — stripping
    # it would hide a real call (false-negative).
    if (content ~ /^[[:space:]]*\*/) next
    if (content ~ /^[[:space:]]*\/\*/) next
    if (content ~ /^[[:space:]]*\/\//) next
    # Allow-listed files may reference the primitives.
    if (file in m) next
    print
  }
' || true)

if [[ -z "$VIOLATIONS" ]]; then
  echo "check-liveness-gate-store-contract: clean (${#FILES[@]} src files scanned; all raw-primitive callers allow-listed)"
  exit 0
fi

MSG_PREFIX="calls a liveness prefix-helper (isSessionLiveByPrefix/isSidPrefixLiveOnChannel) but is not on the ALLOWLIST — this is a NEW single-store liveness gate. Route the decision through the canonical OR-composer active-sessions/session-liveness.ts (classifySessionLiveness/isSessionLive/sessionLivePrefixSource — it consults ALL stores), or if it is a verified both-stores gate, classify it per docs/conventions/liveness-gate-store-contract.md and add the file to ALLOWLIST in scripts/check-liveness-gate-store-contract.sh"
MSG_CLASSIFY="reads the raw classifyLiveness single-listing verdict but is not on the ALLOWLIST — this is a NEW single-store liveness gate (RFC #200 §3.1; the raw primitive yields a single-store bucket). Route the decision through the canonical OR-composer active-sessions/session-liveness.ts (classifySessionLiveness/isSessionLive/sessionLivePrefixSource — it consults ALL stores), or classify it per docs/conventions/liveness-gate-store-contract.md and add the file to ALLOWLIST"

printf '%s\n' "$VIOLATIONS" | awk -v msgp="$MSG_PREFIX" -v msgc="$MSG_CLASSIFY" -v gha="${GITHUB_ACTIONS:-}" '
{
  match($0, /^[^:]+:[0-9]+:/)
  prefix = substr($0, 1, RLENGTH)
  content = substr($0, RLENGTH + 1)
  split(prefix, p, ":")
  file = p[1]
  line = p[2]
  # classifyLiveness (the single-listing verdict) -> LGC-002; the prefix-helpers
  # -> LGC-001. Key the line by the raw primitive it references.
  if (content ~ /classifyLiveness/) { code = "LGC-002"; msg = msgc }
  else { code = "LGC-001"; msg = msgp }
  printf "%s:%s:1: error[%s]: %s\n", file, line, code, msg
  if (gha == "true") {
    printf "::error file=%s,line=%s,col=1,title=%s::%s\n", file, line, code, msg
  }
}
' >&2

TOTAL=$(printf '%s\n' "$VIOLATIONS" | wc -l | tr -d ' ')
FILE_COUNT=$(printf '%s\n' "$VIOLATIONS" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')
echo "check-liveness-gate-store-contract: ${TOTAL} violation(s) across ${FILE_COUNT} file(s) — new liveness gate(s) reading a raw single-store primitive but not classified against the store contract" >&2
exit 1
