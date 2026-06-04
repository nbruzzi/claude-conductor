<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# C1: Boot-Reconciliation Contract — durable session-liveness (design)

**Status:** design draft for the multi-cycle C1 arc (roadmap L1049; agetor steal-list A-P0-1; backlog 1040). The artifact for Nick's multi-cycle buy-in. A1-shaped: design → audit-loop → ~4 slices. Co-scoped: Charlie (author) + Alpha. `[DECISION — open for co-scope]` markers flag the choices needing ratification.

## 1. Problem — the mtime proxy has TWO failure modes

Session liveness today is a 3-signal **mtime PROXY** (`classifyLiveness`, active-sessions/index.ts:212): mtime within `LIVE_WINDOW_MS` (30min) + a parseable OwnerRecord (anti-ghost) + host-match → `live | likely-dead | stale`. The proxy is wrong in BOTH directions:

- **false-DEAD** — the process is alive but the heartbeat aged out (a heads-down session; a peer who sends only on the channel). **A1 PATCHED this** per-gate by OR-consulting both heartbeat stores (active-sessions + channel). But that is a patch ON the proxy, not a fix OF it.
- **false-LIVE** — the process CRASHED but its last heartbeat is still inside the window → the proxy reads "live" for up to `GC_WINDOW_MS` (60min) after death. **Unaddressed today**: a crashed session squats its presence/identity/worktree for an hour.

Plus an **enforcement gap**: LGC-001 (the A1 tripwire) scans for the _idiomatic prefix-helper_ callers; a future alive-anywhere gate reading liveness via ONLY a raw primitive (`heartbeat_mtime_ms` / `scanHeartbeats` / `newestHeartbeatMtime`) slips it — the documented false-negative.

## 2. Frame — root-closure vs proxy-patch

A1 (OR-consult both stores) + LGC-001 (the tripwire) are the **proxy-PATCH + a PARTIAL interim guard**: they stopped the acute false-dead pain (~6×/session false-idle; the live-peer presence-delete) and force-classify new _idiomatic_ gates. They do **not** fix false-live, and the tripwire's raw-primitive false-negative remains.

**C1 = the durable ROOT-closure**: replace the mtime PROXY with a real liveness determination (the actual OS process), and CENTRALIZE it so the raw-primitive false-negative class is _structurally_ closed. Defer of C1 is **bounded-acceptable** short-term (A1 guards the acute idiomatic case), **not "covered"** — the proxy + the raw-primitive FN persist until C1.

## 3. Design

### 3.1 Canonical liveness API — closes the raw-primitive FN (the root-vs-patch PROOF)

Introduce ONE canonical primitive — `classifySessionLiveness(sessionId, now): Liveness` (+ `isSessionLive`) — that internally consults: (a) real pid-liveness (§3.2), (b) BOTH heartbeat stores OR-composed (the A1 alive-anywhere contract), (c) the pause marker. The raw primitives (`heartbeat_mtime_ms`, `scanHeartbeats`, `newestHeartbeatMtime`, and the prefix-helpers) become **module-INTERNAL** — not exported for gates to call.

Consequence: every liveness gate MUST call the canonical API. A single-store / raw-primitive alive-anywhere gate becomes **impossible to write** (the raw reads aren't reachable from outside the module).

**Demonstrable closure** `[Alpha's directive]`:

- _Structural_ — the raw primitives are unexported; a gate physically cannot read one store directly.
- _Enforcement_ — extend the check (LGC-002) to flag any raw-primitive read OUTSIDE the liveness module — catches a gate that re-implements liveness from raw reads.
- _The TEST_ — a fixture "rogue gate" that determines liveness via ONLY a raw primitive (no canonical-API call) is caught by the check (or won't compile, primitives being private). **This is the proof C1 closes what LGC-001 only scans for** — root vs patch.

### 3.2 Real session-pid liveness

Record the SESSION's real OS pid + process **start-time** at session-INIT (net-new — the `pid` on OwnerRecord today is the DISPATCHER's ephemeral `process.pid`, not the session's). Probe with `process.kill(pid, 0)` — POSIX existence check, portable macOS+Linux, no `/proc`, no fork; `ESRCH` → dead.

- **pid-reuse disambiguation**: a pid is "the same process" iff `(pid, start-time)` BOTH match the recorded tuple. Record own `(pid, start-time)` at init (cheap — we know our own); compare at probe.
- **same-host-only**: `kill(pid,0)` works only same-host. Cross-host sessions can't be pid-probed → fall back to the proxy + host-match (already a signal). pid-liveness is a same-host REFINEMENT layered on the proxy, not a universal replacement.

### 3.3 The pid-role `[DECISION D1 — open for co-scope; the crux]`

pid-liveness is **HYBRID two-lane**, not pure subtract-only:

- **PROTECT-lane** (subtract-only — preserves today's safety): pid-ALIVE forces `gc_eligible=false` (a paused-but-alive or proxy-stale-but-alive session is protected). Matches the reserved `pid-alive` design (reconcile-boot.ts:75).
- **FAST-REAP-lane** (NEW, maximally-gated — fixes false-LIVE): a session is confirmed-dead + fast-reapable iff `same-host AND pid-dead AND start-time/generation-match AND 2-sweep-confirmed AND past-floor`. The ONLY new aggression; fires only on high-confidence dead.

**NEVER-auto-kill preserved**: the fast-reap lane stays operator-explicit (`--apply`) + CAS-rechecked; it adds a confirmed-dead criterion. It cannot misfire on cross-host (no probe → no fast-reap), pid-reuse (start-time-match), or transient (2-sweep). **Alternative** = subtract-only-only (don't fix false-live this arc). **Lean = hybrid**; the one departure from pure subtract-only — Alpha's co-scope call.

### 3.4 2-sweep-confirm + the generation marker

Don't reap on a single sweep's "pid-dead" — require 2 confirmations across a **persisted generation marker** (net-new; none exists today, only `pausedAt`). `[DECISION D3 — open]` per-session "suspected-dead-since `(generation, ts)`" record (recommended — distinguishes session-local restart) vs a substrate boot-generation counter. The marker **fails toward NOT-reaping** (missing/unreadable → not-yet-confirmed → don't fast-reap; Delta's marker-staleness flag); GC'd on re-register or reap.

### 3.5 The state machine

Formalize the lifecycle (supersedes the ad-hoc `live/likely-dead/stale` buckets):

`live → idle → likely-dead → stale → suspected-dead (sweep-1) → confirmed-dead (sweep-2 + pid-dead) → gc'd (--apply) → reclaimed (re-register)`; **paused = orthogonal** (blocks all reap transitions). Each transition's driving signal is explicit + testable.

## 4. The 3-primitive contract test

Three liveness primitives, each a focused test, + the closure + invariants:

1. **mtime-proxy** — the OR-composed both-store signal (the A1 contract; preserved).
2. **session-pid liveness** — `kill(pid,0)` + start-time-match; cross-platform (macOS+Linux); pid-reuse.
3. **generation / 2-sweep-confirm** — suspected→confirmed-dead; the marker staleness fail-direction.

- **rogue-gate closure test** (§3.1) — a raw-primitive-only gate is caught/impossible.
- **NEVER-auto-kill invariants** — carried from reconcile-boot's existing suite (report-default, --apply-only, floor, CAS-recheck, paused-protected, channel-live-protected).

## 5. Slice plan (A1-shaped, ~4 slices)

1. **S1 — canonical API + closure**: the `classifySessionLiveness` entry point; make raw primitives module-internal; LGC-002 (raw-read-outside-module); the rogue-gate test. _(Lands the root-vs-patch structural closure FIRST.)_
2. **S2 — real session-pid**: session-init pid+start-time recording; the `kill(pid,0)` probe + reuse-disambig; the PROTECT-lane (subtract-only). Cross-platform tests.
3. **S3 — 2-sweep + fast-reap**: the generation marker + 2-sweep-confirm; the FAST-REAP lane (D1) + its NEVER-auto-kill re-justification + tests.
4. **S4 — state machine + contract test**: formalize the machine; the 3-primitive contract test; fold identity/worktree `--apply`-GC (roadmap deferred) IF scope allows, else → C2.

Per slice: research→evaluate→plan→build→verify→test; branch; pre-commit; CI-green; inline Nick-lens audit pre-PR; peer-shadow at the PR boundary.

## 6. Supersedes Q2's minimal tuning (Delta's subsume-flag)

Q2 tunes the CURRENT proxy heuristic; C1 subsumes the heuristic. They COMPOSE, not collide:

- **lazy-compute** (defer channelLive until needed) — C1's canonical API keeps the lazy pattern. Compatible.
- **channelHB-GC** (bound the channel-HB scan) — C1 still OR-reads the channel store → the GC remains valuable (bounds a scan C1 also uses). C1 builds ON it.
- **enumeration-budget** (deferred into C1 per Delta) — C1's state machine + 2-sweep naturally bound enumeration; designed here, not in Q2.

## 7. Risks + open questions

- **Risk** pid-reuse → mitigated by start-time-match + generation.
- **Risk** cross-platform start-time → mitigated by record-own-at-init (not probing arbitrary pids' start-times).
- **Risk** generation-marker staleness → fail-toward-not-reaping; GC on re-register.
- **Risk** the subtract-only departure (fast-reap lane) → heavily-gated; the co-scope crux (§3.3).
- **OPEN Q (load-bearing, for Nick / co-scope)**: the SOURCE of the session's real OS pid at init (harness / env `CLAUDE_SESSION_OS_PID` / session-start hook?). If unobtainable, the pid lane degrades — this gates the whole pid-liveness design.
- **OPEN Q**: marker design (per-session vs boot-generation) — §3.4.
- **OPEN Q**: S4 scope — fold identity/worktree `--apply` now, or defer to C2?

## References

reconcile-boot.ts (current boot-recon; `pid-alive` reserved :75; `isGcEligible` :215; `casRecheckFlip` :537) · active-sessions/index.ts (`classifyLiveness` :212; OwnerRecord :132-155, ephemeral `pid` :134/:485; windows :82/:90) · docs/conventions/liveness-gate-store-contract.md (A1 contract) · feedback-cycle-2-boot-reconciliation-design.md (original state machine + NEVER-auto-kill) · agetor-bernstein-combined-roadmap-2026-05-26.md (C1 scope) · LGC-001 (the partial tripwire C1 supersedes).
