// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Canonical suite for the shared `isOsPidAlive` probe (Lane B unify,
 * 2026-06-07). The probe was lifted from `active-sessions` into the `shared/`
 * leaf so both the mutating-gate consumer (`reconcile-boot` `--apply`) and the
 * read-only observe board (`cohort-sight`) share ONE source of truth. These
 * tests pin the ESRCH-vs-EPERM discriminator the pid-spike confirmed:
 *   - own/live pid → true
 *   - alive-but-unsignalable pid (EPERM, e.g. pid 1) → true
 *   - exited pid (ESRCH) → false
 *   - absent/invalid pid → false (an ABSENT signal, never a protect)
 *
 * POSIX-portable: every assertion holds identically on macOS + Linux (no
 * `/proc`, no platform-divergent start-time read).
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { isOsPidAlive } from "../../src/shared/os-pid.ts";

describe("isOsPidAlive (same-host kill(pid,0) probe)", () => {
  it("returns true for the current process (own pid is alive)", () => {
    expect(isOsPidAlive(process.pid)).toBe(true);
  });

  it("returns true for an alive-but-unsignalable pid (EPERM, e.g. pid 1)", () => {
    // pid 1 (launchd / init) exists on macOS + Linux. As a normal user
    // kill(1, 0) throws EPERM (alive-unsignalable → true); as root it succeeds
    // (→ true). Either way the process is ALIVE, so the probe reports true.
    expect(isOsPidAlive(1)).toBe(true);
  });

  it("returns false for a pid that has exited (ESRCH)", () => {
    // Spawn a trivial child and wait for exit + reap; its pid is then gone, so
    // kill(pid, 0) throws ESRCH → not alive.
    const child = spawnSync(process.execPath, ["--version"]);
    const pid = child.pid;
    if (typeof pid !== "number") {
      throw new Error("spawnSync returned no pid");
    }
    expect(isOsPidAlive(pid)).toBe(false);
  });

  it("returns false for an absent / invalid pid (no signal, never a protect)", () => {
    expect(isOsPidAlive(0)).toBe(false); // 0 targets the process group — never probe it
    expect(isOsPidAlive(-1)).toBe(false);
    expect(isOsPidAlive(Number.NaN)).toBe(false);
    expect(isOsPidAlive(1.5)).toBe(false);
  });
});
