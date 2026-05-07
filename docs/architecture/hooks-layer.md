<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Hooks layer — operator mental model

How `claude-conductor`'s hook checks compose at runtime. This doc is the operator's reference for: which hooks fire when, how their outputs concatenate, what their failure modes are, and how to disable or override them.

Phase 1 shipped 17 hook checks; Phase 2 adds 4 (Slices 4–7). This doc covers both phases. Each new hook slice MUST update this doc as part of its commit.

## Phase 2 status

This doc ships with Phase 2 Slice 4.5 (cut from `phase-1-lane-b-binary` post-`v0.1.0-phase-1`). Phase 2 hook entries below are pending until each slice ships:

| Slice | Hook                     | Status  |
| ----- | ------------------------ | ------- |
| 4     | `channels-gc-reaper`     | PENDING |
| 5     | `identity-injector`      | PENDING |
| 6     | `task-coordinator`       | PENDING |
| 7     | `teammate-idle-reminder` | PENDING |

This file's "PENDING" entries are placeholders. As each slice ships, the row above flips to "SHIPPED <commit-sha>" and the §Hook catalog below gains the concrete entry.

---

## Firing order

Hooks fire in registry-determined order, NOT lexically. The registry is `src/hooks/bundled-check-names.ts:BUNDLED_CHECKS_BY_EVENT` — the array order per event is the firing order.

Current order (Phase 1 v0.1.0-phase-1 + Phase 2 placeholders):

**Cluster 1 of INVERSIONS arc (2026-05-07):** 9 universal-coding-discipline checks (`auto-format`, `branch-enforcement`, `destructive-cmd`, `no-any`, `no-enum`, `pre-commit`, `prefer-bun`, `sensitive-files`, `test-gate`) moved to substrate (`~/.claude-dotfiles/src/hooks/checks/`); they run from substrate's bundled-registrations layer, NOT plugin's. Plugin's bundled-registrations now owns only multi-instance-coordination machinery.

### `pre-tool-use` (plugin-canonical post-Cluster-1)

1. `session-collision-gate` — refuses tool dispatch when another active session conflicts.
2. `handoff-symlink-write-guard` — blocks writes to handoff symlinks.
3. `fact-force` — enforces fact-force scope.
4. `config-protection` — protects `~/.claude/` config from accidental overwrites.
5. `task-coordinator` (Phase 2 Slice 6) — gates Task tool dispatch on channel role.
6. `ci-verification-pre-push-arm` — TIER 4 sentinel for `git push` ground truth.

### `post-tool-use` (plugin-canonical post-Cluster-1)

1. `ci-verification-reminder` — emit reminder after `git push`.

### `stop` (plugin-canonical post-Cluster-1)

1. `ci-verification-gate` — TIER 2 block on shipped/merged claims without CI evidence.
2. `handoff-latest-guard` — verifies LATEST.md symlink integrity.
3. `session-presence-unregister` — drops session from active-sessions registry.
4. **(Phase 3 Slice 2):** `dotfiles-worktree-cleanup` — fires BEFORE `session-presence-unregister` per array order; removes the per-session dotfiles worktree, calls `unregisterActiveSession` (RE-3 self-heal — explicit, not relying on downstream unregister), and clears the heartbeat-body sentinel. RE-104 reconciliation guard. CLI-DX-5 epilogue points operators at runbook §"Working from a second terminal".

### `session-start`

1. `channel-gc` — Phase 1 channel-archive gc.
2. `active-channels-load` — Phase 1 active-channels surfacing.
3. `session-presence-register` — registers session in active-sessions registry.
4. **(Phase 2 Slice 4):** `channels-gc-reaper` — Phase 2 sentinel/metadata reconciliation reaper.
5. **(Phase 2 Slice 5):** `identity-injector` — Phase 2 NATO-identity context surface.
6. **(Phase 3 Slice 2):** `dotfiles-worktree-provisioner` — feature-flag-gated per-session worktree provisioner. Anchor-pins canonical-claude-home heartbeat (REV 0.2 ARCH-1). RE-105 soft-ceiling reminder + RE-8 mixed-flag-state warning.
7. **(Phase 3 Slice 2):** `dotfiles-worktree-gc` — orphan reaper for per-session worktrees. RE-102 single-threshold staleness (`GC_WINDOW_MS` = 60min). RE-103 mtime-filtered safety guards. RE-3 self-heal triple. Forensic-marker escape hatch. 5-min rate-gate cursor.

### `user-prompt-submit`

1. **(Phase 2 Slice 7, PENDING):** `teammate-idle-reminder` — surfaces idle peers on prompt submission.

Phase 2 hooks are appended to existing arrays — new hooks fire AFTER all Phase 1 hooks for the same event. Reordering existing hooks is out of scope for Phase 2.

---

## system-reminder composition

When N hooks fire on the same event and emit `system-reminder`-class output, the dispatcher concatenates the outputs in firing order with `\n\n---\n\n` separators. Each hook's output is one block.

Operator mental model: each `\n\n---\n\n`-separated block in a SessionStart message is one hook's output. The block order matches the firing order above.

There is NO per-hook header or footer. Each hook is responsible for self-identifying its output via a leading `[<source>]` tag (convention from `active-channels-load.ts:32` `const SOURCE = "active-channels-load"` style). Phase 2 hooks follow the same convention: `[task-coordinator]`, `[teammate-idle]`, `[gc-reaper]`. The identity-injector hook is the exception — its output is operator-facing context, not a debug-tagged note, so it omits the bracket prefix.

Maximum recommended hook output: 8 lines per fire. Operators reading SessionStart should be able to scan each block in 1-2 seconds.

---

## Failure-mode classification

Every hook MUST declare one of three failure-mode classes. The class shapes IO-error behavior:

### fail-open silent

IO error → skip emission, NO breadcrumb. Used for low-priority informational hooks where a missing emission is fine and noise should not accumulate in the failure log.

**When to use:** read-only informational hooks where absence-of-output is acceptable.

**Phase 1 examples:** `channel-gc` (best-effort archive cleanup).

### fail-open + breadcrumb

IO error → skip emission, log via `appendPresenceFailure` with `source: "<hook-name>"` and a `kind` describing the failure class.

**When to use:** default for read-path hooks. Operators can debug via `~/.claude/presence-failures.jsonl` if behavior seems wrong.

**Phase 1 examples:** `active-channels-load` (read-side surfacing).

**Phase 2 examples:** `identity-injector`, `task-coordinator`, `teammate-idle-reminder` (all read-only operator-context hooks).

### fail-loud

IO error → emit a system-reminder error block + breadcrumb. Operator sees the failure inline AND the breadcrumb persists for forensics.

**When to use:** required for write-path hooks where operators MUST know reconciliation is in a degraded state.

**Phase 2 examples:** `channels-gc-reaper` (writes sentinel + metadata).

**Format for fail-loud emissions:**

```
[<source>] Failed to <operation>: <error>.
<one-line operator-actionable recovery hint>

(diagnostic) Breadcrumb: appendPresenceFailure source=<source> kind=<kind>
```

The `(diagnostic)` prefix on the breadcrumb line tells the operator the line is for forensics, not action.

---

## Per-hook recovery

Phase 2 hooks fail-soft (fail-open + breadcrumb) by design except for `channels-gc-reaper` (fail-loud — substrate corruption needs operator action). When a hook gets the operator into a wedged state, recovery is per-hook rather than via a global kill-switch — each hook owns substrate with different correctness implications, so a universal "disable all" toggle would be a footgun. The procedures below resolve the dominant wedge cases.

| Hook                     | Wedge symptom                                      | Recovery                                                                                                                 |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `channels-gc-reaper`     | Persistent stuck-orphan breadcrumbs                | `claude-conductor channels close-peer <id> --peer <Identity> --force` (releases the sentinel).                           |
| `channels-gc-reaper`     | Reaper logs settled but `.reaper-acked` marker old | `rm ~/.claude/channels/<id>/identities/.reaper-acked.<Identity>` (rare; the marker auto-clears on reap).                 |
| `identity-injector`      | Stale claim or cadence-cursor stuck                | `claude-conductor channels join <id>` (rejoin idempotently re-resolves the claim).                                       |
| `task-coordinator`       | Task tool blocked under a role you don't intend    | `claude-conductor channels set-role <id> --role pen` (rotate to pen-holder; reverses the block).                         |
| `teammate-idle-reminder` | Suspected stale-peer false positive                | `claude-conductor channels peers <id>` shows the underlying heartbeat ages; clock-skew breadcrumb is informational only. |
| `read --since-cursor`    | Cursor stuck on a since-cursor read                | `claude-conductor channels forget-cursor <id>` (resets cursor; next read bootstraps from full history).                  |

A dispatcher-level universal kill-switch (`CLAUDE_CONDUCTOR_DISABLE_HOOKS`) shipped in Phase 3 Slice 1 — see [`docs/operations/phase-3-kill-switch.md`](../operations/phase-3-kill-switch.md) for the operator runbook + composition rule + breadcrumb taxonomy. The per-hook recovery procedures in the table above remain the granular per-hook path; the kill-switch is the universal emergency-stop for multi-hook wedges.

**Cannot fail-open via skip (substrate-level invariants):**

- `pre-commit` (gate-of-record for the commit pipeline; opt-out via `--no-verify` flag at commit time only).
- `session-presence-register` / `session-presence-unregister` (substrate-level; sessions without registry presence break peer-coordination).

---

## Phase 1 ↔ Phase 2 hook composition

Phase 2's hooks read substrate that Phase 1 established. The composition rules:

1. **`active-channels-load` (Phase 1) fires before `identity-injector` (Phase 2)** on SessionStart. Operators see channel-existence first, then NATO-identity context. The order matters because identity-injector's output assumes the operator already knows which channels are active.

2. **`channels-gc-reaper` (Phase 2 Slice 4) reaps stale identity sentinels created via `claimIdentity` (Phase 1).** The reaper participates in the same `linkSync` ownership protocol — it OWNS the sentinel via linkSync before unlinking. See `~/.claude/plans/prismatic-orbiting-mesh.md §Slice 4` for the lock-domain spec.

3. **`task-coordinator` (Phase 2 Slice 6) reads `metadata.identities` populated by `claimIdentity` (Phase 1 Slice 2/2.1/2.2).** Sessions without claims are no-op (the dominant case for Task subagent dispatch outside any channel).

4. **`teammate-idle-reminder` (Phase 2 Slice 7) reads heartbeat mtime (Phase 1) AND heartbeat body timestamp (Phase 2 Slice 7 schema extension).** Backwards-compat: pre-Slice-7 heartbeats with empty body resolve via mtime-only; Slice-7+ heartbeats with `Date.now()` written into the body get clock-skew sanity checks.

5. **`identity-injector` cadence cursor at `<channel-dir>/identity-emit/<sid>.json`** is independent of Phase 1's substrate. The cursor lives alongside `last-seen/` (Slice 8) and `identities/` (Phase 1) sibling-directory pattern.

---

## Hook catalog

(Phase 1 + Phase 2 hooks summarized. Each entry: name, event, failure-mode class, one-line purpose, source link.)

### Phase 1

| Name                          | Event         | Failure mode           | Purpose                                               |
| ----------------------------- | ------------- | ---------------------- | ----------------------------------------------------- |
| `session-collision-gate`      | pre-tool-use  | fail-loud              | Block tool dispatch under conflicting active session. |
| `handoff-symlink-write-guard` | pre-tool-use  | fail-loud              | Refuse writes to handoff symlinks.                    |
| `fact-force`                  | pre-tool-use  | fail-loud              | Enforce fact-force scope.                             |
| `config-protection`           | pre-tool-use  | fail-loud              | Protect `~/.claude/` from accidental overwrites.      |
| `handoff-latest-guard`        | stop          | fail-loud              | Verify LATEST.md symlink integrity.                   |
| `session-presence-unregister` | stop          | fail-open + breadcrumb | Drop session from active-sessions registry.           |
| `channel-gc`                  | session-start | fail-open silent       | Best-effort channel-archive gc.                       |
| `active-channels-load`        | session-start | fail-open + breadcrumb | Surface live channels on SessionStart.                |
| `session-presence-register`   | session-start | fail-open + breadcrumb | Register session in active-sessions registry.         |

### Phase 2 (PENDING — entries finalized at slice-ship time)

| Name                     | Event              | Failure mode           | Purpose                                                            |
| ------------------------ | ------------------ | ---------------------- | ------------------------------------------------------------------ |
| `channels-gc-reaper`     | session-start      | **fail-loud**          | Reconcile metadata.identities ↔ sentinels with own-before-unlink.  |
| `identity-injector`      | session-start      | fail-open + breadcrumb | Surface NATO identity + role + peer context for claimed channels.  |
| `task-coordinator`       | pre-tool-use       | fail-open + breadcrumb | Gate Task tool dispatch on channel role (block out, warn queue).   |
| `teammate-idle-reminder` | user-prompt-submit | fail-open + breadcrumb | Surface idle peers (heartbeat-stale) with clock-skew sanity check. |

---

## Debugging

Every hook event end-to-end is observable via:

1. **`appendPresenceFailure` log:** `~/.claude/logs/.presence-gate-failures.log` (JSONL). Filter by `source: "<hook-name>"` (or `source: "channels-identity"` for the channels-identity hook category). Each entry has timestamp, kind, sessionId (if known), and detail. Tail with `tail -f ~/.claude/logs/.presence-gate-failures.log | jq .`.
2. **system-reminder output:** captured in the agent's session transcript at `~/.claude/projects/<project>/<sid>.jsonl`. Search for `[<source>]` tags.
3. **Per-hook recovery to isolate:** if a hook is wedged, run the per-hook recovery procedure from §Per-hook recovery above and re-run; if the symptom resolves, that hook owned the issue.

For Phase 2 hook-specific debugging, see also:

- `claude-conductor channels peers <channel-id>` — current peer state (heartbeat ages, roles).
- `claude-conductor channels meta <channel-id>` — full metadata.json including `identities` map.
- `claude-conductor channels list --include-archived` — channel inventory.

---

## Adding a new hook (post-Phase-2)

Phase 3+ hook authors: this is the canonical add-a-hook checklist:

1. New file under `src/hooks/checks/<hook-name>.ts`. Follow `active-channels-load.ts` style.
2. Add export entry to `package.json:exports`: `"./hooks/checks/<hook-name>"`.
3. Append name to `src/hooks/bundled-check-names.ts:BUNDLED_CHECKS_BY_EVENT[<event>]` array.
4. Register in `src/hooks/checks/bundled-registrations.ts` with import + `Registry.register` call.
5. **Cross-edge atomic-wiring:** parallel commit on dotfiles' `src/hooks/checks/bundled-registrations.ts` per `feedback-atomic-wiring-discipline.md`. Both repos must update in lockstep or CI parity check fails.
6. Update this doc:
   - Add row to §Hook catalog.
   - Add slot to firing order under the appropriate event.
   - If it's a write-path hook, declare fail-loud + describe the recovery flow.
   - If it composes with existing hooks in non-obvious ways, document under §Phase N ↔ existing hook composition.
7. Add tests under `test/hooks/checks/<hook-name>.test.ts`.

The doc-update step (6) is non-optional — operators rely on this catalog for mental model.
