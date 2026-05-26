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
#   P4 — 7-40 char hex string ([a-f0-9]) — potential SHA / commit / cache key
#        leak. FP-class filter excludes substring matches inside lowercase
#        words (e.g., "feedbac" inside "feedback") via surrounding-char check.
#
# Run:    bun run check-generic-paths
#         bash scripts/check-generic-paths.sh
#         bash scripts/check-generic-paths.sh --include-untracked
# Flags:
#   --include-untracked  Also scan files in the working tree that are not yet
#                        tracked by git (i.e. `git ls-files --others`). Honors
#                        the same EXCLUDE_PATHSPECS as the tracked scan and
#                        `--exclude-standard` (.gitignore + global excludes).
#                        Use during local dev to catch leaks BEFORE staging;
#                        CI runs without the flag (tracked-only is the gate).
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
# Output: compiler-style `<file>:<line>:<col>: error[CGP-001..004]: <msg>` to
# stderr; clean message to stdout. Under GITHUB_ACTIONS=true, also emits
# `::error file=...,line=...::` workflow commands for PR annotations.
# Error-code convention: <DETECTOR-PREFIX>-<NNN>; see
# docs/conventions/error-code-scheme.md. Renamed from P1..P4 in slice 6
# A4 (CLI-11 closure) — Phase 0 → v0.1.0 boundary churn window per the
# zero-external-consumer primary-source verification.
#
# Bash 3.2+ portable (do NOT use mapfile, which requires bash 4.4+).

set -e
set -u
set -o pipefail

# --- 0. --help / -h + --include-untracked flag parsing ---
INCLUDE_UNTRACKED=0
for arg in "$@"; do
  case "$arg" in
    --help | -h)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
      exit 0
      ;;
    --include-untracked)
      INCLUDE_UNTRACKED=1
      ;;
    *)
      echo "check-generic-paths: error: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

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
  # Cycle 2026-05-25 substrate-evolution slice — substrate-class PR
  # detection helper uses 'nbruzzi/<repo>' as GitHub-repo-identifier
  # convention (NOT path-substrate-leak); SUBSTRATE_CLASS_REPOS const
  # set is project-config data. Tests reference the same identifiers
  # in their fixture-cases per paired-contract-test discipline.
  ":(exclude)src/channels/substrate-class.ts"
  ":(exclude)test/channels/substrate-class.test.ts"
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
  # T4-X2 cycle 2026-05-22 — registry-assertion.ts JSDoc "Recovery paths"
  # section + fail-CLOSED error message + armed-state visibility reminder
  # reference the canonical kill-switch path
  # `~/.claude/hook-registry-assert-warn` as operator-facing documentation.
  # The literal IS the operator-facing recovery instruction; routing via
  # paths.ts in JSDoc / error strings would obscure the "what file do I
  # touch to recover" answer at exactly the moment the operator needs it
  # (mid-session wedge). Same rationale as channels/cli.ts + disable-hooks.ts.
  "src/hooks/registry-assertion.ts"
)

# --- 3. Patterns ---
P1_REGEX='[Nn][Bb][Rr][Uu][Zz][Zz][Ii]'
P2_REGEX='/Users/[a-zA-Z][a-zA-Z0-9._-]*/'
P3_REGEX='\.claude/'
P4_REGEX='[a-f0-9]{7,40}'

# --- 4. Collect tracked files (bash 3.2+ portable; NOT mapfile) ---
FILES=()
TRACKED_COUNT_PRE=0
while IFS= read -r -d '' f; do
  FILES+=("$f")
  TRACKED_COUNT_PRE=$((TRACKED_COUNT_PRE + 1))
done < <(git ls-files -z -- "${EXCLUDE_PATHSPECS[@]}")

# Optionally append untracked files (CLI-3b — Phase 0.10 follow-on).
# `--exclude-standard` honors .gitignore + global excludes; the same
# EXCLUDE_PATHSPECS apply (a top-level CONTRIBUTING.md staged as untracked
# should also be excluded). Pass `--others` to scope to untracked only —
# `--modified`/`--cached` would re-cover tracked files we already have.
# `[ -f "$f" ]` filters to regular files (and symlinks-to-regular-files,
# which grep can read); symlinks-to-directories like `node_modules ->
# canonical/node_modules` are excluded — grep returns exit 2 on a dir
# without `-r`, which would mis-classify the whole scan as a script error.
UNTRACKED_SCANNED_COUNT=0
if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
  while IFS= read -r -d '' f; do
    if [[ -f "$f" ]]; then
      FILES+=("$f")
      UNTRACKED_SCANNED_COUNT=$((UNTRACKED_SCANNED_COUNT + 1))
    fi
  done < <(git ls-files --others --exclude-standard -z -- "${EXCLUDE_PATHSPECS[@]}")
fi

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
RAW_HITS=$(grep -HnIE -e "$P1_REGEX" -e "$P2_REGEX" -e "$P3_REGEX" -e "$P4_REGEX" "${FILES[@]}" 2>&1) || GREP_EXIT=$?

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

    # P4 — 7-40 char hex with FP-class exclusion. Only check when no
    # higher-priority pattern matched on this line. Loop because a single
    # line may contain multiple hex candidates; we keep going until we find
    # one with non-letter, non-backtick boundaries (real leak), or exhaust
    # them all (all FP-class → suppress).
    has_p4 = 0
    if (!has_p1 && !has_p2 && !has_p3) {
      rem = content
      while ((mp = match(rem, /[a-f0-9]{7,40}/)) > 0) {
        me = mp + RLENGTH
        pc = (mp > 1) ? substr(rem, mp - 1, 1) : ""
        nc = (me <= length(rem)) ? substr(rem, me, 1) : ""
        if (pc !~ /[a-z`]/ && nc !~ /[a-z`]/) { has_p4 = 1; break }
        rem = substr(rem, me)
      }
      if (!has_p4) next

      # Layer 3 (P4 extension) — hex strings on comment-narration lines are
      # documentation/examples, not runtime substrate. Match existing comment
      # prefixes (`*`, `//`, `#`, `/*`).
      if (content ~ /^[[:space:]]*\*.*[a-f0-9]{7,40}/) next
      if (content ~ /^[[:space:]]*\/\*.*[a-f0-9]{7,40}/) next
      if (content ~ /^[[:space:]]*\/\/.*[a-f0-9]{7,40}/) next
      if (content ~ /^[[:space:]]*#.*[a-f0-9]{7,40}/) next

      # P4 file-type filter — markdown (docs), test/ (fixtures), CI
      # workflows (action SHAs), smoke/integration scripts (synthetic SIDs)
      # all legitimately contain hex strings. Suppress P4-alone in those.
      if (file ~ /\.md$/) next
      if (file ~ /^test\//) next
      if (file ~ /^\.github\/workflows\//) next
      if (file ~ /^scripts\/smoke-/) next
    }

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
TRACKED_COUNT="$TRACKED_COUNT_PRE"
# Count untracked-not-scanned only when the flag isn't set (informational
# hint for the operator). When the flag IS set, the untracked files were
# folded into FILES[] and the count is reported via UNTRACKED_SCANNED_COUNT.
if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
  UNTRACKED_NOT_SCANNED_COUNT=0
else
  UNTRACKED_NOT_SCANNED_COUNT=$(git ls-files --others --exclude-standard -- "${EXCLUDE_PATHSPECS[@]}" 2>/dev/null | wc -l | tr -d ' ')
fi

if [[ -z "$FILTERED_HITS" ]]; then
  msg="check-generic-paths: clean (0 violations across ${TRACKED_COUNT} tracked files"
  if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
    msg="${msg} + ${UNTRACKED_SCANNED_COUNT} untracked files (--include-untracked)"
  elif [[ "$UNTRACKED_NOT_SCANNED_COUNT" != "0" ]]; then
    # Tracked-only is intentional for CI (the gate). Use --include-untracked
    # locally during dev to catch leaks before staging — see flag docstring.
    msg="${msg}; ${UNTRACKED_NOT_SCANNED_COUNT} untracked file(s) not scanned"
  fi
  msg="${msg})"
  echo "$msg"
  exit 0
fi

# --- 8. Emit violations + summary ---
P1_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P1_REGEX" || true)
P2_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P2_REGEX" || true)
P3_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P3_REGEX" || true)
P4_COUNT=$(printf '%s\n' "$FILTERED_HITS" | grep -cE "$P4_REGEX" || true)
TOTAL=$(printf '%s\n' "$FILTERED_HITS" | wc -l | tr -d ' ')
FILE_COUNT=$(printf '%s\n' "$FILTERED_HITS" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')

# Compiler-style output to stderr. Pattern priority for classification:
# P1 (nbruzzi) > P2 (/Users/<name>/) > P3 (\.claude/) > P4 (hex string) — a
# single line that matches multiple patterns is reported under the most-specific class.
printf '%s\n' "$FILTERED_HITS" | awk -v p1="$P1_REGEX" -v p2="$P2_REGEX" -v p3="$P3_REGEX" -v p4="$P4_REGEX" -v gha="${GITHUB_ACTIONS:-}" '
{
  # Parse "file:line:content"
  match($0, /^[^:]+:[0-9]+:/)
  prefix = substr($0, 1, RLENGTH)
  content = substr($0, RLENGTH + 1)
  split(prefix, parts, ":")
  file = parts[1]
  line = parts[2]

  # Determine pattern + remediation (priority CGP-001 > CGP-002 > CGP-003 > CGP-004).
  # Error-code convention: <DETECTOR-PREFIX>-<NNN>; see docs/conventions/error-code-scheme.md.
  if ($0 ~ p1) {
    pid = "CGP-001"
    msg = "hardcoded user identifier '\''nbruzzi'\'' (substrate leak) — parameterize via effectiveHome() from src/shared/home.ts, or extend Layer 1 allowlist in scripts/check-generic-paths.sh if intentional fixture"
  } else if ($0 ~ p2) {
    pid = "CGP-002"
    msg = "hardcoded /Users/<name>/ absolute path (non-portable) — use path.join(homedir(), ...) or process.env.HOME-based construction"
  } else if ($0 ~ p3) {
    pid = "CGP-003"
    msg = "\\.claude/ literal under src/ outside the 12-file bypasser allowlist — route through paths.ts (channelsDir/todosDir/activeSessionsDir/etc.), or add this file to P3_FILE_ALLOWLIST in scripts/check-generic-paths.sh with rationale"
  } else if ($0 ~ p4) {
    pid = "CGP-004"
    msg = "potential anonymization leak — 7-40 char hex string ([a-f0-9]{7,40}) bordered by non-letter, non-backtick chars. Verify it is not a real SHA / commit / cache key; if it is an intentional reference, quote in backticks (`<sha>`) to mark as documentation, or rewrite using a parameterized constant"
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

echo "check-generic-paths: ${TOTAL} violation(s) across ${FILE_COUNT} file(s) (P1: ${P1_COUNT}, P2: ${P2_COUNT}, P3: ${P3_COUNT}, P4: ${P4_COUNT})" >&2
exit 1
