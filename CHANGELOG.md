<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Changelog

All notable changes to claude-conductor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-phase-1] — 2026-04-29

### Phase 1 — Agent Teams identity + cross-edge plugin boundary

Phase 1 ships the identity + role + display layer that lets multiple Claude sessions co-inhabit a channel without role-collision, plus the cross-edge boundary that splits the canonical channels implementation between dotfiles (consumer shim) and plugin (source of truth). 12 implementation slices, 31 commits, 6,429 net insertions, 405 tests passing. Five audit cycles (Wave 0 + Slice 2 inner + Wave 1 + Slice 3 Lane D inner + Wave 2 + Bravo verification round).

#### Added

- **Top-level binary** `bin/claude-conductor` — Phase 1 introduces the canonical CLI entry point (Slice 0). Bare-bun fallback for slash-command callers preserved indefinitely (Risk #6 mitigation).
- **Dispatcher** `src/cli/dispatcher.ts` — verb routing for `channels` and `todos` subcommands; `--help` / `--json` / `--quiet` are position-insensitive (Slice 4.5 CLI-B); symlink chain depth bounded at 8 (Slice 4.5 RE-W1-6).
- **Flag parser** `src/cli/flags.ts` — shared parsing surface for all CLI entry points; supports `--json`, `--quiet`, `--help`, `--force`, `--role`, `--body-file`, `--peer`, `--since-mtime`.
- **NATO identity primitive** `src/channels/identity.ts` (NEW, 559 LOC) — `claimIdentity` via per-letter sentinel files using `linkSync(tmp, sentinel)` (POSIX EEXIST primitive); sibling pattern of `active-sessions/index.ts:writeMetaIfMissing`. Idempotent rejoin via session-id scan. `NatoExhaustedError` points at `close-peer` for recovery (26-letter pool exhaustion, Risk #8). Companion primitives: `setRole`, `getIdentityForSession`, `releaseIdentity`, `unlinkIdentitySentinelOrLogOrphan`, `IdentityNotHeldError`, `INTERNAL.unlinkSentinel` (mockable layer for failure-injection tests).
- **ChannelMessage schema additive fields** — `identity?: NatoIdentity` and `role?: ChannelRole` (Slice 1; backwards-compatible — legacy messages render as `<unknown>: <body>`).
- **CLI verbs** `whoami` / `set-role` / `modified join` / `close-peer` (Slice 5). `close-peer --force` for active peer override; heartbeat-staleness guard inside same `withMetadataLock` section (RE close-peer race fix).
- **Send role-gate + read render** (Slice 6) — `send` auto-attaches `identity` + `role`; rejects `role==='out'` with exit 4 AFTER body-read (ARCH-4 contractual ordering, locked by `cli-send-merged.test.ts`). `read` renders via `src/channels/render.ts` 7-cell display matrix with 2 soft-wrap edge handlers.
- **Cross-edge plugin boundary** (Slice 3a) — `src/channels/api.ts` widened to 18 value + 8 type re-exports for dotfiles consumers. `src/shared/session-id-discovery.ts` (NEW, 387 LOC) lifted from dotfiles with `assertNever` exhaustiveness helper + ARCH-1 dual-resolver JSDoc documenting strict-UUID vs lenient-channels-internal policy split. `runChannelsCli` exported with `import.meta.main` guard. `--body-file` plumbing (62 LOC) ported with realpath denylist + tmpdir allowlist (RE-1 macOS `/private/var/folders` + Linux `/tmp` cross-platform fix).
- **`die()` rewrite** (Slice 4) — uniform exit-code partition, JSON vs bare-string parity across all 14 verbs, `--json` produces parseable error JSON. `main()` try/catch funnels uncaught throws (Slice 4.5 CLI-A) through `die()` with `category: "UNCAUGHT"`.
- **Decision log** `decisions/phase-1.md` (NEW, 171 LOC) — captures architecturally-significant Phase 1 decisions including MCP Agent Mail integration deferral, NATO not Greek phonetic, `close-peer` for manual recovery, role taxonomy (`pen`/`queue`/`out`), exports map curation policy.
- **Test budget** (Slice 7, 405 tests, 847 expect calls):
  - 26-concurrent identity claim stress test (subprocess + in-process Promise.all property-based fuzz, 1000 iterations N=2-4 + 50 iterations N=20).
  - ChannelMessage round-trip invariant lock (15 tests covering all 4 ChannelKind, all 3 ChannelRole, body fidelity UTF-8/CRLF/escapes, body_ref shunt, multi-message ordering, tolerant reader, schema rejection).
  - identity.ts unit-extension (path-traversal channelId, invalid role, removeIdentityClaim discriminated return, closeStalePeerIdentity not-held/still-active/stale-released, setIdentityRole direct discriminated coverage).
  - Dispatcher verb-routing matrix (channels create/read e2e, send stdin pass-through, exit-code propagation, todos exists routing, presence rejection per Decision C).
  - render.ts branch coverage (suppressTimestamp true/false, Cell 7b body+body_ref, cross-key independence).

#### Changed

- **`acquireLock` async cascade** (Slice 2) — `withMetadataLock` is now `async`; all callers await. Typechecker catches missed-await via `Promise<void>` vs `void`.
- **`channels send` body-read ordering** (Slice 6 / ARCH-4) — body read happens BEFORE role-rejection (denylist+role compete only if both fire). Locked by `test/channels/cli-send-merged.test.ts`.
- **`channels read` rendering** (Slice 6) — outputs renderMessage by default; `--json` flag produces raw JSON for programmatic consumers (Slice 7 cross-edge tests rely on this).
- **`flags.help`** (RE-7) — `--help` writes to stdout, exits 0 (POSIX), per-verb top check.

#### Deprecated / Removed

- Nothing removed in Phase 1 — Phase 0 surface fully preserved. Identity/role/send-render layered additively per "live substrate sequencing — backwards-compatible shape changes first" discipline.

#### Architecture / Boundaries

- **Plugin exports map** widened: `./channels/identity` (NEW, Slice 1), `./channels/cli` (NEW, Slice 3a), `./channels/api` (widened, Slice 3a), `./shared/session-id-discovery` (NEW, Slice 3a).
- **Cross-edge boundary established**: dotfiles `src/channels/{index,cli}.ts` are now 30+25 LOC re-export shims pointing at this plugin via `claude-conductor/channels/{api,cli}` (sibling-link `file:../claude-conductor`). The plugin is the source of truth; dotfiles consumes via the shim.
- **Sibling-parity** with `active-sessions/index.ts:writeMetaIfMissing` (lines 335-360) verified at Wave 2: PARITY (no drift in dotfiles canonical since Phase 0 baseline).

#### Phase 2 backlog (deferred)

- MCP Agent Mail integration shape decision (decisions/phase-1.md).
- TaskCreated / TeammateIdle hooks consume identity + role.
- `--since` integration with last-seen substrate.
- Automatic GC for stale identity claims (post-Slice-5 manual `close-peer` recovery).
- `assign` as separate verb — never; collapsed into `join` per CLI-2.
- Identity recycling within a channel — never; per parent plan §159.
- Channel-CLI ppid+mtime fallback for non-UUID `CLAUDE_SESSION_ID` consumers — port plugin's UUID-strict resolver as opt-in if any surface (`feedback-channel-cli-uuid-only-env.md`).

## [0.1.0-phase-0] — 2026-04-28

### Added

- Phase 0 sub-step 0.6 batch 7b — extracted 21 agents from upstream substrate to `agents/` per audited `agents-to-bundle.md` (sub-step 0.3b deliverable, GREEN R2-verified). 13 cold auditors + 2 generic agents bundle as-is. 4 familiar auditors anonymized (architecture-integration HEAVY frontmatter+body+Audit Protocol; knowledge-system HEAVY full rewrite; code-standards LIGHT context_sources; workflow-process LIGHT context_sources + CONTRIBUTING.md ref). `familiar/domain-business.md` DROPPED (lens IS HeatPrice thesis; doesn't generalize). NEW `familiar/_template.md` ships unregistered as the structural extensibility example. `audit/registry.md` rewritten: header counts → "13 cold + 4 familiar with 1 template", BIZ row + TSV row dropped, ARCH+KS triggers rewritten to plugin-internal vocabulary. INDEX.md updated to catalog the bundled agents. CI substrate-leak grep + cross-reference graph: clean. `claude plugin validate` PASS.
- Phase 0 sub-step 0.6 batch 7a — extracted 18 cross-session feedback memories from upstream substrate to `memories/` with anonymization rewrites per audited `memories-to-bundle.md` (sub-step 0.3 deliverable, GREEN R2-verified). All bundled memories use V2 schema vocabulary (`cadence: stable`, `scope: global`, `updated: 2026-04-25`, `origin: extracted`). Cross-reference graph check passes (no dangling links between bundled memories); CI substrate-leak grep passes (with documented allowed-in-frontmatter false positives on `updated:` date). `claude plugin validate` PASS. Tests still 168/168.
- Phase 0 sub-step 0.6 batch 6 follow-up F-3 — added `description:` frontmatter to 4 session command files (handoff, handoff-resume, channel, presence). `claude plugin validate` now passes with 0 frontmatter warnings.
- Phase 0 sub-step 0.6 batch 6 — extracted 2 skills + 4 session commands from dotfiles. Plugin now ships `.claude-plugin/plugin.json` (first manifest), `skills/audit/SKILL.md`, `skills/commit-push-pr/SKILL.md`, and `commands/session/{handoff,handoff-resume,channel,presence}.md`. Auto-discovery from `skills/` and `commands/` subdirectories per official Claude Code plugin reference. Markdown-only move; no TS / no exports map change.
- Phase 0 in progress — repo cut, initial scaffold, extraction-manifest preparation underway. See `~/.claude/plans/claude-conductor-phase-0-execution.md` (private, not in repo) for the active sub-plan.

## [0.0.0] — 2026-04-25

### Added

- Initial repo creation. License (Apache-2.0), README skeleton with the 6 MUST-contains sections, CHANGELOG (this file), CONTRIBUTING, INDEX (master catalog), SECURITY, .gitignore, package.json with `engines` pinning Claude Code minimum version, tsconfig.json with strict mode and lint config, decisions/phase-0.md (first decision-log entry), audits/ directory scaffolded, docs/ tree (architecture/conventions/operations/api), memories/ directory scaffolded, dependencies-rationale.md, ADR-001 documenting the extraction strategy.
- Phase 0 starts here. Subsequent commits ship the extraction-manifest, generic-paths primitives, file extraction with refactor, test scaffolding, plugin-managed memory loader, dotfiles-side `claude-conductor-extraction` feature branch updates, and CI gates.

[Unreleased]: https://github.com/nbruzzi/claude-conductor/compare/v0.1.0-phase-1...HEAD
[0.1.0-phase-1]: https://github.com/nbruzzi/claude-conductor/compare/v0.1.0-phase-0...v0.1.0-phase-1
[0.1.0-phase-0]: https://github.com/nbruzzi/claude-conductor/compare/v0.0.0...v0.1.0-phase-0
[0.0.0]: https://github.com/nbruzzi/claude-conductor/releases/tag/v0.0.0
