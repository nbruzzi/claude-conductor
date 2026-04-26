// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Branch-enforcement gate — block Edit/Write on main/master once ≥ THRESHOLD
 * distinct files have been touched in a session.
 *
 * Enforces the CLAUDE.md branching rule: "Create a feature branch before
 * starting work if the work will touch more than 3 files." The rule was
 * previously instruction-only and could be silently violated (e.g., when a
 * prior Bash cd leaked cwd into a later `git checkout -b` and the branch
 * landed in the wrong repo). This check turns the instruction into a
 * deterministic gate.
 *
 * State management:
 * - JSON files at ~/.claude/logs/.branch-enforcement-state-<sessionId>.json,
 *   sharded per session so two concurrent Claude instances never overwrite
 *   each other's per-repo distinct-file counter. The earlier single-file
 *   layout paired `stateFile()` with a `session` field; when two sessions
 *   raced, cross-session loadState returned freshState and wiped the peer's
 *   counter — the shared lock only serialized byte-level writes, not this
 *   logical overwrite. Pattern mirrors session-collision-gate.ts's
 *   `stateFile(sessionId)` shard.
 * - Session isolation via hook input `session_id` (stable across subprocess
 *   hook invocations; replaces an earlier ppid-based scheme that churned
 *   per invocation and reset the per-session repo map on every tool call).
 * - 30-minute inactivity timeout resets state
 * - Per-repo distinct-file lists bounded at MAX_FILES_PER_REPO
 *
 * Allowlist: reuses fact-force's isAllowlisted() — handoff/memory/auto-managed
 * paths don't count toward the threshold because they aren't feature work.
 *
 * Kill switch: if ~/.claude/branch-enforcement-off exists, the check passes
 * unconditionally. Use for legitimate direct-to-main work (hotfixes, etc.).
 *
 * Concurrency: shared withLock helper in ../lock.ts. LockTimeoutError is
 * caught and treated as fail-soft — a missed increment is better than an
 * infrastructure error gating edits.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isValidSessionId } from "../../active-sessions/index.ts";
import { LockTimeoutError, withLock } from "../lock.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { block, pass } from "../types.ts";
import { isAllowlisted } from "./fact-force.ts";

const SOURCE = "branch-enforcement";

// HOME-derived paths are computed per-call so test harnesses can override
// process.env.HOME at runtime. A module-level const would bind HOME at import
// time and defeat test isolation.
function home(): string {
  return process.env["HOME"] ?? "";
}
function stateDir(): string {
  return `${home()}/.claude/logs`;
}
function stateFile(sessionId: string): string {
  // Defense-in-depth: reject anything that isValidSessionId rejects. The
  // check() entry point already filters via resolveSessionIdOrNull, but
  // matches the safeguard added in fact-force.ts + session-collision-gate.ts
  // after the `-undefined.json` phantom-file class was observed in the wild.
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `${SOURCE}.stateFile: invalid sessionId (len=${String(sessionId).length})`,
    );
  }
  return `${stateDir()}/.branch-enforcement-state-${sessionId}.json`;
}
function stateTmp(sessionId: string): string {
  return `${stateFile(sessionId)}.tmp`;
}
function lockDir(): string {
  return `${stateDir()}/.branch-enforcement.lock`;
}
function killSwitch(): string {
  return `${home()}/.claude/branch-enforcement-off`;
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_FILES_PER_REPO = 100;
const THRESHOLD = 4;
const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

type RepoState = { files: string[] };
type State = {
  session: string;
  lastActive: number;
  repos: Record<string, RepoState>;
};

/**
 * PreToolUse check: block on 4th distinct file edited on main/master.
 */
export async function check(input: HookInput): Promise<HookResult> {
  const file = input.filePath;
  if (!file) return pass();

  try {
    if (existsSync(killSwitch())) return pass();
  } catch (err: unknown) {
    // Fail-open on FS error — kill switch must work even when FS is
    // degraded. Breadcrumb prefers stack (which starts with the message)
    // so unusual FS errors (EBUSY on Samba, EACCES from SELinux, etc.)
    // are diagnosable without a repro.
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
      `[${SOURCE}] kill-switch check failed, failing open: ${detail}`,
    );
    return pass();
  }

  const canonical = resolve(file);
  if (isAllowlisted(canonical)) return pass();

  const repo = findGitRoot(canonical);
  if (!repo) return pass();

  const branch = currentBranch(repo);
  if (!branch) return pass();
  if (!PROTECTED_BRANCHES.includes(branch)) return pass();

  const sessionId = resolveSessionIdOrNull(input);
  if (!sessionId) return pass();
  // Belt-and-suspenders: resolver already validated, but re-check here so a
  // future refactor of the resolver cannot silently produce state files
  // such as `.branch-enforcement-state-undefined.json`.
  if (!isValidSessionId(sessionId)) return pass();

  try {
    return withLock(
      () => {
        const state = loadState(sessionId);
        const repoState = state.repos[repo] ?? { files: [] };

        if (!repoState.files.includes(canonical)) {
          repoState.files.push(canonical);
          if (repoState.files.length > MAX_FILES_PER_REPO) {
            repoState.files = repoState.files.slice(-MAX_FILES_PER_REPO);
          }
        }
        state.repos[repo] = repoState;
        touchState(state);

        if (repoState.files.length >= THRESHOLD) {
          return block(SOURCE, branchGateMsg(repo, branch, repoState.files));
        }
        return pass();
      },
      { lockDir: lockDir(), ownerTag: SOURCE },
    );
  } catch (err: unknown) {
    if (err instanceof LockTimeoutError) {
      console.error(`[${SOURCE}] lock timeout — allowing edit without gate`);
      return pass();
    }
    throw err;
  }
}

/**
 * Exported for tests. `stateFile` is a method (not a getter) because state
 * files are sharded per session-id. Other entries read HOME per-access via
 * getters.
 */
export const INTERNAL = {
  THRESHOLD,
  PROTECTED_BRANCHES,
  SESSION_TIMEOUT_MS,
  MAX_FILES_PER_REPO,
  stateFile(sessionId: string): string {
    return stateFile(sessionId);
  },
  get LOCK_DIR() {
    return lockDir();
  },
  get KILL_SWITCH() {
    return killSwitch();
  },
};

// ─── Git helpers ────────────────────────────────────────────────

function findGitRoot(filePath: string): string | null {
  let dir = dirname(filePath);
  for (;;) {
    if (existsSync(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function currentBranch(repo: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", repo, "symbolic-ref", "--short", "HEAD"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      },
    );
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// ─── State management ───────────────────────────────────────────

function loadState(sessionId: string): State {
  const file = stateFile(sessionId);
  try {
    if (!existsSync(file)) return freshState(sessionId);

    const raw = readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return freshState(sessionId);

    const obj = parsed as Record<string, unknown>;
    const session = typeof obj["session"] === "string" ? obj["session"] : "";
    const lastActive =
      typeof obj["lastActive"] === "number" ? obj["lastActive"] : 0;
    const reposRaw =
      typeof obj["repos"] === "object" && obj["repos"] !== null
        ? (obj["repos"] as Record<string, unknown>)
        : {};

    if (session !== sessionId || Date.now() - lastActive > SESSION_TIMEOUT_MS) {
      return freshState(sessionId);
    }

    const repos: Record<string, RepoState> = {};
    for (const [repoPath, value] of Object.entries(reposRaw)) {
      if (typeof value !== "object" || value === null) continue;
      const v = value as Record<string, unknown>;
      const files = v["files"];
      if (
        Array.isArray(files) &&
        files.every((f): f is string => typeof f === "string")
      ) {
        repos[repoPath] = { files };
      }
    }

    return { session, lastActive, repos };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] state load failed — resetting: ${msg}`);
    return freshState(sessionId);
  }
}

function freshState(sessionId: string): State {
  return { session: sessionId, lastActive: Date.now(), repos: {} };
}

function touchState(state: State): void {
  state.lastActive = Date.now();
  const file = stateFile(state.session);
  const tmp = stateTmp(state.session);
  try {
    writeFileSync(tmp, JSON.stringify(state), "utf-8");
    renameSync(tmp, file);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] state write failed: ${msg}`);
  }
}

// ─── Gate message ───────────────────────────────────────────────

function branchGateMsg(repo: string, branch: string, files: string[]): string {
  const recent = files.slice(-5).join("\n  ");
  return [
    `[branch-enforcement] CLAUDE.md rule: ${files.length} distinct files edited on \`${branch}\` in ${repo}.`,
    "",
    "Recent files touched this session:",
    `  ${recent}`,
    "",
    "Branching rule: create a feature branch before continuing.",
    `Run: cd ${repo} && git checkout -b <feature-name>`,
    "Then retry your edit.",
    "",
    `Override (hotfix only): touch ${killSwitch()}`,
  ].join("\n");
}
