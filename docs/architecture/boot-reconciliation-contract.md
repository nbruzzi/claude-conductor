<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# C1: Boot-Reconciliation Contract — durable session-liveness (design)

**Status:** design RFC for the multi-cycle C1 arc (roadmap L1049; agetor steal-list A-P0-1; backlog 1040) — the durable ROOT-closure the A1 acute slices point at. The artifact for Nick's multi-cycle buy-in. A1-shaped: design → audit-loop → ~4 slices. Co-scoped: Charlie (author) + Alpha (D1/correctness) + Delta (effort/sequencing). This revision folds the cohort co-scope (see the fold-log at the end).

## 1. Problem — the mtime proxy has TWO failure modes

Session liveness today is a 3-signal **mtime PROXY** (`classifyLiveness`, active-sessions/index.ts:212): mtime within `LIVE_WINDOW_MS` (30min) + a parseable OwnerRecord (anti-ghost) + host-match → `live | likely-dead | stale`. The proxy is wrong in BOTH directions:

- **false-DEAD** — the process is alive but the heartbeat aged out. **A1 PATCHED this** per-gate by OR-consulting both heartbeat stores. A patch ON the proxy, not a fix OF it.
- **false-LIVE** — the process CRASHED but its last heartbeat is still inside the window → the proxy reads "live" for up to `GC_WINDOW_MS` (60min) after death. **Unaddressed today.**

Plus the **enforcement gap**: LGC-001 (the A1 tripwire) scans the _idiomatic prefix-helper_ callers; a future alive-anywhere gate reading liveness via ONLY a raw primitive slips it — the documented false-negative.

## 2. Frame — root-closure vs proxy-patch

A1 + LGC-001 = the **proxy-PATCH + a PARTIAL interim guard**: they stopped the acute false-dead pain and force-classify new _idiomatic_ gates. They do **not** fix false-live, and the tripwire's raw-primitive false-negative remains. **C1 = the durable ROOT-closure**: a real liveness determination (the actual OS process), CENTRALIZED so the raw-primitive FN class is _structurally_ closed. Defer of C1 is **bounded-acceptable** (A1 guards the acute idiomatic case), **not "covered."**

## 3. Design

### 3.1 Canonical liveness API — closes the raw-primitive FN (the root-vs-patch PROOF)

ONE canonical primitive — `classifySessionLiveness(sessionId, now)` (+ `isSessionLive`) — internally consults: real pid-liveness (§3.2), BOTH heartbeat stores OR-composed (the A1 contract), the pause marker. The raw primitives (`heartbeat_mtime_ms`, `scanHeartbeats`, the prefix-helpers) become **module-INTERNAL**. Every gate MUST call the canonical API → a single-store / raw-primitive alive-anywhere gate is **impossible to write**.

**Demonstrable closure** `[Alpha's directive]`: _structural_ (raw primitives unexported) + _enforcement_ (extend the check → LGC-002, flag a raw-primitive read OUTSIDE the liveness module) + _the TEST_ — a fixture "rogue gate" determining liveness via only a raw primitive is caught (or won't compile). **The proof C1 closes what LGC-001 only scans for.** This slice (S1) is independent of the pid lane — it ships durable value even if the pid spike (§3.2) fails.

### 3.2 Real session-pid liveness — and the cross-platform reuse question `[folds Alpha-S2]`

Record the SESSION's real OS pid at session-INIT (net-new — `OwnerRecord.pid` today is the DISPATCHER's ephemeral `process.pid`). Probe with `process.kill(pid, 0)` — POSIX, portable macOS+Linux, no `/proc`, no fork; `ESRCH` → the pid is gone.

**The reuse question, resolved (Alpha's S2 catch — the earlier draft wrongly claimed to "dodge" the divergence):** reuse-disambiguation (is the process at pid P _still my session_ vs a recycled pid?) genuinely needs the PROBED pid's start-time — which IS the macOS/Linux-divergent part. So the design makes start-time-match **NON-load-bearing**:

- **fast-reap (S3b) fires ONLY on `kill(pid,0)=ESRCH`** — the pid is _gone_, so there is no process to be reused and no start-time to read. Definitive death; zero cross-platform start-time dependency.
- **protect fires on `kill(pid,0)=success`** but is **staleness-ceiling-bounded**: pid-alive forces `gc_eligible=false` ONLY while within a ceiling (e.g. ≤ `GC_WINDOW_MS`); beyond it, mtime-staleness wins regardless of pid. So a **reused-pid false-protect cannot leak forever** (the protect-lane false-LIVE-protect risk Alpha flagged — bounded by the ceiling, degrading to today's proxy behavior).
- **start-time-match is an OPTIONAL refinement** (tighten the protect where a platform's start-time is cheaply readable) — never on the load-bearing path. This is HOW the design avoids the cross-platform divergence: by not making reuse-disambiguation load-bearing.

**Same-host-only**: `kill(pid,0)` works only same-host; cross-host sessions fall back to the proxy + host-match. pid-liveness is a same-host refinement, not a universal replacement. **Paired macOS+Linux tests** for the probe + the ceiling-bounded protect.

### 3.3 The pid-role `[DECISION D1 — folds Alpha; S3b gated on ratify]`

HYBRID two-lane:

- **PROTECT-lane** (subtract-only — preserves today's safety; ships in S2): pid-ALIVE (ceiling-bounded, §3.2) forces `gc_eligible=false`.
- **FAST-REAP-lane** (NEW; **S3b**, gated on D1-ratify): `kill(pid,0)=ESRCH AND 2-sweep-confirmed AND past-floor` → fast-reapable.

**Reframe (Alpha):** the fast-reap's value is **faster OPERATOR-RECLAIM** (a crashed session's presence/identity/worktree freed sooner for a human to reclaim), **NOT** an autonomous stall-fix. The **~30min fresh-HB residual** (a crash's heartbeat stays "live" until ageout) is left to the existing channels — `close-peer` + the cohort bump handle post-ageout recovery. **Autonomous-fast-reap is scoped OUT.** This keeps NEVER-auto-kill intact: fast-reap stays operator-explicit (`--apply`) + CAS-rechecked; it only adds an ESRCH-confirmed-dead criterion.

### 3.4 2-sweep-confirm + the generation marker `[folds Alpha/Delta-D3]`

Don't reap on one sweep's ESRCH — require 2 confirmations across a persisted generation. **REUSE the OwnerRecord** for the marker (a `suspected_dead` generation/ts field), **NOT a net-new staleness store** — reuse beats a new CAS+staleness store (Delta's effort-flag; cheaper long-pole). The marker **fails toward NOT-reaping** (missing/unreadable → not-yet-confirmed). GC'd on re-register.

### 3.5 The state machine

Formalize (supersedes the ad-hoc buckets): `live → idle → likely-dead → stale → suspected-dead (sweep-1, ESRCH) → confirmed-dead (sweep-2) → gc'd (--apply) → reclaimed`; **paused = orthogonal**. Each transition's signal explicit + testable.

## 4. The 3-primitive contract test

1. **mtime-proxy** (the OR-composed both-store signal; A1 contract, preserved). 2. **session-pid** (`kill(pid,0)`; ESRCH-fast-reap + ceiling-bounded-protect; paired macOS+Linux). 3. **generation / 2-sweep** (suspected→confirmed; OwnerRecord marker; fail-direction). Plus the **rogue-gate closure test** (§3.1) + the **NEVER-auto-kill invariants** (carried from reconcile-boot's suite).

## 5. Slice plan (A1-shaped) `[folds Alpha/Delta — split S3, fold-order, pid-spike]`

**Fold-order:** S1 → pid-SPIKE → S2 → S3a → [S3b gated on D1-ratify] → S4. Q2's `channelHB-GC` lands first/independently (C1 assumes it; §6).

1. **S1 — canonical API + FN-closure** (de-risked; ships regardless): the `classifySessionLiveness` entry point; raw primitives module-internal; LGC-002; the rogue-gate test. **Independent of the pid spike** — the structural root-vs-patch closure lands even if the spike fails.
2. **pid-SPIKE (the fork gate — Delta):** a tiny spike resolving the load-bearing OPEN Q — can we capture the session's real OS pid at init (env `CLAUDE_SESSION_OS_PID` / session-start hook / harness)? **FORKS the arc:** spike-passes → full S2–S4; **spike-fails → degraded arc** = S1 + S4 on the proxy (structural closure + state-machine; NO pid-lane; false-LIVE stays open, deferred to a harness-dep follow-on). Make the fork explicit _before_ committing S2/S3 scope.
3. **S2 — real session-pid + protect-lane** (long pole #1): pid-init recording; the `kill(pid,0)` probe + ESRCH/ceiling design (§3.2); the subtract-only PROTECT-lane; paired macOS+Linux tests.
4. **S3a — 2-sweep + generation-marker** (long pole #2; durable false-DEAD closure): the OwnerRecord-reuse marker (§3.4) + 2-sweep-confirm. Ships the durable closure WITHOUT the fast-reap.
5. **S3b — FAST-REAP lane** (gated on D1-ratify): the ESRCH-confirmed-dead fast-reap (§3.3) — separable so the durable closure (S1/S2/S3a/S4) lands without blocking on the fast-reap ratification.
6. **S4 — state machine + 3-primitive contract test** (§3.5, §4); fold identity/worktree `--apply`-GC (roadmap deferred) IF scope allows, else → C2.

Per slice: research→evaluate→plan→build→verify→test; branch; pre-commit; CI-green; inline Nick-lens audit; PR-boundary peer-shadow. **Effort (Delta):** S2 (cross-platform pid) + S3a (net-new persisted marker semantics) are the heavy slices — budget above S1/S4.

## 6. Supersedes Q2's minimal tuning (Delta's subsume-flag — affirmed)

Q2 tunes the current proxy heuristic; C1 subsumes it. They COMPOSE: **lazy-compute** — C1's canonical API keeps the lazy pattern; **channelHB-GC** — C1 still OR-reads the channel store, so the GC stays valuable (bounds a scan C1 also uses) and **lands first/independently in Q2** (C1 assumes it); **enumeration-budget** — designed INTO C1's state machine, not Q2 (deferred-into-C1, ratified).

## 7. Risks + open questions

- **The load-bearing dependency (now framed as the pid-SPIKE gate, §5):** the SOURCE of the session's real OS pid at init — CONFIRMED absent today (grep + research); net-new, likely a harness/env dependency **outside cohort control**. The spike resolves it before S2; the degraded-arc fork is the fallback. **This is the dependency Nick weighs.**
- **Risk** pid-reuse → non-load-bearing (ESRCH-fast-reap + ceiling-protect, §3.2). **Risk** cross-platform start-time → avoided on the load-bearing path. **Risk** marker staleness → fail-toward-not-reaping; OwnerRecord-reuse. **Risk** the subtract-only departure (S3b fast-reap) → ESRCH-only + 2-sweep + operator-explicit; gated on D1-ratify.
- **OPEN Q:** S4 scope — fold identity/worktree `--apply` now, or defer to C2?

## Fold-log (co-scope, this revision)

- Alpha D1-reframe: fast-reap = faster operator-reclaim, NOT autonomous stall-fix; ~30min fresh-HB residual documented (close-peer/bump); autonomous-fast-reap scoped-out (§3.3).
- Alpha S2: spelled out reuse-disambig is non-load-bearing (ESRCH-fast-reap + ceiling-bounded-protect) — resolves the "dodge" gap + the protect-lane false-LIVE-protect risk (§3.2).
- Alpha/Delta D3: reuse OwnerRecord for the generation marker, not a net-new store (§3.4).
- Delta: pid-source → an explicit pid-SPIKE with a degraded-arc fork (§5 step 2, §7).
- Delta: split S3 → S3a (durable) + S3b (fast-reap, gated) (§5).
- Delta/Alpha fold-order: S1 → spike → S2 → S3a → [S3b] → S4; channelHB-GC first (§5, §6).

## References

reconcile-boot.ts (`pid-alive` reserved :75; `isGcEligible` :215; `casRecheckFlip` :537) · active-sessions/index.ts (`classifyLiveness` :212; OwnerRecord :132-155, ephemeral `pid` :134/:485; windows :82/:90) · docs/conventions/liveness-gate-store-contract.md (A1) · feedback-cycle-2-boot-reconciliation-design.md (original state machine + NEVER-auto-kill) · agetor-bernstein-combined-roadmap-2026-05-26.md (C1 scope) · LGC-001 (the partial tripwire C1 supersedes).
