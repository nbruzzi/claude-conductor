---
name: Walkie-talkie `out` kind — terminal-until-takeover semantics
description: Phase 4 Step A Layer 3 introduced `kind=out` as an explicit channel-departure announcement plus a metadata cache (`metadata.identities[<L>].out_posted_at`) that lets peers filter departed sessions without scanning the message log; `out` is terminal-until-takeover (reset only via `claim --force`); manual `channels send <id> out` is the sole writer this arc — auto-out from the Stop hook was DROPPED before merge (deferred to Phase 4 Step B SessionStart-reaper)
type: feedback
cadence: stable
scope: global
updated: 2026-05-13
origin: native
---

Phase 4 Step A Layer 3 (PR #B1, plan `eventual-marinating-wall.md` v5) introduced `kind=out` as one of five walkie-talkie protocol primitives (`ack` / `roger` / `over` / `standby` / `out`). The `out` kind is structurally different from the other four — it's the only one that mutates per-identity channel state — and that asymmetry encodes the **terminal-until-takeover** semantics.

## What `out` does

Manual operator `channels send <id> out` is the sole writer this arc:

- The CLI send-role-gate carve-out at `src/channels/cli.ts` lets the `out` kind through regardless of the sender's current role (the gate blocks every OTHER kind when role=`out`, but `out` is the one allowed self-departure announcement).
- When `kind === "out"`, the CLI passes `makeSendOutMutator(sessionId)` (exported from `src/channels/index.ts`) as the `extraMetadataMutator` parameter to `appendMessage`. The mutator runs inside `withMetadataLock` and atomically sets BOTH `role = "out"` AND `out_posted_at = <ISO ts>` on the sender's identity claim.

After the send returns: the JSONL line `{kind: "out", role: <prior role>, ...}` is on disk; the metadata's `identities[<L>]` has `role: "out"` and `out_posted_at` populated. The message preserves the sender's PRIOR role (auto-attach runs before the mutator), so the JSONL audit trail records the transition explicitly (was-queue, now-out).

## What `out` does NOT do (and why)

**The Stop hook does NOT auto-post `out`.** An earlier plan draft (v4) extended `session-presence-unregister` to iterate every channel the session had a claim on and post `kind=out` + set `out_posted_at` automatically at session-end. That extension was DROPPED before merge for a structural reason:

> Stop fires per-turn, not session-end. See `src/hooks/checks/bundled-registrations.ts:71-78` for the precedent — the codebase already removed `dotfiles-worktree-cleanup` on 2026-05-08 for the exact same bug shape: a Stop-event hook with no session-end discrimination destroys session-scoped state after turn 1 instead of waiting for the session to actually end.

Auto-out would have marked the working session as departed after its first turn. Every subsequent turn would have re-posted another `kind=out` line. Sibling sessions consuming via `explicitlyOutPeers` or `listLivePeers({excludeOut: true})` (planned consumer) would see the active session as departed.

The catch came from staged-diff Reliability audit citing the dotfiles-worktree-cleanup precedent comment — **substrate-as-precedent** caught a plan-level defect that two prior audit cycles (4-persona v1 dispatch + Bravo v3 sibling cross-audit) had missed because both reasoned forward from the design intent rather than reverse from "what does Stop actually mean here".

**Replacement plan (deferred to Phase 4 Step B):** SessionStart-driven reaper. On the next session-start, walk channels for stale heartbeats and auto-post `out` for departed peers. Mirrors the `dotfiles-worktree-gc` SessionStart-reaper pattern; structurally correct because next-session-start is durable evidence that the prior session ended. Filed in `wiki/backlog.md` as a Phase 4 Step B candidate.

## Why atomic matters

Pre-fold, the substrate design (and Bravo's MAJOR-3 fold on plan v3 → v4) routed the message append and metadata mutation through separate writes. Three problems:

1. **Race window** — between writes, `explicitlyOutPeers` returns false-negative. Any peer iteration in that window misclassifies.
2. **Partial-write inconsistency** — if message append succeeded but metadata write threw, the log says "out" forever, the cache lies indefinitely.
3. **Cache-as-truth claim weakens** — callers can't trust the O(1) cache as fast-path if it can disagree with the log.

The fold consolidated both writes under one lock via `appendMessage`'s new `extraMetadataMutator: (meta) => ChannelMetadata` parameter. RE-2 fold sequenced the writes JSONL-first, metadata-second so the audit trail is the anchor (graceful-degrade on metadata-write failure: log has the line, cache catches up on next read). Validation runs BEFORE the JSONL append so a mis-shaped mutator output rolls back the entire transaction.

## Terminal-until-takeover

Once `out_posted_at` is set for a NATO letter, it stays set on every read. The only reset is `claimIdentityNamed --force` — a takeover replaces the entire claim record with a fresh one carrying no `out_posted_at`. RE-7 semantics: a departed peer doesn't auto-resurrect when its session returns; an operator (or an explicit `--force` claim from the next session) has to displace the stale claim.

## Predicate posture: `explicitlyOutPeers`

The reader is intentionally narrow: returns the NATO letters whose claim has `out_posted_at` set, empty array on unreadable metadata. Consumers (`listLivePeers({excludeOut: true})` landing in a follow-up, `channels peers --reason="explicit-out"` planned) use this O(1) predicate instead of scanning the message log — which is the whole reason the cache exists. The message log remains the audit trail; the metadata field is the operational cache.

## Cross-references

- `feedback-distinct-lenses-over-repeat-verifications.md` — the 4-persona pre-fold audit + the plan-v3 cross-audit both missed the per-turn Stop concern; staged-diff Reliability audit caught it via substrate-precedent.
- `feedback-cross-edge-contract-via-paired-tests.md` — substrate change + writer + reader + tests in one bounded review surface.
- `feedback-no-known-gaps.md` — atomicity + per-turn folds landed pre-merge instead of as known-gap deferrals.
- `bundled-registrations.ts:71-78` — the dotfiles-worktree-cleanup removal precedent that grounded the auto-out drop.
