// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 6 item-3 — handoff archive/prune (teardown parity; agetor steal-list
 * A-P1-7 sibling). Mirrors the channels archive/prune contract
 * ({@link archiveChannel} / {@link pruneArchive} in index.ts) for handoff files
 * under {@link handoffsDir}.
 *
 * Cardinal safety contract — **NEVER auto-delete** (mirrors Cycle-2
 * reconcile-boot):
 *   - {@link sweepArchivableHandoffs} is REPORT-ONLY (never mutates the fs);
 *   - {@link archiveHandoff} MOVES a handoff into `.archive/` (recoverable),
 *     never deletes; collision-stamps rather than overwriting;
 *   - {@link pruneHandoffArchive} deletes only ALREADY-ARCHIVED entries past
 *     the retention/cap (the explicit GC step).
 *
 * Reference-awareness (this increment): the sweep protects
 *   (a) the LATEST symlink target — never archive the active handoff; and
 *   (c) a recency window — `keepRecent` most-recent (by mtime) + anything
 *       younger than `retentionDays`. Keep the window CONSERVATIVELY GENEROUS.
 *
 * DEFERRED to increment-2 — (b) explicit lineage-input_handoffs protection
 * (parseHandoffFrontmatter/parseLineageEnvelope). Bounded residual: an OLD
 * lineage-referenced handoff (older than the recency window) could be archived.
 * That residual is (i) recoverable from `.archive/` (move-not-delete),
 * (ii) VISIBLE in the report before any `--apply`, and (iii) hardened in
 * increment-2. Largely subsumed today because supersedes-chain heads are recent
 * (so (c) protects them); only a deep chain reaching an old input is exposed.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import { getWallClockNow } from "../shared/clock.ts";
import { handoffsDir } from "../shared/paths.ts";

/** Handoff file shape written by the `/handoff` skill: `HANDOFF_<id>.md`. */
const HANDOFF_FILE_RE = /^HANDOFF_.+\.md$/;
const HANDOFF_ARCHIVE_SUBDIR = ".archive";

/** `<handoffsDir>/.archive` — sibling of the channels `.archive/`. */
export function handoffArchiveDir(): string {
  return join(handoffsDir(), HANDOFF_ARCHIVE_SUBDIR);
}

/**
 * Basename of the handoff that `LATEST.md` points at, or `null` when LATEST is
 * absent, broken, or not a symlink. The returned name is protected from
 * archival by {@link sweepArchivableHandoffs}.
 */
export function latestTargetName(): string | null {
  try {
    return basename(readlinkSync(join(handoffsDir(), "LATEST.md")));
  } catch {
    return null;
  }
}

export type HandoffArchiveCandidate = {
  /** `HANDOFF_<id>.md` */
  name: string;
  mtimeMs: number;
  ageMs: number;
};

export type SweepHandoffsOptions = {
  now: number;
  /** Recency window in days — handoffs younger than this are never archivable. */
  retentionDays: number;
  /** Always protect the N most-recent handoffs (by mtime), regardless of age. */
  keepRecent: number;
};

export type SweepHandoffsOutput = {
  ok: boolean;
  total_handoffs: number;
  /** The LATEST target name (protected), or null. */
  protected_latest: string | null;
  keep_recent: number;
  /** Old + non-LATEST + beyond-keepRecent + beyond-retention. NEVER mutated. */
  archivable: HandoffArchiveCandidate[];
};

/**
 * Report-only sweep: enumerate handoffs and return the archivable candidates.
 * Protects (a) the LATEST target and (c) the recency window
 * (`keepRecent` most-recent + anything younger than `retentionDays`). Does NOT
 * touch the filesystem — the caller invokes {@link archiveHandoff} per
 * candidate under an explicit `--apply`.
 */
export function sweepArchivableHandoffs(
  opts: SweepHandoffsOptions,
): SweepHandoffsOutput {
  const dir = handoffsDir();
  const latest = latestTargetName();
  const retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => HANDOFF_FILE_RE.test(n));
  } catch {
    names = [];
  }

  const all: HandoffArchiveCandidate[] = [];
  for (const name of names) {
    try {
      const mtimeMs = statSync(join(dir, name)).mtimeMs;
      all.push({ name, mtimeMs, ageMs: opts.now - mtimeMs });
    } catch {
      /* unreadable entry — skip (mirrors pruneArchive's per-entry tolerance) */
    }
  }

  // (c) keepRecent: the N most-recent by mtime are always protected.
  const recentProtected = new Set(
    [...all]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, opts.keepRecent))
      .map((c) => c.name),
  );

  const archivable = all.filter(
    (c) =>
      c.name !== latest && // (a) LATEST target protected
      !recentProtected.has(c.name) && // (c) keepRecent protected
      c.ageMs > retentionMs, // (c) older than the recency window
  );

  return {
    ok: true,
    total_handoffs: all.length,
    protected_latest: latest,
    keep_recent: opts.keepRecent,
    archivable,
  };
}

/**
 * Move a handoff file into `.archive/` (recoverable; NEVER deletes). Mirrors
 * {@link archiveChannel}: boundary-guard + `renameSync` + collision-stamp.
 */
export function archiveHandoff(name: string): void {
  if (!HANDOFF_FILE_RE.test(name)) {
    throw new Error(
      `[handoff-archive] archiveHandoff: invalid handoff name "${name}" — must match HANDOFF_<id>.md`,
    );
  }
  const src = join(handoffsDir(), name);
  const archive = handoffArchiveDir();
  mkdirSync(archive, { recursive: true });
  const dest = join(archive, name);
  if (existsSync(dest)) {
    // Don't overwrite a prior archived copy — stamp the new one.
    renameSync(src, join(archive, `${name}__${getWallClockNow()}`));
    return;
  }
  renameSync(src, dest);
}

/**
 * Purge ALREADY-ARCHIVED handoffs older than `retentionDays`, then cap the
 * archive at `maxEntries` (oldest first). Mirrors {@link pruneArchive}. Returns
 * the purged names. This is the only delete path — it never touches live
 * handoffs, only `.archive/` contents.
 */
export function pruneHandoffArchive(opts: {
  retentionDays: number;
  maxEntries: number;
}): string[] {
  const archive = handoffArchiveDir();
  if (!existsSync(archive)) return [];
  const now = getWallClockNow();
  const retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;

  type Entry = { name: string; path: string; mtimeMs: number };
  const entries: Entry[] = [];
  for (const name of readdirSync(archive)) {
    const path = join(archive, name);
    try {
      entries.push({ name, path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      /* skip */
    }
  }

  const purged: string[] = [];
  for (const e of entries) {
    if (now - e.mtimeMs > retentionMs) {
      rmSync(e.path, { recursive: true, force: true });
      purged.push(e.name);
    }
  }

  const remaining = entries.filter((e) => !purged.includes(e.name));
  if (remaining.length > opts.maxEntries) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = remaining.length - opts.maxEntries;
    for (let i = 0; i < excess; i++) {
      const entry = remaining[i];
      if (!entry) continue;
      rmSync(entry.path, { recursive: true, force: true });
      purged.push(entry.name);
    }
  }

  return purged;
}
