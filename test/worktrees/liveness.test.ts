// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SPAWN-3 — gated named-worktree reap enumeration (`src/worktrees/liveness.ts`).
 *
 * Real git fixtures (makeTmpRepo — no mocking; the porcelain + worktree
 * behavior IS the contract). Registry/pidfile stores are sandboxed via the
 * same seams as worktree-path-liveness.test.ts.
 *
 * Pins:
 *   - pass-through: clean + stale + not-live → candidate, nothing excluded;
 *   - deep-activity exclusion (tree-file mtime bump that the shallow
 *     staleness misses — the G6-P2 F1 blind spot);
 *   - gitdir-activity exclusion (HEAD bump — per-worktree git op);
 *   - live-session exclusion via the sentinel tier;
 *   - indeterminate exclusion (fresh-malformed plausible-artifact poison);
 *   - RE-3 SELF-POLLUTION regression: two back-to-back gated runs must BOTH
 *     yield the candidate — the first run's own `git status` probe (index
 *     refresh) must not read as deep-activity on the second run;
 *   - walk-cap → indeterminate (fail-safe, never silently-stale);
 *   - the `./worktrees/liveness` exports-map entry (paired-test owner half).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { artifactIdFromPath } from "../../src/active-sessions/index.ts";
import { gatedNamedWorktreeReapCandidates } from "../../src/worktrees/liveness.ts";
import { makeTmpRepo, type TmpRepo } from "../../test-utils/index.ts";

const HOUR_MS = 60 * 60 * 1000;

let repo: TmpRepo | null = null;
let sessionsDir: string;
let registryDir: string;
let channelsDir: string;
let prevRegistryEnv: string | undefined;
let prevChannelsEnv: string | undefined;

beforeEach(() => {
  repo = makeTmpRepo();
  sessionsDir = join(repo.base, "sessions");
  registryDir = join(repo.base, "active-sessions");
  channelsDir = join(repo.base, "channels");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });
  prevRegistryEnv = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannelsEnv = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = registryDir;
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = channelsDir;
});

afterEach(() => {
  if (prevRegistryEnv === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevRegistryEnv;
  }
  if (prevChannelsEnv === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsEnv;
  }
  repo?.cleanup();
  repo = null;
});

function getRepo(): TmpRepo {
  if (repo === null) throw new Error("repo not initialized");
  return repo;
}

function addNamedWorktree(r: TmpRepo, slug: string, branch: string): string {
  const path = `${r.dir}-${slug}`;
  r.git("worktree", "add", path, "-b", branch);
  // One empty commit ahead — the squash-debt shape (clean tree, content ahead).
  r.git("-C", path, "commit", "--allow-empty", "-q", "-m", `work-${slug}`);
  return path;
}

function writeSentinelHeartbeat(
  sessionId: string,
  dotfilesRoot: string,
  mtimeMs: number,
): void {
  const dir = join(registryDir, "artifact-x", "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(
    path,
    `${JSON.stringify({
      sessionId,
      pid: 4242,
      host: "test-host",
      createdAt: 1,
      touchedAt: 1,
      dotfilesRoot,
    })}\n`,
  );
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

describe("gatedNamedWorktreeReapCandidates — pass-through + exclusions", () => {
  test("clean + stale + not-live named worktree → candidate, nothing excluded", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;
    addNamedWorktree(r, "bravo-done", "bravo-done-branch");

    const gated = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
    });
    expect(gated.candidates.map((c) => c.slug)).toEqual(["bravo-done"]);
    expect(gated.excluded).toEqual([]);
  });

  test("deep-activity: fresh mtime on a COMMITTED tree file (shallow-stale) → excluded", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;
    const wt = addNamedWorktree(r, "bravo-active", "bravo-active-branch");

    // The G6-P2 F1 blind spot: a file-level touch bumps neither the worktree
    // ROOT dir mtime nor the HEAD commit time, so the BASE enumerator still
    // reads stale — only the deep probe can see it. Content is unchanged, so
    // the tree stays CLEAN.
    const treeFile = join(wt, ".gitkeep");
    utimesSync(treeFile, now / 1000, now / 1000);

    const gated = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
    });
    expect(gated.candidates).toEqual([]);
    expect(gated.excluded.length).toBe(1);
    expect(gated.excluded[0]?.slug).toBe("bravo-active");
    expect(gated.excluded[0]?.reason).toContain("recent-deep-activity");
  });

  test("gitdir-activity: fresh private-gitdir HEAD → excluded", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;
    const wt = addNamedWorktree(r, "bravo-gitop", "bravo-gitop-branch");

    const gitdir = r.git("-C", wt, "rev-parse", "--absolute-git-dir").trim();
    utimesSync(join(gitdir, "HEAD"), now / 1000, now / 1000);

    const gated = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
    });
    expect(gated.candidates).toEqual([]);
    expect(gated.excluded[0]?.reason).toContain("gitdir HEAD modified");
  });

  test("live session (sentinel tier) → excluded with the live reason", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;
    const wt = addNamedWorktree(r, "bravo-live", "bravo-live-branch");
    writeSentinelHeartbeat("sess-live", realpathSync(wt), now);

    const gated = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
    });
    expect(gated.candidates).toEqual([]);
    expect(gated.excluded.length).toBe(1);
    expect(gated.excluded[0]?.reason).toContain(
      "live-session (sentinel-dotfilesroot)",
    );
  });

  test("Decision 5: fresh-malformed heartbeat on the repo-family artifact → excluded as indeterminate", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;
    addNamedWorktree(r, "bravo-fog", "bravo-fog-branch");

    // Poison the candidate's OWN repo-family artifact (artifactIdFromPath of a
    // path inside a git tree canonicalizes to the canonical toplevel — r.dir).
    const familyArtifact = artifactIdFromPath(r.dir);
    const dir = join(registryDir, familyArtifact, "heartbeats");
    mkdirSync(dir, { recursive: true });
    const poison = join(dir, "sess-poison");
    writeFileSync(poison, "{{not json");
    utimesSync(poison, now / 1000, now / 1000);

    const gated = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
    });
    expect(gated.candidates).toEqual([]);
    expect(gated.excluded[0]?.reason).toContain("liveness-indeterminate");
  });

  test("RE-3 self-pollution regression: two back-to-back gated runs BOTH yield the candidate", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;
    addNamedWorktree(r, "bravo-stale", "bravo-stale-branch");

    // First run executes the base enumerator's `git status` probe (index
    // refresh: lock create → rename, bumping `index` + the gitdir DIR mtime)
    // plus all read-probes. If the deep probe read either polluted mtime, the
    // SECOND run would flip the worktree to excluded("recent-deep-activity")
    // and the feature would vacuous-block itself on every sweep.
    const first = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
    });
    const second = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
    });
    expect(first.candidates.map((c) => c.slug)).toEqual(["bravo-stale"]);
    expect(second.candidates.map((c) => c.slug)).toEqual(["bravo-stale"]);
    expect(second.excluded).toEqual([]);
  });

  test("walk-cap hit without a verdict → excluded as indeterminate (fail-safe)", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;
    const wt = addNamedWorktree(r, "bravo-big", "bravo-big-branch");
    // A handful of stale files; with cap=1 the walk cannot complete.
    for (const n of ["a", "b", "c", "d"]) {
      writeFileSync(join(wt, n), n);
    }
    r.git("-C", wt, "add", ".");
    r.git("-C", wt, "commit", "-q", "-m", "files", "--no-gpg-sign");

    const gated = gatedNamedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
      sessionsDir,
      deepScanEntryCap: 1,
    });
    expect(gated.candidates).toEqual([]);
    expect(gated.excluded[0]?.reason).toContain("deep scan capped");
  });
});

describe("./worktrees/liveness exports-map entry (paired-test owner half)", () => {
  test("entry exists with all three conditions pointing at the module", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "../../package.json"), "utf-8"),
    ) as {
      exports: Record<
        string,
        { types: string; import: string; default: string } | undefined
      >;
    };
    const entry = pkg.exports["./worktrees/liveness"];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.types).toBe("./src/worktrees/liveness.ts");
    expect(entry.import).toBe("./src/worktrees/liveness.ts");
    expect(entry.default).toBe("./src/worktrees/liveness.ts");
  });
});
