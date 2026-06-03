#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for audit-queue (Tier 1 Slice 3 Layer 4).
 *
 * Usage:
 *   bun run src/audits/cli.ts queue --for <identity> --channel <channel-id>
 *
 * Or via dispatcher:
 *   claude-conductor audits queue --for <identity> --channel <channel-id>
 *
 * Output: JSON object with `channel_id`, `target_identity`, `as_of_ms`,
 * and `pending[]` — the queue of pending audit-asks targeting `--for`
 * identity, sorted by waited_minutes DESC then tier rank DESC.
 *
 * Body resolution: in-flight messages may have inline `body` OR
 * `body_ref` pointing to `~/.claude/channels/<id>/bodies/<ref>.txt`.
 * The CLI prepopulates a body-store map for `body_ref`-only messages
 * before calling into the pure-logic layer.
 *
 * Plan: ~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md v0.1.
 */

import { readMessages, readBodyFile } from "../channels/index.ts";
import { queryPendingAuditAsks } from "./queue.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[audits] ${message}\n`);
  process.exit(code);
}

function consumeStringValue(
  argv: readonly string[],
  i: number,
  flag: string,
): { value: string; consumed: number } {
  // Support both `--flag value` and `--flag=value` forms.
  const head = argv[i];
  if (head === undefined) die(`missing argument for ${flag}`);
  if (head.startsWith(`${flag}=`)) {
    const value = head.slice(flag.length + 1);
    if (value.length === 0) die(`empty value for ${flag}`);
    return { value, consumed: 1 };
  }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("-")) {
    die(`missing argument for ${flag}`);
  }
  return { value: next, consumed: 2 };
}

function parseQueueFlags(argv: readonly string[]): {
  target_identity: string;
  channel_id: string;
} {
  let target_identity = "";
  let channel_id = "";
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--for" || arg.startsWith("--for=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--for");
      target_identity = value;
      i += consumed;
    } else if (arg === "--channel" || arg.startsWith("--channel=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--channel");
      channel_id = value;
      i += consumed;
    } else {
      die(`unknown flag '${arg}' for audits queue`);
    }
  }
  if (target_identity.length === 0) {
    die("--for <identity> is required (e.g., --for Delta)");
  }
  if (channel_id.length === 0) {
    die(
      "--channel <channel-id> is required (e.g., --channel 2026-05-18_10-50)",
    );
  }
  return { target_identity, channel_id };
}

function queueCommand(argv: readonly string[]): void {
  const { target_identity, channel_id } = parseQueueFlags(argv);

  // includeArchive: full-history audit must span rotation archives.
  const messages = readMessages(channel_id, { includeArchive: true });

  // Prepopulate bodies_by_ref for body_ref-only messages so the pure
  // logic doesn't need filesystem access. Inline `body` skips lookup.
  const bodies_by_ref = new Map<string, string>();
  for (const m of messages) {
    if (m.body !== undefined) continue;
    if (m.body_ref === undefined) continue;
    const raw = readBodyFile(channel_id, m.body_ref);
    if (raw !== null) bodies_by_ref.set(m.body_ref, raw);
  }

  const now_ms = Date.now();
  const pending = queryPendingAuditAsks({
    messages,
    bodies_by_ref,
    target_identity,
    now_ms,
  });

  const output = {
    channel_id,
    target_identity,
    as_of_ms: now_ms,
    pending,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const rest = argv.slice(1);
  if (verb === undefined || verb === "--help" || verb === "-h") {
    process.stdout.write(
      [
        "audits CLI — pending audit-queue per NATO identity.",
        "",
        "Subcommands:",
        "  queue --for <identity> --channel <channel-id>",
        "    Print { channel_id, target_identity, as_of_ms, pending[] } JSON.",
        "    Pending = audit-asks targeting <identity> without matching",
        "    audit-verdict reply. Sorted by waited_minutes DESC then tier DESC.",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (verb === "queue") {
    queueCommand(rest);
    return;
  }
  die(`unknown subcommand '${verb}' for audits CLI (valid: queue)`);
}

main();
