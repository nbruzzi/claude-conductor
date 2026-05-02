// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER-3a — SessionStart `gh auth status` advisory check.
 *
 * Surfaces gh-auth state at session start so the agent knows whether
 * `gh pr checks` will work BEFORE push-time. Pairs with TIER 4 (PreToolUse
 * sentinel), TIER 3 (PostToolUse reminder), and TIER 2 (Stop verification gate)
 * as the precondition layer of the CI verification cycle per
 * ~/.claude/plans/typed-sleeping-snowglobe.md.
 *
 * Spawns `gh auth status` synchronously with 2 s timeout (probed PASS 2026-05-02
 * on Bun 1.3.11 — `Bun.spawnSync(["sleep","5"], { timeout: 100 })` returned in
 * 104.2 ms with `exitCode: null` + `signalCode: "SIGTERM"`; native timeout works
 * as designed without AbortController fallback).
 *
 * Detection map (per probe-confirmed branches + RE #9 stdout parsing):
 *   - exitCode === 0                                 → pass (authed)
 *   - exitCode === null && signalCode === "SIGTERM"  → pass (timeout, fail-open)
 *   - exitCode !== 0 && exitCode !== null            → warn (parse stdout for variant)
 *   - Spawn throws ENOENT                            → warn (gh not in PATH)
 *   - Other thrown error                             → pass + one-time stderr breadcrumb
 *
 * Stdout-parsing variants for the warn branch:
 *   - "Logged in to github.com as"  → defense-in-depth pass (some gh versions exit non-zero with logged-in)
 *   - "expired"                     → "run `gh auth refresh`"
 *   - "not logged into" / "not authenticated" → "run `gh auth login`"
 *   - other                         → generic-not-authed message
 *
 * Severity: warn-only. Auth state is advisory — never block a session over a
 * flaky CLI. Day-1 ships synchronous spawn; if 1-week soak shows latency hit
 * (per RE #8), follow-up slice ships async cache.
 *
 * Kill switches:
 *   - Session-scoped: ~/.claude/.flags/ci-verification-auth-warn-disabled-<sessionId>
 *   - Global emergency: ~/.claude/.flags/ci-verification-auth-warn-disabled
 *
 * HOME-per-call (per test-gate.ts:23-26).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";
import { extractSessionId } from "../session-id.ts";

const SOURCE = "ci-verification-auth-warn";
const SPAWN_TIMEOUT_MS = 2000;

const errorReported = new Set<string>();

function homeFlagsDir(): string {
  return join(process.env["HOME"] ?? "", ".claude", ".flags");
}

function killSwitchPaths(sessionId: string | undefined): {
  session: string | undefined;
  global: string;
} {
  const dir = homeFlagsDir();
  return {
    session:
      sessionId === undefined
        ? undefined
        : join(dir, `${SOURCE}-disabled-${sessionId}`),
    global: join(dir, `${SOURCE}-disabled`),
  };
}

function reportOnce(key: string, msg: string): void {
  if (errorReported.has(key)) return;
  errorReported.add(key);
  console.error(`[${SOURCE}] ${msg}`);
}

type SpawnOk = {
  kind: "ok";
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
};
type SpawnEnoent = { kind: "enoent" };
type SpawnError = { kind: "error"; message: string };
type SpawnOutcome = SpawnOk | SpawnEnoent | SpawnError;

function runGhAuthStatus(): SpawnOutcome {
  try {
    // Explicit env spread at call time — Bun.spawnSync's default env appears to
    // cache at process start, so mutations to process.env (e.g. test PATH stubs)
    // don't propagate without an explicit env parameter.
    const proc = Bun.spawnSync(["gh", "auth", "status"], {
      timeout: SPAWN_TIMEOUT_MS,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    return {
      kind: "ok",
      exitCode: proc.exitCode,
      signalCode: proc.signalCode ?? null,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { kind: "enoent" };
    return { kind: "error", message: e.message ?? String(err) };
  }
}

type AuthClassification = {
  outcome: "authed" | "timeout" | "expired" | "not-authed" | "warn-other";
  detail: string;
};

function classifyAuth(result: SpawnOk): AuthClassification {
  // Native timeout: process killed by SIGTERM with null exitCode.
  if (result.exitCode === null && result.signalCode === "SIGTERM") {
    return {
      outcome: "timeout",
      detail: "gh auth status timed out (>2s) — fail-open",
    };
  }
  if (result.exitCode === 0) {
    return { outcome: "authed", detail: "gh auth ok" };
  }
  // gh writes most diagnostic content to STDERR. Inspect both for resilience.
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (combined.includes("logged in to github.com as")) {
    return {
      outcome: "authed",
      detail: "gh reports logged-in despite non-zero exit",
    };
  }
  if (combined.includes("expired")) {
    return { outcome: "expired", detail: "gh token expired" };
  }
  if (
    combined.includes("not logged into") ||
    combined.includes("not authenticated")
  ) {
    return { outcome: "not-authed", detail: "gh not authenticated" };
  }
  return {
    outcome: "warn-other",
    detail: `gh exit=${result.exitCode ?? "null"} sig=${result.signalCode ?? "null"}`,
  };
}

function killSwitchInstruction(sessionId: string | undefined): string {
  if (sessionId === undefined) {
    return "Disable: touch ~/.claude/.flags/ci-verification-auth-warn-disabled";
  }
  return `Disable: touch ~/.claude/.flags/ci-verification-auth-warn-disabled-${sessionId}`;
}

function notInstalledMessage(sessionId: string | undefined): string {
  return [
    "── CI Verification Auth ──",
    "",
    "gh CLI not found in PATH. Per ~/CLAUDE.md After Every Push, CI verification needs `gh pr checks` / `gh run view`.",
    "",
    "Install: brew install gh && gh auth login",
    killSwitchInstruction(sessionId),
  ].join("\n");
}

function notAuthedMessage(sessionId: string | undefined): string {
  return [
    "── CI Verification Auth ──",
    "",
    "gh CLI not authenticated. CI verification (`gh pr checks` / `gh run view`) will fail until you authenticate.",
    "",
    "Run: gh auth login",
    killSwitchInstruction(sessionId),
  ].join("\n");
}

function expiredMessage(sessionId: string | undefined): string {
  return [
    "── CI Verification Auth ──",
    "",
    "gh CLI token expired. CI verification will fail until you refresh.",
    "",
    "Run: gh auth refresh",
    killSwitchInstruction(sessionId),
  ].join("\n");
}

function genericWarnMessage(
  sessionId: string | undefined,
  detail: string,
): string {
  return [
    "── CI Verification Auth ──",
    "",
    `gh auth status returned non-zero (${detail}). CI verification may fail until resolved.`,
    "",
    "Inspect: gh auth status",
    killSwitchInstruction(sessionId),
  ].join("\n");
}

export async function check(input: HookInput): Promise<HookResult> {
  const sessionId = extractSessionId(input.raw);

  // Kill switch (session-scoped first if available, then global emergency).
  const ks = killSwitchPaths(sessionId);
  try {
    if (ks.session !== undefined && existsSync(ks.session)) return pass();
    if (existsSync(ks.global)) return pass();
  } catch (err) {
    reportOnce(
      "kill-switch-stat",
      `kill-switch stat failed: ${(err as Error).message}`,
    );
    return pass();
  }

  const outcome = runGhAuthStatus();

  if (outcome.kind === "enoent") {
    return warn(SOURCE, notInstalledMessage(sessionId), "gh not installed");
  }
  if (outcome.kind === "error") {
    reportOnce("spawn-error", `spawn failed: ${outcome.message}`);
    return pass();
  }

  const classified = classifyAuth(outcome);
  switch (classified.outcome) {
    case "authed":
      return pass();
    case "timeout":
      return pass();
    case "expired":
      return warn(SOURCE, expiredMessage(sessionId), classified.detail);
    case "not-authed":
      return warn(SOURCE, notAuthedMessage(sessionId), classified.detail);
    case "warn-other":
      return warn(
        SOURCE,
        genericWarnMessage(sessionId, classified.detail),
        classified.detail,
      );
  }
}

// Test-only exports for fixture-driven unit tests + PATH-stub harness.
export const INTERNAL = {
  killSwitchPaths,
  homeFlagsDir,
  classifyAuth,
  notInstalledMessage,
  notAuthedMessage,
  expiredMessage,
  genericWarnMessage,
  SPAWN_TIMEOUT_MS,
};
