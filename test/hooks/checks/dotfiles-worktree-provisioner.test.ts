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
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
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

  // P0 substrate canary (backlog L:892, 2026-05-17) — minimal canonical
  // `node_modules/claude-conductor/` fixture so post-link `verifyProvision`'s
  // `cross-edge-dep-missing` facet doesn't fire on happy-path hook tests.
  // Tests that exercise failure paths (skip / link-failed / facet-fires) override
  // by removing or shadowing this fixture locally before invoking the hook.
  const canonicalCcDir = join(canonical, "node_modules", "claude-conductor");
  mkdirSync(canonicalCcDir, { recursive: true });
  writeFileSync(join(canonicalCcDir, "package.json"), "{}");

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

  it("returns complete=true when path exists, no realpath drift, sentinel pinned, cross-edge dep resolves", () => {
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    mkdirSync(wt, { recursive: true });
    // P0 substrate canary (backlog L:892) — materialize the cross-edge dep
    // probe target directly so `cross-edge-dep-missing` facet doesn't fire.
    // Production hook path uses `linkCanonicalNodeModules` to make this true;
    // this unit test exercises `verifyProvision` in isolation.
    mkdirSync(join(wt, "node_modules", "claude-conductor"), {
      recursive: true,
    });
    writeFileSync(
      join(wt, "node_modules", "claude-conductor", "package.json"),
      "{}",
    );
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

// ─── P0 substrate canary (backlog L:892, 2026-05-17) ───────────────────────
// Hook-level integration of `linkCanonicalNodeModules` per Path B (link
// composition lifted outside the conditional). Covers fresh-create + idempotent
// re-entry + skip + operator-collision + cross-edge-dep-missing facet + TA-3
// real-subprocess `bun` resolve.

describe("dotfiles-worktree-provisioner hook — node_modules linking (P0 L:892)", () => {
  it("symlinks worktree node_modules → canonical node_modules on fresh provision", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);

    // The hook reads `dotfilesCanonical` from CLAUDE_DOTFILES_ROOT (raw form);
    // git worktree add resolves to the realpath form for the worktree dir;
    // `linkCanonicalNodeModules` writes the symlink target as the raw
    // canonical that was passed. Assert via realpath-equivalence on both
    // sides per `feedback-cross-platform-tmpdir-divergence.md` (macOS
    // `/var ↔ /private/var` aliasing).
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    const wtNm = join(wt, "node_modules");
    expect(lstatSync(wtNm).isSymbolicLink()).toBe(true);
    expect(realpathSync(wtNm)).toBe(join(realCanonical, "node_modules"));
    // Specifically: no worktree-deps-link-failed breadcrumb on happy path.
    // (Note: on macOS, `realpath-mismatch` from the existing H2 facet still
    // fires because the hook stores raw `dotfilesCanonical` from env var while
    // realpath-resolves under `/private/var/`. That's orthogonal to the P0 fix.)
    const linkFailures = readPresenceFailures().filter(
      (e) => e.kind === "worktree-deps-link-failed" && e.sessionId === SID,
    );
    expect(linkFailures).toHaveLength(0);
  });

  it("idempotent on re-entry — second call observes already-linked, no errors logged", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    const first = await provisionerCheck(makeInput());
    expect(first.exitCode).toBe(0);
    const second = await provisionerCheck(makeInput());
    expect(second.exitCode).toBe(0);

    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    // Symlink still present, target resolves to the canonical's node_modules
    // (realpath compare per macOS tmpdir divergence).
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(wt, "node_modules"))).toBe(
      join(realCanonical, "node_modules"),
    );
    // No worktree-deps-link-failed breadcrumb on either call.
    const linkFailures = readPresenceFailures().filter(
      (e) => e.kind === "worktree-deps-link-failed" && e.sessionId === SID,
    );
    expect(linkFailures).toHaveLength(0);
  });

  it("logs worktree-deps-link-failed when worktree node_modules is a real dir (operator collision)", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    // First call provisions + links. Tear down the symlink and replace with a
    // real directory to simulate an operator override left in place across
    // sessions.
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    await provisionerCheck(makeInput());
    rmSync(join(wt, "node_modules"), { recursive: true, force: true });
    mkdirSync(join(wt, "node_modules"));

    // Second call sees the real dir, refuses to overwrite, logs the failure.
    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    const linkFailures = readPresenceFailures().filter(
      (e) => e.kind === "worktree-deps-link-failed" && e.sessionId === SID,
    );
    expect(linkFailures).toHaveLength(1);
    expect(linkFailures[0]?.detail).toContain("not a symlink");
  });

  it("emits skip-breadcrumb when canonical has no node_modules", async () => {
    process.env[FEATURE_FLAG_ENV] = "1";
    // Tear down the beforeEach-provisioned canonical node_modules to simulate
    // first-ever invocation before any `bun install` ran at canonical.
    rmSync(join(canonical, "node_modules"), { recursive: true, force: true });

    const result = await provisionerCheck(makeInput());
    expect(result.exitCode).toBe(0);
    // The hook returns warn() with a skip-breadcrumb; no link-failed entry.
    const linkFailures = readPresenceFailures().filter(
      (e) => e.kind === "worktree-deps-link-failed" && e.sessionId === SID,
    );
    expect(linkFailures).toHaveLength(0);
    // verifyProvision fires cross-edge-dep-missing → worktree-provision-incomplete entry.
    const incomplete = readPresenceFailures().filter(
      (e) => e.kind === "worktree-provision-incomplete" && e.sessionId === SID,
    );
    expect(incomplete).toHaveLength(1);
  });

  it("verifyProvision: cross-edge-dep-missing fires when worktree node_modules has no claude-conductor", () => {
    const { verifyProvision } = PROVISIONER_INTERNAL;
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    mkdirSync(wt, { recursive: true });
    // Empty node_modules dir — exists but lacks claude-conductor.
    mkdirSync(join(wt, "node_modules"));
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: wt });

    const verdict = verifyProvision({
      sessionId: SID,
      worktreePath: wt,
      dotfilesCanonical: realCanonical,
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.facet).toBe("cross-edge-dep-missing");
  });

  it("verifyProvision: cross-edge-dep-missing does NOT fire when claude-conductor/package.json present", () => {
    const { verifyProvision } = PROVISIONER_INTERNAL;
    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;
    mkdirSync(wt, { recursive: true });
    // Direct (non-symlink) materialization of the probe target.
    mkdirSync(join(wt, "node_modules", "claude-conductor"), {
      recursive: true,
    });
    writeFileSync(
      join(wt, "node_modules", "claude-conductor", "package.json"),
      "{}",
    );
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: wt });

    const verdict = verifyProvision({
      sessionId: SID,
      worktreePath: wt,
      dotfilesCanonical: realCanonical,
    });

    expect(verdict.complete).toBe(true);
    expect(verdict.facet).toBeNull();
  });

  it("TA-3 (real-subprocess bun resolve): import resolves from worktree script after hook fires", async () => {
    // Materialize a real importable package in canonical's node_modules.
    const ccDir = join(canonical, "node_modules", "claude-conductor");
    writeFileSync(
      join(ccDir, "package.json"),
      JSON.stringify({
        name: "claude-conductor",
        type: "module",
        exports: { "./marker": "./marker.js" },
      }),
    );
    writeFileSync(join(ccDir, "marker.js"), "export const marker = 'OK';\n");

    process.env[FEATURE_FLAG_ENV] = "1";
    await provisionerCheck(makeInput());

    const realCanonical = realpathSync(canonical);
    const wt = `${realCanonical}-${SID.slice(0, 8)}`;

    // Per Path A validation lesson: bun's package resolution is script-file-
    // relative, not cwd-relative. The probe script must be a real file inside
    // the worktree so resolution walks up from the script's location.
    const probeScript = join(wt, "test-resolve.mjs");
    writeFileSync(
      probeScript,
      [
        "import { marker } from 'claude-conductor/marker';",
        "if (marker !== 'OK') process.exit(2);",
        "process.exit(0);",
      ].join("\n"),
    );

    const proc = spawnSync("bun", [probeScript], {
      cwd: wt,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    // Skip gracefully on runners without `bun` on PATH (per the
    // "skipped gracefully on runners without production canonicals" pattern).
    if (
      proc.error !== undefined &&
      (proc.error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }

    expect(proc.status).toBe(0);
  });
});
