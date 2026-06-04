#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Liveness-gate store-contract enforcement
# (docs/conventions/liveness-gate-store-contract.md).
#
# TRIPWIRE: any src/ (non-test) file that CALLS a liveness prefix-helper
# (isSessionLiveByPrefix / isSidPrefixLiveOnChannel) must be on the ALLOWLIST
# below — a gate already classified + verified against the store contract.
# A NEW caller is flagged LGC-001, forcing the author to CLASSIFY the gate:
#   - alive-anywhere ("is this session alive / doing ANY work?") -> must consult
#     ALL stores (active-sessions + the coordination channel), at every decision
#     point it acts on the liveness;
#   - store-specific (a participation-in-ONE-store liveness, e.g. reclaim) -> the
#     one store that defines that participation.
# ...then add it to ALLOWLIST with the classification, or route the liveness
# decision through an existing allow-listed gate.
#
# SCOPE (honest): this tripwires the IDIOMATIC prefix-helper probes — the common
# new-gate shape. A gate that reads a store via a RAW primitive
# (heartbeat_mtime_ms / scanHeartbeats / newestHeartbeatMtime) instead of a
# prefix-helper is NOT auto-caught here; the written contract + the PR-boundary
# store-contract review cover that. (teammate-idle reads the channel via
# heartbeat_mtime_ms, not isSidPrefixLiveOnChannel — it is allow-listed as a
# verified-compliant gate, not auto-verified.) A grep cannot verify "consults
# both stores by any mechanism" (the channel read has 3+ forms); the allow-list
# IS the human-verified both-stores gate, and this tripwire makes adding a NEW
# un-classified gate impossible-to-do-silently.
#
# Run:    bun run check-liveness-gate-store-contract
#         bash scripts/check-liveness-gate-store-contract.sh
# Exit:   0 = clean   1 = violations   2+ = error (e.g. not in a git repo)
# Output: compiler-style `<file>:<line>:<col>: error[LGC-001]: <msg>` to stderr;
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

# Files ALLOWED to reference the liveness prefix-helpers. Two categories:
#   GATES (classified + store-contract-verified this cohort, A1):
#     - the two worktree reapers + reconcile-boot presence-GC — alive-anywhere;
#       consult active-sessions AND the channel (channel via isSidPrefixLiveOnChannel).
#     - teammate-idle-reminder — alive-anywhere; consults active-sessions via
#       isSessionLiveByPrefix + the channel via its existing heartbeat_mtime_ms
#       idle-read (NOT isSidPrefixLiveOnChannel — verified-compliant via a
#       different channel primitive; this is WHY the tripwire is allow-list-gated,
#       not "calls both helpers").
#   HELPER SOURCES (define / re-export / JSDoc-reference the helpers; not gates):
#     - active-sessions/index.ts (defines isSessionLiveByPrefix),
#       channels/index.ts (defines isSidPrefixLiveOnChannel + JSDoc-mentions the
#       sibling), channels/api.ts (re-exports isSidPrefixLiveOnChannel).
# A NEW src/ caller not listed here is a new liveness gate -> classify + add, or
# route the liveness decision through an allow-listed gate.
ALLOWLIST=(
  "src/hooks/checks/dotfiles-worktree-gc.ts"
  "src/hooks/checks/repo-worktree-gc.ts"
  "src/active-sessions/reconcile-boot.ts"
  "src/hooks/checks/teammate-idle-reminder.ts"
  "src/active-sessions/index.ts"
  "src/channels/index.ts"
  "src/channels/api.ts"
)

HELPER_REGEX='isSessionLiveByPrefix|isSidPrefixLiveOnChannel'

# Tracked src/ files, excluding tests (*.test.ts + any __tests__/).
FILES=()
while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(git ls-files -z -- 'src' ':(exclude)*.test.ts' ':(exclude)src/**/__tests__/**')

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "check-liveness-gate-store-contract: clean (0 src files to scan)"
  exit 0
fi

# Single grep pass for the two helper names. Direct file args (NOT xargs) so the
# tristate exit (0=match / 1=no-match / 2+=error) is grep's, not xargs' 123.
GREP_EXIT=0
RAW_HITS=$(grep -HnE "$HELPER_REGEX" "${FILES[@]}" 2>&1) || GREP_EXIT=$?
if [[ $GREP_EXIT -ge 2 ]]; then
  echo "check-liveness-gate-store-contract: error: grep failed (exit $GREP_EXIT)" >&2
  echo "$RAW_HITS" >&2
  exit 2
fi

# Filter: drop comment-narration lines (a mention, not a call) + allow-listed
# files. What survives is a CALL to a prefix-helper in a non-allow-listed file.
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
    # Comment-narration (JSDoc * , line // , bash #) is a mention, not a call.
    if (content ~ /^[[:space:]]*\*/) next
    if (content ~ /^[[:space:]]*\/\//) next
    if (content ~ /^[[:space:]]*#/) next
    # Allow-listed files may reference the helpers.
    if (file in m) next
    print
  }
' || true)

if [[ -z "$VIOLATIONS" ]]; then
  echo "check-liveness-gate-store-contract: clean (${#FILES[@]} src files scanned; all prefix-helper callers allow-listed)"
  exit 0
fi

MSG="calls a liveness prefix-helper (isSessionLiveByPrefix/isSidPrefixLiveOnChannel) but is not on the ALLOWLIST — this is a NEW liveness gate. Classify it per docs/conventions/liveness-gate-store-contract.md (alive-anywhere -> consult ALL stores at every decision point it acts on liveness; store-specific -> the one store that defines that participation), then add the file to ALLOWLIST in scripts/check-liveness-gate-store-contract.sh with the classification; or route the liveness decision through an allow-listed gate"

printf '%s\n' "$VIOLATIONS" | awk -v msg="$MSG" -v gha="${GITHUB_ACTIONS:-}" '
{
  match($0, /^[^:]+:[0-9]+:/)
  prefix = substr($0, 1, RLENGTH)
  split(prefix, p, ":")
  file = p[1]
  line = p[2]
  printf "%s:%s:1: error[LGC-001]: %s\n", file, line, msg
  if (gha == "true") {
    printf "::error file=%s,line=%s,col=1,title=LGC-001::%s\n", file, line, msg
  }
}
' >&2

TOTAL=$(printf '%s\n' "$VIOLATIONS" | wc -l | tr -d ' ')
FILE_COUNT=$(printf '%s\n' "$VIOLATIONS" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')
echo "check-liveness-gate-store-contract: ${TOTAL} violation(s) across ${FILE_COUNT} file(s) — new liveness gate(s) calling a prefix-helper but not classified against the store contract" >&2
exit 1
