#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for bandwidth inference (Tier 1 Slice 3 Layer 4).
 *
 * Usage:
 *   bun run src/bandwidth/cli.ts show --for <identity> --channel <channel-id>
 *
 * Or via dispatcher:
 *   claude-conductor bandwidth show --for <identity> --channel <channel-id>
 *
 * Output: JSON object with `channel_id`, `identity`, `derived_at_ms`,
 * `state` (BandwidthState), and `inputs` (BandwidthInputs). Surfaces
 * BOTH the inferred state AND the artifact-evidence behind it.
 *
 * Heartbeat resolution: identity → session_id via channel metadata's
 * identities map; session_id → heartbeat mtime via `heartbeatMtime`.
 * Missing identity claim → `heartbeat_age_ms: null` → STALE.
 *
 * Plan: ~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md v0.1.
 */

import {
  heartbeatMtime,
  readBodyFile,
  readMessages,
  readMetadata,
} from "../channels/index.ts";
import { inferBandwidth } from "./inference.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[bandwidth] ${message}\n`);
  process.exit(code);
}

function consumeStringValue(
  argv: readonly string[],
  i: number,
  flag: string,
): { value: string; consumed: number } {
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

function parseShowFlags(argv: readonly string[]): {
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
      die(`unknown flag '${arg}' for bandwidth show`);
    }
  }
  if (target_identity.length === 0) {
    die("--for <identity> is required (e.g., --for Bravo)");
  }
  if (channel_id.length === 0) {
    die(
      "--channel <channel-id> is required (e.g., --channel 2026-05-18_10-50)",
    );
  }
  return { target_identity, channel_id };
}

/**
 * Resolve a NATO identity name to its current session_id via the
 * channel metadata's identities map. Returns `null` when the identity
 * is not claimed on the channel.
 */
function resolveIdentitySessionId(
  channel_id: string,
  target_identity: string,
): string | null {
  const meta = readMetadata(channel_id);
  const claim = meta.identities?.[target_identity];
  if (claim === undefined) return null;
  return claim.session_id;
}

function showCommand(argv: readonly string[]): void {
  const { target_identity, channel_id } = parseShowFlags(argv);

  // includeArchive: full-history analytics must span rotation archives.
  const messages = readMessages(channel_id, { includeArchive: true });

  const bodies_by_ref = new Map<string, string>();
  for (const m of messages) {
    if (m.body !== undefined) continue;
    if (m.body_ref === undefined) continue;
    const raw = readBodyFile(channel_id, m.body_ref);
    if (raw !== null) bodies_by_ref.set(m.body_ref, raw);
  }

  const now_ms = Date.now();

  // Identity → sid → heartbeat-mtime → age.
  let heartbeat_age_ms: number | null = null;
  const sid = resolveIdentitySessionId(channel_id, target_identity);
  if (sid !== null) {
    const mtime = heartbeatMtime(channel_id, sid);
    if (mtime !== null) {
      heartbeat_age_ms = Math.max(0, now_ms - mtime);
    }
  }

  const result = inferBandwidth({
    messages,
    bodies_by_ref,
    target_identity,
    heartbeat_age_ms,
    now_ms,
  });

  const output = {
    channel_id,
    identity: target_identity,
    derived_at_ms: now_ms,
    state: result.state,
    inputs: result.inputs,
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
        "bandwidth CLI — derive identity bandwidth-state from artifacts.",
        "",
        "Subcommands:",
        "  show --for <identity> --channel <channel-id>",
        "    Print { channel_id, identity, derived_at_ms, state, inputs } JSON.",
        "    State ∈ { SATURATED, ACTIVE, IDLE-AVAILABLE, STALE }.",
        "    Inputs include msg_density_30min, audits_delivered_90min,",
        "    heartbeat_age_ms (null when identity unclaimed), open_audit_asks.",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (verb === "show") {
    showCommand(rest);
    return;
  }
  die(`unknown subcommand '${verb}' for bandwidth CLI (valid: show)`);
}

main();
