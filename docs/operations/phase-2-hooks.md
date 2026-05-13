<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Phase 2 hooks — operator runbook

Phase 2 ships 4 integration hooks (Slices 4–7), the heartbeat-body timestamp schema extension (Slice 7), and the `--since-mtime` / `--since-cursor` cursor substrate (Slice 8) with companion `forget-cursor` / `show-cursor` verbs. This runbook is the operator's reference for what fires when, what each new error means, where the breadcrumbs land, and how to recover when a hook gets the operator into a wedged state.

**Audience:** operators triaging Claude Code SessionStart / UserPromptSubmit / PreToolUse output, debugging stuck-orphan reports, or recovering a wedged channel.

**Prerequisites:**

- Phase 1 mental model: see `docs/architecture/hooks-layer.md` §Hooks layer — operator mental model for the firing-order and failure-mode-class taxonomy that Phase 2 layers onto.
- Channel + identity primitives: see `decisions/phase-1.md` for the NATO-identity / role taxonomy / `close-peer` recovery pattern.

---

## Hook firing order matrix

Hooks fire in lifecycle order, not lexically. The lifecycle order is fixed by Claude Code's hook event ordering; per-event firing order is set by `src/hooks/bundled-check-names.ts:BUNDLED_CHECKS_BY_EVENT` (array order = firing order).

```
SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop
```

Per-event order (Phase 1 + Phase 2 combined; **bold** = Phase 2):

### `session-start`

1. `channel-gc` — best-effort archive cleanup (Phase 1).
2. **`channels-gc-reaper`** — Phase 2 sentinel ↔ metadata reconciliation reaper.
3. `active-channels-load` — surface live channels (Phase 1).
4. `session-presence-register` — register session in active-sessions registry (Phase 1).
5. **`identity-injector`** — Phase 2 NATO-identity + role + peer-roster context.

(Source of truth: `src/hooks/bundled-check-names.ts:BUNDLED_CHECKS_BY_EVENT["session-start"]`.)

Order rationale: the reaper fires before `active-channels-load` so any stale orphan sentinel is reconciled before the channel inventory is surfaced — operators don't see a "live channel" briefing that includes peers the reaper would have just released. The injector fires last so its NATO + role + peer-roster context reflects post-reaper authoritative state.

### `user-prompt-submit`

1. **`teammate-idle-reminder`** — Phase 2 idle-peer reminder with clock-skew sanity check.

### `pre-tool-use`

1. `session-collision-gate` (Phase 1).
2. `handoff-symlink-write-guard` (Phase 1).
3. `fact-force` (Phase 1).
4. `branch-enforcement` (Phase 1).
5. `destructive-cmd` (Phase 1).
6. `prefer-bun` (Phase 1).
7. `pre-commit` (Phase 1).
8. `config-protection` (Phase 1).
9. `sensitive-files` (Phase 1).
10. **`task-coordinator`** — Phase 2 Task-tool dispatch role-gate.

Order rationale: `task-coordinator` fires last so it doesn't compete with substrate-correctness hooks (`session-collision-gate`, `pre-commit`) for the operator's attention. A `task-coordinator` block under `role=out` is a coordination signal, not a substrate violation.

### `post-tool-use`

No Phase 2 hooks.

### `stop`

No Phase 2 hooks.

---

## Phase 2 hook catalog

Each hook lists event, can-block, failure-mode class, breadcrumb kinds, and source/test paths.

### `channels-gc-reaper`

- **Event:** `session-start`
- **Can block:** No (informational; emits `system-reminder` text only)
- **Failure mode:** **fail-loud** for true orphan-unlink failures (operator-actionable); fail-open + breadcrumb for transient skip conditions (lock contention, metadata corrupt). The SessionStart chain is never broken.
- **Purpose:** sweeps orphan channel-identity sentinels (per-letter sentinel files under `<channel-dir>/identities/<letter>` with no matching `metadata.identities[<letter>]` entry). Genesis path is a `claimIdentity` that won the `linkSync` but crashed before `commitIdentityClaim` wrote metadata, OR a `closeStalePeerIdentity` whose metadata removal succeeded but sentinel-unlink failed (EACCES/EBUSY).
- **Race-against-claimIdentity guards:** mtime gate (90 s = 3 × `LOCK_STALE_MS`) + sweep-phase invariant re-check + `<letter>.reaper-acked` 7-day suppression marker (file lives at `<channel-dir>/identities/<letter>.reaper-acked`).
- **Breadcrumb kinds:** `lock-timeout` (mark/sweep/last-seen-prune lock-acquire failure), `write-failed` (sentinel-unlink or marker-write failure), `registry-contention` (transient skip on metadata read race), `unhandled` (catch-all for unexpected throws). All under `source: "channels-identity"`.
- **Rate-gate:** `REAP_INTERVAL_MS = 5 min`. Successive SessionStarts within 5 minutes short-circuit before the mark/sweep runs (cursor at `<channel-dir>/reap-cursors/cursor` tracks last-reap mtime — Step G renamed from `gc-reap/`; the rate-gate consults MAX(newMtime, legacyMtime) during the ≥30-day dual-read window).
- **Source:** [src/hooks/checks/channels-gc-reaper.ts](../../src/hooks/checks/channels-gc-reaper.ts)
- **Tests:** [test/hooks/checks/channels-gc-reaper.test.ts](../../test/hooks/checks/channels-gc-reaper.test.ts)

### `identity-injector`

- **Event:** `session-start`
- **Can block:** No
- **Failure mode:** **fail-open + breadcrumb**. Read failures (corrupt metadata, IO error) are caught and the per-channel emission is skipped; the outer try/catch returns a silent pass without an `unhandled` breadcrumb.
- **Purpose:** for each channel where this session has a NATO claim, emits one block with the assigned letter, current role, peer roster, and canonical CLI form for the four common coordination verbs (`whoami`, `set-role`, `send`, `peers`).
- **Cadence:** per-session cursor at `<channel-dir>/identity-emit-cursors/<sid>.json` records the last `(identity, role, peer-letter-set)` tuple emitted; emission is suppressed when the tuple is unchanged. This avoids spamming SessionStart with the same context every `/resume`. (Step G renamed from `identity-emit/`; reader falls back to the legacy path during the ≥30-day dual-read window.)
- **Breadcrumb kinds:** `write-failed` (cadence-cursor write failure). Under `source: "channels-identity"`. The hook does NOT emit `registry-contention` or `unhandled` — the outer catch returns pass silently.
- **Source:** [src/hooks/checks/identity-injector.ts](../../src/hooks/checks/identity-injector.ts)
- **Tests:** [test/hooks/checks/identity-injector.test.ts](../../test/hooks/checks/identity-injector.test.ts)

### `task-coordinator`

- **Event:** `pre-tool-use` (Task tool only — every other tool is a pass-through)
- **Can block:** Yes (under `role=out`)
- **Failure mode:** **fail-open + breadcrumb**. Read failures never block a Task dispatch; the breadcrumb is for forensics.
- **Purpose:** gates `Task` tool dispatches against this session's NATO role on every claimed channel.
  - `role=out` → hard-BLOCK (exit 2); subagent dispatches under `out` would produce file/channel side effects an observing-only role explicitly disallows.
  - `role=queue` → soft-warn (exit 0 + `system-reminder`); operator can still dispatch but is reminded another peer holds the pen.
  - `role=pen` → no emission.
- **Multi-channel:** if ANY channel reports `out`, block; else if ANY reports `queue`, warn (concatenating per-channel guidance).
- **No-claim sessions:** zero emission. Subagent dispatch outside any channel is the dominant case.
- **Breadcrumb kinds:** `registry-contention` (helper threw on `getIdentityContextForSession`). Under `source: "channels-identity"`. The hook does NOT emit an `unhandled` breadcrumb — the single try/catch wraps the helper call only.
- **Source:** [src/hooks/checks/task-coordinator.ts](../../src/hooks/checks/task-coordinator.ts)
- **Tests:** [test/hooks/checks/task-coordinator.test.ts](../../test/hooks/checks/task-coordinator.test.ts)

### `teammate-idle-reminder`

- **Event:** `user-prompt-submit`
- **Can block:** No
- **Failure mode:** **fail-open + breadcrumb**. An outer try/catch ensures a thrown helper never breaks the UserPromptSubmit chain.
- **Purpose:** for each channel where this session has a claim, surfaces idle peers (heartbeat-mtime older than `DEFAULT_IDLE_THRESHOLD_MS = 5 min`) so operators discover stuck/crashed siblings without manual `peers` queries.
- **Clock-skew sanity check:** before flagging a peer as idle, reads `readHeartbeatBody` (the peer's `Date.now()` written into the body at the same instant the kernel set mtime). If `|mtime − body_ts| > 5 min`, the divergence is suspected to be clock skew → reminder is suppressed and a `kind: "clock-skew"` breadcrumb is logged. Body=null (legacy peer pre-Slice-7 / corrupt) skips the skew check and treats mtime as authoritative.
- **Rate-limit:** per-(channel, observer-session) cursor at `<channel-dir>/idle-emit-cursors/<sid>.json` keyed by peer letter; emission is suppressed for 30 minutes after the last emission for that peer. (Step G renamed from `idle-emit/`; reader falls back to the legacy path during the ≥30-day dual-read window.)
- **Idle threshold tuning:** `CLAUDE_CONDUCTOR_IDLE_THRESHOLD_MS=<positive-integer-ms>` env var overrides the 5-min default. Validated by `/^\d+$/` regex pre-check + `Number.isFinite` + `Number.isInteger` + `n > 0`; invalid values silently fall back to the default with NO breadcrumb (operators reading the breadcrumb log will not see a misconfigured-env-var entry).
- **Breadcrumb kinds:** `clock-skew` (peer body-vs-mtime skew > 5 min — reminder suppressed), `write-failed` (rate-limit-cursor write failure). Under `source: "channels-identity"`. The hook does NOT emit an `unhandled` breadcrumb — outer try/catch returns pass without log.
- **Source:** [src/hooks/checks/teammate-idle-reminder.ts](../../src/hooks/checks/teammate-idle-reminder.ts)
- **Tests:** [test/hooks/checks/teammate-idle-reminder.test.ts](../../test/hooks/checks/teammate-idle-reminder.test.ts)

---

## Phase 2 CLI surface

Two new verbs and two new flags landed on `claude-conductor channels`. Both verbs target operator-facing recovery + introspection of the cursor substrate; both flags target programmatic consumers reading channel deltas across reads.

### `forget-cursor <channel-id>`

```
claude-conductor channels forget-cursor <channel-id> [--json]
```

- **Purpose:** reset this session's last-seen cursor on the channel. Subsequent `--since-cursor` reads will return full history (then bootstrap a fresh cursor on next read).
- **JSON shape:** `{kind: "cleared" | "absent" | "archived" | "error", channelId, sessionId, code?, detail?}`. `code` is `"EACCES" | "EBUSY" | "OTHER"` and `detail` is a human-readable string; both are present only on `kind: "error"`.
- **Idempotent:** running `forget-cursor` on a channel with no cursor returns `kind: "absent"`, exit 0. Repeating on a freshly-cleared channel returns `kind: "absent"`.
- **Exit codes:** 0 (always — the `kind` discriminator carries the recovery state, including `kind: "error"` on EACCES/EBUSY); 2 (ARGS — bad channel-id shape rejected by `requireChannelId`).
- **Recovery scenarios:**
  - "stuck cursor on a since-cursor read" → `forget-cursor <id>` resets; next read bootstraps from full history.
  - "running on an already-archived channel" → returns `kind: "archived"`, exit 0; safe no-op (archived channels don't have live cursors).

### `show-cursor <channel-id>`

```
claude-conductor channels show-cursor <channel-id> [--json]
```

- **Purpose:** print this session's last-seen cursor as JSON (for inspection before deciding whether to `forget-cursor`).
- **JSON shape:** `{kind: "present" | "absent" | "archived", channelId, sessionId, cursor?: {mtime: number, ts: string}}`. `cursor` is present only on `kind: "present"`; `mtime` is epoch ms; `ts` is ISO-8601 (the message timestamp the cursor advanced to).
- **Read-only:** does not mutate cursor state.
- **Exit codes:** 0 (always — `present` / `absent` / `archived`).

### `read --since-mtime <value>`

```
claude-conductor channels read <channel-id> --since-mtime <epoch-ms-or-iso-8601>
```

- **Value shape:** epoch ms (e.g. `1735689600000`) OR ISO 8601 (e.g. `2025-01-01T00:00:00Z`). Shape detection: any value matching `/^\d{4}-\d{2}-\d{2}/` is parsed as ISO; everything else is parsed as ms.
- **Filter:** returns messages where `Date.parse(msg.ts) > value`.
- **Mutual exclusivity:** passing both `--since-mtime` and `--since-cursor` is a hard error (exit 2 ARGS, "mutually exclusive" diagnostic).

### `read --since-cursor`

```
claude-conductor channels read <channel-id> --since-cursor
```

- **Bootstrap behavior:** first use on a channel returns full history with a stderr advisory (`[since-cursor] no prior cursor for <sid> on <channel-id>; reading full history (N messages). Subsequent --since-cursor calls will be incremental.`). Successful filtered reads advance the cursor.
- **Cursor location:** `~/.claude/channels/<channel-id>/last-seen-cursors/<sid>.json` with shape `{mtime: number, ts: string}`. (Step G renamed from `last-seen/`; reader falls back to the legacy path during the ≥30-day dual-read window.)
- **Mutual exclusivity:** see `--since-mtime`.
- **Cursor advance vs. read failure:** if the cursor write fails post-read, the read still returns its results (exit 0) but a `since-cursor write failed` breadcrumb is logged + a stderr warning surfaces. Subsequent `--since-cursor` calls will re-read the same range until the cursor write succeeds.
- **`--quiet` × `--json` matrix:** `--quiet` suppresses the stderr advisory; `--json` emits the message array as raw JSON. Combine for programmatic consumers (`--quiet --json`).

---

## Debug breadcrumbs via appendPresenceFailure

Every Phase 2 hook + the cursor write path participate in a shared breadcrumb log written by `appendPresenceFailure`.

- **Log location:** `~/.claude/logs/.presence-gate-failures.log` (JSONL — one event per line).
- **Per-line shape:** `{timestamp, sessionId, source, kind, artifactPath, detail}`. Paths are HOME-redacted to `~/...` form before write so the log can travel across hosts safely.

### PresenceFailureKind taxonomy

Six kinds. Each carries a different operator action:

| Kind                  | Meaning                                                                                                  | Operator action                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock-timeout`        | A lock acquire (sentinel sweep, metadata write) timed out waiting for a peer to release.                 | Usually transient (peer was slow). If repeating: `claude-conductor channels peers <id>` to find the held lock; `close-peer --force` if peer crashed.                    |
| `write-failed`        | A write to substrate (sentinel, cursor, metadata) failed (EACCES/EBUSY/ENOSPC).                          | Check filesystem permissions on `~/.claude/channels/<id>/`. ENOSPC = disk full. EACCES = chmod issue (rare; usually a leaked-from-CI file).                             |
| `registry-contention` | A read on `metadata.json` or active-sessions registry caught a concurrent-mutation race; read was empty. | Usually transient. If reproducible, capture the artifact path (in detail) for triage.                                                                                   |
| `operator-reset`      | An operator-driven recovery action (`forget-cursor`, `close-peer --force`) intentionally reset state.    | Audit-trail entry only — no action needed unless the recovery itself failed.                                                                                            |
| `unhandled`           | Catch-all for unexpected throws inside a hook's outer try/catch.                                         | Capture the line + open an issue. The hook still passed (no SessionStart break) but the throw is unexpected.                                                            |
| `clock-skew`          | A peer's heartbeat-body timestamp diverges from its mtime by > 5 min.                                    | Informational. Suggests the peer's clock is wrong (NTP drift, container clock issue) or the heartbeat write was delayed by an unusually long pause. No action required. |

### Reading the log

```bash
# Tail and pretty-print live entries:
tail -f ~/.claude/logs/.presence-gate-failures.log | jq .

# Filter by source (e.g. only channels-gc-reaper events):
tail -f ~/.claude/logs/.presence-gate-failures.log | jq 'select(.source == "channels-identity")'

# Last 10 clock-skew events:
tac ~/.claude/logs/.presence-gate-failures.log | jq -r 'select(.kind == "clock-skew") | "\(.timestamp) \(.detail)"' | head

# Group by kind for the last 100 events:
tail -100 ~/.claude/logs/.presence-gate-failures.log | jq -r '.kind' | sort | uniq -c | sort -rn
```

### Per-hook expected kinds

| Hook                     | Expected kinds                                                     | Most-common cause                                                          |
| ------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `channels-gc-reaper`     | `lock-timeout`, `write-failed`, `registry-contention`, `unhandled` | Slow-lock acquire; EACCES/EBUSY on sentinel; concurrent claimIdentity race |
| `identity-injector`      | `write-failed`                                                     | Cadence-cursor write failure                                               |
| `task-coordinator`       | `registry-contention`                                              | `getIdentityContextForSession` threw                                       |
| `teammate-idle-reminder` | `clock-skew`, `write-failed`                                       | Peer NTP drift / unusual write-delay; rate-limit-cursor write failure      |
| Cursor write path        | `write-failed`                                                     | EACCES/EBUSY on `last-seen-cursors/<sid>.json`                             |

---

## Per-channel substrate layout

The `~/.claude/channels/<channel-id>/` directory is the per-channel substrate. Phase 2 added three per-session cursor subdirs plus a fourth (Slice 7) reminder cursor. Phase 3 Step G (ARCH-W2-4) standardized the naming to noun-form with explicit "cursor" terminology and set-plurality on `heartbeats/`; the legacy single-form subdir names are retained via dual-read for a ≥30-day window (through ≥2026-06-12, per Decision F in `decisions/phase-3.md`) so pre-Step-G peers' artifacts remain visible during the transition. Writers write NEW-only; readers try NEW first, fall back to LEGACY on ENOENT; clear/unlink walks BOTH; enumerate unions BOTH; the rate-gate cursor uses MAX(newMtime, legacyMtime).

| Path                                   | Slice           | Owner                    | Content                                                                                          | File format                                      |
| -------------------------------------- | --------------- | ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `metadata.json`                        | Phase 0/1       | (multiple)               | Channel metadata: kind, identities map, role assignments, archived flag.                         | JSON                                             |
| `messages.jsonl`                       | Phase 0         | `appendMessage`          | Append-only message log.                                                                         | JSONL                                            |
| `bodies/`                              | Phase 0         | `--body-file` writer     | Externalized large message bodies (referenced via `body_ref`).                                   | Per-message file                                 |
| `heartbeats/<sid>` ⁽ᴳ⁾                 | Phase 0/1       | `touchHeartbeat`         | Per-session liveness file. Phase 2 Slice 7 extends body to integer epoch-ms (was empty pre-S7).  | Plain integer ms (Slice 7+); empty file (legacy) |
| `identities/<letter>`                  | Phase 1 Slice 1 | `claimIdentity`          | Per-letter sentinel file (presence = claim held); content = JSON `IdentityClaim`.                | JSON                                             |
| `identities/<letter>.reaper-acked`     | Phase 2 Slice 4 | `channels-gc-reaper`     | 7-day TTL marker suppressing repeated stuck-orphan reminders for one letter.                     | Empty file (mtime = TTL anchor)                  |
| `last-seen-cursors/<sid>.json` ⁽ᴳ⁾     | Phase 2 Slice 8 | `read --since-cursor`    | Per-session cursor: last message mtime + ts the session has read up to.                          | JSON `{mtime, ts}`                               |
| `reap-cursors/cursor` ⁽ᴳ⁾              | Phase 2 Slice 4 | `channels-gc-reaper`     | Single per-reaper rate-gate cursor (mtime tracks last-reap timestamp).                           | JSON                                             |
| `identity-emit-cursors/<sid>.json` ⁽ᴳ⁾ | Phase 2 Slice 5 | `identity-injector`      | Last-emitted (identity, role, peer-letter-set) tuple per session — drives cadence suppression.   | JSON                                             |
| `idle-emit-cursors/<sid>.json` ⁽ᴳ⁾     | Phase 2 Slice 7 | `teammate-idle-reminder` | Per-(channel, observer-session) rate-limit cursor: peer letter → ISO timestamp of last reminder. | JSON `Record<peerLetter, isoTimestamp>`          |

> ⁽ᴳ⁾ = renamed in Step G (`heartbeat/`, `last-seen/`, `gc-reap/`, `identity-emit/`, `idle-emit/` respectively); dual-read fallback retained ≥30 days post-merge (through ≥2026-06-12 per Decision F).

---

## Per-hook recovery

Phase 2 hooks fail-soft (fail-open + breadcrumb) by design except for `channels-gc-reaper` (fail-loud — substrate corruption needs operator action). When a hook gets the operator into a wedged state, recovery is **per-hook rather than via a global kill-switch** — each hook owns substrate with different correctness implications, so a universal "disable all" toggle would be a footgun.

**A dispatcher-level kill-switch (`CLAUDE_CONDUCTOR_DISABLE_HOOKS`) shipped in Phase 3 Slice 1** — see [`phase-3-kill-switch.md`](phase-3-kill-switch.md) for the full operator runbook. The per-hook recovery procedures below remain the granular path; the kill-switch is the universal emergency-stop for multi-hook wedges. Composition rule: profile-filter applies first, env-var-disable second, `--check=NAME` isolation third.

Each entry is structured **symptom → diagnose → recover → verify** (depth-3 per CLI-2):

### `channels-gc-reaper`

**Symptom:** Persistent stuck-orphan breadcrumb at SessionStart, e.g.:

```
[gc-reaper] Failed to unlink orphan sentinel for <letter> on <channel-id>: EBUSY.
Run: claude-conductor channels close-peer <channel-id> --peer <letter> --force
(diagnostic) Breadcrumb: appendPresenceFailure source=channels-identity kind=write-failed
```

**Diagnose:**

```bash
# Confirm the orphan: sentinel exists but no metadata entry.
ls ~/.claude/channels/<channel-id>/identities/<letter>
jq '.identities' ~/.claude/channels/<channel-id>/metadata.json
```

The sentinel file should be present; the `.identities` map should NOT have an entry for `<letter>`.

**Recover:**

```bash
claude-conductor channels close-peer <channel-id> --peer <letter> --force
```

`--force` releases the sentinel without the heartbeat-staleness guard normally used for active peers. This is the canonical recovery path; the breadcrumb itself surfaces this command.

**Verify:**

```bash
ls ~/.claude/channels/<channel-id>/identities/<letter>  # → should report not-found

# IMPORTANT: clear the reap-rate-gate cursor first, otherwise the next
# SessionStart will short-circuit (REAP_INTERVAL_MS = 5 min) and you'll
# falsely conclude the fix worked when the reaper hasn't re-evaluated:
rm -f ~/.claude/channels/<channel-id>/reap-cursors/cursor
# [step-g-transition] Dual-read window (through ≥2026-06-12): also clear the
# legacy path so the MAX(newMtime, legacyMtime) rate-gate fully resets. Drop
# these 2 lines when the legacy-removal cycle lands (rg "step-g-transition").
rm -f ~/.claude/channels/<channel-id>/gc-reap/cursor
```

Re-fire `/resume` (triggers SessionStart). The stuck-orphan breadcrumb should not reappear.

**Special case — `<letter>.reaper-acked` won't auto-clear:**

If the reaper logs that it settled (no orphan in metadata) but the `<letter>.reaper-acked` marker persists for > 7 days:

```bash
rm ~/.claude/channels/<channel-id>/identities/<letter>.reaper-acked
```

Rare; the marker auto-clears on each successful reap. Manual removal is a backstop.

### `identity-injector`

**Symptom:** Stale identity context surfaced at SessionStart (wrong role, wrong peer roster), OR identity-injector emits the same context every `/resume` despite no state change (cadence cursor not suppressing).

**Diagnose:**

```bash
# Read the cadence cursor. The reader mirrors runtime semantics: NEW first,
# LEGACY fallback (Step G dual-read window through ≥2026-06-12 — see
# [step-g-transition] markers below):
echo "[new]"; cat ~/.claude/channels/<channel-id>/identity-emit-cursors/<sid>.json 2>/dev/null
# [step-g-transition] drop the next 2 lines when the legacy-removal cycle lands:
echo "[legacy]"; cat ~/.claude/channels/<channel-id>/identity-emit/<sid>.json 2>/dev/null

# Read current authoritative state:
claude-conductor channels meta <channel-id> | jq '.identities'
claude-conductor channels whoami <channel-id>
```

<!-- [step-g-transition] drop "(or the legacy ...)" parenthetical when legacy-removal cycle lands -->

If `identity-emit-cursors/<sid>.json` (or the legacy `identity-emit/<sid>.json` during the dual-read window) differs from authoritative state, the cursor is stale (or never written).
If they match but the operator perceives it as wrong, the metadata itself is wrong → see `close-peer` below.

**Recover:**

```bash
# Idempotent rejoin — re-resolves the claim from scratch:
claude-conductor channels join <channel-id>
```

For a stuck cadence cursor specifically:

```bash
rm -f ~/.claude/channels/<channel-id>/identity-emit-cursors/<sid>.json
# [step-g-transition] Dual-read window (through ≥2026-06-12): also clear the
# legacy path so a pre-Step-G cursor file (still readable via dual-read
# fallback) doesn't resurrect the suppression. Drop these 2 lines when the
# legacy-removal cycle lands (rg "step-g-transition").
rm -f ~/.claude/channels/<channel-id>/identity-emit/<sid>.json
```

Next SessionStart will treat the channel as never-emitted-before and surface fresh context.

**Verify:**

Re-fire `/resume`. Identity context should reflect current authoritative state and `identity-emit-cursors/<sid>.json` should regenerate **on this run** (cadence cursor was just removed, so the suppression check fires once with no prior tuple). After this verifying re-fire, subsequent `/resume` will resume normal cadence-suppression — silent emission is the success state, not a failure.

### `task-coordinator`

**Symptom:** Task tool blocked with `[task-coordinator] role=out on channel <id>: refusing dispatch` when the operator did not intend to be observing-only on that channel, OR Task warns about queue-role when operator wants to dispatch without the warning.

**Diagnose:**

```bash
# Confirm current role on the offending channel:
claude-conductor channels whoami <channel-id>
```

The role field tells you what the hook is reading.

**Recover:**

```bash
# Rotate from out → pen-holder (reverses both the block AND any warn under queue):
claude-conductor channels set-role <channel-id> --role pen
```

Or rotate to `queue` if the operator wanted to step back from pen but not observe-only:

```bash
claude-conductor channels set-role <channel-id> --role queue
```

**Verify:**

```bash
claude-conductor channels whoami <channel-id>  # role should reflect new value
```

Re-fire the Task dispatch. Should no longer block (under `pen`) or warn (under `queue`).

### `teammate-idle-reminder`

**Symptom:** Suspected stale-peer false positive — teammate-idle-reminder flags a peer as idle but the operator believes the peer is still alive, OR no idle reminder is firing despite a peer that genuinely went away > 5 min ago.

**Diagnose:**

```bash
# Show authoritative peer state (mtime ages, body timestamps if Slice 7+):
claude-conductor channels peers <channel-id>

# Inspect the rate-limit cursor (suppresses re-emission for 30 min per peer).
# Reader semantics: NEW first, LEGACY fallback (Step G dual-read window
# through ≥2026-06-12 — see [step-g-transition] markers below):
echo "[new]"; cat ~/.claude/channels/<channel-id>/idle-emit-cursors/<sid>.json 2>/dev/null
# [step-g-transition] drop the next 2 lines when the legacy-removal cycle lands:
echo "[legacy]"; cat ~/.claude/channels/<channel-id>/idle-emit/<sid>.json 2>/dev/null

# Check the breadcrumb log for clock-skew kind on this peer:
grep clock-skew ~/.claude/logs/.presence-gate-failures.log | tail
```

If `peers` shows fresh heartbeat-mtime AND the breadcrumb log has `clock-skew` entries → the peer's clock is ahead/behind real time and the hook is intentionally suppressing the reminder.

If the hook never fires for a real idle peer, the rate-limit cursor may have a stale entry.

**Recover:**

For false-positive clock-skew suppression — operator must investigate the peer's clock; no code-side fix.

For the rate-limit cursor blocking emission of a real idle:

```bash
rm -f ~/.claude/channels/<channel-id>/idle-emit-cursors/<sid>.json
# [step-g-transition] Dual-read window (through ≥2026-06-12): also clear the
# legacy path so a pre-Step-G cursor file doesn't resurrect the suppression
# via fallback. Drop these 2 lines when the legacy-removal cycle lands
# (rg "step-g-transition").
rm -f ~/.claude/channels/<channel-id>/idle-emit/<sid>.json
```

Forces a fresh emission cycle; next prompt-submit will re-evaluate without the suppression cursor.

**Verify:**

Submit a new prompt. If the peer is still genuinely idle and the cursor is gone, the `[teammate-idle]` reminder should fire.

### `read --since-cursor` (substrate, not a hook — included here because operators hit it together)

**Symptom:** Stuck cursor on a `--since-cursor` read; subsequent reads return empty arrays despite known-new messages, OR cursor write keeps failing per breadcrumb.

**Diagnose:**

```bash
# Confirm cursor state:
claude-conductor channels show-cursor <channel-id>

# Compare to last message ts:
claude-conductor channels read <channel-id> | jq -r '.[-1].ts'
```

**Recover:**

```bash
claude-conductor channels forget-cursor <channel-id>
```

Next `--since-cursor` read will bootstrap from full history (with stderr advisory) and write a fresh cursor.

**Verify:**

```bash
claude-conductor channels show-cursor <channel-id>  # → kind=absent
claude-conductor channels read <channel-id> --since-cursor  # → full history (bootstrap)
claude-conductor channels show-cursor <channel-id>  # → kind=present (fresh cursor)
```

---

## References / See also

- **Phase 1 mental model:** [docs/architecture/hooks-layer.md](../architecture/hooks-layer.md) — firing-order taxonomy, failure-mode classes (`fail-open silent` / `fail-open + breadcrumb` / `fail-loud`), `system-reminder` composition rules, add-a-hook checklist.
- **Decision log:** [decisions/phase-2.md](../../decisions/phase-2.md) — Decision A (heartbeat schema), Decision B (canBlock taxonomy), Decision C (Wave 2 audit dispositions including the `CLAUDE_CONDUCTOR_DISABLE_HOOKS` Phase 3 deferral).
- **Plan:** `~/.claude/plans/lovely-dreaming-willow.md` REV 2.1 — Slice 10 spec including this runbook's outline.
- **CHANGELOG:** [CHANGELOG.md](../../CHANGELOG.md) §`[0.2.0-phase-2]` — operator-impact section enumerates the env-var / verb / flag / breadcrumb / substrate-subdir surface.
- **Smoke matrix v2:** [scripts/smoke-phase-2.sh](../../scripts/smoke-phase-2.sh) — 19 end-to-end scenarios covering all of the above, plus `scripts/smoke-phase-1.sh` (8 scenarios) for the Phase 1 surface.
- **Presence-failure log:** `~/.claude/logs/.presence-gate-failures.log`. Schema in [src/shared/presence-failure-log.ts](../../src/shared/presence-failure-log.ts).
- **File an issue:** https://github.com/nbruzzi/claude-conductor/issues with the relevant breadcrumb + the channel-dir snapshot (`tar czf channel-snap.tar.gz ~/.claude/channels/<id>/`) attached.
