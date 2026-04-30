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
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  listWorktrees,
  provisionWorktree,
  removeWorktree,
  worktreePathForSession,
} from "../../src/worktrees/index.ts";
import { makeTmpRepo, type TmpRepo } from "../../test-utils/index.ts";

const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";
const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";
const SID2 = "76b84abc-a6a2-4395-bb65-f5bd799c525c";

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
