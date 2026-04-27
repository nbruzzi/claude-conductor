<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Changelog

All notable changes to claude-conductor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Phase 0 sub-step 0.6 batch 7b — extracted 21 agents from upstream substrate to `agents/` per audited `agents-to-bundle.md` (sub-step 0.3b deliverable, GREEN R2-verified). 13 cold auditors + 2 generic agents bundle as-is. 4 familiar auditors anonymized (architecture-integration HEAVY frontmatter+body+Audit Protocol; knowledge-system HEAVY full rewrite; code-standards LIGHT context_sources; workflow-process LIGHT context_sources + CONTRIBUTING.md ref). `familiar/domain-business.md` DROPPED (lens IS HeatPrice thesis; doesn't generalize). NEW `familiar/_template.md` ships unregistered as the structural extensibility example. `audit/registry.md` rewritten: header counts → "13 cold + 4 familiar with 1 template", BIZ row + TSV row dropped, ARCH+KS triggers rewritten to plugin-internal vocabulary. INDEX.md updated to catalog the bundled agents. CI substrate-leak grep + cross-reference graph: clean. `claude plugin validate` PASS.
- Phase 0 sub-step 0.6 batch 7a — extracted 18 cross-session feedback memories from upstream substrate to `memories/` with anonymization rewrites per audited `memories-to-bundle.md` (sub-step 0.3 deliverable, GREEN R2-verified). All bundled memories use V2 schema vocabulary (`cadence: stable`, `scope: global`, `updated: 2026-04-25`, `origin: extracted`). Cross-reference graph check passes (no dangling links between bundled memories); CI substrate-leak grep passes (with documented allowed-in-frontmatter false positives on `updated:` date). `claude plugin validate` PASS. Tests still 168/168.
- Phase 0 sub-step 0.6 batch 6 follow-up F-3 — added `description:` frontmatter to 4 session command files (handoff, handoff-resume, channel, presence). `claude plugin validate` now passes with 0 frontmatter warnings.
- Phase 0 sub-step 0.6 batch 6 — extracted 2 skills + 4 session commands from dotfiles. Plugin now ships `.claude-plugin/plugin.json` (first manifest), `skills/audit/SKILL.md`, `skills/commit-push-pr/SKILL.md`, and `commands/session/{handoff,handoff-resume,channel,presence}.md`. Auto-discovery from `skills/` and `commands/` subdirectories per official Claude Code plugin reference. Markdown-only move; no TS / no exports map change.
- Phase 0 in progress — repo cut, initial scaffold, extraction-manifest preparation underway. See `~/.claude/plans/claude-conductor-phase-0-execution.md` (private, not in repo) for the active sub-plan.

## [0.0.0] — 2026-04-25

### Added

- Initial repo creation. License (Apache-2.0), README skeleton with the 6 MUST-contains sections, CHANGELOG (this file), CONTRIBUTING, INDEX (master catalog), SECURITY, .gitignore, package.json with `engines` pinning Claude Code minimum version, tsconfig.json with strict mode and lint config, decisions/phase-0.md (first decision-log entry), audits/ directory scaffolded, docs/ tree (architecture/conventions/operations/api), memories/ directory scaffolded, dependencies-rationale.md, ADR-001 documenting the extraction strategy.
- Phase 0 starts here. Subsequent commits ship the extraction-manifest, generic-paths primitives, file extraction with refactor, test scaffolding, plugin-managed memory loader, dotfiles-side `claude-conductor-extraction` feature branch updates, and CI gates.

[Unreleased]: https://github.com/nbruzzi/claude-conductor/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/nbruzzi/claude-conductor/releases/tag/v0.0.0
