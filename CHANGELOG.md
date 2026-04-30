<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Changelog

All notable changes to claude-conductor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Phase 3 (in progress)

- **Phase 3 Slice 1 — `dispatcher-kill-switch`** (SHIPPED 2026-04-30; plugin merge `3197810` + dotfiles merge `f49a0e9`). Operator emergency-stop primitive: `CLAUDE_CONDUCTOR_DISABLE_HOOKS` env var, comma-separated hook names, fail-OPEN with breadcrumb. Decisions A + B + C in `decisions/phase-3.md`. Closes Phase 2 CLI-W2-1 deferral.

- **Phase 3 Slice 2 — Per-session dotfiles worktrees** (plugin lane in progress on branch `phase-3-slice-2-per-session-worktrees`; dotfiles lane queued for Bravo per D-RE6 strict serialization; plan `~/.claude/plans/curious-whistling-sparrow.md` REV 0.2). Substrate-bake of per-session `git worktree` provisioning, eliminating shared-tree-bleed between concurrent Claude sessions. Default-off via `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES`; flip-default scheduled as a follow-up commit on main after Bravo first-dogfood ack.

  Plugin lane: NEW `src/worktrees/` (primitives — provisionWorktree / removeWorktree / listWorktrees + porcelain parser). EDIT `src/active-sessions/index.ts`: RE-1 mandatory canonicalization via `git rev-parse --git-common-dir` so worktree + canonical produce same artifact-id; `OwnerRecord` schema extended with optional `dotfilesRoot?: string`; `touchHeartbeat()` read-merge-write so the field survives subsequent dispatcher fires (REV 0.2 ARCH-2 fix); 4 new exports for D-ARCH3 anchor (setSentinel / readSentinel / clearSentinel + RE-3 self-heal `unregisterActiveSession`). NEW `src/shared/dotfiles-root.ts` (memoized 4-tier resolver per Bravo B8 spec). NEW `src/cli/resolve-dotfiles-root.ts` (D-ARCH5 slash-command prelude eval) + `src/cli/worktrees-show.ts` (D-CLIDX2 inspector). NEW 3 hook checks (provisioner with REV 0.2 anchor-pin + soft-ceiling; gc with RE-2 mtime-filtered safety guards + 5-min rate-gate; cleanup with reconciliation guard + CLI-DX-5 epilogue). EDIT `src/shared/presence-failure-log.ts`: 6 new kinds (`deprecation`, `sentinel-corrupt`, `worktree-{provision-failed,gc-reaped,cleanup-failed,cleanup-incomplete}`). Bundled-check count 22 → 25 + parity script auto-detects via line-count. Plugin canonical 4 slash commands prepend D-ARCH5 sentinel-reader prelude. `package.json` exports map +5 entries. NEW depth-3 runbook `docs/operations/phase-3-worktrees.md` with 10 scenarios + 8 verbatim error drafts + Operational notes (Time Machine exclusion + path-walk discipline).

  Dotfiles lane (queued): `dotfiles-common.ts` const → `dotfilesRoot()` function; 3 consumer files refactored (catchup / commit / sync — Bravo B7 drift fix); `dotfiles-sync.test.ts` extended for env-override coverage; 3 NEW shim files; atomic-wiring (check-names + bundled-registrations + 2 ORDER files + registry.test.ts ARCH-4 sibling-parity); `dispatcher.ts` D-CLIDX3 `[fff-off]` tag stacking grammar (Bravo B9). Slash command symlink-restore via install.sh:248 DIR_SYMLINK. ARCH-3 cross-edge: shim-migrate dotfiles `active-sessions/` to plugin re-export OR duplicate-patch fallback per Bravo lane Step 0 pre-flight.

  Decisions D-ARCH1 / D-ARCH3 / D-ARCH5 / D-CLIDX3 / D-CLIDX4 / D-RE6 in `decisions/phase-3.md`. Resolves R1 backlog item (`feedback-parallel-session-shared-tree-branch-race.md` becomes RESOLVED post-Bravo-merge).

## [0.2.0-phase-2] — 2026-04-30

### Phase 2 — Agent Teams hooks layer + heartbeat schema + cursor substrate

Phase 2 ships 4 integration hooks (Slices 4–7), the heartbeat-body timestamp schema extension (Slice 7), and `--since-mtime` / `--since-cursor` cursor substrate (Slice 8) with companion `forget-cursor` / `show-cursor` verbs. 11 implementation slices, 32 commits since v0.1.0-phase-1.5, 6,178 net insertions, 507 tests passing. Three audit waves: Wave 0 plan-time (3-persona on parent plan; SLICE-CHANGE → REV 2.x), Wave 1 mid-phase (RE + ARCH on Slice 4–7), Wave 2 terminal (RE + ARCH + CLI DX on full Phase 2 diff: RE 8.2 / ARCH 8.0 / CLI DX 7.6 → all FOLD). Bravo verification round (bounded 1) on the integration commit: SHIP. Pre-tag self-audit (CLI DX + Test Architect) on Slice 10.E + 10.F + 10.G found 11 fold-now items (runbook accuracy + count drift); all folded into the cap commit.

#### Added

- **`channels-gc-reaper` hook** (Slice 4) — SessionStart sweep of orphan channel-identity sentinels (per-letter sentinel files with no matching `metadata.identities[<letter>]` entry). Own-sentinel-before-unlink discipline via the same `linkSync` ownership protocol `claimIdentity` uses; mtime gate (90 s = 3 × `LOCK_STALE_MS`) + sweep-phase invariant re-check + `.reaper-acked.<Identity>` 7-day suppression marker layer to prevent racing in-flight `claimIdentity`. Fail-loud + breadcrumb on true unlink failures (operator-actionable); fail-open + breadcrumb on transient skip conditions.
- **`identity-injector` hook** (Slice 5) — SessionStart NATO-identity + role + peer-roster context emission for each claimed channel. Per-session cadence cursor at `<channel-dir>/identity-emit/<sid>.json`; emission suppressed when `(identity, role, peer-letter-set)` tuple unchanged. Fail-open + breadcrumb. Companion helper `getIdentityContextForSession` lifted to `src/channels/identity-context.ts` (NEW, shared with `task-coordinator` + `teammate-idle-reminder`).
- **`task-coordinator` hook** (Slice 6) — PreToolUse Task-only role-gate. `role=out` → hard-BLOCK (exit 2); `role=queue` → soft-warn (exit 0 + system-reminder); `role=pen` → no emission. Multi-channel evaluation: any `out` blocks; else any `queue` warns. No-claim sessions: zero emission (subagent dispatch outside any channel is the dominant case). Fail-open + breadcrumb.
- **`teammate-idle-reminder` hook** (Slice 7) — UserPromptSubmit idle-peer reminder with clock-skew sanity check. Reads heartbeat mtime + Slice-7 heartbeat body (`Date.now()` written at write instant); divergence > 5 min suppresses reminder + logs `clock-skew` breadcrumb. Per-(channel, observer-session) rate-limit cursor at `<channel-dir>/idle-emit/<sid>.json` keyed by peer letter (30-min suppression). `CLAUDE_CONDUCTOR_IDLE_THRESHOLD_MS` env var override (regex pre-check + `Number.isFinite` guard).
- **Heartbeat-body schema extension** (Slice 7) — `touchHeartbeat` writes integer epoch-ms into the heartbeat body alongside the kernel-set mtime. Backwards-compat: pre-Slice-7 heartbeats with empty body resolve via mtime-only; Slice-7+ heartbeats unlock the clock-skew sanity check. New `readHeartbeatBody` reader with strict integer-ms validation.
- **`channels read --since-mtime <value>`** (Slice 8) — filter messages where `Date.parse(msg.ts) > value`. Value shape: epoch ms OR ISO 8601 (shape-detected via `/^\d{4}-\d{2}-\d{2}/`).
- **`channels read --since-cursor`** (Slice 8) — per-session cursor at `~/.claude/channels/<id>/last-seen/<sid>.json` (`{mtime, ts}` shape). First use bootstraps from full history with stderr advisory; successful filtered reads advance the cursor. Mutually exclusive with `--since-mtime` (exit 2 ARGS).
- **`channels forget-cursor <id>`** (Slice 8) — reset this session's last-seen cursor. JSON discriminator `kind: "cleared" | "absent" | "archived" | "error"`. Idempotent (exit 0 across `cleared`/`absent`/`archived`).
- **`channels show-cursor <id>`** (Slice 8) — read-only cursor inspection. JSON discriminator `kind: "present" | "absent" | "archived"` with `{mtime, ts}` for `present`.
- **`PresenceFailureKind` extension** — new `clock-skew` kind on `~/.claude/logs/.presence-gate-failures.log`; six kinds total (`lock-timeout`, `write-failed`, `registry-contention`, `operator-reset`, `unhandled`, `clock-skew`).
- **Operator runbook** `docs/operations/phase-2-hooks.md` — depth-3 symptom/diagnose/recover/verify procedures for all 4 hooks + `read --since-cursor` substrate; Phase 2 hook catalog; firing order matrix; CLI surface section; debug breadcrumb taxonomy + tail+jq examples; per-channel substrate layout TABLE.
- **Architecture doc** `docs/architecture/hooks-layer.md` — operator mental model for hook firing order, failure-mode classification (fail-open silent / fail-open + breadcrumb / fail-loud), `system-reminder` composition rules, add-a-hook checklist. Phase 2 catalog table + per-hook recovery section (CLI-W2-1 disposition).
- **Decision log** `decisions/phase-2.md` — Decision A (heartbeat schema), Decision B (canBlock taxonomy), Decision C (Wave 2 audit dispositions: 11 fold-now + 2 deferred Phase 3 + 2 accepted-as-documented + 1 deferred Phase 4+ + 5 Phase-1 carryovers).
- **Smoke matrix v2** — `scripts/smoke-phase-2.sh` (19 scenarios #9–#27) + `scripts/smoke-common.sh` (extracted shared helpers); `package.json` adds `smoke:phase-1` / `smoke:phase-2` / `smoke:all`. RE-14 closure: pre-extraction `smoke-phase-1.sh` reference output verified byte-identical to post-extraction.
- **Cross-edge dotfiles shims** — `~/.claude-dotfiles/src/hooks/checks/{channels-gc-reaper,identity-injector,task-coordinator,teammate-idle-reminder}.ts` re-export shims; bundled-name registrations + JSDoc count (22) + check-names parity surfaces extended in plugin's `check-bundled-registrations-parity.sh` (ARCH-W2-3 closure: now covers 4 surfaces — registrations + bundled-name-set + cross-edge count + JSDoc count freshness).

#### Changed

- **`appendMessage` async + in-lock cascade** (Slice 1+2) — body resolution + reference write happen INSIDE `withMetadataLock` to eliminate the post-lock interleave that allowed stale identity reads. All callers awaited.
- **`unlinkIdentitySentinelOrLogOrphan` `{suppressLog}` flag** (Wave 2 RE-W2-3 closure) — channels-gc-reaper passes `suppressLog: true` to close the 2,016-dupe-per-orphan growth pattern.
- **`identity-context` source-name correction** (Wave 2 ARCH-W2-1 closure) — SOURCE constant resolves to `channels-identity` consistently across the helper + the 3 hooks consuming it.
- **`channels close-peer` orphan-sentinel JSON** (Slice 3) — discriminated `UnlinkResult` with explicit `orphan_sentinel: boolean` field; tolerant of EACCES/EBUSY persistence.
- **Atomic-wiring discipline** (cross-edge) — every Phase 2 hook lands plugin-side (registration + check-name + JSDoc count + cross-edge count) and dotfiles-side (re-export shim + bundled-registrations + ALL_CHECK_NAMES) atomically. Cross-edge audit script `check-bundled-registrations-parity.sh` extended to 4 surfaces; CI parity check is now load-bearing for catching this drift.

#### Architecture / Boundaries

- **Plugin exports map** widened: `./hooks/checks/channels-gc-reaper`, `./hooks/checks/identity-injector`, `./hooks/checks/task-coordinator`, `./hooks/checks/teammate-idle-reminder`, `./channels/identity-context` (NEW), `./shared/presence-failure-log` (already exported, type extension).
- **Per-channel substrate** gains 4 new subdirs: `last-seen/` (Slice 8), `gc-reap/` (Slice 4), `identity-emit/` (Slice 5), `idle-emit/` (Slice 7). All sibling-pattern with Phase 1's `identities/` + `heartbeat/`.
- **Heartbeat semantics** extended additively: mtime-only readers continue to work (Phase 1); body-aware readers gain clock-skew detection (Phase 2 Slice 7).

#### Operator impact

- **2 new CLI verbs:** `claude-conductor channels forget-cursor <id>`, `claude-conductor channels show-cursor <id>`.
- **2 new CLI flags:** `--since-mtime <ms-or-iso>`, `--since-cursor` (mutually exclusive on `channels read`).
- **1 new tunable:** `CLAUDE_CONDUCTOR_IDLE_THRESHOLD_MS=<integer-ms>` overrides the 5-min teammate-idle-reminder threshold.
- **1 new breadcrumb kind:** `clock-skew` in `~/.claude/logs/.presence-gate-failures.log`.
- **4 new substrate subdirs per channel:** `last-seen/`, `gc-reap/`, `identity-emit/`, `idle-emit/`. See `docs/operations/phase-2-hooks.md` §Per-channel substrate layout for the full table.
- **SessionStart firing order:** `channel-gc` → **`channels-gc-reaper`** → `active-channels-load` → `session-presence-register` → **`identity-injector`** (Phase 2 hooks bolded; `channels-gc-reaper` interleaved at #2 so orphan reconciliation precedes the live-channels briefing, `identity-injector` appended at #5 so its NATO + role + peer-roster context reflects post-reaper authoritative state). Source: `src/hooks/bundled-check-names.ts:BUNDLED_CHECKS_BY_EVENT["session-start"]`.
- **Per-hook recovery:** `docs/operations/phase-2-hooks.md` §Per-hook recovery has depth-3 symptom/diagnose/recover/verify procedures for all 4 hooks plus the cursor substrate. A dispatcher-level kill-switch (`CLAUDE_CONDUCTOR_DISABLE_HOOKS`) is deferred to Phase 3 (CLI-W2-1 disposition).

#### Deferred (Phase 3 backlog)

Wave 2 + Slice 8 round-2 deferrals routed to `wiki/backlog.md` `claude-conductor — Phase 3 first-slice candidates`:

- `dispatcher-kill-switch` — CLAUDE_CONDUCTOR_DISABLE_HOOKS env var + cross-edge atomic-wiring (CLI-W2-1).
- `claim-validation-primitive-lift` — lift `validateIdentityClaim` into `src/channels/claim.ts`; update 4 readers (RE-W2-4 + ARCH-W2-2).
- `unreachable-channels-substrate` — extend `listChannels()` to surface corrupt-metadata channels as placeholders (RE-W2-1).
- `clock-skew-tsot` — single time-source-of-truth for heartbeat freshness (RE-W2-2).
- `lock-domain-composition` — explicit `LockDomainPhase[]` registry pattern for SessionStart sweep phases (RE-W2-5).
- `substrate-rename` — standardize subdir naming on noun-form; live-substrate migration (ARCH-W2-4 partial).
- `slash-cmd-path-convention` — Phase-1 CLI-W2-4 carryover; deferred to public-launch boundary.

## [0.1.0-phase-1.5] — 2026-04-29

### Phase 1 follow-on — CLI-DX consistency closure + RE polish

Wave 2 audit closures from Phase 1 that were too substantive for v0.1.0-phase-1 inline closure but worth shipping as a follow-on point release. 8 commits, 7 of 8 outstanding W2 polish items closed (5 CLI-DX + 2 RE; CLI-W2-4 slash command migration deferred to Phase 2 Slice 9).

#### Added

- **`--version` / `-V` flag** on `claude-conductor` binary — POSIX/GNU convention; reads version constant from dispatcher (mirrors `package.json:version` with CHANGELOG cap discipline keeping them in lockstep at tag time).
- **`--help` Global flags section** documenting position-insensitive `--json` / `--quiet` / `--help` / `--version`.
- **Dispatcher 'presence' deferral hint** — instead of bare "unknown subcommand" error, points operators at `bun run src/active-sessions/cli.ts` (canonical fallback per Decision C). ARCH-W2-4 closure.
- **`acquireLock` writes process.pid into lockfile** — best-effort; on acquire-fail surfaces "held by pid X" in the thrown error. Sibling pattern with `active-sessions/index.ts` owner-of-meta convention. RE-W2-5 closure.
- **`DieAlreadyHandled` sentinel + catch-all guard** — forward-compat for in-process consumers that mock `process.exit`; preserves the original die's category/code/remediation rather than re-firing as `UNCAUGHT`. RE-W2-6 closure.

#### Changed

- **`--json` position-insensitivity full fix** — `partitionPropagatedFlags` scans the FULL argv now, not just pre-cmd position. CLI-W2-1 closure.
- **`todos/cli.ts` structural parity with channels/cli.ts** — `parseFlags` integration (per-verb `--help`), `VERB_HELP` map, `runTodosCli` programmatic export + `import.meta.main` guard. CLI-W2-3 closure.

#### Phase 2 hand-off

Phase 2 (Agent Teams integration hooks) starts from this v0.1.0-phase-1.5 tag. Plan: `~/.claude/plans/prismatic-orbiting-mesh.md` REV 2.1 (ratified 2026-04-29 post Wave 0 audit + bounded verification round). 11 slices; Phase 2 carry-over backlog includes RE-W2-1/2/3/4, ARCH-W2-7, CLI-W2-4, plus the 5 hook integrations.

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

[Unreleased]: https://github.com/nbruzzi/claude-conductor/compare/v0.2.0-phase-2...HEAD
[0.2.0-phase-2]: https://github.com/nbruzzi/claude-conductor/compare/v0.1.0-phase-1.5...v0.2.0-phase-2
[0.1.0-phase-1.5]: https://github.com/nbruzzi/claude-conductor/compare/v0.1.0-phase-1...v0.1.0-phase-1.5
[0.1.0-phase-1]: https://github.com/nbruzzi/claude-conductor/compare/v0.1.0-phase-0...v0.1.0-phase-1
[0.1.0-phase-0]: https://github.com/nbruzzi/claude-conductor/compare/v0.0.0...v0.1.0-phase-0
[0.0.0]: https://github.com/nbruzzi/claude-conductor/releases/tag/v0.0.0
