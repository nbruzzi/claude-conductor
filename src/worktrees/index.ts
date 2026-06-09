// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — per-session git worktree manager.
 *
 * Plan: ~/.claude/plans/curious-whistling-sparrow.md REV 0.2.
 * R1 backlog reference: wiki/backlog.md `(R1) Per-session git worktrees`.
 * Eliminates shared-tree-bleed
 * (`feedback-parallel-session-shared-tree-branch-race.md`).
 *
 * Pure primitives over `git worktree`. No I/O wiring beyond spawning git.
 * Hook callers (provisioner / gc / cleanup) compose these with the
 * heartbeat-body sentinel + active-sessions registry; the primitive itself
 * is registry-agnostic.
 *
 * Convention (D2 — sibling-at-home): worktree path is the canonical path
 * with `-<sid-prefix-8>` appended. Example: canonical `~/.claude-dotfiles`
 * + session id `94a8058c-…` → worktree `~/.claude-dotfiles-94a8058c`. The
 * sid-prefix-8 is the first 8 hex characters of the session id (typed via
 * `isValidSessionId` upstream — this module trusts what it's given but
 * defends with light validation for fail-soft behavior).
 *
 * Branch convention (REV 0 D-Q2 resolved): each provisioned worktree gets
 * its own sentinel branch named `worktree/<sid-prefix-8>` from the
 * canonical's current HEAD. Operators can rename or discard; GC reaper
 * removes the worktree but does not auto-prune the branch (left as
 * Phase 3 polish to keep this primitive minimal).
 *
 * Feature flag: `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES`. Default-off in
 * this slice; provisionWorktree returns `kind: "feature-disabled"` when
 * the env var is unset, empty, or not `"1"`. Caller can override via
 * `opts.featureFlagOverride` (test escape hatch + explicit operator
 * intent path).
 */

import { decodeStdio, runGit } from "../git/index.ts";
import { effectiveHome } from "../shared/home.ts";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

export type WorktreePath = string;

export type ProvisionResult =
  | {
      readonly kind: "ok";
      readonly path: WorktreePath;
      readonly sessionId: string;
    }
  | {
      readonly kind: "exists";
      readonly path: WorktreePath;
      readonly sessionId: string;
    }
  | { readonly kind: "feature-disabled"; readonly reason: string }
  | { readonly kind: "error"; readonly detail: string };

export type RemoveResult =
  | { readonly kind: "removed"; readonly path: WorktreePath }
  | { readonly kind: "absent"; readonly path: WorktreePath }
  | {
      readonly kind: "error";
      readonly path: WorktreePath;
      readonly detail: string;
    };

export type WorktreeEntry = {
  readonly path: WorktreePath;
  readonly sessionId: string;
  readonly branch: string | null;
};

export type LinkResult =
  | { readonly kind: "ok" }
  | { readonly kind: "already-linked"; readonly existingTarget: string }
  | { readonly kind: "skip"; readonly reason: "canonical-has-no-node-modules" }
  | { readonly kind: "error"; readonly detail: string };

const SID_PREFIX_LEN = 8;
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";

/**
 * Compute the canonical per-session worktree path. Pure; no fs probe.
 *
 * `<dotfilesCanonical>-<sid-prefix-8>`. Trailing slashes on
 * dotfilesCanonical are stripped so the resulting path is well-formed.
 */
export function worktreePathForSession(
  sessionId: string,
  dotfilesCanonical: string,
): WorktreePath {
  const trimmed = dotfilesCanonical.replace(/\/+$/, "");
  const prefix = sessionId.slice(0, SID_PREFIX_LEN);
  return `${trimmed}-${prefix}`;
}

/**
 * Is `worktreeId` (the path tail after `<canonical>-`) a sid-prefix-shaped id —
 * exactly SID_PREFIX_LEN (8) lowercase-hex chars, the shape
 * {@link worktreePathForSession} produces for an AUTO-provisioned per-session
 * worktree?
 *
 * The worktree reapers use this to SCOPE themselves to worktrees they can safely
 * attribute to a session by sid-prefix. A MANUAL named-branch worktree
 * (`<canonical>-<nato>-<slug>`, e.g. `-delta-g2`, `-golf-item3`) has a slug tail,
 * NOT a sid-prefix: `sessionLivePrefixSource` can't attribute it (no session's
 * sid starts with the slug) and `removeWorktree`'s `slice(0, SID_PREFIX_LEN)`
 * truncates the slug to a WRONG path — a silent no-op the reaper re-logs
 * `worktree-cleanup-incomplete` every boot. So named worktrees are out of the
 * reaper's sid-prefix model — skipped, left to the operator sweep — until G6-P2
 * lands a safe-by-content (merged + clean + stale) named-reap path.
 * (G6-P1 reaper-coverage; CG5-exempt — a scope filter, not a liveness verdict.)
 */
export function isSidPrefixWorktreeId(worktreeId: string): boolean {
  // SID_PREFIX_LEN (8) lowercase-hex — the worktreePathForSession path shape.
  return /^[0-9a-f]{8}$/u.test(worktreeId);
}

/**
 * Provision a worktree for the session. Idempotent over the path:
 * a second call with the same sessionId returns `kind: "exists"`.
 *
 * Reads `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES` unless
 * `opts.featureFlagOverride` is set (test/operator escape hatch).
 *
 * Atomicity: relies on `git worktree add`'s own locking. Two concurrent
 * provisioners targeting the same path: the second sees the dir already
 * exists (post-first-create) and returns `kind: "exists"`. If they race
 * inside git's add, git's locking ensures one succeeds and the other
 * surfaces a lock error which we map to `kind: "error"`.
 */
export function provisionWorktree(
  sessionId: string,
  opts: {
    readonly dotfilesCanonical: string;
    readonly featureFlagOverride?: boolean;
  },
): ProvisionResult {
  if (!isFeatureEnabled(opts.featureFlagOverride)) {
    return {
      kind: "feature-disabled",
      reason: `${FEATURE_FLAG_ENV} unset or not "1"`,
    };
  }

  const path = worktreePathForSession(sessionId, opts.dotfilesCanonical);

  if (existsSync(path)) {
    return { kind: "exists", path, sessionId };
  }

  const branch = `worktree/${sessionId.slice(0, SID_PREFIX_LEN)}`;
  const result = runGit(opts.dotfilesCanonical, [
    "worktree",
    "add",
    "-b",
    branch,
    path,
  ]);

  if (result.status !== 0) {
    const stderr = decodeStdio(result.stderr) || decodeStdio(result.stdout);
    return {
      kind: "error",
      detail: stderr || `git worktree add exited ${String(result.status)}`,
    };
  }

  return { kind: "ok", path, sessionId };
}

/**
 * Remove the worktree for the session. Idempotent: returns `kind: "absent"`
 * if the worktree dir is already gone.
 *
 * Uses `git worktree remove --force` — the `--force` is required when the
 * worktree has uncommitted changes (Stop-hook firing on a session that
 * left WIP). RE-2 safety guards (refusing `--force` on mid-write state)
 * are caller-side concerns in the GC reaper hook + Stop-hook integration;
 * this primitive trusts the caller to have run those checks.
 *
 * Branch-cleanup ride-along (cycle-3 fix): after the worktree directory is
 * removed, also delete the `worktree/<sid-prefix-8>` branch via
 * `git branch -D`. Without this, branches accumulate forever (one per
 * session ever provisioned) and eventually cause UUID-prefix collisions
 * that break future provisioning. Branch-delete is fail-soft — if it errors
 * (branch already gone, ref-update transient), `removeWorktree` still
 * returns `{kind: "removed"}` since the load-bearing teardown (directory)
 * succeeded; the branch leak is best-effort hygiene per RE-2 pattern.
 */
export function removeWorktree(
  sessionId: string,
  opts: { readonly dotfilesCanonical: string },
): RemoveResult {
  const path = worktreePathForSession(sessionId, opts.dotfilesCanonical);

  if (!existsSync(path)) {
    return { kind: "absent", path };
  }

  const result = runGit(opts.dotfilesCanonical, [
    "worktree",
    "remove",
    "--force",
    path,
  ]);

  if (result.status !== 0) {
    const stderr = decodeStdio(result.stderr) || decodeStdio(result.stdout);
    return {
      kind: "error",
      path,
      detail: stderr || `git worktree remove exited ${String(result.status)}`,
    };
  }

  // Branch-cleanup ride-along (fail-soft). `git worktree remove --force`
  // dissociates the branch from the worktree but does NOT delete it —
  // we have to explicitly `git branch -D`.
  const branch = `worktree/${sessionId.slice(0, SID_PREFIX_LEN)}`;
  const branchResult = runGit(opts.dotfilesCanonical, ["branch", "-D", branch]);
  if (branchResult.status !== 0) {
    // Best-effort — log breadcrumb to stderr but don't fail the call.
    // Common benign cause: branch was already deleted by an earlier
    // cleanup pass or by the operator. Less common: ref-update transient
    // (e.g., concurrent gc) — caller will retry on next session-start
    // via dotfiles-worktree-gc reaper.
    const stderr =
      decodeStdio(branchResult.stderr) || decodeStdio(branchResult.stdout);
    process.stderr.write(
      `[worktrees.removeWorktree] branch-delete failed for ${branch}: ${stderr.trim()}\n`,
    );
  }

  return { kind: "removed", path };
}

/**
 * Remove a worktree by its FULL path (the G6-P2 named-worktree-reap path).
 *
 * {@link removeWorktree} derives the path from a sid-prefix via
 * `worktreePathForSession`'s `slice(0, SID_PREFIX_LEN)` — correct ONLY for an
 * AUTO-provisioned `<canonical>-<sid8>` worktree. For a MANUAL named worktree
 * (`<canonical>-<nato>-<slug>`) that slice truncates the slug to a WRONG path (a
 * silent no-op — the G6-P1 root cause). This variant removes the path VERBATIM,
 * and deletes the worktree's ACTUAL checked-out branch (resolved before removal),
 * not a `worktree/<sid8>` sentinel.
 *
 * Idempotent (`absent` when already gone). A detached HEAD skips the branch
 * delete. The CALLER owns the safety gates (clean + landed + stale + not-live)
 * before invoking this destructive primitive — this is the path-correct remover,
 * not a policy gate.
 */
export function removeWorktreeByPath(
  worktreePath: string,
  opts: { readonly dotfilesCanonical: string },
): RemoveResult {
  if (!existsSync(worktreePath)) {
    return { kind: "absent", path: worktreePath };
  }

  // Resolve the actual branch BEFORE removal (the worktree is gone after).
  const headResult = runGit(worktreePath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const branch =
    headResult.status === 0 ? decodeStdio(headResult.stdout).trim() : "";

  const result = runGit(opts.dotfilesCanonical, [
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
  if (result.status !== 0) {
    const stderr = decodeStdio(result.stderr) || decodeStdio(result.stdout);
    return {
      kind: "error",
      path: worktreePath,
      detail: stderr || `git worktree remove exited ${String(result.status)}`,
    };
  }

  // Branch-cleanup ride-along (fail-soft); skip a detached HEAD ("HEAD").
  if (branch !== "" && branch !== "HEAD") {
    const branchResult = runGit(opts.dotfilesCanonical, [
      "branch",
      "-D",
      branch,
    ]);
    if (branchResult.status !== 0) {
      const stderr =
        decodeStdio(branchResult.stderr) || decodeStdio(branchResult.stdout);
      process.stderr.write(
        `[worktrees.removeWorktreeByPath] branch-delete failed for ${branch}: ${stderr.trim()}\n`,
      );
    }
  }

  return { kind: "removed", path: worktreePath };
}

/**
 * Paths in a worktree that carry uncommitted work a `--force` removal would
 * destroy. Runs `git status --porcelain` in the worktree and ignores the
 * provisioner-created `node_modules` symlink (which always shows as untracked
 * because it is not git-ignored). Any remaining entry — staged, modified,
 * renamed, or other untracked — is WIP.
 *
 * Best-effort + fail-open: a git error (broken/missing worktree, git absent)
 * returns `[]` so a probe failure does not permanently block reaping (a
 * worktree whose git is broken would otherwise never be reapable). The
 * reaper's liveness gate + forensic-marker escape hatch remain the other
 * safety layers.
 *
 * RE-2 caller-side guard (see `removeWorktree`'s JSDoc): `removeWorktree` uses
 * `--force` and trusts the caller to refuse on WIP. This is that refusal probe;
 * `dotfiles-worktree-gc`'s `guardReason` consults it before reaping.
 */
export function worktreeUncommittedPaths(
  worktreePath: string,
): readonly string[] {
  const result = runGit(worktreePath, ["status", "--porcelain"]);
  if (result.status !== 0) return [];
  // Decode RAW — do NOT route porcelain through `decodeStdio`: it `.trim()`s,
  // and porcelain's worktree-side change lines carry a LOAD-BEARING leading
  // space (" M path"). Trimming the blob eats the first line's leading space,
  // so the `.slice(3)` below would drop the path's FIRST char — and a modified
  // file like `qnode_modules` could mangle to exactly `node_modules`, get
  // filtered out, and make a DIRTY tree read clean → a `--force` reap that
  // destroys WIP (the exact catastrophe this guard prevents). git C-quotes
  // embedded newlines, so splitting the untrimmed output on "\n" is safe.
  return (
    result.stdout
      .toString("utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      // Porcelain line is "XY <path>" (2 status columns + a space); slice the
      // fixed 3-char prefix off the RAW (untrimmed) line so the leading status
      // space is intact.
      .map((line) => line.slice(3))
      // The provisioner's node_modules symlink is always untracked but never
      // WIP — exclude it so a clean provisioned worktree still reaps.
      .filter(
        (path) => path !== "node_modules" && !path.startsWith("node_modules/"),
      )
  );
}

/**
 * Most-recent-activity signal for a worktree (unix ms): the later of its
 * directory mtime and its HEAD commit time. Conservative — ANY recent signal
 * reads fresh. Fail-safe for a DESTRUCTIVE caller: a stat error yields `now` (so
 * the worktree reads NOT stale → never a reap candidate). All-local, no network.
 */
export function worktreeLastActivityMs(
  worktreePath: string,
  now: number,
): number {
  let latest: number;
  try {
    latest = lstatSync(worktreePath).mtimeMs;
  } catch {
    return now;
  }
  const head = runGit(worktreePath, ["log", "-1", "--format=%ct"]);
  if (head.status === 0) {
    const ct = Number.parseInt(decodeStdio(head.stdout).trim(), 10);
    if (Number.isFinite(ct)) latest = Math.max(latest, ct * 1000);
  }
  return latest;
}

/** True when a worktree has had no activity (commit OR dir-mtime) for `floorMs`. */
export function isWorktreeStale(
  worktreePath: string,
  now: number,
  floorMs: number,
): boolean {
  return now - worktreeLastActivityMs(worktreePath, now) >= floorMs;
}

/**
 * A NAMED (non-sid-prefix) worktree that is CLEAN + STALE — a G6-P2 report
 * candidate. Carries informational landed-SIGNALS, NOT a verdict: the cohort
 * SQUASH-merge makes every cheap "merged" signal unreliable (`is-ancestor`=NO
 * because squash makes a NEW commit; the remote ref may still exist), so the
 * HUMAN confirms "landed" from these signals before an explicit apply (model-b,
 * decisions/phase-3 G6-P2). All signals are LOCAL git — the reaper stays
 * network-free (the fail-safe substrate tier).
 */
export type NamedWorktreeReapCandidate = {
  readonly path: WorktreePath;
  readonly slug: string;
  readonly branch: string | null;
  readonly isAncestorOfMain: boolean;
  readonly localRemoteRefExists: boolean;
  readonly commitsAheadOfMain: number;
  readonly lastActivityMs: number;
};

/**
 * Enumerate the NAMED worktrees that are CLEAN (no uncommitted) and STALE (no
 * activity for `staleFloorMs`) with their local landed-signals. PURE enumeration
 * — it NEVER reaps. Network-free + fail-safe: a DIRTY, FRESH, or stat/git-error
 * worktree is EXCLUDED. The caller (report or explicit apply) decides; the user
 * confirms LANDED. Used by both the opt-in reaper report and the apply path.
 *
 * STALENESS IS AN ACTIVITY HEURISTIC, NOT A LIVENESS VERDICT (Architecture-lens
 * fold): the named path has no sid-prefix to liveness-match, and `isWorktreeStale`
 * keys on max(dir-mtime, HEAD commit-time). A LIVE session working >floor in a
 * named worktree but editing only sub-directory files (no new commit, parent-dir
 * mtime unbumped) reads STALE — a false candidate. The landed-signals are
 * ADVISORY, not proof: `localRemoteRefExists` resolves a real remote ref for a
 * local branch coincidentally named after one (e.g. a branch literally `main`).
 * So a candidate is NOT "safe to delete" — it is a REPORT row a human vets. The
 * destructive apply MUST gate on liveness (a live-idle session is NOT caught by
 * the clean+stale TOCTOU re-verify) or per-candidate human confirm — see
 * `decisions/phase-3.md` G6-P2.
 */
export function namedWorktreeReapCandidates(
  dotfilesCanonical: string,
  now: number,
  opts: { readonly staleFloorMs: number },
): readonly NamedWorktreeReapCandidate[] {
  const out: NamedWorktreeReapCandidate[] = [];
  for (const wt of listWorktrees(dotfilesCanonical)) {
    if (isSidPrefixWorktreeId(wt.sessionId)) continue; // sid-prefix path owns those
    // Fail-CLOSED cleanliness probe (adversarial-pass finding): a worktree whose
    // own `git status` errors (severed .git link, unstattable cwd) has
    // UNVERIFIABLE cleanliness — `worktreeUncommittedPaths` fails OPEN (returns
    // [] = reads clean), which for a MANUAL named worktree (likely to hold
    // un-pushed WIP) would surface it as a reap candidate the tool never actually
    // checked. Exclude it — fail toward NOT-reporting (matching
    // `worktreeLastActivityMs` / `isNamedWorktreeReapReportEnabled`). Honors this
    // fn's JSDoc "a DIRTY, FRESH, or stat/git-error worktree is EXCLUDED".
    if (runGit(wt.path, ["status", "--porcelain"]).status !== 0) continue;
    if (worktreeUncommittedPaths(wt.path).length > 0) continue; // not DIRTY
    if (!isWorktreeStale(wt.path, now, opts.staleFloorMs)) continue; // not FRESH
    const head = decodeStdio(
      runGit(wt.path, ["rev-parse", "HEAD"]).stdout,
    ).trim();
    // Orphan/unborn HEAD (RE-lens NIT): `git rev-parse HEAD` fails but prints the
    // literal "HEAD" to stdout, so `head` is non-empty — skip rather than emit a
    // candidate whose landed-signals are all meaningless. (Such a worktree is
    // normally DIRTY → already excluded; belt-and-suspenders for the clean case.)
    if (head === "" || head === "HEAD") continue;
    const isAncestor =
      head.length > 0 &&
      runGit(dotfilesCanonical, [
        "merge-base",
        "--is-ancestor",
        head,
        "origin/main",
      ]).status === 0;
    const localRemoteRefExists =
      wt.branch !== null &&
      runGit(dotfilesCanonical, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${wt.branch}`,
      ]).status === 0;
    const aheadStr = decodeStdio(
      runGit(dotfilesCanonical, ["rev-list", "--count", head, "^origin/main"])
        .stdout,
    ).trim();
    const ahead = Number.parseInt(aheadStr, 10);
    out.push({
      path: wt.path,
      slug: wt.sessionId,
      branch: wt.branch,
      isAncestorOfMain: isAncestor,
      localRemoteRefExists,
      commitsAheadOfMain: Number.isFinite(ahead) ? ahead : -1,
      lastActivityMs: worktreeLastActivityMs(wt.path, now),
    });
  }
  return out;
}

/**
 * Default stale floor for the G6-P2 named-worktree-reap report (48h) — Alpha's
 * conservative ruling: a longer floor shrinks the live-idle-but-clean residual.
 */
export const NAMED_WORKTREE_STALE_FLOOR_MS = 48 * 60 * 60 * 1000;

/**
 * The opt-in flag gating the G6-P2 named-worktree-reap REPORT. ABSENT by default
 * (anti-default per CLAUDE.md — NEVER default-on a destructive-adjacent
 * capability): with no flag the reaper stays SILENT and nothing changes. Present
 * → the reaper EMITS the clean+stale named candidates (it still NEVER reaps; the
 * destructive apply is always user-driven via the dotfiles apply path).
 */
export function isNamedWorktreeReapReportEnabled(): boolean {
  try {
    return existsSync(
      join(effectiveHome(), ".claude", ".flags", "named-worktree-reap-enabled"),
    );
  } catch {
    return false;
  }
}

/**
 * One-line human report for a named-worktree reap candidate — the landed-SIGNALS
 * (is-ancestor / local-remote-ref / commits-ahead / idle-age) the USER reviews
 * before an explicit apply. NOT a verdict: the cohort SQUASH-merge breaks cheap
 * landed-detection (is-ancestor=NO on a squashed branch), so the human confirms.
 */
export function formatNamedWorktreeReapCandidate(
  c: NamedWorktreeReapCandidate,
  now: number,
): string {
  const ageH = Math.floor((now - c.lastActivityMs) / (60 * 60 * 1000));
  const landed = c.isAncestorOfMain
    ? "branch IS in main (true-merge — safe)"
    : `branch NOT in main (squash? ${c.commitsAheadOfMain} commit(s) ahead, remote-ref ${c.localRemoteRefExists ? "present" : "gone"}) — VERIFY its PR merged before apply`;
  return `${c.path} [${c.branch ?? "detached-HEAD"}]: clean + idle ${ageH}h — ${landed}`;
}

/**
 * Enumerate per-session worktrees registered with git for the given
 * canonical. Excludes the canonical itself and any operator-created
 * worktrees that don't follow the `<canonical>-<sid-prefix-8>` naming
 * convention — listWorktrees is intentionally narrow, returning only
 * worktrees this primitive could have provisioned.
 *
 * Returns `[]` on any git error (the canonical may not be a git repo
 * during early bootstrap; fail-soft to keep callers crash-free).
 */
export function listWorktrees(
  dotfilesCanonical: string,
): readonly WorktreeEntry[] {
  const trimmedCanonical = dotfilesCanonical.replace(/\/+$/, "");

  // Realpath both the canonical and each parsed worktree path so
  // sibling-at-home prefix matching works under macOS's `/var → /private/var`
  // symlink (and any other symlink shape the operator uses). Without this,
  // `git worktree list --porcelain` reports paths in their resolved form
  // while the caller's prefix may be in the symlink form, breaking the
  // match. See `feedback-cross-platform-tmpdir-divergence.md`.
  const realCanonical = tryRealpath(trimmedCanonical) ?? trimmedCanonical;
  const expectedPrefix = `${realCanonical}-`;

  const result = runGit(dotfilesCanonical, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) return [];

  const stdout = decodeStdio(result.stdout);
  return parseWorktreePorcelain(stdout, realCanonical, expectedPrefix);
}

/**
 * Symlink `<worktreePath>/node_modules` → `<canonicalPath>/node_modules`.
 *
 * Backlog `wiki/backlog.md:892` substrate canary fix. `git worktree add`
 * does not create or populate `node_modules/`, so cross-edge bun imports
 * (e.g., `import "claude-conductor/channels/cli"`) fail from the worktree.
 *
 * The canonical's `node_modules/claude-conductor/` is already a per-file
 * symlink mirror back to `~/Repos/claude-conductor/` (bun's `file:` protocol
 * shape). A single symlink at `<worktreePath>/node_modules` lets the worktree
 * reuse the canonical's resolution surface — microseconds vs `bun install`'s
 * ~10s cold cost, and eliminates lockfile-divergence concerns entirely.
 *
 * Idempotent: calling twice with the same args returns `already-linked` on
 * the second call. Safe for concurrent callers (filesystem `symlinkSync`
 * is atomic; two racers either both succeed (one creates, one returns
 * already-linked) or one races to create and the other returns already-linked
 * after observing the result).
 *
 * Refuses to overwrite an existing non-symlink or a symlink to a different
 * target — operator-created collisions are surfaced via `kind: "error"`
 * rather than silently destroyed. Operators can manually `rm node_modules`
 * before re-invocation if intentional.
 *
 * Path equality compares the literal `existingTarget` (what readlink returns
 * for the existing symlink) against `canonicalNm` (what we'd write). On
 * macOS the operator's canonical path and a symlink-tree's literal target
 * can differ (`/var` vs `/private/var`); a realpath-fallback compare
 * handles this without forcing the caller to normalize. See
 * `feedback-cross-platform-tmpdir-divergence.md`.
 */
export function linkCanonicalNodeModules(
  canonicalPath: string,
  worktreePath: string,
): LinkResult {
  const canonicalNm = join(canonicalPath, "node_modules");
  if (!existsSync(canonicalNm)) {
    return { kind: "skip", reason: "canonical-has-no-node-modules" };
  }

  const worktreeNm = join(worktreePath, "node_modules");
  const worktreeNmStat = tryLstat(worktreeNm);
  if (worktreeNmStat !== null) {
    if (!worktreeNmStat.isSymbolicLink()) {
      return {
        kind: "error",
        detail: `worktree node_modules exists and is not a symlink: ${worktreeNm}`,
      };
    }
    const existingTarget = tryReadlink(worktreeNm);
    if (existingTarget === null) {
      return {
        kind: "error",
        detail: `worktree node_modules is a symlink but readlink failed: ${worktreeNm}`,
      };
    }
    if (samePath(existingTarget, canonicalNm)) {
      return { kind: "already-linked", existingTarget };
    }
    return {
      kind: "error",
      detail: `worktree node_modules is a symlink to a different target: ${worktreeNm} -> ${existingTarget} (expected -> ${canonicalNm})`,
    };
  }

  try {
    symlinkSync(canonicalNm, worktreeNm, "dir");
    return { kind: "ok" };
  } catch (err: unknown) {
    // Race: a parallel caller (different OS process, different Claude session
    // hitting the same fresh worktree) won the symlink creation between our
    // tryLstat probe and this symlinkSync. Re-probe and return the equivalent
    // already-linked result if their write matches what we'd have written.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const existingTarget = tryReadlink(worktreeNm);
      if (existingTarget !== null && samePath(existingTarget, canonicalNm)) {
        return { kind: "already-linked", existingTarget };
      }
      return {
        kind: "error",
        detail: `race: worktree node_modules appeared with unexpected state during symlink creation at ${worktreeNm}`,
      };
    }
    return {
      kind: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

function isFeatureEnabled(override: boolean | undefined): boolean {
  if (override === true) return true;
  if (override === false) return false;
  return process.env[FEATURE_FLAG_ENV] === "1";
}

function tryLstat(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function tryReadlink(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * Compare two paths for equivalence with a realpath fallback. macOS-style
 * `/var` ↔ `/private/var` divergence (and other operator-symlinked roots)
 * means literal string compare can return false-mismatch for two paths that
 * resolve to the same inode. Tries literal compare first (cheap), then
 * realpath compare on mismatch (defensive). Either side's realpath failure
 * falls through to false — the caller treats that as "not equal" which is
 * the conservative outcome (refuse to overwrite).
 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const realA = tryRealpath(a);
  const realB = tryRealpath(b);
  if (realA === null || realB === null) return false;
  return realA === realB;
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Parse `git worktree list --porcelain`. The format is line-delimited
 * paragraphs separated by blank lines:
 *
 *   worktree /path/to/main
 *   HEAD <sha>
 *   branch refs/heads/main
 *
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/worktree/abc12345
 *
 * A worktree may be detached (no `branch` line, replaced by `detached`).
 */
function parseWorktreePorcelain(
  stdout: string,
  canonical: string,
  prefix: string,
): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = stdout.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split("\n");
    let path: string | null = null;
    let branch: string | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length).trim();
      }
    }

    if (path === null) continue;
    // Resolve through symlinks so prefix-match works on macOS where git
    // emits `/private/var/...` while the caller may carry `/var/...`.
    const realPath = tryRealpath(path) ?? path;
    if (realPath === canonical) continue;
    if (!realPath.startsWith(prefix)) continue;

    const sidPrefix = realPath.slice(prefix.length);
    if (sidPrefix.length === 0) continue;

    entries.push({ path: realPath, sessionId: sidPrefix, branch });
  }

  return entries;
}
