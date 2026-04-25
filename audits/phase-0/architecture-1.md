<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Phase 0 Audit — Architecture (Round 1)

**Subject:** `agents-to-bundle.md` (sub-step 0.3b deliverable)
**Date:** 2026-04-25
**Persona:** Architecture Auditor (single-persona mini-audit)
**Score:** 7.5/10
**Verdict:** Ship-with-conditions

## Scope dispatched

Anonymization rewrite plan for agents shipped under `<plugin-root>/agents/`. Audited for: scope coherence, cross-deliverable consistency with `memories-to-bundle.md`, familiar rewrite completeness, validation gate executability, registry rewrite scope, drop decision for `domain-business`, cold + generic agent assumption.

## Findings

| ID     | Severity | Summary                                                                                                                                                                                                                                                                                            |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARCH-1 | critical | Audit Protocol numbered-check list is a substrate-leak vector the rewrite plan misses. `architecture-integration.md` steps 7/9/10/11 reference `install.sh`, sync allowlist, PostToolUse, sentinel; `knowledge-system.md` steps 6-11 reference wiki conventions, hot.md, three-layer architecture. |
| ARCH-2 | critical | Step 6 YAML resolver is broken: awk range pattern terminates at first lowercase line (killing memory: block); slash-presence heuristic misclassifies plain filenames. Gate is theater.                                                                                                             |
| ARCH-3 | major    | Registry rewrite scope incomplete (flagged 2 line edits; actual scope is 7 changes including header counts, BIZ table+TSV row drops, architecture-integration TSV, knowledge-system TSV, missing-agent commission test).                                                                           |
| ARCH-4 | major    | Cross-deliverable inconsistency: `agents-to-bundle.md` asserts `ceiling-standard.md` is dropped from memories, but `memories-to-bundle.md` doesn't list it in drop-entirely OR deferred-generic.                                                                                                   |
| ARCH-5 | major    | `triggers:` block specs use prose-comments instead of literal resulting YAML lists. Sub-step 0.6 has to interpret; can drift between agent frontmatter and registry TSV.                                                                                                                           |
| ARCH-6 | minor    | `model: opus` portability deferral risks shipping unusable agents. Decide in this deliverable, not at extraction time.                                                                                                                                                                             |
| ARCH-7 | minor    | Drop decision for `domain-business` is correct but stub-template deferral to v0.5+ is wrong sequencing. Ship `familiar/_template.md` in Phase 0 to demonstrate registry extensibility.                                                                                                             |

## Resolution

All 7 findings integrated in commit `d12c176` on branch `phase-0-initial-scaffold`. Full resolution map in `agents-to-bundle.md` § "Round-1 audit findings → resolution map". `ceiling-standard.md` reconciliation lands in `memories-to-bundle.md` drop list in the same commit.

## Verification

Round 2 verification (Architecture Auditor) returned GREEN at commit `0862ff7`. See `architecture-2.md`.
