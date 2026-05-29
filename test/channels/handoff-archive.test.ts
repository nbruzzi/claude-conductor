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
import {
  createLineageEnvelope,
  type LineageEnvelope,
} from "../../src/channels/api.ts";

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

  it("F5: collision-stamp stays UNIQUE even when the stamped name ALSO exists (same-ms double collision)", () => {
    const n = writeHandoff("dup2", 10 * DAY);
    mkdirSync(join(tmpDir, ".archive"), { recursive: true });
    // dest exists (forces the stamp path) AND the stamp for now=12345 already
    // exists (forces the F5 uniquifier loop — a same-ms re-archive of the name).
    writeFileSync(join(tmpDir, ".archive", n), "pre-existing-dest");
    writeFileSync(
      join(tmpDir, ".archive", `${n}__12345`),
      "pre-existing-stamp",
    );
    archiveHandoff(n, { now: 12345 });
    // Neither pre-existing archived copy is overwritten; the new one lands under a
    // further-disambiguated name.
    expect(existsSync(join(tmpDir, ".archive", n))).toBe(true);
    expect(existsSync(join(tmpDir, ".archive", `${n}__12345`))).toBe(true);
    const further = readdirSync(join(tmpDir, ".archive")).filter((f) =>
      f.startsWith(`${n}__12345__`),
    );
    expect(further.length).toBe(1);
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

  it("F4: a non-directory .archive yields [] (no throw) — prune blast-radius isolation", () => {
    // .archive exists but is a FILE -> readdirSync throws ENOTDIR. Prune must
    // tolerate it (return []), mirroring the sweep's enumeration tolerance + #175 N1.
    writeFileSync(join(tmpDir, ".archive"), "not a dir");
    let result: string[] | undefined;
    expect(() => {
      result = pruneHandoffArchive({ retentionDays: 30, maxEntries: 50 });
    }).not.toThrow();
    expect(result).toEqual([]);
  });
});

describe("sweepArchivableHandoffs — F1 transient-LATEST fail-safe (Pair-A RE shadow)", () => {
  it("a TRANSIENT LATEST-resolution failure fails SAFE: ok:false + nothing archivable (never defeats LATEST-protection)", () => {
    // Point handoffsDir at a FILE: readlinkSync(<file>/LATEST.md) -> ENOTDIR (a
    // non-legitimate errno) -> latestTargetName rethrows -> sweep fails safe.
    // Pre-fix the bare catch swallowed ENOTDIR -> null -> the sweep proceeded
    // (every candidate `!== null` -> LATEST-protection DEFEATED, ok:true). Post-
    // fix: ok:false + archivable:[] so the active handoff can never surface.
    const filePath = join(tmpDir, "not-a-dir");
    writeFileSync(filePath, "x");
    process.env["CLAUDE_CONDUCTOR_HANDOFFS_DIR"] = filePath; // afterEach restores
    const out = sweepArchivableHandoffs({
      now: NOW,
      retentionDays: 14,
      keepRecent: 0,
    });
    expect(out.ok).toBe(false);
    expect(out.archivable).toEqual([]);
    expect(out.protected_latest).toBeNull();
  });
});

const FIXTURE_SID = "11111111-1111-4111-8111-111111111111";

/** Replicated from the lineage roundtrip integration test — emits parser-valid lineage YAML. */
function emitLineageYaml(env: LineageEnvelope): string {
  const lines: string[] = [
    "lineage:",
    `  kind_version: ${env.kind_version}`,
    `  producer_session_id: ${env.producer_session_id}`,
  ];
  if (env.produced_at !== undefined && env.produced_at !== null) {
    lines.push(`  produced_at: ${env.produced_at}`);
  }
  if (env.input_body_refs.length === 0) {
    lines.push(`  input_body_refs: []`);
  } else {
    lines.push(`  input_body_refs:`);
    for (const ref of env.input_body_refs) lines.push(`    - ${ref}`);
  }
  if (Array.isArray(env.input_handoffs) && env.input_handoffs.length > 0) {
    lines.push(`  input_handoffs:`);
    for (const h of env.input_handoffs) lines.push(`    - ${h}`);
  }
  return lines.join("\n");
}

/** Write a HANDOFF_<id>.md carrying lineage.input_handoffs frontmatter + controlled age. */
function writeHandoffWithLineage(
  id: string,
  ageMs: number,
  inputHandoffs: readonly string[],
): string {
  const env = createLineageEnvelope({
    producer_session_id: FIXTURE_SID,
    produced_at: new Date(NOW).toISOString(),
    input_body_refs: [],
    input_handoffs: [...inputHandoffs],
  });
  const name = `HANDOFF_${id}.md`;
  const path = join(tmpDir, name);
  const content = `---
session_id: ${FIXTURE_SID}
started_at: 2026-05-27T10:00:00Z
ended_at: 2026-05-27T11:00:00Z
entries_touched: []
${emitLineageYaml(env)}
---

# Handoff ${id}
`;
  writeFileSync(path, content);
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
  return name;
}

describe("sweepArchivableHandoffs — (b) lineage-input protection (increment-2)", () => {
  it("a handoff referenced by another's lineage.input_handoffs is PROTECTED, even when old + beyond recency", () => {
    // A: old, beyond retention, non-LATEST, beyond keepRecent — archivable WITHOUT (b).
    const a = writeHandoff("lineage-input-old", 60 * DAY);
    // B: recent, references A via lineage.input_handoffs.
    writeHandoffWithLineage("referrer", 1 * DAY, [a]);
    const out = sweepArchivableHandoffs({
      now: NOW,
      retentionDays: 14,
      keepRecent: 0,
    });
    // (b): A is protected because a live handoff's lineage references it.
    expect(out.archivable.map((c) => c.name)).not.toContain(a);
  });

  it("Sharpening 1(i): a PRESENT-but-malformed frontmatter is PROTECTED, while a legacy NO-frontmatter handoff stays archivable", () => {
    // malformed: opener (---) present + unparseable body -> protect (can't read its
    // lineage, so don't archive it — "can't protect what you can't read").
    const malformed = "HANDOFF_malformed-old.md";
    const mPath = join(tmpDir, malformed);
    writeFileSync(mPath, "---\ngarbage: true\nfoo: bar\n---\n\n# malformed\n");
    const oldMtime = new Date(NOW - 60 * DAY);
    utimesSync(mPath, oldMtime, oldMtime);
    // legacy: NO opener -> normal archivable candidate (absence is legitimate, NOT
    // malformed — over-protecting these would break archival for every old handoff).
    const legacy = writeHandoff("legacy-none-old", 60 * DAY);
    const out = sweepArchivableHandoffs({
      now: NOW,
      retentionDays: 14,
      keepRecent: 0,
    });
    const names = out.archivable.map((c) => c.name);
    expect(names).not.toContain(malformed); // malformed-present protected
    expect(names).toContain(legacy); // legacy-absent still archivable
  });

  it("F2/F3 transparency: reports protected_referenced + protected_malformed so the operator sees WHAT (b) protected", () => {
    const a = writeHandoff("ref-target", 60 * DAY);
    writeHandoffWithLineage("referrer2", 1 * DAY, [a]);
    const malformed = "HANDOFF_malformed2.md";
    writeFileSync(join(tmpDir, malformed), "---\nbad: yaml\n---\n\n# m\n");
    const mt = new Date(NOW - 60 * DAY);
    utimesSync(join(tmpDir, malformed), mt, mt);
    const out = sweepArchivableHandoffs({
      now: NOW,
      retentionDays: 14,
      keepRecent: 0,
    });
    expect(out.protected_referenced).toContain(a);
    expect(out.protected_malformed).toContain(malformed);
    // ok stays TRUE: (b) protections are HEALTHY outcomes, not a degraded view
    // (Alpha convergent F2 — a healthy protection must never flip ok:false).
    expect(out.ok).toBe(true);
  });
});
