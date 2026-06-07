// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Same-host OS-process liveness probe (C1 S2) — the shared leaf.
 *
 * `process.kill(pid, 0)` sends NO signal — it only tests whether a process with
 * that pid exists and is signalable. POSIX-portable (macOS + Linux); no `/proc`,
 * no fork.
 *
 * Returns `true` (ALIVE) on no-throw AND on `EPERM` (a process exists at that
 * pid that we lack permission to signal — e.g. pid 1; the spike confirmed it
 * throws `EPERM`, not `ESRCH`). Returns `false` (NOT ALIVE) on `ESRCH` (no such
 * process) and on a missing/invalid pid (`≤ 0` / non-integer — an ABSENT
 * signal, never a protect).
 *
 * The asymmetry is deliberate. This feeds a SUBTRACT-ONLY protect on a MUTATING
 * gate (`reconcile-boot` `--apply`), which must fail toward NOT-reaping on an
 * ambiguous-but-present pid (`EPERM`); but an ABSENT pid must NOT protect, or a
 * legacy heartbeat with no recorded session pid would be pinned live forever. A
 * future fast-reap (S3b) keys on `ESRCH` SPECIFICALLY — never on `EPERM`.
 *
 * Same-host only: a pid is meaningless across hosts, so callers gate this on a
 * host match (`owner.host === currentHost`) before probing.
 *
 * **Shared leaf (Lane B unify, 2026-06-07).** Single source of truth for the
 * `kill(pid, 0)` probe, formerly duplicated as `active-sessions.isOsPidAlive`
 * (the mutating-gate consumer) and `cohort-sight.isPidSignalable` (the read-only
 * observe board). Lives in `shared/` — a leaf with no conductor imports — so the
 * lightweight read-only board need not import the heavyweight `active-sessions`
 * module just for the probe. `active-sessions` re-exports it to preserve its
 * existing import surface (`reconcile-boot` + the dotfiles wildcard shim).
 */
export function isOsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
