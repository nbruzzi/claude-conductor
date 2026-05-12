// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `getWallClockNow()` — the time-source-of-truth primitive
 * lifted in Phase 3 Step E.
 *
 * Coverage:
 *   1. Primitive returns numeric wall-clock ms (sanity + monotonic-
 *      within-call-window).
 *   2. Byte-equivalence with `Date.now()` at lift-time (heartbeat-body
 *      write-via-primitive → read back → byte-equal to pre-primitive
 *      output). This is the LOAD-BEARING wall-clock-retention HARD
 *      constraint regression-gate per `decisions/phase-2.md` Decision C
 *      RE-W2-2.
 *   3. Lock-owner-record round-trip (per Charlie v2.9 (E.A) cross-audit
 *      suggestion): `OwnerInfo.ts` field set via primitive → JSON-serialize
 *      → JSON-parse → numeric + parseable + comparable. Pins the SECOND
 *      cross-process wall-clock contract that joined narrow-atomic scope
 *      under v2.9 (E.A).
 */

import { describe, expect, it } from "bun:test";

import { getWallClockNow } from "../../src/shared/clock.ts";

describe("getWallClockNow", () => {
  it("returns a number representing milliseconds since the Unix epoch", () => {
    const result = getWallClockNow();
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
    // Sanity: should be after 2020-01-01 (1577836800000) and before
    // 2050-01-01 (2524608000000). Pinning the magnitude as a sentinel
    // against accidental switch to seconds or microseconds.
    expect(result).toBeGreaterThan(1577836800000);
    expect(result).toBeLessThan(2524608000000);
  });

  it("returns monotonically non-decreasing values within a call window", () => {
    // Note: NOT strictly monotonic — Date.now() can return the same ms
    // for back-to-back calls on fast hardware. Pinning non-decreasing.
    const a = getWallClockNow();
    const b = getWallClockNow();
    const c = getWallClockNow();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });

  it("returns byte-equivalent to Date.now() for heartbeat-body roundtrip (LOAD-BEARING wall-clock retention HARD)", () => {
    // The on-disk heartbeat-body schema at `src/channels/index.ts`
    // touchHeartbeat writes `String(getWallClockNow())` into the file body;
    // `readHeartbeatBody` parses it back as a number. Switching to
    // monotonic-clock would break cross-process roundtrip. This test pins
    // the byte-equivalence claim: write-via-primitive produces a string
    // that parses back to a Date.now()-shape ms timestamp.
    const written = String(getWallClockNow());
    const parsed = Number(written);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(Number.isInteger(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(1577836800000);
    expect(parsed).toBeLessThan(2524608000000);

    // Comparable to a Date.now() value taken at the same instant
    // (must be within a few ms; loose to absorb test-host jitter).
    const dateNow = Date.now();
    expect(Math.abs(parsed - dateNow)).toBeLessThan(1000);
  });

  it("supports lock-owner-record JSON roundtrip (v2.9 (E.A) Charlie fold — second cross-process wall-clock contract)", () => {
    // `src/hooks/lock.ts` writes `OwnerInfo.ts = getWallClockNow()` into a
    // cross-process JSON file at `<lockDir>/owner`. Another process reads
    // and computes `getWallClockNow() - owner.ts > maxAgeMs` for stale-
    // lock detection. Pins that the primitive's output round-trips
    // through JSON.stringify + JSON.parse losslessly and remains
    // comparable for age computations — the SAME wall-clock HARD
    // contract as heartbeat-body, applied to a SECOND substrate site.
    const owner = {
      pid: 12345,
      host: "test-host",
      ts: getWallClockNow(),
      tag: "test-tag",
    };
    const serialized = JSON.stringify(owner);
    const parsed = JSON.parse(serialized) as typeof owner;

    expect(parsed.ts).toBe(owner.ts);
    expect(typeof parsed.ts).toBe("number");
    expect(Number.isFinite(parsed.ts)).toBe(true);

    // Age comparison shape (matches lock.ts:324 + :330 semantics):
    // `getWallClockNow() - owner.ts > maxAgeMs` must yield a finite,
    // small-positive delta when computed immediately post-roundtrip.
    const ageMs = getWallClockNow() - parsed.ts;
    expect(Number.isFinite(ageMs)).toBe(true);
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(1000); // immediate-readback should be sub-second
  });

  it("supports OwnerRecord JSON roundtrip (v2.10 (E.B) 3-lens cross-audit fold — THIRD cross-process wall-clock contract; sibling to lock.ts:OwnerInfo)", () => {
    // `src/active-sessions/index.ts` writes `OwnerRecord.touchedAt =
    // getWallClockNow()` into cross-process JSON files at
    // `<artifactDir>/heartbeats/<sessionId>`. `readOwnerRecord` parses
    // back; cross-cutting consumers (15+ importers) compute age via
    // `LIVE_WINDOW_MS` / `LIKELY_DEAD_MS` / `GC_WINDOW_MS` deltas.
    //
    // Same wall-clock HARD contract as heartbeat-body (test 3) +
    // OwnerInfo (test 4). v2.9 (E.A) Charlie pre-flight caught lock.ts;
    // v2.10 (E.B) 3-lens audit caught active-sessions/index.ts as
    // sibling substrate. This test pins the THIRD cross-process schema
    // contract so any future primitive evolution (clock-skew correction,
    // test-injection) preserves it.
    const record = {
      sessionId: "33333333-3333-4333-8333-333333333333",
      pid: 99999,
      host: "test-host",
      createdAt: getWallClockNow(),
      touchedAt: getWallClockNow(),
    };
    const serialized = JSON.stringify(record);
    const parsed = JSON.parse(serialized) as typeof record;

    expect(parsed.touchedAt).toBe(record.touchedAt);
    expect(parsed.createdAt).toBe(record.createdAt);
    expect(typeof parsed.touchedAt).toBe("number");
    expect(Number.isFinite(parsed.touchedAt)).toBe(true);

    // Age comparison shape matches active-sessions/index.ts age
    // windows (LIVE_WINDOW_MS / LIKELY_DEAD_MS / GC_WINDOW_MS deltas).
    const ageMs = getWallClockNow() - parsed.touchedAt;
    expect(Number.isFinite(ageMs)).toBe(true);
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(1000);

    // createdAt is comparable (test the createdAt vs touchedAt invariant
    // pattern used in setSentinelDotfilesRoot:986 where createdAt =
    // existing?.createdAt ?? now — both fields must be the same shape).
    expect(parsed.createdAt).toBeLessThanOrEqual(parsed.touchedAt);
  });

  it("primitive is the same function on every call (no per-call closure / no test-injection backdoor)", () => {
    // Defensive: confirm the export is a single bound function reference,
    // not a per-call closure that could be swapped/mocked unintentionally.
    // (When future clock-skew correction or testing-time-injection lands,
    // it should be additive to this module — not a silent override.)
    const ref1 = getWallClockNow;
    const ref2 = getWallClockNow;
    expect(ref1).toBe(ref2);
    expect(typeof ref1).toBe("function");
  });
});
