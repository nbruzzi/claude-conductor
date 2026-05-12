// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Lock-domain composition registry — per-phase lock-touching shape for
 * plugin-bundled checks (RE-W2-5 closure; Step F of Phase 3 substrate-completion
 * cycle 2026-05-12).
 *
 * Static-metadata only. Declares which lock-touching resources each
 * plugin-bundled check writes (or unlinks/renames). Consumers (current
 * session: none — additive-first per `feedback-live-substrate-sequencing.md`;
 * future cycles: race-surface analysis, lock-acquire ordering composition,
 * dotfiles-side framework consumers) can filter by `event` or `phase` to
 * derive an event-scoped view.
 *
 * Source-of-truth shape (v2.12 fold per ARCH-F-1):
 * - `LOCK_DOMAINS` — 10-literal const-array + `none` sentinel = 11 literals.
 * - `LockDomain` — closed literal-union derived from `LOCK_DOMAINS`.
 * - `BundledPhaseLockDomains` — row type `{ phase; event; domains; comment? }`.
 * - `BUNDLED_LOCK_DOMAINS_BY_EVENT` — event-keyed source-of-truth map
 *   (mirrors `bundled-check-names.ts:58-72` `BUNDLED_CHECKS_BY_EVENT` shape
 *   per sibling-parity discipline). `as const satisfies Record<HookEvent,
 *   readonly BundledPhaseLockDomains[]>` enforces compile-time HookEvent
 *   key-completeness — adding a new HookEvent without an entry is a
 *   compile error, not a runtime test failure.
 * - `BUNDLED_LOCK_DOMAINS` — flat array derived via `Object.values(...).flat()`,
 *   stays in sync automatically (matches `BUNDLED_CHECK_NAMES` derivation
 *   pattern at `bundled-check-names.ts:77-79`).
 *
 * Scope-decision (v2.11, ratified by Delta gate-2 sibling): ALL 11
 * plugin-bundled checks, event-tagged, NOT scoped to session-start only.
 * Reasoning: (a) registry-of-shape that gates session-start would leak
 * abstraction across the event boundary; (b) sibling-shape recurrence
 * vector preserved per `feedback-substrate-fix-pattern-must-self-mirror.md`
 * (Step E rented 4× on sibling-shape catches); (c) additive cost asymmetry
 * (widening = +4 rows; narrowing-then-widening = structural one-way door);
 * (d) framework-vs-library inversion alignment per
 * `feedback-framework-vs-library-inversion.md` — plugin publishes complete
 * shape; framework (dotfiles) consumes a filter.
 *
 * Empirical derivation: 10-domain taxonomy + `none` sentinel + 11-row matrix
 * derived via per-phase write-graph trace through `channels/index.ts` +
 * `channels/identity.ts` + `active-sessions/index.ts` + `worktrees/index.ts`
 * + `shared/presence-failure-log.ts`. Sweep-ordering is NOT encoded here —
 * that authority belongs to
 * `~/.claude-dotfiles/src/hooks/handlers/session-start.order.ts`
 * `SESSION_START_ORDER` per the dotfiles ORDER-file lookup pattern. This
 * registry expresses lock-touching shape; consumers compose ordering.
 *
 * Anti-drift discipline (8 invariants pinned by `test/hooks/lock-domain.test.ts`):
 * 1. **Exhaustive-coverage** — `BUNDLED_LOCK_DOMAINS` ↔ `BUNDLED_CHECK_NAMES`
 *    set-equality + 1:1 mapping. Adding a new bundled check without a row
 *    fails with a directed `expect.unreachable()` message.
 * 2. **Event-tag consistency** — each row's `event` matches the actual
 *    event-bucket in `BUNDLED_CHECKS_BY_EVENT`.
 * 3. **Event-keyed key completeness** — `BUNDLED_LOCK_DOMAINS_BY_EVENT` has
 *    a key for every `HookEvent` literal (enforced compile-time via
 *    `satisfies Record<HookEvent, ...>`; runtime test pins parity).
 * 4. **Domain-enum exhaustive** — every non-`none` LockDomain literal is
 *    referenced by ≥1 row (catches taxonomy drift).
 * 5. **`none` discipline** — rows with `domains: ["none"]` must have a
 *    non-empty `comment` (rationale-required per `feedback-self-sufficient-notes.md`).
 *    Currently 0 such rows (after RE-3 v2.12 fold moved `task-coordinator`
 *    to `presence-failure-log`).
 * 6. **Duplicate-detection between rows** — no two rows share the same `phase`.
 * 7. **Domain-uniqueness within row** (ARCH-F-3 v2.12 fold) — no row's
 *    `domains` list contains a duplicate.
 * 8. **Domains-non-empty** — every row has ≥1 domain (use `["none"]` for
 *    read-only baseline; currently no rows qualify).
 *
 * Pinned at `BUNDLED_CHECK_NAMES.length === 11` via
 * `test/hooks/bundled-registrations.test.ts:77` `EXPECTED_COUNT = 11`. When
 * `BUNDLED_CHECK_NAMES.length` changes upstream, `BUNDLED_LOCK_DOMAINS` row
 * count must change in lockstep — invariant #1 fires loudly on miss.
 *
 * Out of scope (v2.11; explicit deferrals filed for future cycles):
 * - Lock-acquire ordering enforcement (this slice is static metadata only).
 * - Cross-edge dotfiles consumer wiring (additive-first; follow-up cycle).
 *   Paired structural test at the exports-map boundary (per
 *   `feedback-cross-edge-contract-via-paired-tests.md`) lands with that cycle
 *   when the first dotfiles consumer is wired.
 * - `archiveChannel` whole-dir `renameSync` without `withMetadataLock`
 *   (substrate-fix concurrency hazard at `src/channels/index.ts:1276-1287`;
 *   backlog item — not Step F scope; the channel-gc row's wide domain set
 *   below DOCUMENTS the blast radius but does not fix the hazard).
 * - Dotfiles-side `withLock` consumers (8 distinct: branch-enforcement /
 *   dotfiles-catchup / dotfiles-commit / fact-force / memory-index-sync /
 *   output-externalization-nudge / vault-commit / vault-sync — substrate
 *   per INVERSIONS arc partition; not plugin-bundled).
 */

import type { BundledCheckName } from "./bundled-check-names.ts";
import type { HookEvent } from "./types.ts";

/**
 * Closed literal-union of distinct lock-touching resource types touched by
 * plugin-bundled checks. Plus `none` sentinel for read-only baseline phases
 * (rationale-required via the `comment` field per `none`-discipline test).
 *
 * `as const satisfies readonly string[]` preserves literal-narrowing per
 * `feedback-as-const-satisfies-record-narrowing.md`.
 */
export const LOCK_DOMAINS = [
  "per-channel-metadata",
  "per-channel-heartbeat",
  "per-channel-sentinel",
  "per-channel-cursor",
  "per-active-session-heartbeat",
  "per-artifact-meta",
  "per-worktree-dir",
  "gc-reap-cursor-singleton",
  "session-collision-gate-state",
  "presence-failure-log",
  "none",
] as const satisfies readonly string[];

export type LockDomain = (typeof LOCK_DOMAINS)[number];

/**
 * One row per plugin-bundled check. `phase` is narrowed to `BundledCheckName`
 * so typos fail at compile time. `event` is narrowed to `HookEvent` and
 * cross-validated against `BUNDLED_CHECKS_BY_EVENT` at test time. `domains`
 * is non-empty by convention (use `["none"]` for read-only phases — currently
 * no rows qualify after the v2.12 RE-3 fold). `comment` is optional but
 * required for `none`-only rows (rationale-discipline per
 * `feedback-self-sufficient-notes.md`).
 */
export type BundledPhaseLockDomains = {
  phase: BundledCheckName;
  event: HookEvent;
  domains: readonly LockDomain[];
  comment?: string;
};

/**
 * Event-keyed source-of-truth (matches `bundled-check-names.ts:58-72`
 * `BUNDLED_CHECKS_BY_EVENT` shape per sibling-parity discipline).
 *
 * `as const satisfies Record<HookEvent, readonly BundledPhaseLockDomains[]>`
 * forces compile-time HookEvent key-completeness — adding a new HookEvent
 * to `HOOK_EVENTS` without an entry here is a compile error, not a runtime
 * test failure. Explicit `post-tool-use: []` mirrors the canonical sibling.
 *
 * Empirically derived from per-phase write-graph trace
 * (subagent + Alpha verification 2026-05-12; v2.12 fold incorporates
 * RE-1/RE-2/RE-3/RE-7 critical empirical corrections + ARCH-F-1 shape
 * sibling-parity fix). Each row's `comment` captures the rationale for its
 * `domains` choice — load-bearing for future race-surface analysis.
 */
export const BUNDLED_LOCK_DOMAINS_BY_EVENT = {
  "pre-tool-use": [
    {
      phase: "session-collision-gate",
      event: "pre-tool-use",
      domains: [
        "per-active-session-heartbeat",
        "per-artifact-meta",
        "session-collision-gate-state",
        "presence-failure-log",
      ],
      comment:
        "Only plugin-bundled consumer of `withLock` (from src/hooks/lock.ts). Acquires mkdir-based lock on `<effectiveHome>/.claude/logs/.session-collision-gate.lock` while reading + writing collision-warning state file `<effectiveHome>/.claude/logs/.session-collision-warnings-<sessionId>.json`. Also reads + writes per-(artifactId, sessionId) heartbeats via `listLivePeers` + `touchHeartbeat`; `touchHeartbeat` invokes `writeMetaIfMissing` (linkSync-atomic) on first write — hence `per-artifact-meta` (RE-2 v2.12 fold). Error-path appendPresenceFailure writes.",
    },
    {
      phase: "task-coordinator",
      event: "pre-tool-use",
      domains: ["presence-failure-log"],
      comment:
        'Otherwise read-only — `getIdentityContextForSession(sessionId)` composes `listChannels` + `readMetadata` + `heartbeatMtime`. Error-path appendPresenceFailure writes via fail-open catch (`src/hooks/checks/task-coordinator.ts:68-75`). v2.12 RE-3 fold moved this row off `["none"]` because the catch branch\'s appendPresenceFailure is a real shared-mutable write, even on fail-open paths.',
    },
  ],

  "post-tool-use": [],

  stop: [
    {
      phase: "session-presence-unregister",
      event: "stop",
      domains: ["per-active-session-heartbeat", "presence-failure-log"],
      comment:
        "Sibling-symmetric to `session-presence-register`. Reads collision-gate state file `stateFile(sessionId)` for `touched[]` artifact list, then calls `removeOwnHeartbeat(artifactId, sessionId)` for each — `unlinkSync(<activeSessionsDir>/<artifactId>/heartbeats/<sid>)`. Error-path appendPresenceFailure writes.",
    },
  ],

  "session-start": [
    {
      phase: "channel-gc",
      event: "session-start",
      domains: [
        "per-channel-metadata",
        "per-channel-heartbeat",
        "per-channel-sentinel",
        "per-channel-cursor",
      ],
      comment:
        "RE-1 v2.12 fold: `archiveChannel(id)` does whole-dir `renameSync(<channelsDir>/<id>, <archiveDir>/<id>)` at `src/channels/index.ts:1276-1287` — atomically moves EVERY subdirectory (metadata, lockfile, heartbeat/, last-seen/, identity-emit/, gc-reap/, bodies/, messages.jsonl) PLUS identities sentinels. The whole-dir rename has the full per-channel blast radius. BYPASSES `withMetadataLock` (substrate-fix concurrency hazard filed for backlog at `src/channels/index.ts:1276-1287`). pruneArchive also rmSync's whole archived entries past retention. Does NOT call appendPresenceFailure.",
    },
    {
      phase: "channels-gc-reaper",
      event: "session-start",
      domains: [
        "per-channel-metadata",
        "per-channel-sentinel",
        "per-channel-cursor",
        "presence-failure-log",
      ],
      comment:
        "Three NON-CONTIGUOUS `withMetadataLock(channelId, fn)` sections: `markPhase` + `sweepPhase` + `pruneStaleLastSeenCursors`. Holds metadata lock (under-lock READ only — sibling-shape note: `per-channel-metadata` here means lock-serialization-touched, not metadata-write — see RE-4 deferred for taxonomy refinement). Sentinel-sweep `unlinkSync` on `identities/<letter>` + `.tmp.*` + `.reap-tmp.*` + `.reaper-acked`. Cursors: `gc-reap/cursor` (rate-gate) + `last-seen/<sid>.json` (prune). Documented at `channels-gc-reaper.ts:36-49`. Error-path appendPresenceFailure writes.",
    },
    {
      phase: "active-channels-load",
      event: "session-start",
      domains: ["per-channel-heartbeat"],
      comment:
        "For each participating channel: `touchHeartbeat(channelId, sessionId)` → `writeFileSync(<channelsDir>/<id>/heartbeat/<sid>, String(getWallClockNow()))`. Kernel-atomic small-body write; no userspace lock (last-write-wins). Does NOT call appendPresenceFailure (top-level fail-open returns pass without breadcrumb).",
    },
    {
      phase: "session-presence-register",
      event: "session-start",
      domains: [
        "per-active-session-heartbeat",
        "per-artifact-meta",
        "presence-failure-log",
      ],
      comment:
        "Sibling-symmetric to `session-presence-unregister`. Calls `touchHeartbeat({artifactId, sessionId, artifactPath, now})` → writes per-(artifactId, sessionId) heartbeat via `writeAtomic` (tmp+rename). Read-merge-write preserves `dotfilesRoot` field from `dotfiles-worktree-provisioner` anchor (see `feedback-substrate-fix-pattern-must-self-mirror.md`). First-write creates `meta.json` via `writeMetaIfMissing` (linkSync-atomic). Error-path appendPresenceFailure writes.",
    },
    {
      phase: "identity-injector",
      event: "session-start",
      domains: ["per-channel-cursor", "presence-failure-log"],
      comment:
        "Per-(channel, session) emission rate-limit cursor at `<channelsDir>/<id>/identity-emit/<sid>.json`. Direct `writeFileSync` (NOT tmp+rename atomic; corrupt-on-crash self-heals via parse-fail → emit-anyway). Error-path appendPresenceFailure on cursor write failure.",
    },
    {
      phase: "dotfiles-worktree-provisioner",
      event: "session-start",
      domains: [
        "per-active-session-heartbeat",
        "per-artifact-meta",
        "per-worktree-dir",
        "presence-failure-log",
      ],
      comment:
        "Anchor-pin (REV 0.2 ARCH-1): `setSentinelDotfilesRoot({sessionId, dotfilesRoot})` writes per-(canonical-claude-home, sessionId) heartbeat with `dotfilesRoot` field via writeAtomic UNCONDITIONALLY (before existsSync early-return). Also force-creates `meta.json` via `writeMetaIfMissing` (linkSync-atomic). Provisions per-session worktree: spawns `git worktree add -b worktree/<sid-prefix> <dotfilesCanonical>-<sid-prefix>` — git serializes via its own internal `.git/worktrees/` lockfiles. Multi-source appendPresenceFailure on incomplete/failed paths.",
    },
    {
      phase: "dotfiles-worktree-gc",
      event: "session-start",
      domains: [
        "per-worktree-dir",
        "per-active-session-heartbeat",
        "gc-reap-cursor-singleton",
        "presence-failure-log",
      ],
      comment:
        "Singleton cursor at `<effectiveHome>/.claude/logs/.worktree-gc-cursor` (5-min rate gate; multi-session race on the cursor self-heals via symmetric write-skip). Iterates `listWorktrees` (read-only `git worktree list --porcelain`) and calls `removeWorktree(sessionId)` (`git worktree remove --force` + `git branch -D worktree/<prefix>`) for stale entries. Self-heals reverse-direction via `unregisterActiveSession(fullSid)` (iterates ALL artifact-ids unlinking heartbeats for `fullSid`) + `clearSentinelDotfilesRoot(fullSid)` (writeAtomic without `dotfilesRoot` field). Multi-source appendPresenceFailure on each branch.",
    },
  ],

  "user-prompt-submit": [
    {
      phase: "teammate-idle-reminder",
      event: "user-prompt-submit",
      domains: ["per-channel-cursor", "presence-failure-log"],
      comment:
        "Sibling-shape to `identity-injector` cursor pattern. Per-(channel, session) idle-emit rate-limit cursor at `<channelsDir>/<id>/idle-emit/<sid>.json` (tmp+rename atomic, unlike identity-injector's direct write). 30-min rate gate; clock-skew suppression (>5min divergence between body-ts + mtime). Multi-source appendPresenceFailure on read failures + clock-skew + idle-emit cursor write failures.",
    },
  ],
} as const satisfies Record<HookEvent, readonly BundledPhaseLockDomains[]>;

/**
 * Flat array derived from `BUNDLED_LOCK_DOMAINS_BY_EVENT` — mirrors
 * `BUNDLED_CHECK_NAMES = Object.values(BUNDLED_CHECKS_BY_EVENT).flat()`
 * pattern at `bundled-check-names.ts:77-79`. Stays in sync with the
 * event-keyed source-of-truth automatically.
 *
 * Use this when you need to iterate every row regardless of event. When
 * you need event-scoped access, use `BUNDLED_LOCK_DOMAINS_BY_EVENT[event]`
 * directly — O(1) lookup vs O(n) filter.
 */
export const BUNDLED_LOCK_DOMAINS: readonly BundledPhaseLockDomains[] =
  Object.values(BUNDLED_LOCK_DOMAINS_BY_EVENT).flat();
