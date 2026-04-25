<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# ADR-001 — Extraction Strategy

**Status:** Accepted
**Date:** 2026-04-25
**Phase:** 0
**Deciders:** Plan-audit consensus across 4 personas (Architecture + Reliability + CLI DX + Knowledge System) on the parent plan.

## Context

`claude-conductor` extracts skills, hooks, agents, memories, and shared primitives from `nbruzzi/claude-dotfiles` (Nick's personal dotfiles repo, ~1102 tests, 60+ files in `src/`) into this new private repo. The extraction touches multiple substrate components with cross-imports (`channels` ↔ `hooks` ↔ `shared` ↔ `active-sessions` ↔ `todos` ↔ `session-id`, etc.).

Two failure modes risk-class:

1. **Extraction-mid-flight crash** leaves both repos in indeterminate states, breaking the dotfiles substrate Nick uses daily.
2. **Cross-component import edges** with undefined direction create circular references between plugin and dotfiles, OR over-extract (drag helpers the plan didn't budget for) OR under-extract (leave needed helpers behind, breaking plugin compilation).

## Decision

**Coordinated-branch strategy with dotfiles-side vendoring and atomic flip on Phase 5 pass:**

1. **Plugin's `claude-conductor` repo** is cut from scratch with an initial commit containing only the scaffold (LICENSE, README, etc. — no extracted code yet).
2. **Dotfiles' `claude-conductor-extraction` feature branch** is cut from main; on this branch, the dotfiles substrate continues to vendor original code paths during extraction. Main remains untouched.
3. **Extraction-manifest** (`extraction-manifest.md`) is produced in the plugin repo BEFORE any file extraction begins. The manifest enumerates every file's per-edge bundle/keep/extract-with-shim/not-applicable decision.
4. **Mini-Architecture audit** runs against the extraction-manifest before extraction begins.
5. **File extraction** proceeds: per file marked `bundle-into-plugin`, copy + generic-paths refactor + SPDX header + import rewrite to plugin-internal paths. Per file marked `extract-with-shim`, copy as above AND on dotfiles' `claude-conductor-extraction` branch, replace original with re-export shim.
6. **Continuous test verification:** at every Phase 0 sub-commit, both (a) plugin's growing test suite passes and (b) dotfiles' 1102-test suite still passes against the post-extraction state on the feature branch.
7. **Atomic flip:** dotfiles' `claude-conductor-extraction` branch ONLY merges to dotfiles main when plugin's Phase 5 terminal full-diff audit passes AND the plugin is at v0.4.0 release-candidate. Until then, dotfiles main remains authoritative for Nick's daily use.

## Consequences

### Positive

- Dotfiles substrate is never broken — Nick's daily workflow is unaffected during extraction.
- Cross-component import decisions are explicit (in extraction-manifest), not improvised mid-extraction.
- Rollback is well-defined: revert dotfiles' feature branch + delete plugin's main commits if Phase 5 fails irrecoverably.
- Public-flip on the plugin (when/if Phase 4 + Phase 6 execute) is decoupled from dotfiles-side concerns.

### Negative

- Coordinated-branch state across two repos is more complex than single-repo extraction. Requires discipline at every Phase 0 sub-commit.
- If extraction-manifest decisions turn out wrong mid-extraction, the manifest must be revised + re-audited before continuing. Adds friction.
- Dotfiles substrate's tests grow slightly slower during the feature-branch period (no shared improvements until atomic flip).

### Neutral

- The plugin's first 5 phases (0–3 + 5) run entirely in private repo without touching dotfiles main. This is intentional per the parent plan's "private/closed for now" framing.

## Alternatives Considered

1. **Subdirectory inside `claude-dotfiles`** — rejected by the parent plan as creating extraction debt; the eventual public release would require re-extraction with all the git history baggage.
2. **In-place rewrite of `claude-dotfiles` to ship as a plugin** — rejected because dotfiles contains Nick-specific configuration and personal substrate that aren't generalizable.
3. **Extract everything into plugin upfront, no dotfiles vendoring** — rejected because it would break Nick's daily workflow during extraction. The vendoring approach buys time for verification.

## Cross-references

- Parent plan: `~/.claude/plans/disciplined-multi-agent-coordination-plugin.md` (private)
- Phase 0 sub-plan: `~/.claude/plans/claude-conductor-phase-0-execution.md` (private)
- Locked decisions section in parent plan covers RE-1 (extraction atomicity), ARCH-2 (import graph), ARCH-5 (install.sh + dotfiles-sync allowlist alignment).
- Subsequent ADRs in this directory will document downstream decisions (extraction-manifest decisions per file class, generic-paths convention, etc.).
