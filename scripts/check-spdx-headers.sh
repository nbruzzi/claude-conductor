#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Static check: every tracked source file carries a well-formed Apache-2.0
# SPDX license header near the top. Closes the R-3 enforcement gap for the
# "Apache-2.0 SPDX header on every new source file" convention
# (CONTRIBUTING.md) — which was previously convention-by-vigilance only.
# ESLint has NO SPDX rule and lints .ts only (eslint.config.js files-glob),
# so .sh/.js/.mjs/.cjs were entirely ungated; this gate is the cross-file-type
# closure and is the project's ONLY SPDX gate.
#
# Detects:
#   SPDX-001 — source file missing a well-formed Apache-2.0 SPDX header within
#              its first 5 lines. The check requires a line of the form
#              '<comment-leader> SPDX-License-Identifier: Apache-2.0' (a shebang
#              on line 1 is allowed). A bare mention of the marker inside a
#              string or prose does NOT satisfy the gate, and a non-Apache
#              license value (e.g. a copy-pasted GPL header) is flagged.
#              Compound expressions beginning Apache-2.0 ("Apache-2.0 OR MIT",
#              "Apache-2.0 WITH ...") still pass.
#
# Source file types scanned (tracked only): .ts .cts .mts .tsx .sh .js .cjs .mjs .jsx
# Non-source types (.md docs, .json/.yml/.cff config+data, .lock, .gitkeep)
# are NOT scanned — SPDX headers are a source-file convention, not a
# docs/config one.
#
# Run:    bun run check-spdx-headers
#         bash scripts/check-spdx-headers.sh
#         bash scripts/check-spdx-headers.sh --include-untracked
# Flags:
#   --include-untracked  Also scan working-tree files not yet tracked by git
#                        (git ls-files --others --exclude-standard). Use
#                        during local dev to catch a missing header BEFORE
#                        staging; CI runs tracked-only (that is the gate).
# Exit:   0 = clean
#         1 = violations (one or more source files missing a header)
#         2+ = error (e.g. not in a git repo, unknown argument)
#
# Output: compiler-style '<file>:1:1: error[SPDX-001]: <msg>' to stderr;
# clean summary to stdout. Under GITHUB_ACTIONS=true, also emits
# '::error file=...,line=1::' workflow commands for PR annotations.
# Error-code convention: <DETECTOR-PREFIX>-<NNN>; see
# docs/conventions/error-code-scheme.md.
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
      echo "check-spdx-headers: error: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

# --- 1. Resolve repo root regardless of cwd ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-spdx-headers: error: not in a git repo (run from inside a git checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# --- 2. Source-file pathspecs ---
# SPDX headers are a source-file convention. Scan code file types only;
# docs (.md), config/data (.json/.yml/.cff/.lock), and placeholders
# (.gitkeep) are out of scope by design. git pathspec globs match at any
# depth, so '*.ts' covers src/**, test/**, scripts/**, etc. The TS/JS family
# is enumerated in full (incl. .cts/.mts/.tsx/.jsx) so a future component or
# CJS/ESM module is gated the moment it lands, even though none exist today.
SOURCE_PATHSPECS=(
  "*.ts"
  "*.cts"
  "*.mts"
  "*.tsx"
  "*.sh"
  "*.js"
  "*.cjs"
  "*.mjs"
  "*.jsx"
)

# --- 3. Collect tracked source files (bash 3.2+ portable; NOT mapfile) ---
# [ -f ] filters to regular files (symlink-to-regular is readable by head;
# a symlink-to-directory would not be a source file and is skipped).
FILES=()
TRACKED_COUNT=0
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  FILES+=("$f")
  TRACKED_COUNT=$((TRACKED_COUNT + 1))
done < <(git ls-files -z -- "${SOURCE_PATHSPECS[@]}")

# Optionally append untracked source files (local-dev pre-stage catch).
# --exclude-standard honors .gitignore + global excludes (so node_modules,
# dist, build are skipped); --others scopes to untracked only.
UNTRACKED_SCANNED_COUNT=0
if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    FILES+=("$f")
    UNTRACKED_SCANNED_COUNT=$((UNTRACKED_SCANNED_COUNT + 1))
  done < <(git ls-files --others --exclude-standard -z -- "${SOURCE_PATHSPECS[@]}")
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "check-spdx-headers: clean (0 source files to scan)"
  exit 0
fi

# --- 4. Check each file for a well-formed Apache-2.0 SPDX header (first 5 lines) ---
# The regex anchors to a line-start + optional comment leader (//, #, *, /*)
# then 'SPDX-License-Identifier:' + the Apache-2.0 value. This is stricter
# than a bare marker grep on purpose:
#   - a mention inside a string/prose (no ': Apache-2.0') does NOT pass;
#   - a non-Apache value (GPL-3.0, MIT, ...) is flagged — this is the only
#     SPDX gate, so wrong-license headers must not slip through.
# First-5-lines window keeps the header near the top while allowing a shebang
# on line 1. The grep runs inside an `if !` condition, so its no-match exit (1)
# does NOT trip `set -e`.
SPDX_REGEX='^[[:space:]]*(//|#|\*|/\*)?[[:space:]]*SPDX-License-Identifier:[[:space:]]*Apache-2\.0'
MISSING=()
for f in "${FILES[@]}"; do
  if ! head -n 5 "$f" | grep -qE "$SPDX_REGEX"; then
    MISSING+=("$f")
  fi
done

# --- 5. Clean exit if no missing headers ---
UNTRACKED_NOT_SCANNED_COUNT=0
if [[ "$INCLUDE_UNTRACKED" != "1" ]]; then
  UNTRACKED_NOT_SCANNED_COUNT=$(git ls-files --others --exclude-standard -- "${SOURCE_PATHSPECS[@]}" 2>/dev/null | wc -l | tr -d ' ')
fi

if [[ ${#MISSING[@]} -eq 0 ]]; then
  msg="check-spdx-headers: clean (0 violations across ${TRACKED_COUNT} tracked source files"
  if [[ "$INCLUDE_UNTRACKED" == "1" ]]; then
    msg="${msg} + ${UNTRACKED_SCANNED_COUNT} untracked files (--include-untracked)"
  elif [[ "$UNTRACKED_NOT_SCANNED_COUNT" != "0" ]]; then
    msg="${msg}; ${UNTRACKED_NOT_SCANNED_COUNT} untracked source file(s) not scanned"
  fi
  msg="${msg})"
  echo "$msg"
  exit 0
fi

# --- 6. Emit violations (compiler-style + optional GHA annotations) ---
VMSG="missing or non-Apache-2.0 SPDX header — add '// SPDX-License-Identifier: Apache-2.0' (or '# ...' for shell scripts) within the first 5 lines; a shebang stays on line 1"
for f in "${MISSING[@]}"; do
  printf '%s:1:1: error[SPDX-001]: %s\n' "$f" "$VMSG" >&2
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error file=%s,line=1,col=1,title=SPDX-001::%s\n' "$f" "$VMSG" >&2
  fi
done

echo "check-spdx-headers: ${#MISSING[@]} source file(s) missing SPDX header (SPDX-001)" >&2
exit 1
