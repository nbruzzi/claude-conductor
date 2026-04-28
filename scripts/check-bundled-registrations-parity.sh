#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 nbruzzi
#
# Parity check between plugin's `src/hooks/checks/bundled-registrations.ts`
# and the dotfiles canonical at the same relative path. Catches drift in
# the registration LOGIC (check name, fn ref, description, canBlock,
# profiles) without flagging known-intentional differences.
#
# Per cross-audit ARCH-2: until Slice 6b (Phase 1) drops the dotfiles
# canonical, both files must remain in lockstep on the registration block
# content. This script makes that contract observable in CI.
#
# KNOWN INTENTIONAL DIFFERENCES (pre-stripped before diff):
#   1. Plugin SPDX header (`// SPDX-License-Identifier: Apache-2.0` +
#      `// Copyright 2026 nbruzzi`).
#   2. Plugin's stricter generic — `RegistryBuilder<BundledCheckName>` and
#      the `import type { BundledCheckName } from "../bundled-check-names.ts"`
#      that supports it.
#
# PRETTIER NORMALIZATION:
#   Plugin uses prettier defaults (`printWidth: 80`); dotfiles uses an
#   explicit `printWidth: 100`. Both files are prettier-clean per their
#   own config but wrap long descriptions differently. To compare LOGICAL
#   content (not formatting), both files are piped through plugin's
#   prettier before diffing.
#
# DOTFILES PATH:
#   `${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}/src/hooks/checks/bundled-registrations.ts`
#   per Slice 3 env-var convention.
#
# Run:    bun run check-bundled-registrations-parity
#         bash scripts/check-bundled-registrations-parity.sh
# Exit:   0 = parity (or dotfiles canonical absent — graceful skip)
#         1 = drift detected
#         2+ = error (e.g. not in a git repo, prettier missing)
#
# Bash 3.2+ portable.

set -e
set -u
set -o pipefail

# --- 1. Resolve repo root ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-bundled-registrations-parity: error: not in a git repo" >&2
  exit 2
}
cd "$REPO_ROOT"

PLUGIN_FILE="src/hooks/checks/bundled-registrations.ts"
DOTFILES_ROOT="${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}"
DOTFILES_FILE="${DOTFILES_ROOT}/src/hooks/checks/bundled-registrations.ts"

# --- 2. Plugin file must exist ---
if [[ ! -f "$PLUGIN_FILE" ]]; then
  echo "check-bundled-registrations-parity: error: plugin file missing at ${PLUGIN_FILE}" >&2
  exit 2
fi

# --- 3. Dotfiles canonical: graceful skip if absent ---
# Phase 0 CI runs without dotfiles checkout; the parity gate is informational
# in that environment and authoritative locally / in cross-repo CI workflows
# (e.g. install-sh-smoke pattern with sibling-checkout + scoped GH_PAT, per
# memory feedback-ci-cross-repo-checkout.md). When CI gains cross-repo
# checkout for parity (Phase 1 follow-up filed in wiki/backlog.md), this
# graceful skip becomes unnecessary.
if [[ ! -f "$DOTFILES_FILE" ]]; then
  echo "check-bundled-registrations-parity: SKIP — dotfiles canonical not found at ${DOTFILES_FILE}"
  echo "  set CLAUDE_DOTFILES_ROOT=<path> or place dotfiles at \$HOME/.claude-dotfiles to enable parity check"
  exit 0
fi

# --- 4. Prettier must be available ---
if ! command -v bun >/dev/null 2>&1; then
  echo "check-bundled-registrations-parity: error: bun not on PATH (needed to run prettier)" >&2
  exit 2
fi

# --- 5. Pre-strip plugin's intentional differences ---
# Sed expressions:
#   - Drop SPDX-License-Identifier line
#   - Drop Copyright line (matches plugin's two-line SPDX preamble)
#   - Drop `import type { BundledCheckName } from "..."` line
#   - Replace `RegistryBuilder<BundledCheckName>` with `RegistryBuilder`
PLUGIN_PRESTRIP=$(sed -e '/^\/\/ SPDX-License-Identifier:/d' \
                      -e '/^\/\/ Copyright/d' \
                      -e '/^import type { BundledCheckName } from/d' \
                      -e 's/RegistryBuilder<BundledCheckName>/RegistryBuilder/' \
                      "$PLUGIN_FILE")

# --- 6. Prettier-normalize both files via plugin's prettier config ---
# `--stdin-filepath` tells prettier the file extension for parser selection;
# the actual filename doesn't need to exist on disk. No config flag means
# prettier walks up from CWD looking for .prettierrc — which inside
# "$REPO_ROOT" finds plugin's config (or defaults if none).
PLUGIN_FMT=$(echo "$PLUGIN_PRESTRIP" | bun run prettier --stdin-filepath=bundled-registrations.ts 2>/dev/null) || {
  echo "check-bundled-registrations-parity: error: prettier failed on plugin file" >&2
  exit 2
}

DOTFILES_FMT=$(cat "$DOTFILES_FILE" | bun run prettier --stdin-filepath=bundled-registrations.ts 2>/dev/null) || {
  echo "check-bundled-registrations-parity: error: prettier failed on dotfiles file" >&2
  exit 2
}

# --- 7. Diff (ignore blank-line-only differences) ---
DRIFT=$(diff -B <(echo "$PLUGIN_FMT") <(echo "$DOTFILES_FMT") || true)

if [[ -z "$DRIFT" ]]; then
  echo "check-bundled-registrations-parity: clean (plugin and dotfiles canonical agree on registration logic)"
  exit 0
fi

# --- 8. Drift detected — emit diff + exit 1 ---
echo "check-bundled-registrations-parity: DRIFT detected between plugin and dotfiles canonical" >&2
echo "" >&2
echo "Plugin: ${PLUGIN_FILE} (with SPDX + BundledCheckName generic stripped)" >&2
echo "Dotfiles canonical: ${DOTFILES_FILE}" >&2
echo "Both prettier-normalized via plugin's config." >&2
echo "" >&2
echo "Drift (— plugin / + dotfiles canonical):" >&2
printf '%s\n' "$DRIFT" >&2
echo "" >&2
echo "Resolution: edit one side to match the other, OR if intentional, extend pre-strip rules in scripts/check-bundled-registrations-parity.sh and document in decisions/phase-0.md." >&2

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::error file=${PLUGIN_FILE}::bundled-registrations.ts drifts from dotfiles canonical — check-bundled-registrations-parity.sh failed"
fi

exit 1
