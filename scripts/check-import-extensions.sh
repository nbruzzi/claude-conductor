#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Static-analysis check for relative-import file extensions under src/.
# Asserts every relative `import` / `export ... from` ends in `.ts` (or `.json`).
#
# Bun and TypeScript with `moduleResolution: Bundler` accept extensionless
# relative imports, but the plugin convention requires explicit `.ts` for:
#   - cross-runtime portability (node native ESM, deno, future bundlers)
#   - tooling clarity (graph builders, codemods, IDE jump-to-def)
#   - alignment with the surrounding codebase (Slice 7 / TS-A3 cross-audit)
#
# Run:    bun run check-import-extensions
#         bash scripts/check-import-extensions.sh
# Exit:   0 = clean
#         1 = violations
#         2+ = error (e.g. not in a git repo)
#
# Output: compiler-style `<file>:<line>:<col>: error[T1]: <msg>` to stderr;
# clean message to stdout. Under GITHUB_ACTIONS=true, also emits
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
  echo "check-import-extensions: error: not in a git repo (run from inside a git checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

# --- 2. Collect tracked .ts files under src/ (bash 3.2+ portable; NOT mapfile) ---
FILES=()
while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(git ls-files -z -- 'src/**/*.ts' 'src/*.ts')

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "check-import-extensions: clean (0 files to scan)"
  exit 0
fi

# --- 3. Find relative imports/exports ---
# STATIC_REGEX matches statement-form: `import ... "./..."`, `import ... "../..."`,
# `export ... from "./..."`, `export ... from "../..."`, and side-effect
# `import "./..."`. Anchored to line-start to avoid catching JSDoc comment
# strings on the same line.
STATIC_REGEX='^[[:space:]]*(import|export)([[:space:]]+type)?[[:space:]].*"(\./|\.\./)[^"]+"'

# DYNAMIC_REGEX matches call-site form: `await import("./foo")`,
# `void import("../bar.ts")`, etc. Not line-anchored — dynamic imports appear
# mid-expression, often indented inside function bodies. The `\b` boundary
# prevents matching things like `xxximport(...)`. Path is the quoted segment;
# the awk filter below extracts it identically for both forms.
DYNAMIC_REGEX='\bimport[[:space:]]*\([[:space:]]*"(\./|\.\./)[^"]+"'

GREP_EXIT=0
RAW_HITS=$(grep -HnE -e "$STATIC_REGEX" -e "$DYNAMIC_REGEX" "${FILES[@]}" 2>&1) || GREP_EXIT=$?

if [[ $GREP_EXIT -ge 2 ]]; then
  echo "check-import-extensions: error: grep failed (exit $GREP_EXIT)" >&2
  echo "$RAW_HITS" >&2
  exit 2
fi

# GREP_EXIT=0 (matches found) or 1 (no matches); both expected.

# --- 4. Filter to violations: relative paths NOT ending in .ts or .json ---
# `.json` allowed because tsconfig.json sets `"resolveJsonModule": true` and
# JSON imports are a legitimate Bun + Node pattern. Any other extension
# (or extensionless) is a violation.
VIOLATIONS=$(printf '%s\n' "$RAW_HITS" | awk '
  /^$/ { next }
  {
    # Extract the from-string between the last pair of quotes containing
    # a relative path. The match is anchored to the relative-prefix to
    # avoid catching JSDoc comment strings on the same line.
    if (match($0, /"(\.\.\/|\.\/)[^"]+"/)) {
      path = substr($0, RSTART + 1, RLENGTH - 2)
      if (path !~ /\.ts$/ && path !~ /\.json$/) {
        print
      }
    }
  }
' || true)

TRACKED_COUNT="${#FILES[@]}"

if [[ -z "$VIOLATIONS" ]]; then
  echo "check-import-extensions: clean (0 violations across ${TRACKED_COUNT} tracked files)"
  exit 0
fi

# --- 5. Emit violations + summary ---
TOTAL=$(printf '%s\n' "$VIOLATIONS" | wc -l | tr -d ' ')
FILE_COUNT=$(printf '%s\n' "$VIOLATIONS" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')

printf '%s\n' "$VIOLATIONS" | awk -v gha="${GITHUB_ACTIONS:-}" '
{
  match($0, /^[^:]+:[0-9]+:/)
  prefix = substr($0, 1, RLENGTH)
  split(prefix, parts, ":")
  file = parts[1]
  line = parts[2]

  msg = "relative import missing .ts extension — Bun + TS '\''moduleResolution: Bundler'\'' permit extensionless, but plugin convention requires explicit .ts (or .json) for cross-runtime portability. Add the extension to the import path."

  printf "%s:%s:1: error[T1]: %s\n", file, line, msg

  if (gha == "true") {
    printf "::error file=%s,line=%s,col=1,title=T1::%s\n", file, line, msg
  }
}
' >&2

echo "check-import-extensions: ${TOTAL} violation(s) across ${FILE_COUNT} file(s)" >&2
exit 1
