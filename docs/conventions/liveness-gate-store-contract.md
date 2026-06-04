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

## Enforcement

`scripts/check-liveness-gate-store-contract.sh` (a `check-*` convention check —
CI + pre-commit, error code `LGC-001` in `error-code-scheme.md`) scans `src/`
(non-test) for callers of `isSessionLiveByPrefix` / `isSidPrefixLiveOnChannel`:
a class-A gate must consult BOTH; a single-store caller is flagged unless it is
ALLOW-LISTED (a documented class-B gate — the qualifier's escape-hatch). This
catches a NEW alive-anywhere gate that ships single-store. The check is NOT
enforce-by-construction (a combined primitive can be bypassed; a source scan
catches the bypass).

Sequencing: this check lands AFTER the Slice 1 + Slice 2 merges — until both
reconcile-boot and teammate-idle consult both stores, the check would (correctly)
flag them as in-progress single-store gates.

## Known-remaining

- teammate-idle >5-min-compaction edge: `compaction-notify` touches the channel
  HB on PreCompact, so a compacting peer normally is not false-idle; a
  compaction outlasting the 5-min idle threshold could still fire. Documented
  gap; not bundled into Slice 2.
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
