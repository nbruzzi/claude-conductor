<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# GC-fallback symmetry audit — 2026-05-18

**Filed:** 2026-05-18 by Bravo (slice 7 / B4 / vault backlog L945)
**Trigger:** Slice 6 PR #86 squash `b732e35` added `sidPrefixHasLiveAnchor` fallback to `dotfiles-worktree-gc.ts` after the 2026-05-18 Charlie-spawn incident (`feedback-worktree-provisioner-reaps-live-siblings.md`). The fix was specific to one GC path; this audit asks whether sibling GC loops have analogous risk.
**Plan anchor:** `~/.claude/plans/glimmering-tracking-magpie.md` §B4.

## Scope

Plugin (`claude-conductor`) + Dotfiles (`claude-dotfiles`) only. Per slice 7 plan v2 Q4 disposition: extension / 3rd-party hooks are operator responsibility — they do not share substrate state with our GC loops, so symmetry analysis does not extend there.

Audit covers every GC / reaper / sweeper that decides "is this thing alive?" before mutating disk state.

## Verdict summary

| Path                                | Liveness primitive                                                                                                | Raw-vs-realpath risk           | Sentinel-overwrite risk        | Recommended fallback             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------ | -------------------------------- |
| `dotfiles-worktree-gc.ts`           | path-keyed map (`byDotfilesRoot`)                                                                                 | **YES (already fixed PR #86)** | **YES (already fixed PR #86)** | `sidPrefixHasLiveAnchor` shipped |
| `channels-gc-reaper.ts`             | sentinel-vs-metadata-row reconciliation (per-channel)                                                             | NO                             | NO                             | Not applicable                   |
| `channel-gc.ts`                     | composite age check (closed_at / lastMessageTs / created_at / newestHeartbeatMtime) keyed on `channelId` (string) | NO                             | NO                             | Not applicable                   |
| `active-sessions/index.ts` GC sweep | `statSync(heartbeat_path).mtimeMs` keyed on `(artifactId, sessionId)`                                             | NO                             | NO                             | Not applicable                   |

**Headline:** the byDotfilesRoot risk class is unique to `dotfiles-worktree-gc.ts`. No other GC loop in plugin or substrate uses a path-resolved liveness map that can drift raw-vs-realpath. The slice-6 fix is sufficient at the substrate's current GC surface.

## Per-path detail

### 1. `src/hooks/checks/dotfiles-worktree-gc.ts` — already fixed

**Liveness primitive:** at `:113`, `mapByDotfilesRoot(anchors)` builds a `Map<resolvedDotfilesRootPath, HeartbeatListing>` from anchor heartbeats. Each worktree path is looked up against this map; absence + age > GC_WINDOW_MS (60min) triggers reap.

**Failure modes the fix closes:**

- **Raw-vs-realpath drift:** the map key uses `realpathSync(dotfilesRoot)` at write time but `dotfilesRoot` is read raw at heartbeat-write-time. macOS `/private/var/…` symlink chains cause raw + realpath to diverge → map lookup misses even for live sessions.
- **Heartbeat overwrite wiping the sentinel:** if the `dotfilesRoot` field is dropped during a heartbeat overwrite without being re-set, the heartbeat record never enters `byDotfilesRoot`; the worktree's owning session is invisible to the map even when alive.

**Fix (PR #86 squash `b732e35`):** `sidPrefixHasLiveAnchor` scans anchors for a heartbeat whose `sessionId` starts with the worktree's 8-char `sid-prefix` AND whose ageMs is fresh. Fires BEFORE the reap; emits a `worktree-gc-liveness-fallback-fired` breadcrumb to presence-failure-log. Defense-in-depth, not root-cause; the breadcrumb is the diagnostic that will inform a Phase 1 root-cause fix.

**Symmetry analysis:** the fix is correctly scoped. Adding the fallback to other GC paths would NOT close any risk (they do not use path-keyed liveness — see below) and would add noise to the presence-failure-log.

### 2. `src/hooks/checks/channels-gc-reaper.ts` — not applicable

**Liveness primitive:** at `:296` (`reapChannel`), uses `markPhase` to reconcile identity SENTINELS against `metadata.identities` rows for a SINGLE channel. The decision is "does this metadata row name a sentinel that exists on disk?" — not "is this session alive?"

**Why not at risk:**

- No path-resolved map. Lookup is `metadata.identities[letter] → sentinelPath(channelId, letter)`. Both inputs are scoped inside the channel dir; no external path resolution.
- Sentinel-overwrite irrelevant: identity sentinels carry no session-liveness signal; they are claims. The GC reconciles claims vs sentinels, not sessions vs heartbeats.
- The `redactHome` discipline on operator-facing summary lines (`:217`) is orthogonal — addresses path leakage in transcripts, not liveness misclassification.

**Recommendation:** no fallback. The risk class does not apply.

### 3. `src/hooks/checks/channel-gc.ts` — not applicable

**Liveness primitive:** `isStale(ch, now)` at `:90` composes multiple age signals:

- `closed_at + EMPTY_ABANDONED_MS` (closed channels)
- `lastMessageTs + STALE_LAST_MESSAGE_MS` (active channels)
- `created_at + EMPTY_ABANDONED_MS` (empty + abandoned)
- `newestHeartbeatMtime(ch.id) + STALE_HEARTBEAT_MS` (channel-wide heartbeat liveness)

**Why not at risk:**

- All keys are `channelId: string` — a stable identifier from `metadata.json`, not a resolved filesystem path. No raw-vs-realpath surface.
- `newestHeartbeatMtime` scans every heartbeat inside the channel dir and returns the newest mtime. Even if a single heartbeat record drops a `dotfilesRoot` sentinel (sentinel-overwrite), the heartbeat FILE still exists and its mtime still surfaces.
- Multi-signal composition is fault-tolerant: a single failing primitive does not silently flip "alive" → "stale". You need all four signals to read stale before reap fires.

**Recommendation:** no fallback. The risk class does not apply.

### 4. `src/active-sessions/index.ts` GC sweep — not applicable

**Liveness primitive:** at `:619-625` and `:763-768`, the GC sweep walks heartbeat files and reaps via `tryReapHeartbeat(artifactId, sessionId, path)`. Decision is `ageMs > GC_WINDOW_MS` where `ageMs` derives from `statSync(path).mtimeMs`.

**Why not at risk:**

- Path is constructed from `heartbeatPath(artifactId, sessionId)` — both inputs are STRING keys, not resolved filesystem paths. No symlink resolution involved.
- Heartbeat file mtime is the canonical liveness signal; touching the heartbeat updates mtime via the kernel, independent of any sentinel content.
- Even if the heartbeat BODY is overwritten (sentinel-overwrite class), the FILE mtime updates on every touch. Sweep reads mtime, not body.

**Recommendation:** no fallback. The risk class does not apply.

## Why the byDotfilesRoot class is unique

The shape that makes `dotfiles-worktree-gc.ts` vulnerable:

1. **Out-of-band identifier** — worktree paths are constructed by an external system (the dotfiles-worktree provisioner) and stored as filesystem paths, not as opaque IDs.
2. **Path-keyed map** — the GC builds a `Map<path, heartbeat>` for the liveness lookup.
3. **Realpath resolution at write time** — heartbeats persist `realpathSync(dotfilesRoot)` (a derived form), but worktree dir names use the raw form. Drift between the two breaks the map lookup.

No other GC loop matches all three properties. Channels-gc-reaper uses opaque-identifier metadata rows. Channel-gc uses string `channelId` keys. Active-sessions GC uses `(artifactId, sessionId)` string keys.

The sid-prefix fallback is the right tool for property (1) + (2) + (3); applying it elsewhere would be cargo-cult, not defense-in-depth.

## When to re-audit

Re-fire this audit when ANY of the following lands:

- A new GC loop or reaper or sweeper in plugin or substrate (whether a check, a CLI verb, a Stop hook, or otherwise).
- An existing GC loop adds a path-keyed liveness map (especially with realpath resolution at one end).
- A second live-state-reaped incident in any GC path beyond the slice-6 worktree-gc one.
- A Phase 1 GC-discipline refactor pass.

Trigger conditions encoded at vault backlog L945. Cross-reference: `feedback-worktree-provisioner-reaps-live-siblings.md` (the original incident memory), `feedback-substrate-fix-pattern-must-self-mirror.md` (the discipline that this audit ratifies).

## Disposition

**No code changes required.** The slice-6 substrate fix is correctly scoped. This audit is the deliverable; future GC additions should reference this doc when answering "does the new path need a sid-prefix fallback?"
