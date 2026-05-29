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
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import { getWallClockNow } from "../shared/clock.ts";
import { handoffsDir } from "../shared/paths.ts";
import { parseHandoffFrontmatter } from "./handoff-body-parser.ts";

/** Handoff file shape written by the `/handoff` skill: `HANDOFF_<id>.md`. */
const HANDOFF_FILE_RE = /^HANDOFF_.+\.md$/;
const HANDOFF_ARCHIVE_SUBDIR = ".archive";

/** `<handoffsDir>/.archive` — sibling of the channels `.archive/`. */
export function handoffArchiveDir(): string {
  return join(handoffsDir(), HANDOFF_ARCHIVE_SUBDIR);
}

/**
 * Basename of the handoff that `LATEST.md` points at, or `null` when LATEST is
 * legitimately absent (ENOENT) or not a symlink (EINVAL). Protected from
 * archival by {@link sweepArchivableHandoffs}.
 *
 * F1 (Pair-A RE shadow): the catch is NARROWED to the two legitimate "no LATEST
 * target" errnos. A TRANSIENT failure (EMFILE/ENFILE descriptor-exhaustion,
 * EACCES, ENOTDIR, ...) is RE-THROWN, never conflated with null — returning
 * null on a transient would make `c.name !== latest` true for EVERY candidate,
 * DEFEATING the (a)-LATEST protection and breaching this file's cardinal
 * contract ("never archive the active handoff"). The caller fails SAFE on the
 * rethrow. Deny-list over allow-list (feedback-deny-list-over-allow-list-for-skip-gates).
 */
export function latestTargetName(): string | null {
  try {
    return basename(readlinkSync(join(handoffsDir(), "LATEST.md")));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EINVAL") return null; // legitimately no LATEST target
    throw err; // transient — caller fails SAFE; never silently defeat LATEST-protection
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
  /**
   * F2/F3 ok-contract: `true` when every protection input was computed on a
   * RELIABLE view. `false` ONLY when a protection input could not be determined
   * and the sweep therefore fails SAFE (archivable `[]`) — currently the F1
   * transient-LATEST case ({@link latestTargetName} rethrow). A CLI `--apply`
   * MUST refuse to mutate when `ok` is false. The (b) malformed/unreadable
   * handoffs do NOT flip `ok` — protecting them is a HEALTHY outcome (surfaced in
   * {@link SweepHandoffsOutput.protected_malformed}), not a degraded view.
   */
  ok: boolean;
  total_handoffs: number;
  /** The LATEST target name (protected), or null. */
  protected_latest: string | null;
  keep_recent: number;
  /** (b) names protected because a live handoff's lineage references them. */
  protected_referenced: string[];
  /**
   * (b) Sharpening 1(i): names protected because their own frontmatter is
   * present-but-unparseable or unreadable (can't read their lineage; the (ii)
   * documented residual lives in {@link LineageScan}).
   */
  protected_malformed: string[];
  /** Old + non-LATEST + beyond-keepRecent + beyond-retention. NEVER mutated. */
  archivable: HandoffArchiveCandidate[];
};

/**
 * Result of {@link scanLineage}: the two (b) protection sets derived from one
 * read+parse pass over the handoffs.
 */
type LineageScan = {
  /**
   * (b) handoffs named as a `lineage.input_handoffs` entry by ANY live handoff —
   * protected from archival (never archive an ancestor a live handoff still
   * derives from), even when old. Basename-normalized (entries are filenames
   * like `HANDOFF_<id>.md`).
   */
  referenced: Set<string>;
  /**
   * Sharpening 1(i) (Pair-A shadow): handoffs whose frontmatter is PRESENT but
   * unparseable (opener `---` + parse-null) OR unreadable (read threw) — protected
   * as THEMSELVES ("can't protect what you can't read"; never archive a handoff
   * whose lineage we cannot determine). A legacy NO-frontmatter handoff (no opener)
   * is NOT here — its absence is legitimate; it stays a normal candidate (else we
   * would over-protect every old plain handoff and break archival).
   *
   * Sharpening 1(ii) DOCUMENTED RESIDUAL: a malformed/unreadable handoff X also
   * drops out of {@link referenced}, so any handoff X referenced loses X's
   * protection-vote and — if not referenced elsewhere + old — can still be
   * archived. Bounded + recoverable (archive is move-not-delete) + report-visible;
   * same accepted-residual class as increment-1's (b)-defer. Not fixable without
   * reading X.
   */
  malformedProtected: Set<string>;
};

/** True when `source` opens with a YAML frontmatter delimiter (block present). */
function hasFrontmatterOpener(source: string): boolean {
  return source.startsWith("---\n") || source.startsWith("---\r\n");
}

/**
 * Single read+parse pass over the handoffs deriving the (b) lineage-protection
 * sets — see {@link LineageScan} for the (i) protect-rule + (ii) residual.
 */
function scanLineage(dir: string, names: readonly string[]): LineageScan {
  const referenced = new Set<string>();
  const malformedProtected = new Set<string>();
  for (const name of names) {
    let source: string;
    try {
      source = readFileSync(join(dir, name), "utf-8");
    } catch {
      malformedProtected.add(name); // unreadable -> protect itself (Sharpening 1(i))
      continue;
    }
    const fm = parseHandoffFrontmatter(source);
    if (fm === null) {
      // PRESENT-but-malformed (opener) -> protect; legacy no-opener -> normal.
      if (hasFrontmatterOpener(source)) malformedProtected.add(name);
      continue;
    }
    const inputs = fm.lineage?.input_handoffs;
    if (inputs) for (const h of inputs) referenced.add(basename(h));
  }
  return { referenced, malformedProtected };
}

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
  // F1 (Pair-A RE shadow): a TRANSIENT LATEST-resolution failure must NOT be
  // treated as "no LATEST" (that defeats the (a)-protection). Fail SAFE — report
  // nothing archivable + ok:false (honest degraded report) so the active handoff
  // can never surface as archivable under a transient.
  let latest: string | null;
  try {
    latest = latestTargetName();
  } catch {
    return {
      ok: false,
      total_handoffs: 0,
      protected_latest: null,
      keep_recent: opts.keepRecent,
      protected_referenced: [],
      protected_malformed: [],
      archivable: [],
    };
  }
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

  // (b) lineage-input protection (increment-2): never archive a handoff a live
  // handoff still names as a lineage input, nor one whose own frontmatter we
  // can't read (Sharpening 1(i)). See scanLineage / LineageScan.
  const { referenced, malformedProtected } = scanLineage(dir, names);

  const archivable = all.filter(
    (c) =>
      c.name !== latest && // (a) LATEST target protected
      !recentProtected.has(c.name) && // (c) keepRecent protected
      !referenced.has(c.name) && // (b) lineage-referenced protected
      !malformedProtected.has(c.name) && // (b) Sharpening 1(i): unreadable protected
      c.ageMs > retentionMs, // (c) older than the recency window
  );

  return {
    ok: true,
    total_handoffs: all.length,
    protected_latest: latest,
    keep_recent: opts.keepRecent,
    protected_referenced: [...referenced].sort(),
    protected_malformed: [...malformedProtected].sort(),
    archivable,
  };
}

/**
 * Move a handoff file into `.archive/` (recoverable; NEVER deletes). Mirrors
 * {@link archiveChannel}: boundary-guard + `renameSync` + collision-stamp.
 * `opts.now` overrides the collision-stamp clock (defaults to
 * {@link getWallClockNow}); injected for deterministic tests, mirroring
 * {@link sweepArchivableHandoffs}'s `now`.
 */
export function archiveHandoff(
  name: string,
  opts: { now?: number } = {},
): void {
  if (!HANDOFF_FILE_RE.test(name)) {
    throw new Error(
      `[handoff-archive] archiveHandoff: invalid handoff name "${name}" — must match HANDOFF_<id>.md`,
    );
  }
  const src = join(handoffsDir(), name);
  const archive = handoffArchiveDir();
  mkdirSync(archive, { recursive: true });
  const dest = join(archive, name);
  if (!existsSync(dest)) {
    renameSync(src, dest);
    return;
  }
  // Don't overwrite a prior archived copy — stamp the new one. F5 (Pair-A shadow):
  // the timestamp alone collides if the SAME name is re-archived within one ms
  // (e.g. two same-minute handoffs from different sessions swept together). Append
  // a counter until the stamped name is free, so an archived copy is NEVER lost.
  const stamp = opts.now ?? getWallClockNow();
  let candidate = join(archive, `${name}__${stamp}`);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = join(archive, `${name}__${stamp}__${i}`);
    i++;
  }
  renameSync(src, candidate);
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
  // F4 (Pair-A shadow): .archive may exist but be unreadable / not-a-dir
  // (readdirSync throws ENOTDIR/EACCES). Tolerate it — nothing to prune — rather
  // than aborting; mirrors the sweep's enumeration tolerance + #175's N1.
  let archivedNames: string[];
  try {
    archivedNames = readdirSync(archive);
  } catch {
    return [];
  }
  for (const name of archivedNames) {
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
