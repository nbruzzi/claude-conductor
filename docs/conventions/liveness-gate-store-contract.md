<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Liveness-gate store contract

**Scope:** developer + auditor reference for any gate that decides session
liveness and acts on it — worktree reapers, presence-GC, idle/advisory flags.
Defines which heartbeat store(s) such a gate MUST consult, and at which decision
points. Codifies the contract the 2026-06-04 "false-dead liveness-gate class"
arc (A1) converged on; the written target for L1049 slice-2b (#194, worktree
reapers) and its mirror slices (reconcile-boot presence-GC; teammate-idle).

Origin memory: `feedback-liveness-gate-reads-activity-store`. Arc: backlog
L1049; #194 deployed `isSidPrefixLiveOnChannel`.

## The contract

> **Every liveness gate reads every store that proves the SPECIFIC liveness it
> gates on — at every decision point it acts on that liveness.**

Two heartbeat stores prove a session is alive, and DIFFERENT activity refreshes
each — the root cause of the false-dead class (see the origin memory):

- **active-sessions** (`~/.claude/active-sessions/<artifact>/heartbeats/`) —
  refreshed by session-start + per-tool heartbeats on the operated artifact.
  Read via `isSessionLiveByPrefix` (`active-sessions/index.ts`).
- **coordination channel** (`~/.claude/channels/<id>/heartbeats/`) — refreshed
  by `cli.ts send` (channel activity). Read via `isSidPrefixLiveOnChannel`
  (`channels/index.ts`, re-exported on `channels/api.ts`).

A gate that reads one store while the session's real activity refreshes the
other reads a live session as dead. The contract makes a gate's store-set a
function of the liveness QUESTION it asks — not a blanket "read every store."

## Gate class A — alive-anywhere → read ALL stores (OR-composed)

A gate that asks **"is this session alive / doing ANY work?"** then reaps,
deletes, or flags on the answer. It MUST consult BOTH stores, OR-composed:
fresh in EITHER store → alive. OR-composition only ADDS protection — it can
never make a session reapable that a single store alone would have protected.

Members:

- worktree reapers (`dotfiles-worktree-gc`, `repo-worktree-gc`) — **DONE** (#194).
- reconcile-boot presence-GC (`reconcile-boot.ts`: `enumeratePresence` /
  `isGcEligible` + the apply-time `casRecheckFlip`) — A1 Slice 1.
- teammate-idle-reminder (`teammate-idle-reminder.ts`) — A1 Slice 2 (the mirror:
  it reads channel-only today; add active-sessions).

**Every decision point — not just classification (mutating gates).** A MUTATING
alive-anywhere gate (one that deletes/reaps) acts on liveness at more than one
point: classification AND the apply-time recheck that closes the
enumeration→apply TOCTOU. It must consult all stores at EVERY such point. A gate
that reads all stores at classification but a single store at the apply-time
recheck still loses data on a session that goes live in the gap — so
reconcile-boot's `casRecheckFlip` channel-consults, not just its classifier.

**Fail-direction by gate effect.** The store primitives fail SOFT (a missing /
unreadable dir or per-file stat error → "not-live"; never throws). That serves
both gate effects, but the safe direction differs:

- **MUTATING** gates (reap/delete) must fail toward **NOT ACTING**: IO-error →
  not-live → do NOT reap. Fail-soft-to-not-live is correct, but a transient
  error must not single-handedly reap — so a mutating gate ALSO pairs an
  independent signal (the worktree reapers OR two stores AND sit upstream of the
  dirty-tree WIP guard; see #194 M1/M2). A helper used as a sole reap-gate is
  unsafe — its JSDoc says so.
- **ADVISORY** gates (warn/flag) tolerate failing toward **FLAGGING**: a rare
  double-fault (both stores unreadable) emits a noise false-positive, not a
  destructive action — acceptable for a warner.

## Gate class B — store-specific → read THE ONE store (adding others is a BUG)

A gate that asks a liveness scoped to ONE store's participation reads ONLY that
store; consulting others is incorrect.

- **reclaim** (`reclaimStaleIdentities`, 24h) asks "is this NATO-letter holder
  still PARTICIPATING ON THE CHANNEL?" → channel store ONLY. Adding
  active-sessions would let a channel-joined-but-silent solo session keep its
  letter forever, defeating reclaim.

**Verified-clean (A1 gate-audit) — class B or not-a-liveness-gate; no fix:**
`reclaim` · `channel-gc` `sweepStale` (coordination-exempt) ·
peer-message-deliverer (delivers messages; never gates-on-liveness-to-destroy) ·
`session-presence-unregister` (own-Stop self-removal) · the orphan-sentinel /
last-seen-cursor / LATEST-symlink sweeps (do not gate on session liveness).

## Gate class C — observe rung (harness status) → ADVISORY-OBSERVE-ONLY (CG6)

A THIRD liveness signal exists beyond the two heartbeat stores: the harness's
own per-session activity file, `~/.claude/sessions/<pid>.json`
(`{pid, sessionId, status, updatedAt}`), read via
`cohort-sight.buildHarnessStatusIndex`. It is **NOT a heartbeat store** and is
**NOT alive-anywhere store #3** — it is an OBSERVE rung (OBSERVE-NOT-INFER): the
harness DECLARES `busy`/`idle`/`waiting`/`shell` directly, where the two stores
only let a gate INFER liveness from mtime freshness.

**CG6 — advisory-observe-only bound (load-bearing).** A gate may consult the
harness status to SUPPRESS an advisory warn (teammate-idle: an ACTIVE status —
`busy`/`shell`/`waiting` — with a live pid is working-not-idle), but **NO
state-deleting path (reaper / GC / `--apply`) may EVER gate on it.** The harness
pidfile is an undocumented, CC-version-coupled artifact (the C1 pid-spike
caveat); coupling a destructive action to it would make reap-correctness hostage
to a harness internal. Class C is suppress-only — the strictest case of the
class-A advisory fail-direction.

- **trusted by `isOsPidAlive`, not age.** An ACTIVE status is trusted REGARDLESS
  of the pidfile `updatedAt` ageMs — `updatedAt` freezes multi-minute during
  active work (CG1 spike 2026-06-07; a `/compact` is indistinguishable from a
  long busy turn), so an age-staleness gate would re-fire the false-idle bug.
  The only staleness guard is the live-pid probe (`isOsPidAlive`).
- **same-host only.** A pid is meaningless across hosts; a peer with no local
  pidfile DEGRADES to the mtime path (cross-host is CG7-deferred).
- **NOT on the LGC allowlist.** `buildHarnessStatusIndex` is not a prefix-helper
  (`isSessionLiveByPrefix` / `isSidPrefixLiveOnChannel`), so the LGC-001 tripwire
  does not scan it. The advisory-only bound is enforced by THIS clause + the
  PR-boundary review + the CG2 contract test (`cohort-sight` stays AUGMENT-ONLY;
  no reaper/GC module imports it).

Members:

- teammate-idle-reminder (`teammate-idle-reminder.ts`) — **DONE** (Lane A): the
  harness-status PRIMARY idle-suppress, consulted before the class-A
  active-sessions mirror. Breadcrumb kind `harness-active-suppressed`.

## Enforcement

`scripts/check-liveness-gate-store-contract.sh` (a `check-*` convention check —
CI + pre-commit; error code `LGC-001` in `error-code-scheme.md`) is an
**allow-list-gated tripwire**: it scans `src/` (non-test) for callers of the
liveness prefix-helpers (`isSessionLiveByPrefix` / `isSidPrefixLiveOnChannel`)
and flags any caller NOT on the `ALLOWLIST` (the classified, store-contract-
verified gates) with `LGC-001` — forcing a NEW gate to be classified before it
ships. NOT enforce-by-construction (a combined primitive could be bypassed; a
source scan catches the bypass).

**Why a tripwire, not a "consults-both-stores" verifier.** The alive-anywhere
gates read the stores via DIFFERENT primitives, so "calls both helpers" is the
wrong test: the worktree reapers call both prefix-helpers, but reconcile-boot
reads active-sessions via its own `classifyLiveness` + the channel via
`isSidPrefixLiveOnChannel`, and teammate-idle reads active-sessions via
`isSessionLiveByPrefix` + the channel via its `heartbeat_mtime_ms` idle-read. A
grep cannot verify "consults both stores by any mechanism" (the channel read
alone has 3+ forms), so the `ALLOWLIST` IS the human-verified both-stores gate,
and the tripwire makes adding a NEW un-classified gate impossible-to-do-silently.

**Honest scope.** The tripwire catches the IDIOMATIC prefix-helper probes — the
common new-gate shape. A gate that reads a store only via a raw primitive
(`heartbeat_mtime_ms` / `scanHeartbeats` / `newestHeartbeatMtime`) and never a
prefix-helper is not auto-caught; the written contract above + the PR-boundary
store-contract review cover that residual.

## Known-remaining

- teammate-idle >5-min-compaction edge: **mostly closed by Lane A** — the harness
  keeps `status:"busy"` through a compaction it runs, so the class-C harness-
  status PRIMARY suppress self-heals the >5-min case (CG1). `compaction-notify`
  touches the channel HB on PreCompact as the SECONDARY belt-and-suspenders for
  the residual edge (pidfile absent during compaction but the ping fired). Both
  suppress-only.
- the channel heartbeat store has no per-file GC (unbounded growth; mtime-gated,
  so reap-correctness holds). Ticketed (#194 KNOWN-REMAINING).

## Cross-references

- `feedback-liveness-gate-reads-activity-store` — the false-dead root cause and
  the every-store-at-every-decision-point qualifier (origin memory).
- `#194` — deployed `isSidPrefixLiveOnChannel` and the worktree-reaper
  OR-pattern the mirror slices follow.
- `error-code-scheme.md` — the `LGC` error-code prefix (added with the
  enforcement check).
- `decisions/phase-3.md` — the A1 mirror-slice decision entries (reconcile-boot
  presence-GC; teammate-idle).
