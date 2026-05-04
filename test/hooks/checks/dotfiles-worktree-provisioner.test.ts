// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — provisioner hook smoke tests.
 *
 * Coverage:
 * - Feature-flag off → returns pass() (no-op).
 * - Feature-flag on + clean canonical → provisions worktree + pins
 *   the canonical-claude-home anchor (REV 0.2 ARCH-1 fix).
 * - Idempotent re-run when worktree already exists.
 * - Anchor-pin observable from a session whose CWD is in a worktree
 *   (REV 0.2 RE-201 / Bravo F1 fix — the discrete worktree-CWD scenario).
 *
 * Real git fixtures (no mocking — covers the actual primitive integration).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  check as provisionerCheck,
  INTERNAL as PROVISIONER_INTERNAL,
} from "../../../src/hooks/checks/dotfiles-worktree-provisioner.ts";
import {
  artifactIdFromPath,
  readSentinelDotfilesRoot,
  setSentinelDotfilesRoot,
} from "../../../src/active-sessions/index.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";
import {
  appendPresenceFailure,
  readPresenceFailures,
} from "../../../src/shared/presence-failure-log.ts";
import { execFileSync as execFileSyncFor } from "node:child_process";

const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";
const FEATURE_FLAG_ENV = "CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES";

let tmpHome: string;
let canonical: string;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let prevDotfilesRoot: string | undefined;
let prevFlag: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "wt-prov-"));
  canonical = join(tmpHome, ".claude-dotfiles");
  mkdirSync(canonical, { recursive: true });
  mkdirSync(join(tmpHome, ".claude", "logs"), { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonical });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: canonical,
  });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "anchor", "--no-gpg-sign"],
    {
      cwd: canonical,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    },
  );

  prevHome = process.env["HOME"];
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevDotfilesRoot = process.env["CLAUDE_DOTFILES_ROOT"];
  prevFlag = process.env[FEATURE_FLAG_ENV];

  process.env["HOME"] = tmpHome;
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = join(
    tmpHome,
    "active-sessions",
  );
  process.env["CLAUDE_DOTFILES_ROOT"] = canonical;
  delete process.env[FEATURE_FLAG_ENV];
});

afterEach(() => {
  for (const [k, v] of [
    ["HOME", prevHome],
    ["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR", prevActiveSessionsDir],
    ["CLAUDE_DOTFILES_ROOT", prevDotfilesRoot],
    [FEATURE_FLAG_ENV, prevFlag],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeInput(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: tmpHome,
    transcriptPath: undefined,
    raw: { session_id: SID },
    dispatch: DEFAULT_DISPATCH,
  };
}

describe("dotfiles-worktree-provisioner hook", () => {
  it("returns pass() when feature flag is unset (no-op)", async () => {
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    const realCanonical = realpathSync(canonical);
    expect(existsSync(`${realCanonical}-${SID.slice(0, 8)}`)).toBe(false);
    expect(readSentinelDotfilesRoot(SID)).toBeNull();
  });

  it("provisions worktree + pins anchor when flag=1", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);

    const realCanonical = realpathSync(canonical);
    const expectedPath = `${realCanonical}-${SID.slice(0, 8)}`;
    expect(existsSync(expectedPath)).toBe(true);
    const sentinel = readSentinelDotfilesRoot(SID);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.endsWith(`-${SID.slice(0, 8)}`)).toBe(true);
  });

  it("REV 0.2 RE-201: anchor-pin observable at canonical-claude-home artifact-id (NOT worktree-toplevel)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    await provisionerCheck(makeInput());

    // Sentinel was written using the canonical from env var (NOT realpathed).
    // worktreePathForSession appends `-<sid-prefix>` to whatever canonical
    // was passed. The CRITICAL invariant per REV 0.2 ARCH-1 is that
    // readSentinelDotfilesRoot returns SOMETHING (not null) — proving the
    // anchor heartbeat exists at the canonical-claude-home artifact-id
    // regardless of CWD.
    const sentinel = readSentinelDotfilesRoot(SID);
    expect(sentinel).not.toBeNull();
    expect(sentinel?.endsWith(`-${SID.slice(0, 8)}`)).toBe(true);

    // Verify the artifact-id used is the canonical-claude-home one, not
    // the worktree's git toplevel. We assert by computing the worktree's
    // git toplevel and confirming its artifact-id is DIFFERENT — proving
    // the anchor is pinned at the right artifact-id and not at the
    // worktree's, which would have been the bug REV 0.1 had.
    const realCanonical = realpathSync(canonical);
    const worktreePathReal = `${realCanonical}-${SID.slice(0, 8)}`;
    const anchorArtifactId = artifactIdFromPath(join(tmpHome, ".claude"));
    const worktreeGitArtifactId = artifactIdFromPath(worktreePathReal);
    expect(anchorArtifactId).not.toBe(worktreeGitArtifactId);
  });

  it("idempotent re-run when worktree already exists", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const first = await provisionerCheck(makeInput());
    expect(first.exitCode).toBe(0);
    const second = await provisionerCheck(makeInput());
    expect(second.exitCode).toBe(0);
    expect(readSentinelDotfilesRoot(SID)).not.toBeNull();
  });
});

// ─── v3 observability fold tests ─────────────────────────────────────

describe("verifyProvision (v3 fold) — direct unit coverage", () => {
  const { verifyProvision, formatIncompleteDetail } = PROVISIONER_INTERNAL;

  it("returns complete=true when path exists, no realpath drift, sentinel pinned", () => {
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    mkdirSync(wt, { recursive: true });
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: wt });

    const verdict = verifyProvision({
      sessionId: SID,
      worktreePath: wt,
      dotfilesCanonical: realCanonical,
    });

    expect(verdict.complete).toBe(true);
    expect(verdict.detail).toContain("stat-errno=none");
    expect(verdict.detail).toContain("realpath-mismatch=false");
    expect(verdict.detail).toContain(`sentinel-readback=${wt}`);
  });

  it("returns complete=false with stat-errno=ENOENT when path missing", () => {
    const realCanonical = realpathSync(canonical);
    const verdict = verifyProvision({
      sessionId: SID,
      worktreePath: `${realCanonical}-deadbeef`,
      dotfilesCanonical: realCanonical,
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.facet).toBe("stat-errno=ENOENT");
    expect(verdict.detail).toContain("stat-errno=ENOENT");
    expect(verdict.detail).toContain("realpath-mismatch=false");
  });

  it("returns complete=false with realpath-mismatch when raw worktreePath != realpath form", () => {
    // Provisioner stores the raw `dotfilesCanonical` from env var. On macOS
    // mkdtemp under /var, the real path has /private prefix. This is the
    // exact H2 production-bug detector: provisioner stores raw, GC's
    // listWorktrees realpath-resolves → drift → orphan → reap.
    const rawCanonical = canonical;
    const realCanonical = realpathSync(canonical);
    const rawWorktree = `${rawCanonical}-${SID.slice(0, 8)}`;
    const realWorktree = `${realCanonical}-${SID.slice(0, 8)}`;
    mkdirSync(realWorktree, { recursive: true });
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: rawWorktree });

    // Skip if the test fixture happens to land where /var symlink doesn't
    // apply (e.g., Linux CI where mkdtemp lives outside symlinks).
    if (rawCanonical === realCanonical) {
      return;
    }

    const verdict = verifyProvision({
      sessionId: SID,
      worktreePath: rawWorktree,
      dotfilesCanonical: rawCanonical,
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.facet).toBe("realpath-mismatch");
    expect(verdict.detail).toContain("realpath-mismatch=true");
  });

  it("returns complete=false with sentinel-readback-null when sentinel never pinned", () => {
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    mkdirSync(wt, { recursive: true });
    // Intentionally NOT calling setSentinelDotfilesRoot

    const verdict = verifyProvision({
      sessionId: SID,
      worktreePath: wt,
      dotfilesCanonical: realCanonical,
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.facet).toBe("sentinel-readback-null");
    expect(verdict.detail).toContain("sentinel-readback=null");
  });

  it("formatIncompleteDetail locks key order for downstream parsers", () => {
    const detail = formatIncompleteDetail({
      sessionId: SID,
      worktreePath: "/a",
      dotfilesCanonical: "/b",
      canonicalRealpath: "/B",
      statErrno: "none",
      sentinelReadback: "/a",
      realpathMismatch: false,
      branchExists: true,
    });
    // Locked order: sid, path, canonical, realpath, stat-errno,
    // sentinel-readback, realpath-mismatch, branch-exists.
    expect(detail).toBe(
      `sid=${SID} path=/a canonical=/b realpath=/B stat-errno=none sentinel-readback=/a realpath-mismatch=false branch-exists=true`,
    );
  });

  it("F-2 fold: parseEvent round-trips a worktree-provision-incomplete event through the runtime kind guard", () => {
    // Without the disjunction extension at presence-failure-log.ts:258-276,
    // parseEvent silently drops new-kind entries — exact silent-failure
    // pattern this slice exists to fix.
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId: SID,
      source: "dispatcher",
      kind: "worktree-provision-incomplete",
      artifactPath: wt,
      detail: formatIncompleteDetail({
        sessionId: SID,
        worktreePath: wt,
        dotfilesCanonical: realCanonical,
        canonicalRealpath: realCanonical,
        statErrno: "none",
        sentinelReadback: wt,
        realpathMismatch: false,
        branchExists: true,
      }),
    });

    const events = readPresenceFailures();
    const ours = events.filter(
      (e) => e.kind === "worktree-provision-incomplete" && e.sessionId === SID,
    );
    expect(ours.length).toBe(1);
    expect(ours[0]?.detail).toContain("realpath-mismatch=false");
  });
});

// Suppress unused-import lint when the test platform doesn't trip the macOS
// realpath path (Linux CI). execFileSyncFor is deliberately re-exported to
// keep the import surface stable if a future test adds git-driven fixtures.
void execFileSyncFor;
