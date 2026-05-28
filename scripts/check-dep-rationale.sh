#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Static-invariant check for the Dependency policy (CONTRIBUTING.md).
# Asserts every dependency declared in package.json (`dependencies` +
# `devDependencies`) has a corresponding entry in dependencies-rationale.md.
#
# Why a STATIC invariant (not a package.json git-diff): a diff-based check
# needs a base ref (fragile across CI checkout depth / squash-merge / local
# runs). The invariant "every declared dep is rationalized" catches the same
# regression (adding a dep without rationale) at any point, with no base-ref
# dependency, and is trivially runnable locally + in CI identically.
#
# Membership is BACKTICK-precise: a dep `foo` must appear as `` `foo` `` in
# dependencies-rationale.md (the table + entry convention wraps package names
# in backticks). Matching the bare token would false-pass on prose mentions
# (e.g. "typescript-aware"); requiring backticks ties the match to an actual
# rationale entry. New entries MUST wrap the package name in backticks.
#
# Run:    bun run check-dep-rationale
#         bash scripts/check-dep-rationale.sh
# Exit:   0 = clean (all declared deps rationalized, or zero deps)
#         1 = one or more declared deps lack a rationale entry
#         2+ = error (not a git repo / no package.json / parse failure)
#
# Output: compiler-style `<file>:<line>:<col>: error[CDR-001]: <msg>` to
# stderr; clean message to stdout. Under GITHUB_ACTIONS=true, also emits
# `::error file=...,line=...::` workflow commands for PR annotations.
# Error-code convention: <DETECTOR-PREFIX>-<NNN>; see
# docs/conventions/error-code-scheme.md.
#
# Bash 3.2+ portable.

set -e
set -u
set -o pipefail

# --- 0. --help / -h + unknown-arg handling ---
for arg in "$@"; do
  case "$arg" in
    --help | -h)
      grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "check-dep-rationale: error: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

# --- 1. Resolve repo root regardless of cwd ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-dep-rationale: error: not in a git repo (run from inside a git checkout)" >&2
  exit 2
}
cd "$REPO_ROOT"

PKG="package.json"
RATIONALE="dependencies-rationale.md"

if [[ ! -f "$PKG" ]]; then
  echo "check-dep-rationale: error: no package.json at repo root ($REPO_ROOT)" >&2
  exit 2
fi

# --- 2. Extract dependency names (deps + devDeps) robustly via bun ---
# bun is the project runtime (package.json engines.bun); using it to parse
# JSON avoids fragile bash/grep JSON parsing (scoped packages, formatting).
DEP_NAMES="$(bun -e 'const p=require("./package.json");const n=[...Object.keys(p.dependencies||{}),...Object.keys(p.devDependencies||{})];process.stdout.write(n.join("\n"))' 2>/dev/null)" || {
  echo "check-dep-rationale: error: failed to parse $PKG via bun" >&2
  exit 2
}

# Zero declared dependencies → vacuously clean.
if [[ -z "$DEP_NAMES" ]]; then
  echo "check-dep-rationale: clean (0 dependencies declared)"
  exit 0
fi

# --- 3. Load rationale content (absent file => every dep is unrationalized) ---
RATIONALE_CONTENT=""
if [[ -f "$RATIONALE" ]]; then
  RATIONALE_CONTENT="$(cat "$RATIONALE")"
fi

# --- 4. Per-dep membership check (backtick-precise) ---
BT='`' # single backtick, as a fixed-string search token component
GHA="${GITHUB_ACTIONS:-}"
VIOLATIONS=0
TOTAL=0

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  TOTAL=$((TOTAL + 1))
  token="${BT}${name}${BT}"
  if ! printf '%s\n' "$RATIONALE_CONTENT" | grep -qF -- "$token"; then
    # Locate the declaration line in package.json for a clickable location.
    line="$(grep -nF -- "\"$name\"" "$PKG" | head -1 | cut -d: -f1 || true)"
    [[ -z "$line" ]] && line=1
    msg="dependency '$name' declared in $PKG has no entry in $RATIONALE — add a rationale row (why needed / alternatives considered / supply-chain footprint), package name wrapped in backticks, per CONTRIBUTING.md Dependency policy"
    printf '%s:%s:1: error[CDR-001]: %s\n' "$PKG" "$line" "$msg" >&2
    if [[ "$GHA" == "true" ]]; then
      printf '::error file=%s,line=%s,col=1,title=CDR-001::%s\n' "$PKG" "$line" "$msg" >&2
    fi
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done <<<"$DEP_NAMES"

# --- 5. Report ---
if [[ "$VIOLATIONS" -eq 0 ]]; then
  echo "check-dep-rationale: clean ($TOTAL dependencies all rationalized)"
  exit 0
fi

echo "check-dep-rationale: $VIOLATIONS unrationalized dependency(ies) of $TOTAL declared — add entries to $RATIONALE" >&2
exit 1
