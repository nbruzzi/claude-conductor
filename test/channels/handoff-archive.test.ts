// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 6 item-3 — handoff archive/prune (teardown parity) LOGIC units.
 *
 * Mirrors the channels archive/prune contract for handoff files. NEVER-auto-
 * delete: sweepArchivableHandoffs is report-only; archiveHandoff MOVES (not
 * deletes) to .archive/ (recoverable); pruneHandoffArchive deletes archived
 * entries only.
 *
 * Reference-awareness this increment: (a) LATEST-target protected + (c) recency
 * (retentionDays + keepRecent). (b) lineage-input_handoffs is DEFERRED to
 * increment-2 (bounded residual — see module doc).
 *
 * Fixtures are PROGRAMMATIC (back-dated mtime via utimesSync) — age is
 * `now - mtime`, so a static fixture would rot. Registry isolated via
 * CLAUDE_CONDUCTOR_HANDOFFS_DIR.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveHandoff,
  handoffArchiveDir,
  latestTargetName,
  pruneHandoffArchive,
  sweepArchivableHandoffs,
} from "../../src/channels/handoff-archive.ts";

let tmpDir: string;
let prev: string | undefined;
const NOW = 1_800_000_000_000; // fixed reference; tests pass this as `now`.
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "handoff-archive-"));
  prev = process.env["CLAUDE_CONDUCTOR_HANDOFFS_DIR"];
  process.env["CLAUDE_CONDUCTOR_HANDOFFS_DIR"] = tmpDir;
});

afterEach(() => {
  if (prev === undefined) delete process.env["CLAUDE_CONDUCTOR_HANDOFFS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_HANDOFFS_DIR"] = prev;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Write a HANDOFF_<id>.md with a controlled age (back-dated mtime from NOW). */
function writeHandoff(id: string, ageMs: number): string {
  const name = `HANDOFF_${id}.md`;
  const path = join(tmpDir, name);
  writeFileSync(path, `# Handoff ${id}\n`);
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
  return name;
}

function pointLatestAt(name: string): void {
  symlinkSync(join(tmpDir, name), join(tmpDir, "LATEST.md"));
}

describe("handoffArchiveDir + latestTargetName", () => {
  it("handoffArchiveDir is <handoffsDir>/.archive", () => {
    expect(handoffArchiveDir()).toBe(join(tmpDir, ".archive"));
  });

  it("latestTargetName resolves the LATEST symlink basename, null when absent", () => {
    expect(latestTargetName()).toBeNull();
    const n = writeHandoff("2026-05-29_11-11", 0);
    pointLatestAt(n);
    expect(latestTargetName()).toBe(n);
  });
});

describe("archiveHandoff — move (recoverable), never delete", () => {
  it("moves the handoff into .archive/ (src gone, dest present)", () => {
    const n = writeHandoff("a", 10 * DAY);
    archiveHandoff(n);
    expect(existsSync(join(tmpDir, n))).toBe(false);
    expect(existsSync(join(tmpDir, ".archive", n))).toBe(true);
  });

  it("collision-stamps when the archive dest already exists (no overwrite/loss)", () => {
    const n = writeHandoff("dup", 10 * DAY);
    mkdirSync(join(tmpDir, ".archive"), { recursive: true });
    writeFileSync(join(tmpDir, ".archive", n), "pre-existing");
    archiveHandoff(n);
    // pre-existing archived copy preserved; the new one lands under a stamped name.
    expect(existsSync(join(tmpDir, ".archive", n))).toBe(true);
    const stamped = readdirSync(join(tmpDir, ".archive")).filter((f) =>
      f.startsWith(`${n}__`),
    );
    expect(stamped.length).toBe(1);
  });

  it("rejects a non-handoff name (boundary guard)", () => {
    expect(() => archiveHandoff("LATEST.md")).toThrow();
    expect(() => archiveHandoff("notes.md")).toThrow();
  });
});

describe("sweepArchivableHandoffs — reference-aware report (NEVER mutates)", () => {
  const OPTS = { now: NOW, retentionDays: 14, keepRecent: 5 };

  it("does not mutate the filesystem (pure report)", () => {
    writeHandoff("old", 60 * DAY);
    const before = readdirSync(tmpDir).sort();
    sweepArchivableHandoffs(OPTS);
    const after = readdirSync(tmpDir).sort();
    expect(after).toEqual(before);
  });

  it("(a) the LATEST target is NEVER archivable, even when old (isolated from keepRecent)", () => {
    const n = writeHandoff("latest-old", 60 * DAY);
    pointLatestAt(n);
    writeHandoff("other-old", 40 * DAY);
    // keepRecent=0 so ONLY the (a) LATEST-protection keeps latest-old; other-old is archivable.
    const out = sweepArchivableHandoffs({
      now: NOW,
      retentionDays: 14,
      keepRecent: 0,
    });
    expect(out.protected_latest).toBe(n);
    expect(out.archivable.some((c) => c.name === n)).toBe(false);
    expect(out.archivable.map((c) => c.name)).toEqual(["HANDOFF_other-old.md"]);
  });

  it("(c) the keepRecent most-recent are protected regardless of age", () => {
    // 6 handoffs all old; keepRecent=5 protects the 5 most-recent by mtime.
    for (let i = 0; i < 6; i++) writeHandoff(`h${i}`, (60 + i) * DAY); // h0 newest, h5 oldest
    const out = sweepArchivableHandoffs(OPTS);
    expect(out.archivable.map((c) => c.name)).toEqual(["HANDOFF_h5.md"]);
  });

  it("recent handoffs (younger than retention) are not archivable", () => {
    writeHandoff("recent", 3 * DAY); // < 14d retention
    const out = sweepArchivableHandoffs({
      now: NOW,
      retentionDays: 14,
      keepRecent: 0,
    });
    expect(out.archivable.length).toBe(0);
  });

  it("old + non-LATEST + beyond-keepRecent IS archivable", () => {
    const keep = writeHandoff("keep", 1 * DAY); // recent
    pointLatestAt(keep);
    writeHandoff("stale1", 30 * DAY);
    writeHandoff("stale2", 40 * DAY);
    const out = sweepArchivableHandoffs({
      now: NOW,
      retentionDays: 14,
      keepRecent: 0,
    });
    expect(out.archivable.map((c) => c.name).sort()).toEqual([
      "HANDOFF_stale1.md",
      "HANDOFF_stale2.md",
    ]);
  });
});

describe("pruneHandoffArchive — delete old archived (mirror pruneArchive)", () => {
  function writeArchived(name: string, ageMs: number): void {
    const dir = join(tmpDir, ".archive");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "archived");
    // pruneHandoffArchive uses getWallClockNow() (real wall-clock, mirroring
    // pruneArchive — it takes no `now` param), so prune fixtures back-date
    // relative to real-now, NOT the fixed NOW the sweep tests pass in.
    const mtime = new Date(Date.now() - ageMs);
    utimesSync(path, mtime, mtime);
  }

  it("returns [] when no archive dir exists", () => {
    expect(pruneHandoffArchive({ retentionDays: 30, maxEntries: 50 })).toEqual(
      [],
    );
  });

  it("purges archived entries older than retentionDays", () => {
    writeArchived("HANDOFF_old.md", 60 * DAY);
    writeArchived("HANDOFF_recent.md", 5 * DAY);
    const purged = pruneHandoffArchive({ retentionDays: 30, maxEntries: 50 });
    expect(purged).toEqual(["HANDOFF_old.md"]);
    expect(existsSync(join(tmpDir, ".archive", "HANDOFF_recent.md"))).toBe(
      true,
    );
  });

  it("caps at maxEntries, oldest-first", () => {
    writeArchived("HANDOFF_a.md", 5 * DAY);
    writeArchived("HANDOFF_b.md", 6 * DAY);
    writeArchived("HANDOFF_c.md", 7 * DAY);
    // retention won't trigger (all < 30d); maxEntries=1 drops the 2 oldest (b, c).
    const purged = pruneHandoffArchive({
      retentionDays: 30,
      maxEntries: 1,
    }).sort();
    expect(purged).toEqual(["HANDOFF_b.md", "HANDOFF_c.md"]);
    expect(existsSync(join(tmpDir, ".archive", "HANDOFF_a.md"))).toBe(true);
  });
});
