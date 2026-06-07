// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cohort-sight core tests (D2). Exercises buildCohortSight over a sandboxed
 * sessions dir (mkdtemp + tmpdir, never /tmp+pid) with an injected identity map,
 * so no real channel / harness state is touched:
 *   - identity mapping (sessionId -> NATO letter; null when unmapped)
 *   - status passthrough (busy/idle) + "unknown" for absent/garbage
 *   - ageMs = now - updatedAt; null when absent; future-mtime clamped to 0
 *   - pidAlive via kill(pid,0): live (this process) / dead (unused high pid) /
 *     EPERM-as-alive (pid 1)
 *   - blind-spots (unparseable / missing-fields) surfaced, never thrown
 *   - numeric-stem filter (UUID telemetry + non-json skipped, not blind-spotted)
 *   - missing sessions dir => empty board (degrade-safe)
 *   - deterministic ordering (identified-first alpha, then unlabeled by sid)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCohortSight,
  buildHarnessStatusIndex,
  isActiveHarnessStatus,
  type CohortSight,
  type CohortSightRow,
} from "../../src/cohort-sight/index.ts";
import {
  fmtAge,
  renderTable,
  runCohortSightCli,
} from "../../src/cohort-sight/cli.ts";

const NOW = 1_800_000_000_000;
const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SID_X = "cccccccc-0000-4000-8000-000000000003"; // intentionally unmapped

const IDENTITY_MAP: ReadonlyMap<string, string> = new Map([
  [SID_A, "Alpha"],
  [SID_B, "Bravo"],
]);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cohort-sight-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePidfile(pid: number, body: Record<string, unknown>): void {
  writeFileSync(join(tmpDir, `${pid}.json`), JSON.stringify(body));
}
function writeRaw(name: string, raw: string): void {
  writeFileSync(join(tmpDir, name), raw);
}
function build(): ReturnType<typeof buildCohortSight> {
  return buildCohortSight(NOW, {
    sessionsDirOverride: tmpDir,
    identityMapOverride: IDENTITY_MAP,
  });
}
function rowBySid(
  rows: readonly CohortSightRow[],
  sid: string,
): CohortSightRow | undefined {
  return rows.find((r) => r.sessionId === sid);
}

describe("buildCohortSight", () => {
  it("maps sessionId -> NATO identity; null when unmapped", () => {
    writePidfile(101, { pid: 101, sessionId: SID_A, updatedAt: NOW });
    writePidfile(102, { pid: 102, sessionId: SID_X, updatedAt: NOW });
    const { rows } = build();
    expect(rowBySid(rows, SID_A)?.identity).toBe("Alpha");
    expect(rowBySid(rows, SID_X)?.identity).toBeNull();
  });

  it("passes through busy/idle; 'unknown' when absent or garbage", () => {
    writePidfile(201, {
      pid: 201,
      sessionId: SID_A,
      status: "busy",
      updatedAt: NOW,
    });
    writePidfile(202, {
      pid: 202,
      sessionId: SID_B,
      status: "weird",
      updatedAt: NOW,
    });
    writePidfile(203, { pid: 203, sessionId: SID_X, updatedAt: NOW });
    const { rows } = build();
    expect(rowBySid(rows, SID_A)?.status).toBe("busy");
    expect(rowBySid(rows, SID_B)?.status).toBe("unknown");
    expect(rowBySid(rows, SID_X)?.status).toBe("unknown");
  });

  it("ageMs = now - updatedAt; null when absent; future clamps to 0", () => {
    writePidfile(301, { pid: 301, sessionId: SID_A, updatedAt: NOW - 5000 });
    writePidfile(302, { pid: 302, sessionId: SID_B });
    writePidfile(303, { pid: 303, sessionId: SID_X, updatedAt: NOW + 99999 });
    const { rows } = build();
    expect(rowBySid(rows, SID_A)?.ageMs).toBe(5000);
    expect(rowBySid(rows, SID_B)?.ageMs).toBeNull();
    expect(rowBySid(rows, SID_X)?.ageMs).toBe(0);
  });

  it("pidAlive: true for the live test process, false for a dead/invalid pid", () => {
    writePidfile(process.pid, {
      pid: process.pid,
      sessionId: SID_A,
      updatedAt: NOW,
    });
    writePidfile(2_147_483_646, {
      pid: 2_147_483_646,
      sessionId: SID_B,
      updatedAt: NOW,
    });
    const { rows } = build();
    expect(rowBySid(rows, SID_A)?.pidAlive).toBe(true);
    expect(rowBySid(rows, SID_B)?.pidAlive).toBe(false);
  });

  it("treats EPERM (exists-but-not-ours) as alive — pid 1 always exists", () => {
    // pid 1 (launchd/init) always exists: kill(1,0) => EPERM as non-root (the
    // common case, exercising the EPERM-as-alive branch) or success as root.
    // Either way the process exists => pidAlive true.
    writePidfile(1, { pid: 1, sessionId: SID_A, updatedAt: NOW });
    expect(rowBySid(build().rows, SID_A)?.pidAlive).toBe(true);
  });

  it("surfaces unparseable + missing-fields pidfiles as blindSpots, not rows", () => {
    writeRaw("401.json", "{ not valid json");
    writeRaw("402.json", JSON.stringify({ foo: "bar" }));
    const { rows, blindSpots } = build();
    expect(rows).toHaveLength(0);
    expect(blindSpots.find((b) => b.file === "401.json")?.reason).toBe(
      "unparseable",
    );
    expect(blindSpots.find((b) => b.file === "402.json")?.reason).toBe(
      "missing-fields",
    );
  });

  it("skips non-numeric stems (UUID telemetry) and non-json files", () => {
    writeRaw(`${SID_A}.json`, JSON.stringify({ session_id: SID_A }));
    writeRaw("notes.txt", "hello");
    writePidfile(501, { pid: 501, sessionId: SID_B, updatedAt: NOW });
    const { rows, blindSpots } = build();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(SID_B);
    expect(blindSpots).toHaveLength(0);
  });

  it("missing sessions dir => empty board (degrade-safe)", () => {
    const out = buildCohortSight(NOW, {
      sessionsDirOverride: join(tmpDir, "does-not-exist"),
      identityMapOverride: IDENTITY_MAP,
    });
    expect(out.rows).toHaveLength(0);
    expect(out.blindSpots).toHaveLength(0);
  });

  it("orders identified cohort sessions first (alpha), then unlabeled by sid", () => {
    writePidfile(601, { pid: 601, sessionId: SID_X, updatedAt: NOW });
    writePidfile(602, { pid: 602, sessionId: SID_B, updatedAt: NOW });
    writePidfile(603, { pid: 603, sessionId: SID_A, updatedAt: NOW });
    expect(build().rows.map((r) => r.identity)).toEqual([
      "Alpha",
      "Bravo",
      null,
    ]);
  });

  it("reflects generatedAt + default channel (coordination)", () => {
    const out = build();
    expect(out.generatedAt).toBe(NOW);
    expect(out.channel).toBe("coordination");
  });
});

describe("cohort-sight CLI rendering (fmtAge / renderTable) + arg handling", () => {
  it("fmtAge: seconds / minutes / hours+minutes / unknown + boundaries", () => {
    expect(fmtAge(null)).toBe("—");
    expect(fmtAge(0)).toBe("0s");
    expect(fmtAge(42_000)).toBe("42s");
    expect(fmtAge(60_000)).toBe("1m");
    expect(fmtAge(420_000)).toBe("7m");
    expect(fmtAge(3_600_000)).toBe("1h0m");
    expect(fmtAge(3_780_000)).toBe("1h3m");
  });

  it("renderTable: header + row + session count for a non-empty board", () => {
    const sight: CohortSight = {
      generatedAt: NOW,
      channel: "coordination",
      rows: [
        {
          identity: "Alpha",
          sessionId: SID_A,
          pid: 111,
          status: "busy",
          cwd: "/x",
          ageMs: 5000,
          pidAlive: true,
        },
      ],
      blindSpots: [],
    };
    const out = renderTable(sight, false);
    expect(out).toContain("1 session(s)");
    expect(out).toContain("IDENTITY");
    expect(out).toContain("Alpha");
    expect(out).toContain("alive");
  });

  it("renderTable: empty-board line + blind-spot footer, suppressed by quiet", () => {
    const sight: CohortSight = {
      generatedAt: NOW,
      channel: "coordination",
      rows: [],
      blindSpots: [{ file: "9.json", reason: "unparseable" }],
    };
    expect(renderTable(sight, false)).toContain(
      "(no live session pidfiles found)",
    );
    expect(renderTable(sight, false)).toContain("unreadable pidfile");
    expect(renderTable(sight, true)).not.toContain("unreadable pidfile");
  });

  it("CLI rejects an unexpected positional arg with exit 2 (NIT-1)", () => {
    expect(runCohortSightCli(["unexpected"])).toBe(2);
  });
});

describe("Lane A — harness-status taxonomy + index-once reader", () => {
  it("buildCohortSight passes through the 4-value taxonomy (waiting/shell no longer collapse)", () => {
    writePidfile(701, {
      pid: 701,
      sessionId: SID_A,
      status: "waiting",
      updatedAt: NOW,
    });
    writePidfile(702, {
      pid: 702,
      sessionId: SID_B,
      status: "shell",
      updatedAt: NOW,
    });
    writePidfile(703, {
      pid: 703,
      sessionId: SID_X,
      status: "nonsense",
      updatedAt: NOW,
    });
    const { rows } = build();
    expect(rowBySid(rows, SID_A)?.status).toBe("waiting");
    expect(rowBySid(rows, SID_B)?.status).toBe("shell");
    expect(rowBySid(rows, SID_X)?.status).toBe("unknown"); // unrecognized still collapses
  });

  it("isActiveHarnessStatus: busy/shell/waiting active; idle/unknown not", () => {
    expect(isActiveHarnessStatus("busy")).toBe(true);
    expect(isActiveHarnessStatus("shell")).toBe(true);
    expect(isActiveHarnessStatus("waiting")).toBe(true);
    expect(isActiveHarnessStatus("idle")).toBe(false);
    expect(isActiveHarnessStatus("unknown")).toBe(false);
  });

  it("buildHarnessStatusIndex maps sessionId -> {status, pid, pidAlive} via kill(pid,0)", () => {
    writePidfile(process.pid, {
      pid: process.pid,
      sessionId: SID_A,
      status: "busy",
      updatedAt: NOW,
    });
    writePidfile(2_147_483_646, {
      pid: 2_147_483_646,
      sessionId: SID_B,
      status: "idle",
      updatedAt: NOW,
    });
    const index = buildHarnessStatusIndex({ sessionsDirOverride: tmpDir });
    expect(index.get(SID_A)).toEqual({
      status: "busy",
      pid: process.pid,
      pidAlive: true,
    });
    expect(index.get(SID_B)).toEqual({
      status: "idle",
      pid: 2_147_483_646,
      pidAlive: false,
    });
  });

  it("buildHarnessStatusIndex skips UUID telemetry + non-json; missing dir => empty", () => {
    writeRaw(`${SID_A}.json`, JSON.stringify({ session_id: SID_A })); // uuid telemetry
    writeRaw("notes.txt", "hello");
    writePidfile(801, {
      pid: 801,
      sessionId: SID_B,
      status: "busy",
      updatedAt: NOW,
    });
    const index = buildHarnessStatusIndex({ sessionsDirOverride: tmpDir });
    expect(index.size).toBe(1);
    expect(index.has(SID_B)).toBe(true);
    expect(
      buildHarnessStatusIndex({ sessionsDirOverride: join(tmpDir, "nope") })
        .size,
    ).toBe(0);
  });
});
