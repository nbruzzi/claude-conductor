// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — primitives matrix for `src/worktrees/index.ts`.
 *
 * Covers:
 * - worktreePathForSession: deterministic + sid-prefix-8 + trailing-slash strip.
 * - provisionWorktree: feature-flag gates (env unset, env != "1",
 *   featureFlagOverride=true, featureFlagOverride=false), success path,
 *   idempotent re-provision returning kind: "exists", error mapping
 *   (non-zero git exit → kind: "error" with detail).
 * - removeWorktree: present + absent + error paths.
 * - listWorktrees: empty list, single per-session worktree, multiple
 *   worktrees, canonical filtered out, non-convention worktrees ignored,
 *   git-error returns [].
 *
 * Real git fixtures via makeTmpRepo (no mocking — git's actual worktree
 * locking + porcelain output format is what we rely on, so testing
 * against a stub would mask real-world failure modes).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  forensicMarkerActive,
  formatNamedWorktreeReapCandidate,
  isSidPrefixWorktreeId,
  isWorktreeStale,
  linkCanonicalNodeModules,
  listWorktrees,
  NAMED_WORKTREE_STALE_FLOOR_MS,
  namedWorktreeReapCandidates,
  type NamedWorktreeReapCandidate,
  provisionWorktree,
  removeWorktree,
  removeWorktreeByPath,
  worktreeLastActivityMs,
  worktreePathForSession,
  worktreeReapGuard,
} from "../../src/worktrees/index.ts";
import {
  makeTmpHome,
  makeTmpRepo,
  type TmpRepo,
} from "../../test-utils/index.ts";

const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";
const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";
const SID2 = "76b84abc-a6a2-4395-bb65-f5bd799c525c";

describe("isSidPrefixWorktreeId — G6-P1 reaper scope filter", () => {
  it("accepts an 8-char lowercase-hex sid-prefix (the auto-provisioned shape)", () => {
    expect(isSidPrefixWorktreeId("94a8058c")).toBe(true);
    expect(isSidPrefixWorktreeId(SID.slice(0, 8))).toBe(true);
  });

  it("rejects a MANUAL named-branch slug (the worktree-debt class)", () => {
    for (const named of [
      "delta-g2",
      "golf-item3",
      "charlie-d3a",
      "charlie-d3-03342ac4",
      "bravo-nudge-kind",
    ]) {
      expect(isSidPrefixWorktreeId(named)).toBe(false);
    }
  });

  it("rejects wrong-length or non-hex ids (exactly 8, lowercase 0-9a-f)", () => {
    expect(isSidPrefixWorktreeId("94a8058")).toBe(false); // 7 chars
    expect(isSidPrefixWorktreeId("94a8058cd")).toBe(false); // 9 chars
    expect(isSidPrefixWorktreeId("94A8058C")).toBe(false); // uppercase
    expect(isSidPrefixWorktreeId("94a8058g")).toBe(false); // non-hex 'g'
    expect(isSidPrefixWorktreeId("")).toBe(false);
  });
});

let repo: TmpRepo | null = null;
let prevFlag: string | undefined;

beforeEach(() => {
  repo = makeTmpRepo();
  prevFlag = process.env[FEATURE_FLAG_ENV];
  delete process.env[FEATURE_FLAG_ENV];
});

afterEach(() => {
  if (repo !== null) {
    repo.cleanup();
    repo = null;
  }
  if (prevFlag === undefined) {
    delete process.env[FEATURE_FLAG_ENV];
  } else {
    process.env[FEATURE_FLAG_ENV] = prevFlag;
  }
});

function getRepo(): TmpRepo {
  if (repo === null) throw new Error("repo not initialized");
  return repo;
}

describe("worktreePathForSession", () => {
  it("appends -<sid-prefix-8> to the canonical", () => {
    const path = worktreePathForSession(SID, "/tmp/.claude-dotfiles");
    expect(path).toBe("/tmp/.claude-dotfiles-94a8058c");
  });

  it("strips trailing slashes from the canonical", () => {
    const path = worktreePathForSession(SID, "/tmp/.claude-dotfiles///");
    expect(path).toBe("/tmp/.claude-dotfiles-94a8058c");
  });

  it("is deterministic — same sid + canonical → same path", () => {
    const p1 = worktreePathForSession(SID, "/x/y");
    const p2 = worktreePathForSession(SID, "/x/y");
    expect(p1).toBe(p2);
  });

  it("uses exactly the first 8 hex chars of the session id", () => {
    const path = worktreePathForSession(SID, "/x/y");
    expect(path).toBe("/x/y-94a8058c");
    expect(path.endsWith("-94a8058c")).toBe(true);
  });
});

describe("provisionWorktree — feature-flag gating", () => {
  it("returns feature-disabled when env is unset", () => {
    const result = provisionWorktree(SID, { dotfilesCanonical: getRepo().dir });
    expect(result.kind).toBe("feature-disabled");
    if (result.kind === "feature-disabled") {
      expect(result.reason).toContain(FEATURE_FLAG_ENV);
    }
  });

  it("returns feature-disabled when env is not exactly '1'", () => {
    process.env[FEATURE_FLAG_ENV] = "true";
    const result = provisionWorktree(SID, { dotfilesCanonical: getRepo().dir });
    expect(result.kind).toBe("feature-disabled");
  });

  it("returns feature-disabled when env is empty string", () => {
    process.env[FEATURE_FLAG_ENV] = "";
    const result = provisionWorktree(SID, { dotfilesCanonical: getRepo().dir });
    expect(result.kind).toBe("feature-disabled");
  });

  it("featureFlagOverride=true bypasses env-unset", () => {
    const result = provisionWorktree(SID, {
      dotfilesCanonical: getRepo().dir,
      featureFlagOverride: true,
    });
    expect(result.kind).toBe("ok");
  });

  it("featureFlagOverride=false suppresses even when env=1", () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const result = provisionWorktree(SID, {
      dotfilesCanonical: getRepo().dir,
      featureFlagOverride: false,
    });
    expect(result.kind).toBe("feature-disabled");
  });

  it("env=1 alone enables provisioning", () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const result = provisionWorktree(SID, { dotfilesCanonical: getRepo().dir });
    expect(result.kind).toBe("ok");
  });
});

describe("provisionWorktree — success + idempotent", () => {
  it("creates the worktree at the expected sibling-at-home path", () => {
    const r = getRepo();
    const result = provisionWorktree(SID, {
      dotfilesCanonical: r.dir,
      featureFlagOverride: true,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.path).toBe(`${r.dir}-94a8058c`);
      expect(result.sessionId).toBe(SID);
      expect(existsSync(result.path)).toBe(true);
    }
  });

  it("creates the sentinel branch worktree/<sid-prefix-8>", () => {
    const r = getRepo();
    provisionWorktree(SID, {
      dotfilesCanonical: r.dir,
      featureFlagOverride: true,
    });
    const branches = r.git("branch", "--list", "worktree/94a8058c").trim();
    expect(branches).toContain("worktree/94a8058c");
  });

  it("re-provisioning the same sid returns kind: 'exists'", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    const first = provisionWorktree(SID, opts);
    expect(first.kind).toBe("ok");
    const second = provisionWorktree(SID, opts);
    expect(second.kind).toBe("exists");
    if (second.kind === "exists") {
      expect(second.path).toBe(`${r.dir}-94a8058c`);
    }
  });

  it("provisioning two distinct sids creates two worktrees", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    const a = provisionWorktree(SID, opts);
    const b = provisionWorktree(SID2, opts);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind === "ok" && b.kind === "ok") {
      expect(a.path).not.toBe(b.path);
      expect(existsSync(a.path)).toBe(true);
      expect(existsSync(b.path)).toBe(true);
    }
  });
});

describe("provisionWorktree — error path", () => {
  it("returns kind: 'error' with detail when git fails", () => {
    // Force a git failure: remove the .git dir so git can't add a worktree.
    // existsSync would catch a pre-existing worktree path BEFORE git runs,
    // so the conflict has to be at a layer the primitive can't intercept.
    const r = getRepo();
    execFileSync("rm", ["-rf", join(r.dir, ".git")]);
    const result = provisionWorktree(SID, {
      dotfilesCanonical: r.dir,
      featureFlagOverride: true,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("removeWorktree", () => {
  it("returns kind: 'absent' when no worktree exists for the sid", () => {
    const result = removeWorktree(SID, { dotfilesCanonical: getRepo().dir });
    expect(result.kind).toBe("absent");
    if (result.kind === "absent") {
      expect(result.path).toBe(`${getRepo().dir}-94a8058c`);
    }
  });

  it("removes a provisioned worktree and returns kind: 'removed'", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    const provisioned = provisionWorktree(SID, opts);
    expect(provisioned.kind).toBe("ok");

    const removed = removeWorktree(SID, { dotfilesCanonical: r.dir });
    expect(removed.kind).toBe("removed");
    if (removed.kind === "removed") {
      expect(existsSync(removed.path)).toBe(false);
    }
  });

  it("force-removes a worktree even with uncommitted changes", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    const provisioned = provisionWorktree(SID, opts);
    expect(provisioned.kind).toBe("ok");
    if (provisioned.kind !== "ok") return;

    // Leave a dirty file in the worktree.
    writeFileSync(join(provisioned.path, "wip.txt"), "uncommitted work");
    const removed = removeWorktree(SID, { dotfilesCanonical: r.dir });
    expect(removed.kind).toBe("removed");
  });

  // Cycle-3 fix: branch-cleanup ride-along. removeWorktree should also
  // delete the `worktree/<sid-prefix>` branch to prevent UUID-prefix
  // collisions on future provisioning. See plan v1.1 §"What we gain".
  it("deletes the worktree branch after removing the directory (branch-cleanup ride-along)", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    const provisioned = provisionWorktree(SID, opts);
    expect(provisioned.kind).toBe("ok");

    // Pre-condition: provisioning creates the branch
    const branchListPre = execFileSync(
      "git",
      ["branch", "--list", "worktree/94a8058c"],
      {
        cwd: r.dir,
        encoding: "utf-8",
      },
    );
    expect(branchListPre.trim()).toContain("worktree/94a8058c");

    const removed = removeWorktree(SID, { dotfilesCanonical: r.dir });
    expect(removed.kind).toBe("removed");

    // Post-condition: branch should be gone
    const branchListPost = execFileSync(
      "git",
      ["branch", "--list", "worktree/94a8058c"],
      {
        cwd: r.dir,
        encoding: "utf-8",
      },
    );
    expect(branchListPost.trim()).toBe("");
  });

  // Cycle-3 fix per Bravo Lane D TA-1 fold: branch-delete-after-checkout-
  // in-removed-worktree edge case. Verifies `git worktree remove --force`
  // properly dissociates the branch BEFORE our `git branch -D` runs, so
  // the branch deletion succeeds even when the operator was inside the
  // worktree at remove-time. Locks in this behavior so a future git-version
  // change wouldn't silently leave the branch behind.
  it("deletes the branch even when HEAD was checked out inside the removed worktree (TA-1 edge case)", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    const provisioned = provisionWorktree(SID, opts);
    expect(provisioned.kind).toBe("ok");
    if (provisioned.kind !== "ok") return;

    // Operator-style: inside the worktree, HEAD is already at the
    // sentinel branch by virtue of provisioning. `git worktree add -b
    // worktree/<sid>` creates the branch + makes it checked-out in the
    // new worktree. Verify HEAD inside the worktree:
    const headInWorktree = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: provisioned.path,
        encoding: "utf-8",
      },
    );
    expect(headInWorktree.trim()).toBe("worktree/94a8058c");

    // Now remove + verify branch is deleted (worktree-remove --force
    // dissociates the branch first; branch -D succeeds afterward).
    const removed = removeWorktree(SID, { dotfilesCanonical: r.dir });
    expect(removed.kind).toBe("removed");

    const branchList = execFileSync(
      "git",
      ["branch", "--list", "worktree/94a8058c"],
      {
        cwd: r.dir,
        encoding: "utf-8",
      },
    );
    expect(branchList.trim()).toBe("");
  });

  // Cycle-3 fix: fail-soft on branch-delete error. If the worktree directory
  // removal succeeds but `git branch -D` fails (e.g., branch already gone),
  // removeWorktree should STILL return `kind: "removed"` rather than `error`.
  // The load-bearing teardown is the directory; branch is best-effort hygiene.
  it("returns kind: 'removed' even when branch-delete fails (fail-soft)", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    const provisioned = provisionWorktree(SID, opts);
    expect(provisioned.kind).toBe("ok");

    // Pre-emptively delete the branch so removeWorktree's `git branch -D`
    // attempt fails. We do this by switching the worktree off the branch
    // and then deleting the branch from canonical. After this manipulation,
    // `git worktree remove --force` will succeed but the subsequent
    // `git branch -D` will fail with "branch not found".
    if (provisioned.kind === "ok") {
      // Detach HEAD inside the worktree so the branch isn't checked out
      execFileSync("git", ["-C", provisioned.path, "checkout", "--detach"], {
        encoding: "utf-8",
      });
      // Delete the branch from canonical
      execFileSync("git", ["branch", "-D", "worktree/94a8058c"], {
        cwd: r.dir,
        encoding: "utf-8",
      });
    }

    const removed = removeWorktree(SID, { dotfilesCanonical: r.dir });
    // Despite the branch-delete error inside removeWorktree, kind is "removed"
    expect(removed.kind).toBe("removed");
  });
});

describe("listWorktrees", () => {
  it("returns [] when no per-session worktrees exist", () => {
    const list = listWorktrees(getRepo().dir);
    expect(list).toEqual([]);
  });

  it("returns [] when canonical is not a git repo", () => {
    const r = getRepo();
    execFileSync("rm", ["-rf", join(r.dir, ".git")]);
    expect(listWorktrees(r.dir)).toEqual([]);
  });

  it("lists a single provisioned worktree", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    provisionWorktree(SID, opts);

    const list = listWorktrees(r.dir);
    expect(list.length).toBe(1);
    // listWorktrees returns realpath-resolved paths so prefix matching works
    // under macOS's /var → /private/var symlink. Compare against realpath.
    expect(list[0]?.path).toBe(`${realpathSync(r.dir)}-94a8058c`);
    expect(list[0]?.sessionId).toBe("94a8058c");
    expect(list[0]?.branch).toBe("worktree/94a8058c");
  });

  it("lists multiple provisioned worktrees", () => {
    const r = getRepo();
    const opts = { dotfilesCanonical: r.dir, featureFlagOverride: true };
    provisionWorktree(SID, opts);
    provisionWorktree(SID2, opts);

    const list = listWorktrees(r.dir);
    expect(list.length).toBe(2);
    const sids = list.map((e) => e.sessionId).sort();
    expect(sids).toEqual(["76b84abc", "94a8058c"]);
  });

  it("excludes the canonical itself from the list", () => {
    const r = getRepo();
    const list = listWorktrees(r.dir);
    expect(list.find((e) => e.path === r.dir)).toBeUndefined();
  });

  it("ignores worktrees that don't follow the <canonical>-<sid> naming", () => {
    const r = getRepo();
    // Create an operator-named worktree outside the convention.
    const operatorPath = join(r.base, "operator-worktree");
    r.git("worktree", "add", "-b", "operator-branch", operatorPath);
    // And one that DOES follow the convention.
    provisionWorktree(SID, {
      dotfilesCanonical: r.dir,
      featureFlagOverride: true,
    });

    const list = listWorktrees(r.dir);
    expect(list.length).toBe(1);
    expect(list[0]?.sessionId).toBe("94a8058c");
    expect(list.find((e) => e.path === operatorPath)).toBeUndefined();
  });

  it("handles a worktree with a detached HEAD (no branch line)", () => {
    const r = getRepo();
    const detachedPath = `${r.dir}-deadbeef`;
    mkdirSync(r.base, { recursive: true });
    r.git("worktree", "add", "--detach", detachedPath);

    const list = listWorktrees(r.dir);
    const detached = list.find((e) => e.sessionId === "deadbeef");
    expect(detached).toBeDefined();
    expect(detached?.branch).toBeNull();
  });
});

describe("linkCanonicalNodeModules", () => {
  it("returns skip when canonical has no node_modules", () => {
    const r = getRepo();
    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);

    const result = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.reason).toBe("canonical-has-no-node-modules");
    }
  });

  it("creates symlink when worktree node_modules is absent", () => {
    const r = getRepo();
    const canonicalNm = join(r.dir, "node_modules");
    mkdirSync(canonicalNm);
    writeFileSync(join(canonicalNm, ".keep"), "");

    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);

    const result = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(result.kind).toBe("ok");

    const worktreeNm = join(worktreePath, "node_modules");
    expect(lstatSync(worktreeNm).isSymbolicLink()).toBe(true);
    expect(readlinkSync(worktreeNm)).toBe(canonicalNm);
  });

  it("returns already-linked on idempotent re-call", () => {
    const r = getRepo();
    const canonicalNm = join(r.dir, "node_modules");
    mkdirSync(canonicalNm);
    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);

    const first = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(first.kind).toBe("ok");

    const second = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(second.kind).toBe("already-linked");
    if (second.kind === "already-linked") {
      expect(second.existingTarget).toBe(canonicalNm);
    }
  });

  it("returns error when worktree node_modules is a real directory (operator collision)", () => {
    const r = getRepo();
    const canonicalNm = join(r.dir, "node_modules");
    mkdirSync(canonicalNm);
    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);
    mkdirSync(join(worktreePath, "node_modules"));

    const result = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.detail).toContain("not a symlink");
    }
  });

  it("returns error when worktree symlink points to a different target", () => {
    const r = getRepo();
    const canonicalNm = join(r.dir, "node_modules");
    mkdirSync(canonicalNm);
    const otherNm = join(r.base, "other-node-modules");
    mkdirSync(otherNm);

    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);
    symlinkSync(otherNm, join(worktreePath, "node_modules"), "dir");

    const result = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.detail).toContain("different target");
    }
  });

  it("handles trailing slash on canonical path (TA-6 path-shape fuzz)", () => {
    const r = getRepo();
    const canonicalNm = join(r.dir, "node_modules");
    mkdirSync(canonicalNm);
    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);

    const result = linkCanonicalNodeModules(`${r.dir}/`, worktreePath);
    expect(result.kind).toBe("ok");
    const wtnm = join(worktreePath, "node_modules");
    expect(lstatSync(wtnm).isSymbolicLink()).toBe(true);
  });

  it("treats realpath-equivalent existing target as already-linked (TA-6 realpath divergence)", () => {
    const r = getRepo();
    const canonicalNm = join(r.dir, "node_modules");
    mkdirSync(canonicalNm);

    // alias points to the same canonical via a different path; existing
    // worktree symlink uses the alias-routed path, so literal readlink !=
    // canonicalNm but realpath does.
    const aliasParent = join(r.base, "alias");
    mkdirSync(aliasParent);
    const aliasCanonical = join(aliasParent, "canonical");
    symlinkSync(r.dir, aliasCanonical, "dir");

    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);
    const aliasNm = join(aliasCanonical, "node_modules");
    symlinkSync(aliasNm, join(worktreePath, "node_modules"), "dir");

    const result = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(result.kind).toBe("already-linked");
    if (result.kind === "already-linked") {
      expect(result.existingTarget).toBe(aliasNm);
    }
  });

  it("idempotent shape on sequential parallel-style calls (TA-SCOPE-1)", () => {
    // Sync primitive so true concurrency requires multi-process; this test
    // covers the audit's race-shape concern via the sequential idempotent
    // path (one creates, second sees the result). True multi-process race
    // is covered by the symlinkSync EEXIST catch in the primitive itself,
    // which falls through to a re-probed already-linked when the racer's
    // result matches what we'd have written.
    const r = getRepo();
    const canonicalNm = join(r.dir, "node_modules");
    mkdirSync(canonicalNm);
    const worktreePath = `${r.dir}-94a8058c`;
    mkdirSync(worktreePath);

    const first = linkCanonicalNodeModules(r.dir, worktreePath);
    const second = linkCanonicalNodeModules(r.dir, worktreePath);
    const third = linkCanonicalNodeModules(r.dir, worktreePath);
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("already-linked");
    expect(third.kind).toBe("already-linked");
    // Final state: exactly one symlink
    expect(lstatSync(join(worktreePath, "node_modules")).isSymbolicLink()).toBe(
      true,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G6-P2 — named-worktree reap: enumeration + path-correct removal + staleness.
//
// The G6-P1 reaper SKIPS named (non-sid-prefix) worktrees because
// removeWorktree's slice(0,8) truncates a slug to a WRONG path → a silent
// no-op. G6-P2 adds the path-correct primitives (removeWorktreeByPath) + a PURE
// network-free enumerator (namedWorktreeReapCandidates) the opt-in reaper
// REPORTS and the dotfiles --apply consumes. These prove: the clean+stale
// filter + its exclusions (DIRTY / FRESH / sid-prefix), the path-correct remove
// with actual-branch delete + detached-HEAD skip, and the fail-safe floor.
// ───────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function addNamedWorktree(
  r: TmpRepo,
  slug: string,
  branch: string,
  opts: { commitAhead?: boolean } = {},
): string {
  const path = `${r.dir}-${slug}`;
  r.git("worktree", "add", path, "-b", branch);
  if (opts.commitAhead === true) {
    // An empty commit puts the branch one ahead of main without dirtying the
    // tree — the squash-debt shape (content ahead, clean working copy).
    r.git("-C", path, "commit", "--allow-empty", "-q", "-m", `work-${slug}`);
  }
  return path;
}

describe("namedWorktreeReapCandidates — PURE network-free enumerator", () => {
  it("lists a named + clean + stale worktree with its local landed-signals", () => {
    const r = getRepo();
    r.addBareRemote(); // origin/main exists → is-ancestor / commits-ahead resolve
    const now = Date.now() + 2 * HOUR_MS;

    addNamedWorktree(r, "bravo-keep", "bravo-keep-branch", {
      commitAhead: true,
    });

    const cands = namedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
    });
    expect(cands.length).toBe(1);
    expect(cands[0]?.slug).toBe("bravo-keep");
    expect(cands[0]?.branch).toBe("bravo-keep-branch");
    expect(cands[0]?.path.endsWith("-bravo-keep")).toBe(true);
    // Squash-debt reality: a commit ahead, NOT an ancestor of origin/main — the
    // exact signal that makes the cheap "merged" check unreliable (model-b why).
    expect(cands[0]?.isAncestorOfMain).toBe(false);
    expect(cands[0]?.commitsAheadOfMain).toBe(1);
  });

  it("EXCLUDES dirty / fresh / sid-prefix worktrees (only clean+stale+named pass)", () => {
    const r = getRepo();
    r.addBareRemote();
    const now = Date.now() + 2 * HOUR_MS;

    // (A) named + clean + stale → INCLUDED.
    addNamedWorktree(r, "bravo-keep", "bravo-keep-branch", {
      commitAhead: true,
    });
    // (B) named + DIRTY (an uncommitted file) + stale → excluded.
    const dirty = addNamedWorktree(r, "bravo-dirty", "bravo-dirty-branch");
    writeFileSync(join(dirty, "wip.txt"), "uncommitted");
    // (C) named + clean + FRESH (mtime bumped to `now`) → excluded.
    const fresh = addNamedWorktree(r, "bravo-fresh", "bravo-fresh-branch");
    utimesSync(fresh, now / 1000, now / 1000);
    // (D) SID-PREFIX + clean + stale → excluded (the sid-prefix path owns it).
    addNamedWorktree(r, "94a8058c", "sid-branch");

    const cands = namedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
    });
    expect(cands.map((c) => c.slug)).toEqual(["bravo-keep"]);
  });

  it("EXCLUDES a worktree whose `git status` errors — fail-CLOSED on unverifiable cleanliness", () => {
    const r = getRepo();
    const now = Date.now() + 2 * HOUR_MS;
    // A named worktree with UNCOMMITTED WIP, then sever its `.git` link so its
    // own `git status` errors (unverifiable cleanliness). It still enumerates in
    // `git worktree list` (the canonical's admin dir is intact), so it reaches
    // the gate — and must be EXCLUDED, never reported: the report could
    // otherwise misdirect a destructive apply at a worktree whose WIP the tool
    // never managed to read. Closes the adversarial-pass fail-OPEN dirty gate.
    const broken = addNamedWorktree(r, "bravo-broken", "bravo-broken-branch");
    writeFileSync(join(broken, "secret-wip.txt"), "un-pushed work");
    rmSync(join(broken, ".git"), { force: true });

    const cands = namedWorktreeReapCandidates(r.dir, now, {
      staleFloorMs: HOUR_MS,
    });
    expect(cands.map((c) => c.slug)).not.toContain("bravo-broken");
  });

  it("returns [] for a canonical with no worktrees", () => {
    const r = getRepo();
    expect(
      namedWorktreeReapCandidates(r.dir, Date.now(), { staleFloorMs: HOUR_MS }),
    ).toEqual([]);
  });
});

describe("removeWorktreeByPath — path-correct remove (the G6-P1 root-cause fix)", () => {
  it("removes a NAMED worktree by full path + deletes its actual branch", () => {
    const r = getRepo();
    const path = addNamedWorktree(r, "bravo-rm", "bravo-rm-branch");
    expect(existsSync(path)).toBe(true);

    const res = removeWorktreeByPath(path, { dotfilesCanonical: r.dir });
    expect(res.kind).toBe("removed");
    expect(existsSync(path)).toBe(false);
    // The ACTUAL branch (resolved pre-removal) is deleted — not a slug-truncated
    // wrong ref. This is precisely what removeWorktree's slice(0,8) could not do.
    expect(r.git("branch", "--list", "bravo-rm-branch").trim()).toBe("");
  });

  it("skips the branch-delete for a detached HEAD (branch === 'HEAD')", () => {
    const r = getRepo();
    const path = addNamedWorktree(r, "bravo-detach", "bravo-detach-branch");
    r.git("-C", path, "checkout", "--detach");

    const res = removeWorktreeByPath(path, { dotfilesCanonical: r.dir });
    expect(res.kind).toBe("removed");
    expect(existsSync(path)).toBe(false);
    // We did NOT ride-along delete a detached "HEAD" — the branch survives.
    expect(r.git("branch", "--list", "bravo-detach-branch").trim()).not.toBe(
      "",
    );
  });

  it("is idempotent — an absent path returns kind: 'absent'", () => {
    const r = getRepo();
    const res = removeWorktreeByPath(`${r.dir}-never-existed`, {
      dotfilesCanonical: r.dir,
    });
    expect(res.kind).toBe("absent");
  });
});

describe("isWorktreeStale + worktreeLastActivityMs — staleness floor (fail-safe)", () => {
  it("reads fresh just after creation, stale past the floor", () => {
    const r = getRepo();
    const path = addNamedWorktree(r, "bravo-age", "bravo-age-branch");
    const activity = worktreeLastActivityMs(path, Date.now());
    expect(isWorktreeStale(path, activity, HOUR_MS)).toBe(false); // 0 < 1h
    expect(isWorktreeStale(path, activity + 2 * HOUR_MS, HOUR_MS)).toBe(true);
  });

  it("fail-safe: a stat error yields `now` → NEVER stale (never a reap candidate)", () => {
    const missing = "/nonexistent/worktree/path/xyz";
    expect(worktreeLastActivityMs(missing, 123_456)).toBe(123_456);
    expect(isWorktreeStale(missing, 999_999, HOUR_MS)).toBe(false);
  });

  it("pins the default stale floor at 48h (Alpha's conservative ruling)", () => {
    expect(NAMED_WORKTREE_STALE_FLOOR_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe("formatNamedWorktreeReapCandidate — landed-signal one-liner", () => {
  const base: NamedWorktreeReapCandidate = {
    path: "/x/repo-bravo-keep",
    slug: "bravo-keep",
    branch: "bravo-keep-branch",
    isAncestorOfMain: false,
    localRemoteRefExists: true,
    commitsAheadOfMain: 3,
    lastActivityMs: 0,
  };
  const now = 50 * HOUR_MS;

  it("flags a NON-ancestor (squash?) candidate to VERIFY before apply", () => {
    const s = formatNamedWorktreeReapCandidate(base, now);
    expect(s).toContain("bravo-keep-branch");
    expect(s).toContain("VERIFY its PR merged");
    expect(s).toContain("3 commit(s) ahead");
    expect(s).toContain("remote-ref present");
  });

  it("marks a true-merge (ancestor) candidate as safe", () => {
    const s = formatNamedWorktreeReapCandidate(
      { ...base, isAncestorOfMain: true },
      now,
    );
    expect(s).toContain("branch IS in main");
  });

  it("renders a detached-HEAD candidate (branch === null)", () => {
    const s = formatNamedWorktreeReapCandidate({ ...base, branch: null }, now);
    expect(s).toContain("detached-HEAD");
  });
});

/* ─── forensicMarkerActive ────────────────────────────────────────── */

describe("forensicMarkerActive — shared reap-guard primitive", () => {
  let tmp: ReturnType<typeof makeTmpHome>;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = makeTmpHome();
    prevHome = process.env["HOME"];
    process.env["HOME"] = tmp.home;
  });

  afterEach(() => {
    tmp.cleanup();
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
  });

  it("returns false when no marker file exists for the sid-prefix", () => {
    expect(forensicMarkerActive("deadbeef")).toBe(false);
  });

  it("returns true when the marker sentinel file is present", () => {
    const forensicDir = join(tmp.home, ".claude", "session-state-forensic");
    mkdirSync(forensicDir, { recursive: true });
    writeFileSync(join(forensicDir, "deadbeef"), "");
    expect(forensicMarkerActive("deadbeef")).toBe(true);
  });

  it("returns false for an unrelated sid-prefix even when another marker exists", () => {
    const forensicDir = join(tmp.home, ".claude", "session-state-forensic");
    mkdirSync(forensicDir, { recursive: true });
    writeFileSync(join(forensicDir, "cafebabe"), "");
    expect(forensicMarkerActive("deadbeef")).toBe(false);
  });
});

/* ─── worktreeReapGuard ───────────────────────────────────────────── */

describe("worktreeReapGuard — shared reap-guard primitive (G3)", () => {
  let repo: TmpRepo;

  beforeEach(() => {
    repo = makeTmpRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("returns null for a clean worktree (no guard needed)", () => {
    // A fresh worktree with no uncommitted work passes all guards.
    const wtPath = `${repo.dir}-wt-clean`;
    execFileSync("git", ["worktree", "add", "-b", "worktree/clean", wtPath], {
      cwd: repo.dir,
      stdio: "ignore",
    });
    try {
      expect(worktreeReapGuard(wtPath, Date.now())).toBeNull();
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: repo.dir,
        stdio: "ignore",
      });
    }
  });

  it("returns a dirty-working-tree guard when uncommitted files are present", () => {
    // This is the G3 data-loss fix path: an uncommitted file must block the reap.
    // The guard must return a non-null reason containing "dirty working tree".
    const wtPath = `${repo.dir}-wt-dirty`;
    execFileSync("git", ["worktree", "add", "-b", "worktree/dirty", wtPath], {
      cwd: repo.dir,
      stdio: "ignore",
    });
    try {
      writeFileSync(join(wtPath, "wip.ts"), "// uncommitted\n");
      const reason = worktreeReapGuard(wtPath, Date.now());
      expect(reason).not.toBeNull();
      expect(reason).toContain("dirty working tree");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: repo.dir,
        stdio: "ignore",
      });
    }
  });

  it("does NOT guard on an untracked node_modules entry (provisioner symlink class)", () => {
    // The provisioner creates a node_modules symlink that git shows as untracked.
    // This must NOT trigger the dirty guard — a clean worktree with only a
    // node_modules entry must still be reapable.
    const wtPath = `${repo.dir}-wt-nm`;
    execFileSync("git", ["worktree", "add", "-b", "worktree/nm", wtPath], {
      cwd: repo.dir,
      stdio: "ignore",
    });
    try {
      writeFileSync(join(wtPath, "node_modules"), "");
      expect(worktreeReapGuard(wtPath, Date.now())).toBeNull();
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: repo.dir,
        stdio: "ignore",
      });
    }
  });
});
