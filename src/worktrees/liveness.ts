// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SPAWN-3 — the liveness-GATED named-worktree reap enumeration.
 *
 * Composes (without modifying) the pure G6-P2 enumerator
 * (`worktrees/index.ts` `namedWorktreeReapCandidates`) with the two machine
 * checks it deliberately deferred:
 *
 *   1. a DEEP-ACTIVITY probe — closes the G6-P2 F1 staleness blind spot
 *      (`isWorktreeStale` keys on max(root-dir-mtime, HEAD commit-time), so a
 *      session editing only sub-directory or gitignored files reads STALE);
 *   2. the session-ATTACHMENT verdict — `isWorktreePathLive`
 *      (`active-sessions/session-liveness.ts`, the canonical liveness module).
 *
 * Layering (cohort-ratified design, board 2026-06-10): the BASE enumerator
 * stays a pure primitive and is NOT reap-safe by itself — every reap-purposed
 * caller MUST consume THIS wrapper. The wrapper returns the gated candidates
 * PLUS the excluded rows with reasons, so reports stay honest about what the
 * machine withheld and why (#174 honest-blind-spots precedent).
 *
 * Fail-direction (Decision 5, pre-ratified): `live` AND `indeterminate` are
 * both NOT reapable — only a clean `not-live` with a completed deep-scan
 * passes a candidate through. All probes are LOCAL (fs + git + same-host pid)
 * — the G6-P2 network-free constraint holds.
 *
 * HONESTY BOUND (do not over-claim): for a MANUAL named worktree worked from
 * a home-launched session, no attachment tier can fire (see the
 * tier-applicability matrix on `isWorktreePathLive`) and a fully-idle
 * attached session leaves no deep-activity trace past the floor — machine
 * liveness is BEST-EFFORT. The explicit human slug-confirm in the apply path
 * remains the FINAL liveness gate (G6-P2 F1(b)), and every consumer-facing
 * message must keep saying so.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeStdio, runGit } from "../git/index.ts";
import { GC_WINDOW_MS } from "../active-sessions/index.ts";
import { isWorktreePathLive } from "../active-sessions/session-liveness.ts";
import {
  namedWorktreeReapCandidates,
  type NamedWorktreeReapCandidate,
} from "./index.ts";

/** A clean+stale named worktree the gate WITHHELD from the reapable set. */
export type ExcludedNamedWorktree = {
  readonly path: string;
  readonly slug: string;
  /** Human-readable why — carries the tier/source so a vacuous-block is debuggable. */
  readonly reason: string;
};

export type GatedNamedWorktreeReapResult = {
  /** Clean + stale + deep-stale + not-live — the rows a human may now vet for apply. */
  readonly candidates: readonly NamedWorktreeReapCandidate[];
  /** Withheld rows (live / indeterminate / fresh-deep-activity) — NOT reapable. */
  readonly excluded: readonly ExcludedNamedWorktree[];
};

/**
 * Entry cap for the deep tree walk. A named worktree is a code checkout
 * (~2–5k files with `.git` + `node_modules` excluded); the cap only exists so
 * a pathological tree cannot stall a SessionStart hook. Hitting it without a
 * fresh-file verdict means the scan is INCOMPLETE → indeterminate (fail-safe),
 * never silently-stale.
 */
const DEEP_SCAN_ENTRY_CAP = 20_000;

type DeepActivityProbe =
  | { readonly kind: "stale" }
  | { readonly kind: "fresh"; readonly detail: string }
  | { readonly kind: "indeterminate"; readonly detail: string };

/**
 * Liveness-gated named-worktree reap candidates — THE reap-decision surface.
 *
 * Order per candidate: deep-activity probe first (cheap early-exit on fresh,
 * and its verdict is independent of registry state), then the attachment
 * verdict. `livenessWindowMs` bounds the ATTACHMENT tiers (default
 * `GC_WINDOW_MS` — the reaper convention); the deep-activity probe keys on
 * `staleFloorMs` (it is a STALENESS deepening, not an attachment signal — a
 * 2h-old scratch write must read fresh against the 48h floor, not against a
 * 60min liveness window).
 */
export function gatedNamedWorktreeReapCandidates(
  dotfilesCanonical: string,
  now: number,
  opts: {
    readonly staleFloorMs: number;
    readonly livenessWindowMs?: number;
    /** Test seam — forwarded to `isWorktreePathLive` (hermetic pidfile dir). */
    readonly sessionsDir?: string;
    /** Test seam — overrides `DEEP_SCAN_ENTRY_CAP` (cap-verdict coverage). */
    readonly deepScanEntryCap?: number;
  },
): GatedNamedWorktreeReapResult {
  const candidates: NamedWorktreeReapCandidate[] = [];
  const excluded: ExcludedNamedWorktree[] = [];
  for (const c of namedWorktreeReapCandidates(dotfilesCanonical, now, {
    staleFloorMs: opts.staleFloorMs,
  })) {
    const deep = deepActivityProbe(
      c.path,
      now,
      opts.staleFloorMs,
      opts.deepScanEntryCap ?? DEEP_SCAN_ENTRY_CAP,
    );
    if (deep.kind === "fresh") {
      excluded.push({
        path: c.path,
        slug: c.slug,
        reason: `recent-deep-activity: ${deep.detail}`,
      });
      continue;
    }
    if (deep.kind === "indeterminate") {
      excluded.push({
        path: c.path,
        slug: c.slug,
        reason: `liveness-indeterminate (deep-scan): ${deep.detail}`,
      });
      continue;
    }
    const live = isWorktreePathLive(
      c.path,
      now,
      opts.livenessWindowMs ?? GC_WINDOW_MS,
      opts.sessionsDir === undefined
        ? { dotfilesCanonical }
        : { dotfilesCanonical, sessionsDir: opts.sessionsDir },
    );
    if (live.verdict === "live") {
      excluded.push({
        path: c.path,
        slug: c.slug,
        reason: `live-session (${live.source}): ${live.detail}`,
      });
      continue;
    }
    if (live.verdict === "indeterminate") {
      excluded.push({
        path: c.path,
        slug: c.slug,
        reason: `liveness-indeterminate: ${live.reason}`,
      });
      continue;
    }
    candidates.push(c);
  }
  return { candidates, excluded };
}

/**
 * Newest write-activity probe over (a) the worktree TREE and (b) the
 * worktree's PRIVATE gitdir — fresh within `floorMs` means someone touched
 * this worktree after the shallow staleness check said idle.
 *
 * (a) Tree walk: lstat (NEVER follow symlinks — a provisioned worktree's
 *     `node_modules` symlinks to the canonical: following it would both
 *     explode the walk and read the CANONICAL's activity as the candidate's).
 *     `.git` and `node_modules` are excluded BY NAME at every depth; tree
 *     DIRECTORY mtimes count (entry create/delete is real activity — none of
 *     our own probes write inside the tree). Early-exits on the first fresh
 *     entry; `DEEP_SCAN_ENTRY_CAP` without a verdict → indeterminate.
 *
 * (b) Private gitdir (`git rev-parse --absolute-git-dir` →
 *     `<canonical>/.git/worktrees/<name>`): SPECIFIC FILES ONLY — HEAD,
 *     ORIG_HEAD, FETCH_HEAD, MERGE_HEAD, COMMIT_EDITMSG, logs/** and refs/**
 *     file entries. NEVER the gitdir's (or any) DIRECTORY mtime and never
 *     `index` / `*.lock`: the base enumerator's own `git status` probe
 *     refreshes the index (lock-create → rename), bumping `index` AND the
 *     directory mtime — reading either would make every sweep mark the
 *     worktree fresh and vacuous-block the feature (design-audit RE-3,
 *     measured live; the self-pollution regression test pins this).
 */
function deepActivityProbe(
  worktreePath: string,
  now: number,
  floorMs: number,
  entryCap: number,
): DeepActivityProbe {
  try {
    lstatSync(worktreePath);
  } catch {
    return {
      kind: "indeterminate",
      detail: `worktree root unstattable: ${worktreePath}`,
    };
  }

  // (a) tree walk — iterative, capped, early-exit.
  let visited = 0;
  const stack: string[] = [worktreePath];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return {
        kind: "indeterminate",
        detail: `unreadable directory during deep scan: ${dir}`,
      };
    }
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      visited += 1;
      if (visited > entryCap) {
        return {
          kind: "indeterminate",
          detail: `deep scan capped at ${String(entryCap)} entries without a verdict`,
        };
      }
      const path = join(dir, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(path);
      } catch {
        continue; // vanished mid-walk — benign race
      }
      // No `age >= 0` lower bound: a FUTURE-dated tree mtime (clock skew,
      // sync restore) is suspicious activity — fresh is the protective read.
      const age = now - st.mtimeMs;
      if (age < floorMs) {
        return {
          kind: "fresh",
          detail: `tree entry modified ${String(Math.round(Math.max(0, age) / (60 * 60 * 1000)))}h ago: ${path}`,
        };
      }
      if (st.isDirectory()) stack.push(path);
    }
  }

  // (b) private-gitdir file probes.
  const gitdirResult = runGit(worktreePath, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  if (gitdirResult.status !== 0) {
    return {
      kind: "indeterminate",
      detail:
        "private gitdir unresolvable (rev-parse --absolute-git-dir failed)",
    };
  }
  const gitdir = decodeStdio(gitdirResult.stdout).trim();
  if (gitdir.length === 0) {
    return { kind: "indeterminate", detail: "private gitdir resolved empty" };
  }
  for (const name of [
    "HEAD",
    "ORIG_HEAD",
    "FETCH_HEAD",
    "MERGE_HEAD",
    "COMMIT_EDITMSG",
  ]) {
    const fresh = freshFileMtime(join(gitdir, name), now, floorMs);
    if (fresh !== null) {
      return {
        kind: "fresh",
        detail: `gitdir ${name} modified ${fresh}h ago`,
      };
    }
  }
  for (const sub of ["logs", "refs"]) {
    const verdict = walkGitdirFiles(join(gitdir, sub), now, floorMs);
    if (verdict !== null) return verdict;
  }
  return { kind: "stale" };
}

/** Fresh-age in whole hours when the FILE at `path` is fresh; null otherwise. */
function freshFileMtime(
  path: string,
  now: number,
  floorMs: number,
): string | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return null; // absent (ORIG_HEAD etc. are optional) — no signal
  }
  if (!st.isFile()) return null;
  // No lower bound — future-dated counts fresh (protective; see tree walk).
  const age = now - st.mtimeMs;
  if (age < floorMs) {
    return String(Math.round(Math.max(0, age) / (60 * 60 * 1000)));
  }
  return null;
}

/**
 * Recursive FILE-mtime walk under a gitdir subtree (`logs/`, `refs/`).
 * Files only — directory mtimes are excluded (lock-churn bumps them; RE-3) —
 * and `index` / `*.lock` are skipped for the same self-pollution reason.
 */
function walkGitdirFiles(
  root: string,
  now: number,
  floorMs: number,
): DeepActivityProbe | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null; // subtree absent — no signal
  }
  for (const entry of entries) {
    if (entry === "index" || entry.endsWith(".lock")) continue;
    const path = join(root, entry);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const nested = walkGitdirFiles(path, now, floorMs);
      if (nested !== null) return nested;
      continue;
    }
    if (!st.isFile()) continue;
    // No lower bound — future-dated counts fresh (protective; see tree walk).
    const age = now - st.mtimeMs;
    if (age < floorMs) {
      return {
        kind: "fresh",
        detail: `gitdir ${path} modified ${String(Math.round(Math.max(0, age) / (60 * 60 * 1000)))}h ago`,
      };
    }
  }
  return null;
}
