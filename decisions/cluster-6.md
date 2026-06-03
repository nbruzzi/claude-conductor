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

---

## 2026-06-02 — Decision D: `whoami-active` channel-auto-discovery verb (Arc A)

```yaml
---
ts: 2026-06-02T13:15:00Z
kind: api-shape
severity: minor
phase: cluster-6
affects:
  - src/channels/cli.ts
  - src/cli/flags.ts
---
```

**Context:** The statusline (and the future permission-relay router) needs to answer "which NATO identity does THIS session hold, and on which channel" without knowing the channel id ahead of time. The existing `whoami <channel-id>` requires the caller to name the channel; the statusline worked around this by iterating `~/.claude/channels/*/metadata.json` in user-side bash — plugin-owned schema knowledge leaking into a dotfile (backlog L124, Arc A).

**Options considered:**

1. **New `whoami-active` verb that auto-discovers the channel, reusing the already-exported `getIdentityForSession` per channel (CHOSEN).** No channel-id arg; `--session-id` (CLAUDE_SESSION_ID fallback); `--json`/bare; always exit 0 with `null`/empty on no-claim.
2. Extract a new `findActiveIdentity(sessionId)` helper into `identity.ts` + curate via `api.ts`, with the verb as a thin wrapper. Rejected for v1: a new exported helper triggers the "reuse isn't free" cost (api.ts curation + the dotfiles shim-mirror per `feedback-substrate-shim-mirror-on-plugin-export-changes`) for no current cross-edge consumer — the verb's logic is ~25 lines and the item's acceptance criteria are CLI-level. Mirror of Charlie's NF-1 on PR #187 ("already built != already reachable"): here the smallest correct surface is to reuse what is ALREADY reachable.
3. Harden the inline statusline bash instead. Rejected: the whole point of L124 is to STOP reimplementing plugin schema in user-side bash.

**Chosen:** Option 1.

**Reason:** Reusing `getIdentityForSession` (already on the curated surface) means zero new exports → zero shim-mirror obligation → smallest correct change. The double metadata read (`listChannels` + per-channel `getIdentityForSession`) is acceptable for the small-N statusline use (~10–50ms/tick per the item's perf note); `listChannels`'s split try/catch already skips malformed channels, so a bad metadata.json never breaks the scan. The verb is the canonical sibling of `whoami`.

**Operationalized:** `whoami-active [--session-id <uuid>] [--json]` in `src/channels/cli.ts`; `sessionId` added to `FlagSpec` / `FlagValues` / `DEFAULT_SPEC` + a `--session-id` value-flag branch in `parseFlags` (mirrors `--from-session` via `consumeStringValue`). **Deterministic multi-channel tiebreak:** most-recent by `lastMessageTs`, fallback `joined_at`, then `channel_id` — never filesystem-enumeration-order-dependent (documented at the call site + pinned by a test). **Clean-null contract:** no resolvable session-id OR no claim → `null` (`--json`) / empty (bare) + exit 0 (a statusline must never see an error). 7 subprocess tests + a docs page (`docs/conventions/statusline.md`). The dotfiles `statusline-command.sh` swap is an atomic-paired sibling DEFERRED until this verb is GA on origin/main (don't deprecate the inline before the plugin verb lands).

---

## 2026-06-03 — Decision E: `messages.jsonl` rotation — mode-A full-rename (concurrency-safety inversion)

```yaml
---
ts: 2026-06-03T14:35:00Z
kind: architectural
severity: major
phase: cluster-6
affects:
  - src/channels/index.ts
  - src/audit/verify.ts
  - src/channels/cli.ts
  - src/bandwidth/cli.ts
  - src/audits/cli.ts
  - src/audit/cli.ts
  - src/reciprocation/cli.ts
  - src/hooks/checks/channels-gc-reaper.ts
---
```

**Context:** The fixed-eternal `coordination` channel's `messages.jsonl` grows unbounded (this cluster's archival-exemption removed the per-cycle whole-channel archival that used to bound it), degrading every full-scan reader. The design (`plans/messages-jsonl-rotation-design.md`, Delta) left the verdict-chain handling as a build-time mode-2 decision: (A) archive everything incl. verdicts + teach the verifier to read archives, vs (B) keep verdicts live + archive only the non-verdict prefix.

**Options considered:**

1. **Mode-A — whole-file atomic rename; the verifier (+ all full-history readers) span the boundary (CHOSEN).** `rotateChannelMessages` seals the live file into `messages.<seq>.archive.jsonl` via one `renameSync`; readers opt in via `readMessages({ includeArchive })`.
2. Mode-B — keep verdicts live, archive only the non-verdict prefix (the design's density-preferred option — verdicts are only ~2.3% of messages). Rejected: it requires a scatter-gather REWRITE of `messages.jsonl`, which races the lockless O_APPEND hot path and drops concurrent cross-process appends (a dropped verdict breaks the signature chain; a dropped claim breaks coordination). `withMetadataLock` guards metadata only — it cannot serialize appends.
3. `tail`-truncate (destructive). Rejected upstream in the design: loses the verdict chain + history.

**Chosen:** Option 1 (mode-A).

**Reason:** Appends are lockless O_APPEND (`appendLineAtomically` opens by path per call). A whole-file `renameSync` is the ONLY mutation that is zero-loss under that hot path — a racing appender either lands its write in the just-sealed archive inode (in append-order) or O_CREATs a fresh live file. A partial rewrite (mode-B) cannot be made safe without putting a lock on the append hot path. The concurrency constraint INVERTS the design's verdict-density preference: density (2.3%) favored B, but only A is concurrency-safe. Ratified on the cohort `coordination` channel (Alpha merge-gate); Delta (design author) absent this cohort.

**Operationalized:**

- `rotateChannelMessages(id, { thresholdBytes? })` — O(1) `statSync` pre-check, then a re-check INSIDE `withMetadataLock` (TOCTOU; serializes concurrent rotations) before the `renameSync`. `seq` = max-existing + 1.
- `readMessages(id, { includeArchive? })` — default live-only (bounded → the perf win for hot full-scan readers); `includeArchive` spans `messages.*.archive.jsonl` (seq-asc) + live in append-order. `readMessagesTail` / `readMessagesAfter` / `lastMessageTs` span the boundary.
- All 6 full-history readers opt into `includeArchive` (audit verifier, channels `read` verb, bandwidth/audits/audit/reciprocation analytics), preserving whole-history semantics — a no-op until a rotation exists.
- The SessionStart gc-reaper trigger is OPT-IN via a `.rotation-enabled` flag, default OFF (live-substrate sequencing: a `tail -f` Monitor follows by descriptor and would go silent after the rename; enable only once cohort Monitors follow by name with `tail -F`). Flag-absence doubles as the kill-switch. Tunable threshold (default 4 MB).

**Audit cadence:** mode-2 design audit on-channel (the concurrency finding was its output) → Alpha merge-gate ratify → 2 pre-squash pressure-tests addressed: (1) full `readMessages` caller-set audit + per-caller classify; (2) no glob collision with the whole-channel `.archive/` mechanism (`messages.<seq>.archive.jsonl` is matched only by `MESSAGE_ARCHIVE_RE`). PR #189.

**Merge-gate fold (CRITICAL — raw-path reader class):** the merge-gate's layer-spanning lens caught what BOTH `readMessages`-caller audits (build + consumer-lens) missed — a SHARED BLIND SPOT: both grepped the `readMessages` family, so 5 readers that touch `messages.jsonl` via a RAW `readFileSync` were invisible. The CRITICAL was the verdict-chain CONSTRUCTOR (`audit-verdict-auto-wrap.ts lookupPriorAuditVerdictPayload`): reader-only archive-awareness left a reader/WRITER asymmetry — post-rotation the writer would find no prior in the reset live file and bootstrap `prev_audit_body_ref:null`, manufacturing the exact chain break this slice prevents. Fixed by routing all 5 raw readers (the chain constructor + the pattern-trace/lexicon analytics + the peer-message-deliverer cursor + the peer-recent-message tail-scan) through a new `listChannelArchiveFilePaths` helper / `readMessagesAfter`. Lesson: audit the DATA (every `messages.jsonl` toucher) not one API family — and a verdict chain has a WRITER, not just a reader. (Generalized into Alpha's §2 "lenses must span layers" proposal, same cycle.)

**Supersedes / superseded_by:** Additive — extends this cluster's eternal-channel substrate; supersedes nothing. The `messages.<seq>.archive.jsonl` convention is new on-disk state.

---

## 2026-06-03 — Decision F: `check-import-failed` telemetry PresenceFailureKind (#8b per-check isolation observability)

```yaml
---
ts: 2026-06-03T16:00:00Z
kind: api-shape
severity: minor
phase: cluster-6
affects:
  - src/shared/presence-failure-log.ts
---
```

**Context:** #8b per-check import-isolation (`registerCrossEdge`, dotfiles `bundled-registrations.ts`) emits a LOUD R4 stderr breadcrumb when a DIRECT-cross-edge check's dynamic import fails and the check is skipped — the operator-facing "DISARMED" safety notice. That breadcrumb lives only in transient stderr; it is not queryable in the presence-failure log alongside the other coordination fail-soft events.

**Chosen:** Add `"check-import-failed"` to the `PresenceFailureKind` union + the `isPresenceFailureKind` runtime validator. The dotfiles `registerCrossEdge` catch emits it (source `"dispatcher"`, null sessionId at registry-build) ALONGSIDE the unchanged R4 stderr — the dotfiles-side emit is a separate cross-edge follow-up PR.

**Reason:** Telemetry-only + purely additive — no behavior change. The R4 stderr breadcrumb REMAINS the safety control; this structured kind only makes the per-check skip queryable in the presence-failure log rather than living solely in stderr. It instruments already-decided #8b isolation behavior (the isolation + R4 breadcrumb-tiering were the decisions, prior cycle); this is observability, not a new architectural call. Mirrors the established telemetry-kind growth pattern (Phase-3 worktree-lifecycle + Slice-7 provisioner-telemetry kinds).

**Supersedes / superseded_by:** Additive — extends the `PresenceFailureKind` union; supersedes nothing.

---

## 2026-06-03 — Decision G: audit-target generalization to discriminated `AuditTarget` (#3b)

```yaml
---
ts: 2026-06-03T18:50:00Z
kind: api-shape
severity: load-bearing
phase: cluster-6
affects:
  - src/channels/audit-types.ts
  - src/channels/audit-ask.ts
  - src/channels/audit-verdict.ts
  - src/channels/api.ts
  - src/audit/quorum.ts
  - src/audits/queue.ts
  - src/reciprocation/graph.ts
  - src/channels/render.ts
  - src/channels/substrate-class.ts
  - src/channels/cli.ts
---
```

**Context:** `audit-ask`/`audit-verdict` bodies targeted PRs only (`target_pr: {repo, number}`). Plan-gates (auditing a plan document rather than a PR) had no first-class target, so they abused `kind=note` as a workaround — losing the audit-discipline schema (lens-set, axes, verdict, three-option-ask) for an entire class of audits. #3 (Nick: DONE before wind-down) closes this.

**Chosen:** Generalize the body target to a discriminated union `AuditTarget = {kind:"pr"; repo; number} | {kind:"plan"; ref}` in `audit-types.ts`, with helpers `parseAuditTarget` (wire → union, enforces EXACTLY-ONE of `target_pr`/`target_plan`), `auditTargetToWire`, `sameTarget`, `auditTargetKey` (pairing / dedup by target identity). Migration is ADDITIVE per Alpha's right-size (not a D2 full-replace): bodies gain a REQUIRED `target: AuditTarget` plus a TRANSITIONAL-OPTIONAL `target_pr?` (back-compat for in-flight wire during the cohort migration window). PR-only consumers (quorum, queue, reciprocation pairing, the cli substrate-class gate) narrow-and-skip plans via `if (target.kind !== "pr") continue` — full plan-handling in those analytics is DEFERRED (Golf files the backlog item). `render.ts` labels `plan:<ref>` vs `PR#<n>`. `isSubstrateClassTarget` returns false for plan targets (a plan is never substrate-class).

**Reason:** Additive-over-replace surfaces every consumer through the typechecker the moment `target_pr` becomes optional — the optional-field break IS the migration checklist (10 production consumers, all visited). Deferred consumers MUST read the narrowed `target` (not raw `target_pr?`), because two plan-target bodies would `undefined === undefined` false-match on `target_pr` in pairing — the narrowing guard is load-bearing, not cosmetic. Right-sizing to additive (keep `target_pr?`) over D2 full-replace keeps the wire backwards-compatible for the live cohort per live-substrate-sequencing; the optional field is removed in a later cut once no in-flight `target_pr`-only wire remains. The `kind=note` plan-gate workaround is deprecated in favor of the first-class plan target.

**Audit cadence:** Golf design-authority + ratified spec (`~/.claude/plans/audit-target-generalization-design.md`); Echo build (this PR); Foxtrot + Golf lenses requested on-channel post-push.

**Supersedes / superseded_by:** Additive — extends the audit-discipline body schema (`AuditAskBody` / `AuditVerdictBody`). Deprecates the `kind=note` plan-gate workaround (not yet removed; superseded-in-practice once consumers adopt `target:{kind:"plan"}`). The transitional `target_pr?` optional field is scheduled for removal in a follow-up cut.

**Fold absorption (Alpha + Golf convergent SHIP-WITH-FOLDS, 2026-06-03):** absorbed into this PR before merge. (HIGH-2) the new schema surface is now tested — `parseAuditTarget` exactly-one matrix + `auditTargetToWire` roundtrip + `sameTarget` + `auditTargetKey` (audit-types.test.ts), a plan-kind body through both `parseAuditVerdictBody` + `parseAuditAskBody` (Section 3b each), and a `plan:<ref>` render assertion. **Serialize-side roundtrip fix:** the parser returns now spread `...auditTargetToWire(target)` (emit `target_pr` OR `target_plan`) instead of the prior pr-only conditional — a plan body re-serializes WITH `target_plan`, so it roundtrips through `canonicalJson` → wrap → parse. This independently CONVERGES with Golf's forward-catch (the serialize-wiring gap): the auto-wrap plan-roundtrip test (Section 17) made it non-deferrable, so serialize-correctness is IN this PR, not the deferred fast-follow. The deferred fast-follow now retains ONLY the `--target-plan` CLI flag + the queue/quorum/reciprocation full plan-handling. `isSubstrateClassTarget` added to the api.ts surface (the 6th export) for the Alpha-owned dotfiles shim mirror (HIGH-1, sequenced post-merge + canonical-sync).
