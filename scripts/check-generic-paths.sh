#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Static-analysis check for substrate leaks in plugin source.
# Detects:
#   P1 — hardcoded 'nbruzzi' identifier (case-insensitive)
#   P2 — hardcoded /Users/<name>/ absolute paths
#   P3 — \.claude/ literal under src/ outside explicit bypasser allowlist
#        (per Decision N — paths.ts isolation discipline, sub-step 0.10)
#
# Run:    bun run check-generic-paths
#         bash scripts/check-generic-paths.sh
# Exit:   0 = clean
#         1 = violations
#         2+ = error (e.g. not in a git repo)
#
# Allowlist (in script body, no inline `// allow-...` escapes):
#   Layer 1 — file-path globs excluded via git ls-files pathspec.
#             *.md narrowing per CLI-2: only top-level docs (CHANGELOG.md,
#             CONTRIBUTING.md, README.md, INDEX.md) + decisions/ + audits/
#             are excluded; commands/, skills/, agents/, memories/ markdown
#             IS scanned for substrate leaks (this is where CLI-1 lived).
#   Layer 2 — SPDX header region (lines 1-5 matching /copyright|spdx-/i)
#   Layer 3 — JSDoc-narration lines (^* matching nbruzzi or .claude/)
#
# P3 file allowlist: 12 plugin files have legitimate \.claude/ references
# that bypass paths.ts (kill switches, log dirs, error-message metadata).
# New files using \.claude/ must either route through paths.ts or join the
# allowlist explicitly (forces the conversation per ARCH-3).
#
# Output: compiler-style `<file>:<line>:<col>: error[<P1|P2|P3>]: <msg>` to
# stderr; clean message to stdout. Under GITHUB_ACTIONS=true, also emits
# `::error file=...,line=...::` workflow commands for PR annotations.
#
# Bash 3.2+ portable (do NOT use mapfile, which requires bash 4.4+).

set -e
set -u
set -o pipefail

# --- 0. --help / -h handler ---
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
  exit 0
fi

# --- 1. Resolve repo root regardless of cwd ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-generic-paths: error: not in a git repo (run from inside a git checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# --- 2. Allowlist (Layer 1) — pathspec excludes ---
# Markdown narrowed per CLI-2 (sub-step 0.10): only top-level docs +
# decisions/audits dirs are excluded. commands/, skills/, agents/, memories/
# markdown IS scanned (these are where CLI-1 substrate leaks lived).
EXCLUDE_PATHSPECS=(
  # User-facing docs (top-level)
  ":(exclude)CHANGELOG.md"
  ":(exclude)CONTRIBUTING.md"
  ":(exclude)README.md"
  ":(exclude)INDEX.md"
  ":(exclude)SECURITY.md"
  ":(exclude)LICENSE"
  # Extraction working docs — internal scaffolding for the dotfiles → plugin
  # migration. Reference dotfiles paths by design; not user-facing surface.
  ":(exclude)agents-to-bundle.md"
  ":(exclude)memories-to-bundle.md"
  ":(exclude)extraction-manifest.md"
  # Architecture decision records — describe extraction history with paths.
  ":(exclude)docs"
  # CLI-4 Phase 1 backlog item — skills/audit/SKILL.md has user-specific
  # vault references; deferred to Phase 1 anonymization pass per plan.
  ":(exclude)skills/audit/SKILL.md"
  # Plugin manifest + script metadata
  ":(exclude).claude-plugin/plugin.json"
  ":(exclude)scripts/check-generic-paths.sh"
  ":(exclude)test/scripts/check-generic-paths.test.ts"
  ":(exclude)bun.lock"
  # Audit-internal logs (decision records + audit transcripts)
  ":(exclude)decisions"
  ":(exclude)audits"
)

# P3 file allowlist — 12 plugin files with legitimate \.claude/ references.
# New files using \.claude/ must route through paths.ts or be added here
# with rationale.
P3_FILE_ALLOWLIST=(
  "src/shared/paths.ts"
  "src/shared/presence-failure-log.ts"
  "src/active-sessions/index.ts"
  "src/hooks/timing.ts"
  # Cluster 1 of INVERSIONS arc (2026-05-07) — branch-enforcement.ts, sensitive-files.ts,
  # test-gate.ts moved to substrate (`~/.claude-dotfiles/src/hooks/checks/`) and
  # are no longer in plugin source; allowlist entries removed.
  # Cluster 5 of INVERSIONS arc (2026-05-07; FINAL CLUSTER — ARC COMPLETE 21/21) —
  # config-protection.ts + config-protection-store.ts moved to substrate; allowlist
  # entries removed. (config-protection-cli.ts was never in this allowlist.)
  "src/hooks/checks/session-collision-gate.ts"
  "src/hooks/checks/bundled-registrations.ts"
  # Phase 3 Step F (RE-W2-5) — lock-domain registry's per-row `comment` field
  # documents the canonical filesystem paths each plugin-bundled check touches
  # (e.g., `<effectiveHome>/.claude/logs/.session-collision-gate.lock`,
  # `<effectiveHome>/.claude/logs/.worktree-gc-cursor`). The literals ARE the
  # documentation; routing via paths.ts in JSDoc would obscure the "where does
  # this resource live" answer for future race-surface analysis consumers.
  "src/hooks/lock-domain.ts"
  # CI verification cycle (TIER 2/3/3a/4) — moved to substrate per Cluster 2 of
  # INVERSIONS arc (2026-05-07); allowlist entries removed.
  "src/channels/index.ts"
  # Phase 2 Slice 8 — `read` verb help text references the per-channel
  # cursor path `~/.claude/channels/<id>/last-seen-cursors/<sid>.json` (Step
  # G renamed; legacy `last-seen/` also cited as dual-read-window callout)
  # in operator-facing help output. The literal IS the operator-facing
  # documentation; routing via paths.ts would require template
  # interpolation in help strings and obscure the answer to the
  # "where does my cursor live" operator question.
  "src/channels/cli.ts"
  # Phase 3 Slice 1 — kill-switch warning string references the per-hook
  # disable file path `~/.claude/${name}-off` as an operator escape hatch.
  # Operator-facing documentation, same rationale as channels/cli.ts.
  "src/shared/disable-hooks.ts"
  # Phase 2 Slice 10 — smoke matrix scenario greps the canonical
  # `presence-gate-failures.log` citation OUT of hooks-layer.md as the
  # assertion target. The literal is the expected-string-to-match,
  # not a path the script computes.
  "scripts/smoke-phase-2.sh"
)

# --- 3. Patterns ---
P1_REGEX='[Nn][Bb][Rr][Uu][Zz][Zz][Ii]'
P2_REGEX='/Users/[a-zA-Z][a-zA-Z0-9._-]*/'
P3_REGEX='\.claude/'

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
# Pass files directly to grep (NOT via xargs) — GNU xargs exits 123 when
# any grep invocation returns 1 (no-match), which our `>= 2` test would
# misclassify as error. Direct grep returns 0 (matches), 1 (clean), 2+ (error).
# Single grep pass over P1+P2+P3; per-pattern allowlist applied in awk.
GREP_EXIT=0
RAW_HITS=$(grep -HnIE -e "$P1_REGEX" -e "$P2_REGEX" -e "$P3_REGEX" "${FILES[@]}" 2>&1) || GREP_EXIT=$?

if [[ $GREP_EXIT -ge 2 ]]; then
  echo "check-generic-paths: error: grep failed (exit $GREP_EXIT)" >&2
  echo "$RAW_HITS" >&2
  exit 2
fi

# GREP_EXIT=0 (matches found) or 1 (no matches); both expected.

# --- 6. Layer 2 + 3 filtering + P3 file-allowlist (post-grep awk) ---
# Layer 2: drop SPDX header region (lines 1-5 matching /copyright|spdx-/i)
# Layer 3: drop JSDoc-narration lines (^*  or  ^/* prefix — generic, applies
#          to any pattern; documentation strings describing paths are not
#          runtime substrate leaks)
# P3 allowlist: if a line matches ONLY P3 (not P1/P2) and the file is in
# the 12-file P3 allowlist, suppress the violation.
P3_ALLOWLIST_STR=$(IFS=,; echo "${P3_FILE_ALLOWLIST[*]}")
FILTERED_HITS=$(printf '%s\n' "$RAW_HITS" | awk -v p3_allow="$P3_ALLOWLIST_STR" '
  BEGIN {
    n = split(p3_allow, arr, ",")
    for (i = 1; i <= n; i++) p3_map[arr[i]] = 1
  }
  /^$/ { next }
  {
    # Parse "file:line:content"
    match($0, /^[^:]+:[0-9]+:/)
    if (RLENGTH <= 0) { print; next }
    content = substr($0, RLENGTH + 1)
    prefix = substr($0, 1, RLENGTH)
    split(prefix, parts, ":")
    file = parts[1]
    line_num = parts[2]

    # Layer 2 — SPDX header region: lines 1-5 matching /copyright|spdx-/i
    if (line_num + 0 >= 1 && line_num + 0 <= 5) {
      if (content ~ /[Cc]opyright|[Ss][Pp][Dd][Xx]-/) {
        next
      }
    }

    # Layer 3 — comment-narration lines (JSDoc `*`, line `//`, bash `#`)
    # for KNOWN patterns only. Documentation describing a path is not a
    # runtime leak. Pattern-specific to avoid suppressing markdown bullets.
    # Bash `#` shape added when sub-step 0.10 Slice 7 parity-script narrated
    # the pre-stripped SPDX-Copyright literal in its docstring (convergence
    # via Bravo Slice 7 surfacing the gap in Alpha Slice 1).
    if (content ~ /^[[:space:]]*\*.*nbruzzi/) next
    if (content ~ /^[[:space:]]*\/\*.*nbruzzi/) next
    if (content ~ /^[[:space:]]*\/\/.*nbruzzi/) next
    if (content ~ /^[[:space:]]*#.*nbruzzi/) next
    if (content ~ /^[[:space:]]*\*.*\.claude\//) next
    if (content ~ /^[[:space:]]*\/\*.*\.claude\//) next
    if (content ~ /^[[:space:]]*\/\/.*\.claude\//) next
    if (content ~ /^[[:space:]]*#.*\.claude\//) next

    has_p1 = (content ~ /[Nn][Bb][Rr][Uu][Zz][Zz][Ii]/)
    has_p2 = (content ~ /\/Users\/[a-zA-Z][a-zA-Z0-9._-]*\//)
    has_p3 = (content ~ /\.claude\//)

    # P3 file-type filter — markdown files are documentation, not runtime
    # path-construction. P1/P2 still fire on markdown (substrate identifier
    # + absolute /Users/ leaks ARE bugs); P3 alone on .md is suppressed.
    if (has_p3 && !has_p1 && !has_p2 && file ~ /\.md$/) next

    # P3 file-allowlist — 16 plugin source files have legitimate \.claude/
    # references (paths.ts itself is the resolver; sensitive-files.ts lists
    # \.claude/settings.json as a sensitive pattern; the 11 known bypassers
    # use kill-switch / state-dir / log-dir literals; channels/index.ts +
    # bundled-registrations.ts have descriptive metadata strings + tests).
    if (has_p3 && !has_p1 && !has_p2 && (file in p3_map)) next
    # Also allowlist all test/ files — fixtures legitimately reference paths.
    if (has_p3 && !has_p1 && !has_p2 && file ~ /^test\//) next

    print
  }
' || true)

# --- 7. Clean exit if no surviving hits ---
TRACKED_COUNT="${#FILES[@]}"
UNTRACKED_COUNT=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')

if [[ -z "$FILTERED_HITS" ]]; then
  msg="check-generic-paths: clean (0 violations across ${TRACKED_COUNT} tracked files"
  if [[ "$UNTRACKED_COUNT" != "0" ]]; then
    # Untracked files are not currently scanned (Phase 1 backlog item).
    # Tracked-only is intentional for v0.1.0; once code is staged it lands
    # in the gate. Future `--include-untracked` flag deferred per Slice 7.1
    # CLI-3 follow-up.
    msg="${msg}; ${UNTRACKED_COUNT} untracked file(s) not scanned"
  fi
  msg="${msg})"
  echo "$msg"
  exit 0
fi

# --- 8. Emit violations + summary ---
P1_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P1_REGEX" || true)
P2_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P2_REGEX" || true)
P3_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P3_REGEX" || true)
TOTAL=$(printf '%s\n' "$FILTERED_HITS" | wc -l | tr -d ' ')
FILE_COUNT=$(printf '%s\n' "$FILTERED_HITS" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')

# Compiler-style output to stderr. Pattern priority for classification:
# P1 (nbruzzi) > P2 (/Users/<name>/) > P3 (\.claude/) — a single line that
# matches multiple patterns is reported under the most-specific class.
printf '%s\n' "$FILTERED_HITS" | awk -v p1="$P1_REGEX" -v p2="$P2_REGEX" -v p3="$P3_REGEX" -v gha="${GITHUB_ACTIONS:-}" '
{
  # Parse "file:line:content"
  match($0, /^[^:]+:[0-9]+:/)
  prefix = substr($0, 1, RLENGTH)
  content = substr($0, RLENGTH + 1)
  split(prefix, parts, ":")
  file = parts[1]
  line = parts[2]

  # Determine pattern + remediation (priority P1 > P2 > P3)
  if ($0 ~ p1) {
    pid = "P1"
    msg = "hardcoded user identifier '\''nbruzzi'\'' (substrate leak) — parameterize via effectiveHome() from src/shared/home.ts, or extend Layer 1 allowlist in scripts/check-generic-paths.sh if intentional fixture"
  } else if ($0 ~ p2) {
    pid = "P2"
    msg = "hardcoded /Users/<name>/ absolute path (non-portable) — use path.join(homedir(), ...) or process.env.HOME-based construction"
  } else if ($0 ~ p3) {
    pid = "P3"
    msg = "\\.claude/ literal under src/ outside the 12-file bypasser allowlist — route through paths.ts (channelsDir/todosDir/activeSessionsDir/etc.), or add this file to P3_FILE_ALLOWLIST in scripts/check-generic-paths.sh with rationale"
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

echo "check-generic-paths: ${TOTAL} violation(s) across ${FILE_COUNT} file(s) (P1: ${P1_COUNT}, P2: ${P2_COUNT}, P3: ${P3_COUNT})" >&2
exit 1
