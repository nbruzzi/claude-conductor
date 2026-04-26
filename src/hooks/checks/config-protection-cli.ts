#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI for config-protection approval markers.
 *
 * Verbs:
 *   approve <path> [--ttl <seconds>] [--reason "..."]
 *     Write a single-use approval marker for the given path. Default TTL: 300s.
 *   list
 *     List all active (non-expired) approvals.
 *   revoke <path>
 *     Delete the approval marker for the given path.
 *
 * Single-use semantics: the hook deletes the marker on the first matching
 * Edit/Write. Re-edits require a fresh approval.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  approvalsDir,
  canonicalizePath,
  markerPath,
  sanitizeReason,
  type ApprovalMarker,
} from "./config-protection-store.ts";

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;

function ensureAbsolute(path: string): string {
  if (!isAbsolute(path)) {
    return resolve(process.cwd(), path);
  }
  return path;
}

type ParsedArgs = {
  readonly ttl: number;
  readonly reason: string;
  readonly positional: readonly string[];
};

function parseArgs(args: string[]): ParsedArgs {
  let ttl = DEFAULT_TTL_SECONDS;
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
  return { ttl, reason, positional };
}

function ensureApprovalsDir(): string {
  const dir = approvalsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function approve(path: string, ttlSeconds: number, reason: string): void {
  // Canonicalize so the marker path matches whatever spelling the editing
  // tool eventually produces (symlink-resolved, ".."-collapsed). Both write-
  // and read-side go through canonicalizePath so identity holds even when
  // realpath fails (e.g., target file does not yet exist).
  const canonical = canonicalizePath(ensureAbsolute(path));
  ensureApprovalsDir();
  const now = Date.now();
  const cleanReason = sanitizeReason(reason);
  const marker: ApprovalMarker = {
    version: 1,
    path: canonical,
    approved_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
    reason: cleanReason.length > 0 ? cleanReason : "(no reason provided)",
  };
  const target = markerPath(canonical);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(marker, null, 2) + "\n", {
    encoding: "utf8",
  });
  process.stdout.write(
    `approved: ${canonical}\n  expires: ${marker.expires_at} (in ${ttlSeconds}s)\n  reason: ${marker.reason}\n`,
  );
}

function listApprovals(): void {
  const dir = approvalsDir();
  if (!existsSync(dir)) {
    process.stdout.write("(no active approvals — directory does not exist)\n");
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    process.stdout.write("(no active approvals)\n");
    return;
  }
  const now = Date.now();
  const active: ApprovalMarker[] = [];
  for (const file of files) {
    const target = `${dir}/${file}`;
    try {
      const marker = JSON.parse(readFileSync(target, "utf8")) as ApprovalMarker;
      const expiresAt = Date.parse(marker.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt > now) {
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
      "(no active approvals — expired markers cleaned up)\n",
    );
    return;
  }
  for (const marker of active) {
    const remaining = Math.max(
      0,
      Math.floor((Date.parse(marker.expires_at) - now) / 1000),
    );
    process.stdout.write(
      `${marker.path}\n  expires: ${marker.expires_at} (${remaining}s remaining)\n  reason: ${marker.reason}\n`,
    );
  }
}

function revoke(path: string): void {
  const canonical = canonicalizePath(ensureAbsolute(path));
  const target = markerPath(canonical);
  if (!existsSync(target)) {
    process.stdout.write(`no approval marker for: ${canonical}\n`);
    return;
  }
  unlinkSync(target);
  process.stdout.write(`revoked: ${canonical}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const rest = argv.slice(1);
  if (verb === "approve") {
    const { ttl, reason, positional } = parseArgs(rest);
    const path = positional[0];
    if (path === undefined) {
      process.stderr.write("approve: path argument required\n");
      process.exit(2);
    }
    approve(path, ttl, reason);
    return;
  }
  if (verb === "list") {
    listApprovals();
    return;
  }
  if (verb === "revoke") {
    const path = rest[0];
    if (path === undefined) {
      process.stderr.write("revoke: path argument required\n");
      process.exit(2);
    }
    revoke(path);
    return;
  }
  process.stderr.write(
    "usage:\n" +
      '  config-protection-cli approve <path> [--ttl <seconds>] [--reason "..."]\n' +
      "  config-protection-cli list\n" +
      "  config-protection-cli revoke <path>\n",
  );
  process.exit(2);
}

main();
