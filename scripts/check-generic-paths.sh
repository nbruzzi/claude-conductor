#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Static-analysis check for substrate leaks in plugin source.
# Detects:
#   P1 — hardcoded 'nbruzzi' identifier (case-insensitive)
#   P2 — hardcoded /Users/<name>/ absolute paths
#
# Run:    bun run check-generic-paths
#         bash scripts/check-generic-paths.sh
# Exit:   0 = clean
#         1 = violations
#         2+ = error (e.g. not in a git repo)
#
# Allowlist (in script body, no inline `// allow-...` escapes):
#   Layer 1 — file-path globs excluded via git ls-files pathspec
#   Layer 2 — SPDX header region (lines 1-5 matching /copyright|spdx-/i)
#   Layer 3 — JSDoc-narration lines (^* matching nbruzzi)
#
# Output: compiler-style `<file>:<line>:<col>: error[<P1|P2>]: <msg>` to stderr;
# clean message to stdout. Under GITHUB_ACTIONS=true, also emits
# `::error file=...,line=...::` workflow commands for PR annotations.
#
# Bash 3.2+ portable (do NOT use mapfile, which requires bash 4.4+).

set -e
set -u
set -o pipefail

# --- 1. Resolve repo root regardless of cwd ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-generic-paths: error: not in a git repo (run from inside a git checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# --- 2. Allowlist (Layer 1) — pathspec excludes ---
EXCLUDE_PATHSPECS=(
  ":(exclude)*.md"
  ":(exclude)LICENSE"
  ":(exclude).claude-plugin/plugin.json"
  ":(exclude)scripts/check-generic-paths.sh"
  ":(exclude)bun.lock"
  ":(exclude)decisions"
  ":(exclude)audits"
)

# --- 3. Patterns ---
P1_REGEX='[Nn][Bb][Rr][Uu][Zz][Zz][Ii]'
P2_REGEX='/Users/[a-zA-Z][a-zA-Z0-9._-]*/'

# --- 4. Collect tracked files (bash 3.2+ portable; NOT mapfile) ---
FILES=()
while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(git ls-files -z -- "${EXCLUDE_PATHSPECS[@]}")

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "check-generic-paths: clean (0 files to scan)"
  exit 0
fi

# --- 5. Run grep with tristate exit handling ---
GREP_EXIT=0
RAW_HITS=$(printf '%s\0' "${FILES[@]}" | xargs -0 grep -HnIE -e "$P1_REGEX" -e "$P2_REGEX" 2>&1) || GREP_EXIT=$?

if [[ $GREP_EXIT -ge 2 ]]; then
  echo "check-generic-paths: error: grep failed (exit $GREP_EXIT)" >&2
  echo "$RAW_HITS" >&2
  exit 2
fi

# GREP_EXIT=0 (matches found) or 1 (no matches); both expected.

# --- 6. Layer 2 + 3 filtering (post-grep awk) ---
# Layer 2: drop SPDX header region (lines 1-5 matching /copyright|spdx-/i)
# Layer 3: drop JSDoc-narration lines (^* matching nbruzzi)
FILTERED_HITS=$(printf '%s\n' "$RAW_HITS" | awk '
  /^$/ { next }
  # Layer 2 — SPDX header region: lines 1-5 matching /copyright|spdx-/i
  {
    # Parse "file:line:content"
    line_num_field = $0
    sub(/^[^:]+:/, "", line_num_field)
    sub(/:.*$/, "", line_num_field)
    if (line_num_field + 0 >= 1 && line_num_field + 0 <= 5) {
      content = $0
      sub(/^[^:]+:[0-9]+:/, "", content)
      if (content ~ /[Cc]opyright|[Ss][Pp][Dd][Xx]-/) {
        next
      }
    }
  }
  # Layer 3 — JSDoc-narration lines: ^* matching nbruzzi
  /^[^:]+:[0-9]+:[[:space:]]*\*.*nbruzzi/ { next }
  /^[^:]+:[0-9]+:[[:space:]]*\/\*.*nbruzzi/ { next }
  /./ { print }
' || true)

# --- 7. Clean exit if no surviving hits ---
TRACKED_COUNT="${#FILES[@]}"
UNTRACKED_COUNT=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')

if [[ -z "$FILTERED_HITS" ]]; then
  msg="check-generic-paths: clean (0 violations across ${TRACKED_COUNT} tracked files"
  if [[ "$UNTRACKED_COUNT" != "0" ]]; then
    msg="${msg}; ${UNTRACKED_COUNT} untracked file(s) skipped — run with --include-untracked to scan"
  fi
  msg="${msg})"
  echo "$msg"
  exit 0
fi

# --- 8. Emit violations + summary ---
P1_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P1_REGEX" || true)
P2_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P2_REGEX" || true)
TOTAL=$(printf '%s\n' "$FILTERED_HITS" | wc -l | tr -d ' ')
FILE_COUNT=$(printf '%s\n' "$FILTERED_HITS" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')

# Compiler-style output to stderr
printf '%s\n' "$FILTERED_HITS" | awk -v p1="$P1_REGEX" -v p2="$P2_REGEX" -v gha="${GITHUB_ACTIONS:-}" '
{
  # Parse "file:line:content"
  match($0, /^[^:]+:[0-9]+:/)
  prefix = substr($0, 1, RLENGTH)
  content = substr($0, RLENGTH + 1)
  split(prefix, parts, ":")
  file = parts[1]
  line = parts[2]

  # Determine pattern + remediation
  if ($0 ~ p1) {
    pid = "P1"
    msg = "hardcoded user identifier '\''nbruzzi'\'' (substrate leak) — parameterize via effectiveHome() from src/shared/home.ts, or extend Layer 1 allowlist in scripts/check-generic-paths.sh if intentional fixture"
  } else if ($0 ~ p2) {
    pid = "P2"
    msg = "hardcoded /Users/<name>/ absolute path (non-portable) — use path.join(homedir(), ...) or process.env.HOME-based construction"
  } else {
    pid = "??"
    msg = "unknown-pattern"
  }

  # Compiler-style line for IDE clickthrough
  printf "%s:%s:1: error[%s]: %s\n", file, line, pid, msg

  # GHA annotation if running in GitHub Actions
  if (gha == "true") {
    printf "::error file=%s,line=%s,col=1,title=%s::%s\n", file, line, pid, msg
  }
}
' >&2

echo "check-generic-paths: ${TOTAL} violation(s) across ${FILE_COUNT} file(s) (P1: ${P1_COUNT}, P2: ${P2_COUNT})" >&2
exit 1
