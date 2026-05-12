// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Time-source-of-truth primitive (Phase 3 Step E / RE-W2-2 lift).
 *
 * **Single audited time-source for clock-semantic reads across the plugin.**
 * Replaces ad-hoc `Date.now()` calls at clock-semantic call sites — age
 * comparisons, mtime deltas, heartbeat-body timestamp writes, and similar.
 * Provides ONE location to evolve clock-source policy (clock-skew
 * correction, testing-time-injection, monotonic-mirror) without sweeping
 * every consumer.
 *
 * **HARD wall-clock retention constraint (RE-2 fold per
 * `decisions/phase-2.md` Decision C RE-W2-2 + `feedback-live-substrate-
 * sequencing.md`):** the on-disk heartbeat-body schema FORCES wall-clock
 * retention. `touchHeartbeat` at `src/channels/index.ts` writes literal
 * `Date.now()` ms values into per-session heartbeat files; cross-process
 * `readHeartbeatBody` parses them back to compute peer-age. **Switching
 * to `process.hrtime.bigint()` (monotonic) would break the cross-process
 * roundtrip** because monotonic-time has no shared origin between
 * processes. This primitive MUST return wall-clock ms; any future
 * evolution preserves byte-equivalence with `Date.now()` output for
 * heartbeat-body writes.
 *
 * **Scope of this slice (Step E narrow atomic):** primitive defined +
 * critical-path SHARED-LIBRARY SUBSTRATE consumers migrated:
 *   - `channels/index.ts` heartbeat-body write + age comparisons
 *   - `channels-gc-reaper.ts` age comparisons (consumes channels-module)
 *   - `channels/cli.ts` age display
 *   - **`src/hooks/lock.ts`** owner-record schema write + age comparisons
 *     (v2.9 (E.A) Charlie pre-flight catch — substrate-primitive at
 *     `hooks/` top-level, NOT `hooks/checks/`; consumed by
 *     `withMetadataLock` cross-cutting)
 *   - **`src/active-sessions/index.ts`** OwnerRecord touchedAt cross-
 *     process schema writes + age-arg passing (v2.10 (E.B) 3-lens
 *     cross-audit catch — same substrate-primitive-not-hook-handler
 *     pattern as `hooks/lock.ts`; consumed by 15+ importers across
 *     channels/, hooks/checks/, cli/)
 *
 * All migrated sites share the same cross-process wall-clock retention
 * HARD constraint: file-body schemas read by other processes for
 * age computation. Switching to monotonic-clock would break ALL
 * cross-process roundtrips (heartbeat-body + OwnerInfo.ts + OwnerRecord.
 * touchedAt). Three round-trip regression-pins live in
 * `test/shared/clock.test.ts`.
 *
 * Cat 3 unique-suffix tmp-filename generators (`.tmp.${pid}.${ts}`
 * patterns at `channels/index.ts:1420`, `channels/identity.ts:230/868`,
 * `channels-gc-reaper.ts:568`, `active-sessions/index.ts:419/445/898`)
 * are NOT clock-semantic and stay on raw `Date.now()` (collision-
 * avoidance identifiers; Date.now() consumed as RNG-seed-equivalent,
 * not time-source-of-truth).
 *
 * **Hook-handler clock-semantic migrations across `src/hooks/checks/*`**
 * (active-channels-load, channel-gc, dotfiles-worktree-*, identity-
 * injector, session-collision-gate, session-presence-register,
 * teammate-idle-reminder; ~13 sites across 8 files) are deferred to
 * Step E2 per `feedback-live-substrate-sequencing.md` additive-first
 * discipline.
 *
 * **Substrate-vs-handler classification rule** (per `feedback-substrate-
 * fix-pattern-must-self-mirror.md` after v2.9 (E.A) + v2.10 (E.B) +
 * v2.10 (E.A2) recurring catches): files INCLUDED in narrow-atomic by
 * import-graph shape ("consumed cross-cutting by multiple hook-
 * handlers"), NOT by directory path. **Plus (E.A2) write-effect-graph
 * axis:** even hook-HANDLER call-sites are INCLUDED when the
 * `Date.now()` value flows as a parameter into a substrate-primitive's
 * cross-process JSON schema write (e.g., `session-presence-register:50`
 * + `dotfiles-worktree-provisioner:201` pass `now:` to
 * `active-sessions.touchHeartbeat` / `listLivePeers` whose `now` reaches
 * `OwnerRecord.touchedAt`). Classification rule: trace the data-flow,
 * not the file-location. Future Step E2 entry-condition: re-classify
 * any deferred-list candidate by call-site shape AND value-flow-graph.
 *
 * **Why not just `Date.now()` directly?** Auditability + future-proofing.
 * Every call to `getWallClockNow()` is an EXPLICIT clock-semantic read;
 * `Date.now()` callsites are ambiguous (could be time-source OR could be
 * unique-suffix gen OR could be debug-only). Future clock-skew-correction
 * (e.g., subtracting peer-NTP offset) or testing-time-injection (mock the
 * clock in tests without monkey-patching `globalThis.Date`) lands in ONE
 * place, not 31+.
 */

/**
 * Return the current wall-clock time as milliseconds since the Unix epoch.
 *
 * **Semantics: identical to `Date.now()` at lift-time.** Byte-equivalent
 * for heartbeat-body writes (verified by `test/shared/clock.test.ts`
 * round-trip pin). Both calls return `number`; both compute from the
 * same OS clock; both subject to wall-clock skew, NTP adjustments, and
 * user-initiated time changes.
 *
 * @returns Current wall-clock time in milliseconds since 1970-01-01T00:00:00Z.
 */
export function getWallClockNow(): number {
  return Date.now();
}
