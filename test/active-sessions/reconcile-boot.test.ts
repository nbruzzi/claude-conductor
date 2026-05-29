// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 2 boot-reconciliation — runReconcileBoot LOGIC units (in-process).
 *
 * Pair-B test split: Delta owns exhaustive in-process LOGIC coverage; Charlie's
 * dotfiles subprocess suite owns the CLI SURFACE (flag-parse / stdout-shape /
 * exit-codes). One shared dialect = the OwnerRecord on-disk format + the §2
 * ReconcileBootOutput contract.
 *
 * Fixtures are PROGRAMMATIC, not static (binding amendment): liveness is
 * `now - mtime`, so a static committed heartbeat would rot from live to stale
 * with wall-clock. Each test writes heartbeats into a tmpDir-isolated registry
 * (CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR) and back-dates mtime via utimesSync.
 *
 * Scope this increment (2a): presence-class enumeration + malformed-entry
 * surfacing (corrupt owner / future-mtime → errors[]{malformed-entry}, ok
 * load-bearing → exit 3) + the operator-visible `paused` field. `--apply` GC
 * lands in 2b (§10 Q4). Malformed entries are NOT candidates (we can't
 * classify them) but ARE surfaced — `scanHeartbeats` partitions the one walk
 * into valid + malformed, and `listAllHeartbeats` is its `.valid` projection.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  GC_WINDOW_MS,
  LIKELY_DEAD_MS,
  LIVE_WINDOW_MS,
  runReconcileBoot,
} from "../../src/active-sessions/index.ts";

let tmpDir: string;
let prev: string | undefined;
let prevChannels: string | undefined;
let prevConfig: string | undefined;
const NOW = 1_800_000_000_000; // fixed reference; tests pass this as `now`.

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reconcile-boot-"));
  prev = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevConfig = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  // Isolate the channels dir AND the worktree-provisioner config: runReconcile-
  // Boot's default scope now enumerates identity (reads the channels dir) and
  // worktrees (reads the repo config, default ~/.claude/worktree-provisioner.json).
  // Point both at non-existent paths so these presence-focused tests see no real
  // identity claims / worktrees leak in (deterministic across machines + CI).
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpDir, "no-channels");
  process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = join(
    tmpDir,
    "no-config.json",
  );
});

afterEach(() => {
  if (prev === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prev;
  if (prevChannels === undefined)
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannels;
  if (prevConfig === undefined)
    delete process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  else process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = prevConfig;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * Write a heartbeat with a controlled age. `ageMs` is back-dated from NOW via
 * the file mtime (the signal classifyLiveness keys off). `host` defaults to the
 * current hostname so the host-match signal passes unless overridden.
 */
function writeHeartbeat(
  artifactId: string,
  sessionId: string,
  ageMs: number,
  opts: { host?: string; raw?: string } = {},
): void {
  const dir = join(tmpDir, artifactId, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  const body =
    opts.raw ??
    JSON.stringify({
      sessionId,
      pid: 4242,
      host: opts.host ?? hostname(),
      createdAt: NOW - ageMs,
      touchedAt: NOW - ageMs,
    });
  writeFileSync(path, body);
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

describe("runReconcileBoot — presence-class logic", () => {
  it("live-only: all fresh heartbeats classify live, none gc_eligible", () => {
    writeHeartbeat("artifact-a", "11111111-1111-4111-8111-111111111111", 0);
    writeHeartbeat(
      "artifact-a",
      "22222222-2222-4222-8222-222222222222",
      LIKELY_DEAD_MS - 1,
    );
    const out = runReconcileBoot({ now: NOW });
    expect(out.ok).toBe(true);
    expect(out.total_enumerated).toBe(2);
    expect(out.live_count).toBe(2);
    expect(out.stale_count).toBe(0);
    expect(out.gc_eligible_count).toBe(0);
    expect(out.applied).toBe(false);
    expect(out.candidates.every((c) => c.classification === "live")).toBe(true);
    expect(out.candidates.every((c) => c.failed_signals.length === 0)).toBe(
      true,
    );
  });

  it("mixed: live / likely-dead / stale classify by age; only past-floor stale is gc_eligible", () => {
    writeHeartbeat("a", "aaaaaaaa-0000-4000-8000-000000000001", 0); // live
    writeHeartbeat(
      "a",
      "aaaaaaaa-0000-4000-8000-000000000002",
      LIKELY_DEAD_MS + 1,
    ); // likely-dead
    writeHeartbeat(
      "a",
      "aaaaaaaa-0000-4000-8000-000000000003",
      LIVE_WINDOW_MS + 1000,
    ); // stale, under floor
    writeHeartbeat(
      "a",
      "aaaaaaaa-0000-4000-8000-000000000004",
      GC_WINDOW_MS + 1,
    ); // stale, past floor
    const out = runReconcileBoot({ now: NOW });
    expect(out.total_enumerated).toBe(4);
    expect(out.live_count).toBe(1);
    expect(out.likely_dead_count).toBe(1);
    expect(out.stale_count).toBe(2);
    expect(out.gc_eligible_count).toBe(1); // only the past-floor stale
  });

  it("all-stale past floor: every entry stale + gc_eligible", () => {
    writeHeartbeat(
      "a",
      "bbbbbbbb-0000-4000-8000-000000000001",
      GC_WINDOW_MS + 1,
    );
    writeHeartbeat(
      "b",
      "bbbbbbbb-0000-4000-8000-000000000002",
      GC_WINDOW_MS * 5,
    );
    const out = runReconcileBoot({ now: NOW });
    expect(out.stale_count).toBe(2);
    expect(out.gc_eligible_count).toBe(2);
  });

  it("safety-floor: stale but younger than GC_WINDOW_MS is NOT gc_eligible", () => {
    // 45min: stale (> LIVE_WINDOW_MS=30min) but under the 60min floor.
    const fortyFiveMin = 45 * 60 * 1000;
    writeHeartbeat("a", "cccccccc-0000-4000-8000-000000000001", fortyFiveMin);
    const out = runReconcileBoot({ now: NOW });
    expect(out.stale_count).toBe(1);
    expect(out.gc_eligible_count).toBe(0); // floor protects it
    expect(out.candidates[0]?.classification).toBe("stale");
    expect(out.candidates[0]?.gc_eligible).toBe(false);
    // F1 (3-way cross-audit): past the live window (30min) so "mtime-age" IS a
    // failed signal, even though floor-protected from GC — the never-auto-kill
    // transparency field must explain WHY the entry is stale. This assertion
    // was the gap that hid the original > GC_WINDOW_MS threshold bug.
    expect(out.candidates[0]?.failed_signals).toContain("mtime-age");
  });

  it("split-brain: >1 non-stale claim on one artifact flags both; stale residue does not count", () => {
    writeHeartbeat("contended", "dddddddd-0000-4000-8000-000000000001", 0); // live
    writeHeartbeat(
      "contended",
      "dddddddd-0000-4000-8000-000000000002",
      LIKELY_DEAD_MS + 1,
    ); // likely-dead
    writeHeartbeat(
      "contended",
      "dddddddd-0000-4000-8000-000000000003",
      GC_WINDOW_MS + 1,
    ); // stale — not contention
    const out = runReconcileBoot({ now: NOW });
    expect(out.split_brain_count).toBe(2);
    const stale = out.candidates.find((c) => c.classification === "stale");
    expect(stale?.split_brain).toBe(false);
  });

  it("host-mismatch: fresh entry on a different host stays age-live but reports host-match failure", () => {
    writeHeartbeat("a", "eeeeeeee-0000-4000-8000-000000000001", 0, {
      host: "some-other-host",
    });
    const out = runReconcileBoot({ now: NOW });
    const c = out.candidates[0];
    expect(c?.classification).toBe("live"); // classifyLiveness is age-only
    expect(c?.failed_signals).toContain("host-match");
    expect(c?.gc_eligible).toBe(false); // fresh -> never GC'd regardless of host
  });

  it("malformed heartbeat (corrupt owner) is SURFACED as a malformed-entry → ok=false (2a)", () => {
    writeHeartbeat("a", "ffffffff-0000-4000-8000-000000000001", 0); // one valid
    writeHeartbeat("a", "ffffffff-0000-4000-8000-000000000002", 0, {
      raw: "{ not json",
    });
    const out = runReconcileBoot({ now: NOW });
    // The malformed entry is NOT a candidate (we can't classify it) ...
    expect(out.total_enumerated).toBe(1);
    // ... but it IS surfaced, and makes the report not-ok (→ exit 3).
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBe(1);
    const err = out.errors[0];
    expect(err?.error_class).toBe("malformed-entry");
    expect(err?.artifact_id).toBe("a");
    expect(err?.detail).toContain("ffffffff-0000-4000-8000-000000000002");
    expect(err?.detail).toContain("unparseable-owner");
  });

  it("future-mtime garbage is surfaced as a malformed-entry (future-mtime reason)", () => {
    // Negative age → mtime back-dated to NOW + |age| (the future, beyond the
    // clock-skew tolerance) → defensiveAgeMs returns null → scanHeartbeats
    // routes it to malformed{future-mtime}, not the valid set.
    writeHeartbeat("a", "ffffffff-0000-4000-8000-000000000003", 0); // one valid
    writeHeartbeat(
      "a",
      "ffffffff-0000-4000-8000-000000000004",
      -(CLOCK_SKEW_TOLERANCE_MS + 60_000),
    );
    const out = runReconcileBoot({ now: NOW });
    expect(out.total_enumerated).toBe(1); // future-mtime is not a candidate
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]?.error_class).toBe("malformed-entry");
    expect(out.errors[0]?.detail).toContain("future-mtime");
  });

  it("clean enumeration (no malformed) keeps ok=true and errors empty", () => {
    writeHeartbeat("a", "ffffffff-0000-4000-8000-000000000005", 0);
    const out = runReconcileBoot({ now: NOW });
    expect(out.ok).toBe(true);
    expect(out.errors.length).toBe(0);
  });

  it("scope=presence enumerates the presence class", () => {
    writeHeartbeat("a", "10101010-0000-4000-8000-000000000001", 0);
    const out = runReconcileBoot({ now: NOW, scope: "presence" });
    expect(out.total_enumerated).toBe(1);
  });
});
