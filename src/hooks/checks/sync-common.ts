// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cross-hook helpers shared by the vault-sync trio and the dotfiles-sync trio.
 *
 * Anything vault-specific belongs in `vault-common.ts`. Anything
 * dotfiles-specific belongs in `dotfiles-common.ts`. This module exists so
 * primitives that both sync loops need — log rotation, push-timeout
 * diagnostics, whitespace collapse — live in exactly one place instead of
 * drifting between siblings. The lift-up was the Phase 4 audit remediation:
 * the pre-audit state had `appendLogWithRotation` and `diagnosePushFailure`
 * scoped under `vault-*` while `dotfiles-common` and `dotfiles-commit` carried
 * the exact pre-Phase-4 byte-for-byte patterns.
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  truncateSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Single-slot rotation threshold for the structured failure log. 1 MiB is
 * generous but bounded: a machine stuck in a failure loop (EACCES on every
 * sync, bad push credentials) won't grow the log unbounded between user
 * sessions. When the file hits the threshold we rename it to `<path>.1`
 * (overwriting any prior `.1`) and start fresh. Only one archival slot —
 * operators who want deeper history should ship the log to durable storage.
 */
export const SYNC_LOG_MAX_BYTES = 1_048_576;

/**
 * Per-entry size cap (8 KiB). Bounds the worst case where a single JSONL
 * entry could blow past `SYNC_LOG_MAX_BYTES` on its own and force immediate
 * rotation on the next write, losing up to 1 MiB of prior context. Callers
 * upstream already collapse stderr via `oneLine` / `slice(0, 500)`, but the
 * contract here is symmetric: a future caller that bypasses the upstream
 * cap cannot accidentally trigger a rotation storm via this writer.
 * Backlog L320 RE-5 closure.
 */
export const PER_ENTRY_MAX_BYTES = 8 * 1024;

/**
 * Append to a size-capped log with single-slot rotation.
 *
 * Before appending, stat the current log. If it's ≥ `maxBytes`, rename it
 * to `<path>.1` (overwriting the prior archive) and let the append create
 * a fresh file. This keeps the log bounded at roughly `maxBytes + one
 * entry` peak.
 *
 * Rotation errors OTHER than ENOENT (log doesn't exist yet) are non-fatal:
 * stderr'd and the append still runs. The append itself is NOT wrapped —
 * if `appendFileSync` throws (EACCES, EISDIR on the path, etc.) the caller
 * sees the error and is expected to log it via its own catch branch. This
 * contract lets the caller decide whether a log-write failure is fatal for
 * its own control flow (typically it's not — both `logVaultFailure` and
 * `logSyncFailure` catch and stderr, preserving their sentinel writes so
 * catchup still fires).
 */
export function appendLogWithRotation(
  logPath: string,
  entry: string,
  maxBytes: number = SYNC_LOG_MAX_BYTES,
): void {
  mkdirSync(dirname(logPath), { recursive: true });
  try {
    const st = statSync(logPath);
    if (st.size >= maxBytes) {
      try {
        renameSync(logPath, `${logPath}.1`);
      } catch (renameErr: unknown) {
        const renameCode =
          renameErr instanceof Error && "code" in renameErr
            ? String((renameErr as { code: unknown }).code ?? "")
            : "";
        // EXDEV — log and `.1` slot sit on different filesystems (e.g.,
        // ~/.claude/logs/ symlinked to an external SSD). renameSync cannot
        // cross devices; fall back to copy + truncate so rotation still
        // works on cross-device setups. Without this fallback, rotation
        // silently stops working on that machine + the log grows unbounded.
        // Backlog L318 RE-2 closure.
        if (renameCode === "EXDEV") {
          copyFileSync(logPath, `${logPath}.1`);
          truncateSync(logPath, 0);
        } else {
          throw renameErr;
        }
      }
    }
  } catch (err: unknown) {
    const code =
      err instanceof Error && "code" in err
        ? String((err as { code: unknown }).code ?? "")
        : "";
    // ENOENT = log doesn't exist yet, first append will create it. All good.
    // Other errors (EACCES on stat, rename target with permission denied,
    // etc.) shouldn't block the append — log through to stderr and keep
    // going. (EXDEV is handled by the inner fallback above; never reaches
    // this branch.)
    if (code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[sync-common] log rotation check failed (${logPath}): ${msg}`,
      );
    }
  }
  // Clamp entry to PER_ENTRY_MAX_BYTES (with ellipsis sentinel) before
  // append. Defensive against future callers that bypass upstream length
  // bounds (`oneLine` / `.slice(0, 500)`). Preserves trailing newline so
  // the JSONL line shape is intact even when truncation kicks in.
  // Backlog L320 RE-5 closure.
  const clampedEntry =
    entry.length > PER_ENTRY_MAX_BYTES
      ? `${entry.slice(0, PER_ENTRY_MAX_BYTES - 2)}…\n`
      : entry;
  appendFileSync(logPath, clampedEntry, "utf-8");
}

/**
 * Ceiling on how long we're willing to wait for `git push` before treating
 * the call as hung. Bun's subprocess `timeout` option delivers SIGTERM at the
 * boundary; the process then exits with code 143 (128 + SIGTERM=15). This
 * constant is the budget — `diagnosePushFailure` is the signal interpreter.
 */
export const PUSH_TIMEOUT_MS = 10_000;

/**
 * Produce a single-line failure detail for the push path.
 *
 * Priority (highest to lowest):
 *
 *   1. `exitCode === 143` — unambiguous SIGTERM from Bun's subprocess
 *      timeout. Report as "push timeout" regardless of what else is in
 *      stderr, because git may print "error: could not read from remote"
 *      on its way down and that would mislead operators about the cause.
 *
 *   2. Non-empty stderr — a real git error message ("fatal: remote
 *      rejected non-fast-forward", "fatal: Authentication failed") is
 *      always more actionable than an elapsed-time heuristic. A slow
 *      auth-failure that happens to take ≥ `timeoutMs - 500` must NOT
 *      be misreported as a timeout; the user needs to see the auth
 *      failure, not chase a network ghost.
 *
 *   3. `elapsedMs >= timeoutMs - 500` — stderr was empty; we fall back
 *      to the elapsed wall-clock check for the case where the SIGTERM
 *      signal accounting was lost in subprocess teardown on macOS. The
 *      500ms margin below the configured timeout covers Bun's
 *      post-SIGTERM teardown latency.
 *
 *   4. Last-resort exit code — no signal, no stderr, elapsed under the
 *      timeout budget. Unusual; surface the code so debugging has
 *      something to grip.
 */
export function diagnosePushFailure(
  stderr: string,
  elapsedMs: number,
  timeoutMs: number,
  exitCode: number,
): string {
  if (exitCode === 143) {
    return `push timeout after ${Math.round(timeoutMs / 1000)}s — network or remote hung`;
  }
  if (stderr) return stderr;
  if (elapsedMs >= timeoutMs - 500) {
    return `push timeout after ${Math.round(timeoutMs / 1000)}s — network or remote hung`;
  }
  return `git push exited with code ${exitCode}`;
}

/**
 * Indicators that a manual git operation is in-flight in a repo.
 *
 * `.git/index.lock` is the authoritative signal — git creates it during the
 * critical section of any staging/commit operation and removes it on exit.
 * The other files flag multi-step operations (merge, rebase, cherry-pick,
 * revert) that leave the index in an intermediate state. The last two
 * (`gc.pid`, `shallow.lock`) cover Obsidian Git background GC and
 * interrupted shallow fetches respectively — not fatal to `git add`, but
 * lock-contention-prone if our hook fires during the window.
 *
 * Trio-agnostic: caller passes the repo root explicitly. Vault, dotfiles,
 * and any future sibling trio (wiki-sync, plans-sync) consume the same
 * primitive. L328 closure (backlog 2026-04-22): prior location was
 * `dotfiles-common.ts` with a `dotfilesRoot()` default — a name/dependency
 * mismatch flagged as the only remaining cross-trio edge that should live
 * in `sync-common`.
 *
 * Use this before the auto-sync writes to avoid pre-empting the user's
 * in-progress commit.
 */
export function manualCommitInFlight(repoRoot: string): boolean {
  const paths = [
    ".git/index.lock",
    ".git/MERGE_HEAD",
    ".git/CHERRY_PICK_HEAD",
    ".git/REVERT_HEAD",
    ".git/rebase-merge",
    ".git/rebase-apply",
    ".git/gc.pid",
    ".git/shallow.lock",
  ];
  return paths.some((p) => existsSync(`${repoRoot}/${p}`));
}

/**
 * Collapse whitespace, trim, and truncate a raw string for single-line
 * user-facing output. Git stderr, fs error messages, and JSON-parsed details
 * can carry embedded newlines/tabs/\r\n which break our " | "-joined warn
 * lines and the one-line-per-source-prefix contract the catchup tests assert.
 * Truncation happens AFTER collapse so the length budget is predictable
 * regardless of whitespace density in the raw string.
 */
export function oneLine(raw: string, max: number = 200): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}
