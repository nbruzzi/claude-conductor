#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI for fact-force scope-approval markers.
 *
 * Verbs:
 *   approve <session-id> --reason "..." [--ttl 1800] [--max-files 25]
 *     Write a scope marker pre-authorizing N file operations for a session.
 *     Default TTL: 1800s (30min). Default max-files: 25. Max TTL: 3600s.
 *     Max files: 200 (matches fact-force MAX_ENTRIES bound).
 *   list
 *     List all active (non-expired) scope markers across sessions.
 *   revoke <session-id>
 *     Delete the scope marker for the given session.
 *
 * The hook (fact-force.ts) checks for an active scope marker before blocking.
 * If one exists with remaining budget and not expired, the gate passes and
 * files_consumed is incremented atomically.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  sanitizeReason,
  scopeMarkerPath,
  scopesDir,
  type ScopeMarker,
} from "./fact-force-scope-store.ts";

const DEFAULT_TTL_SECONDS = 1800;
const MAX_TTL_SECONDS = 3600;
const DEFAULT_MAX_FILES = 25;
const MAX_FILES_HARD_CAP = 200;

type ParsedArgs = {
  readonly ttl: number;
  readonly maxFiles: number;
  readonly reason: string;
  readonly positional: readonly string[];
};

function parseArgs(args: string[]): ParsedArgs {
  let ttl = DEFAULT_TTL_SECONDS;
  let maxFiles = DEFAULT_MAX_FILES;
  let reason = "";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--ttl") {
      const next = args[i + 1];
      if (next === undefined) {
        process.stderr.write("--ttl requires a value (seconds)\n");
        process.exit(2);
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0 || n > MAX_TTL_SECONDS) {
        process.stderr.write(
          `--ttl must be a positive number ≤ ${MAX_TTL_SECONDS}\n`,
        );
        process.exit(2);
      }
      ttl = n;
      i++;
    } else if (arg === "--max-files") {
      const next = args[i + 1];
      if (next === undefined) {
        process.stderr.write("--max-files requires a value\n");
        process.exit(2);
      }
      const n = Number(next);
      if (!Number.isInteger(n) || n <= 0 || n > MAX_FILES_HARD_CAP) {
        process.stderr.write(
          `--max-files must be a positive integer ≤ ${MAX_FILES_HARD_CAP}\n`,
        );
        process.exit(2);
      }
      maxFiles = n;
      i++;
    } else if (arg === "--reason") {
      const next = args[i + 1];
      if (next === undefined) {
        process.stderr.write("--reason requires a value\n");
        process.exit(2);
      }
      reason = next;
      i++;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { ttl, maxFiles, reason, positional };
}

function ensureScopesDir(): string {
  const dir = scopesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function approve(
  sessionId: string,
  ttlSeconds: number,
  maxFiles: number,
  reason: string,
): void {
  if (sessionId.length === 0) {
    process.stderr.write(
      "session-id argument required and must be non-empty\n",
    );
    process.exit(2);
  }
  ensureScopesDir();
  const cleanReason = sanitizeReason(reason);
  if (cleanReason.length === 0) {
    process.stderr.write(
      "--reason required (no plain audit trail otherwise)\n",
    );
    process.exit(2);
  }
  const now = Date.now();
  const marker: ScopeMarker = {
    version: 1,
    sessionId,
    reason: cleanReason,
    approved_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
    max_files: maxFiles,
    files_consumed: 0,
  };
  const target = scopeMarkerPath(sessionId);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(marker, null, 2) + "\n", {
    encoding: "utf8",
  });
  process.stdout.write(
    `approved scope for session: ${sessionId}\n` +
      `  expires: ${marker.expires_at} (in ${ttlSeconds}s)\n` +
      `  max files: ${maxFiles}\n` +
      `  reason: ${cleanReason}\n`,
  );
}

// Stale `.tmp` files older than this window are swept by listScopes — they're
// crash-debris from an interrupted writeFileSync→renameSync sequence in the
// hook's tryConsumeScope (RE-2). 5 minutes is well past any legitimate write.
const STALE_TMP_AGE_MS = 5 * 60 * 1000;

function sweepStaleTmpFiles(dir: string, now: number): void {
  const all = readdirSync(dir);
  for (const file of all) {
    if (!file.endsWith(".tmp")) continue;
    const target = join(dir, file);
    try {
      const stats = statSync(target);
      if (now - stats.mtimeMs > STALE_TMP_AGE_MS) {
        unlinkSync(target);
      }
    } catch {
      // Stat or unlink failed — leave the file; manual `ls` will surface it.
    }
  }
}

function listScopes(): void {
  const dir = scopesDir();
  if (!existsSync(dir)) {
    process.stdout.write("(no active scopes — directory does not exist)\n");
    return;
  }
  const now = Date.now();
  sweepStaleTmpFiles(dir, now);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    process.stdout.write("(no active scopes)\n");
    return;
  }
  const active: ScopeMarker[] = [];
  for (const file of files) {
    const target = join(dir, file);
    try {
      const marker = JSON.parse(readFileSync(target, "utf8")) as ScopeMarker;
      const expiresAt = Date.parse(marker.expires_at);
      const exhausted = marker.files_consumed >= marker.max_files;
      if (Number.isFinite(expiresAt) && expiresAt > now && !exhausted) {
        active.push(marker);
      } else {
        unlinkSync(target);
      }
    } catch {
      // corrupt marker — leave for manual inspection
    }
  }
  if (active.length === 0) {
    process.stdout.write(
      "(no active scopes — expired/exhausted markers cleaned up)\n",
    );
    return;
  }
  for (const marker of active) {
    const remaining = Math.max(
      0,
      Math.floor((Date.parse(marker.expires_at) - now) / 1000),
    );
    const filesLeft = marker.max_files - marker.files_consumed;
    process.stdout.write(
      `session ${marker.sessionId}\n` +
        `  expires: ${marker.expires_at} (${remaining}s remaining)\n` +
        `  files: ${marker.files_consumed}/${marker.max_files} consumed (${filesLeft} left)\n` +
        `  reason: ${marker.reason}\n`,
    );
  }
}

function revoke(sessionId: string): void {
  if (sessionId.length === 0) {
    process.stderr.write("session-id argument required\n");
    process.exit(2);
  }
  const target = scopeMarkerPath(sessionId);
  if (!existsSync(target)) {
    process.stdout.write(`no scope marker for session: ${sessionId}\n`);
    return;
  }
  unlinkSync(target);
  process.stdout.write(`revoked scope for session: ${sessionId}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const rest = argv.slice(1);
  if (verb === "approve") {
    const { ttl, maxFiles, reason, positional } = parseArgs(rest);
    const sessionId = positional[0];
    if (sessionId === undefined) {
      process.stderr.write("approve: session-id argument required\n");
      process.exit(2);
    }
    approve(sessionId, ttl, maxFiles, reason);
    return;
  }
  if (verb === "list") {
    listScopes();
    return;
  }
  if (verb === "revoke") {
    const sessionId = rest[0];
    if (sessionId === undefined) {
      process.stderr.write("revoke: session-id argument required\n");
      process.exit(2);
    }
    revoke(sessionId);
    return;
  }
  process.stderr.write(
    "usage:\n" +
      '  fact-force-scope-cli approve <session-id> --reason "..." [--ttl 1800] [--max-files 25]\n' +
      "  fact-force-scope-cli list\n" +
      "  fact-force-scope-cli revoke <session-id>\n",
  );
  process.exit(2);
}

main();
