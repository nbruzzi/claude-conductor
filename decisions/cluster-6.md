# Cluster 6 — Fixed-eternal coordination channel (cohort 2026-05-31)

**Slice:** Slice 1 (substrate) of the fixed-eternal `coordination` channel build. Cohort `cohort-2026-05-31` (Alpha/Bravo/Charlie/Delta); design `plans-durable/channel-coordination-fixed-eternal-design-2026-05-31.md` + its authoritative Build-kickoff addendum (2026-06-01).
**Cycle:** 2026-06-01
**Outcome:** Slice 1 in flight (PR #183).

Mirrors `decisions/cluster-1..5.md` shapes. This cluster logs the within-build decisions made implementing the Slice-1 substrate (the eternal-channel join-or-create + the coupled `channel-gc` archival-exemption / stale-identity reclaim reaper + `api.ts` curation). The architectural frame — one global eternal channel; isolation-by-filtering; NO key-revoke for routine reclaim (D-INT-3) — is upstream in the design doc; entries here are the build-time calls.

---

## 2026-06-01 — Decision A: 24h reclaim threshold (ONLINE-window / dead edge), coordination-scoped reaper

```yaml
---
ts: 2026-06-01T15:00:00Z
kind: architectural
severity: major
phase: cluster-6
affects:
  - src/channels/reclaim.ts
  - src/hooks/checks/channels-gc-reaper.ts
  - src/hooks/checks/channel-gc.ts
---
```

**Context:** The eternal channel's archival-exemption (`channel-gc:sweepStale` skips `coordination`) removes the per-cycle archival that used to recycle the 26-letter NATO pool, so a stale-identity reaper is REQUIRED — coupled, neither ships without the other. The design said "reuse the 30min/24h liveness taxonomy" but did not pin the exact reclaim threshold or the channel scope.

**Options considered:**

1. **24h (ONLINE_WINDOW) threshold, coordination-scoped reaper (CHOSEN).** Reclaim a claim only when its channel heartbeat is stale beyond 24h — the edge past which a session is no longer even "online", and the same boundary `channel-gc` archives a non-exempt channel at. Run the reaper only for `COORDINATION_CHANNEL_ID`.
2. 60s `STALE_THRESHOLD_MS` (the close-peer manual gate). Rejected: it false-positives on Monitor-wake-delayed / heads-down sessions — confirmed LIVE on 2026-06-01 when the teammate-idle hook flagged all three building siblings at 5–9 min idle. An automated reaper at 60s would reclaim live sessions' letters.
3. All-channels reaper. Rejected: non-coordination channels already get whole-channel archival at 24h (`channel-gc`), which recycles their pool — per-claim reclaim there is redundant and widens blast radius.

**Chosen:** Option 1.

**Reason:** 24h clears the observed heartbeat-lag-during-long-tool-runs band (5–9 min) by >150x, so heads-down sessions are never reclaimed — only truly dead/crashed ones (clean exits self-release their letter). Tying the reclaim edge to `channel-gc`'s archival edge gives one coherent liveness boundary: instead of archiving the whole channel (which recycled the pool), reclaim individual dead claims at the same 24h edge. Coordination-scope keeps the reaper's job exactly "compensate for the archival-exemption."

**Operationalized:** `COORDINATION_RECLAIM_STALE_MS = 24h` in `channels-gc-reaper.ts`; the primitive `reclaimStaleIdentities({ channelId, staleThresholdMs })` is policy-free (caller supplies the window; tests inject small windows). Wired into the `channels-gc-reaper` SessionStart check for `COORDINATION_CHANNEL_ID` only. Exemption in `channel-gc:sweepStale` is a single `if (ch.id === COORDINATION_CHANNEL_ID) continue;` before the staleness check.

---

## 2026-06-01 — Decision B: reaper reuses closeStalePeerIdentity(force:false) + sentinel-unlink; NO key-revoke

```yaml
---
ts: 2026-06-01T15:05:00Z
kind: api-shape
severity: major
phase: cluster-6
affects:
  - src/channels/reclaim.ts
  - src/channels/api.ts
---
```

**Context:** How to implement reclaim without duplicating the close-peer machinery, and the code-level confirmation of the no-key-revoke contract (D-INT-3).

**Options considered:**

1. **Reuse `closeStalePeerIdentity(force:false)` + `unlinkIdentitySentinelOrLogOrphan`, iterating `listClaims` (CHOSEN).** The "two-call free" the design anticipated. `force:false` makes the primitive's internal heartbeat-staleness check the gate (released only when `ageMs > threshold`); the sentinel-unlink frees the pool slot. Iterate `listClaims` (the sentinel scan) because the 26 sentinels ARE the pool slots `claimIdentity` walks.
2. Hand-rolled metadata + sentinel mutation. Rejected: duplicates close-peer's lock discipline + heartbeat semantics; drift risk.

**Chosen:** Option 1.

**Reason:** Mirrors the `close-peer` / `release-self` released-branch exactly, so the reaper inherits their lock-correctness + orphan-handling (a non-ENOENT unlink failure surfaces as `stuck`, leaving the metadata-removed sentinel for the orphan-sentinel reaper to retry — no permanent pool leak). NO key-revoke: `reclaim.ts` imports nothing from `key-revoke.ts` — reclaiming a dead session's letter never touches its key (keys are per-letter + persistent; the identity path is unsigned). Code-level confirmation of D-INT-3 (Bravo's Slice-3 test #5 asserts it negatively).

**Operationalized:** `reclaimStaleIdentities` + `ReclaimResult` curated via `api.ts` (+ paired-contract value-presence test). `closeStalePeerIdentity` stays imported intra-module (not on the public surface), per the existing curation policy. `joinOrCreateChannel` + `COORDINATION_CHANNEL_ID` also curated; `cli.ts` join verb routes the constant through join-or-create (handoff_id self-anchors to the channel id).

**Cross-edge note:** dotfiles shim-mirror of the 3 new `api.ts` exports DEFERRED (no dotfiles-surface consumer; integration-lead verdict 2026-06-01) — lands with the first consumer.

---

## 2026-06-01 — Decision C: body-returning peer-recent-message helper via module subpath (deploy follow-up #6)

```yaml
---
ts: 2026-06-01T18:35:00Z
kind: api-shape
severity: minor
phase: cluster-6
affects:
  - src/channels/peer-recent-message.ts
  - test/channels/peer-recent-message.test.ts
---
```

**Context:** Post-merge deploy follow-up #6 (scope the dotfiles `live-update-reminder` hook to the parallel-join marker instead of any present peer) must read a present peer's most-recent `status` BODY to test for the marker. The two existing `peer-recent-message` helpers (`getMostRecentPeerKind` / `getMostRecentPeerMessageOfKind`) return `{ kind, ts }` only — no body. A body-returning helper is required; the open questions were its public surface (where exported / curated) and its body-resolution semantics.

**Options considered:**

1. **New sibling `getMostRecentPeerMessageWithBody`, exposed via the module's existing `./channels/peer-recent-message` subpath — no `api.ts` curation (CHOSEN).** Refactor the private `tailScanForPeer` to return the matched `ChannelMessage`; the two kind-variants project `{ kind, ts }` (ZERO behavior change); the new variant resolves the body (inline, or `body_ref` via `readBodyFile`, with `body_read_error` on failure).
2. Curate the new fn in `api.ts` per Option-R's "new exported fn → api.ts curation + paired-contract test." Rejected: the module's two existing siblings are NOT in `api.ts` — the dotfiles consumer imports them directly from `claude-conductor/channels/peer-recent-message`; adding only the third to `api.ts` is a one-of-three inconsistent surface, and no CI gate enforces api.ts curation. Option-R's intent (a guarded cross-edge contract) is met here by the stable subpath export + the in-repo test importing via that path.
3. Overload `getMostRecentPeerMessageOfKind` with an optional `includeBody` flag. Rejected: violates the module's explicit sibling-not-optional-param convention (caller-intent stays explicit at the use site).

**Chosen:** Option 1. (Subpath surface flagged to Alpha on-channel for the post-PR audit; Delta independently converged on the same subpath consumption before the note — not yet an explicit Alpha ratification.)

**Reason:** The `peer-recent-message` module predates Option-R and already established direct-subpath consumption, so the smallest correct surface is a third sibling on the same subpath — consistency with the module's actual pattern beats literal Option-R compliance. Body resolution mirrors the channel read path so the helper stays correct for large (`body_ref`) bodies too, not only the small inline marker #6 needs.

**Operationalized:** `getMostRecentPeerMessageWithBody(channelId, peerSessionId, kindFilter) -> { kind, ts, body, body_read_error? } | null`; READ-ONLY (at most one extra `readBodyFile`; zero writes, zero locks). Delta wires the dotfiles #6 consumer against the subpath import. The test sandbox was migrated `/tmp+pid -> mkdtemp+tmpdir` (FINDING-1 class) in the same PR per the Alpha + Bravo deconfliction (the file was out of #5 scope).
