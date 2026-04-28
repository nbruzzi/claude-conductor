#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI wrapper for the channels module, invoked by session slash commands.
 *
 * Usage:
 *   bun run src/channels/cli.ts from-handoff <handoff-path>
 *   bun run src/channels/cli.ts create <channel-id> <handoff-id>
 *   bun run src/channels/cli.ts join <channel-id>
 *   bun run src/channels/cli.ts close <channel-id>
 *   bun run src/channels/cli.ts send <channel-id> <kind>   [body on stdin]
 *   bun run src/channels/cli.ts read <channel-id>          [prints JSON array]
 *   bun run src/channels/cli.ts list [--include-archived]
 *   bun run src/channels/cli.ts meta <channel-id>
 *   bun run src/channels/cli.ts heartbeat <channel-id>
 *   bun run src/channels/cli.ts peers <channel-id>
 *   bun run src/channels/cli.ts body <channel-id> <body-ref>
 *
 * Session identity: reads `CLAUDE_SESSION_ID` from env. Slash commands must
 * pass it through: `CLAUDE_SESSION_ID="$session_id" bun run ...`.
 *
 * Cross-edge invocation note (per memory `feedback-channel-cli-uuid-only-env.md`
 * + sub-step 0.10 RE-2 tightening): this CLI rejects non-UUID-shaped
 * CLAUDE_SESSION_ID via `isValidSessionId`. There is intentionally NO
 * ppid-walk fallback here — that pattern lives in dotfiles' canonical
 * `src/channels/cli.ts` for sessions whose UUID is harness-randomized
 * without being env-exported. For cross-edge invocation from a session
 * lacking a UUID-shaped CLAUDE_SESSION_ID, use the dotfiles canonical CLI.
 */

import { isValidArtifactId } from "../active-sessions/index.ts";
import {
  appendMessage,
  channelIdFromHandoff,
  closeChannel,
  createChannel,
  heartbeatMtime,
  joinChannel,
  listChannels,
  newestHeartbeatMtime,
  readBodyFile,
  readMessages,
  readMetadata,
  resolveSessionId,
  touchHeartbeat,
  type ChannelKind,
  type ChannelMessage,
} from "./index.ts";

const VALID_KINDS: readonly ChannelKind[] = [
  "note",
  "question",
  "handoff",
  "status",
];
const LIVE_WINDOW_MS = 30 * 60 * 1000;
const ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

function die(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function requireArg(argv: string[], i: number, name: string): string {
  const v = argv[i];
  if (!v) die(`missing argument: ${name}`);
  return v;
}

// Defense-in-depth: channel-id flows directly into channelDir → metadataPath →
// heartbeatPath → bodyDir path joins. Without this gate, an argv value like
// "../../etc" would escape the channels root. Symmetric with isValidSessionId
// gating in active-sessions/index.ts:302. Sub-step 0.10 RE-2.
function requireChannelId(argv: string[], i: number): string {
  const v = requireArg(argv, i, "channel-id");
  if (!isValidArtifactId(v)) {
    die(
      `invalid channel-id: "${v}" — must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`,
    );
  }
  return v;
}

function sid(): string {
  return resolveSessionId(undefined);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function printJson(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

function liveness(
  ageMs: number | null,
): "live" | "online" | "stale" | "unknown" {
  if (ageMs === null) return "unknown";
  if (ageMs < LIVE_WINDOW_MS) return "live";
  if (ageMs < ONLINE_WINDOW_MS) return "online";
  return "stale";
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "from-handoff": {
      const path = requireArg(rest, 0, "handoff-path");
      process.stdout.write(`${channelIdFromHandoff(path)}\n`);
      return;
    }
    case "create": {
      const channelId = requireChannelId(rest, 0);
      const handoffId = requireArg(rest, 1, "handoff-id");
      printJson(createChannel({ channelId, handoffId, sessionId: sid() }));
      return;
    }
    case "join": {
      const channelId = requireChannelId(rest, 0);
      printJson(joinChannel({ channelId, sessionId: sid() }));
      return;
    }
    case "close": {
      const channelId = requireChannelId(rest, 0);
      printJson(closeChannel({ channelId, sessionId: sid() }));
      return;
    }
    case "send": {
      const channelId = requireChannelId(rest, 0);
      const kind = requireArg(rest, 1, "kind");
      if (!VALID_KINDS.includes(kind as ChannelKind)) {
        die(
          `invalid kind "${kind}" — must be one of ${VALID_KINDS.join(", ")}`,
        );
      }
      const body = (await readStdin()).trim();
      if (body.length === 0)
        die("empty body — send requires a non-empty message on stdin");
      const message: ChannelMessage = {
        ts: new Date().toISOString(),
        from: sid(),
        kind: kind as ChannelKind,
        body,
      };
      printJson(appendMessage({ channelId, message }));
      return;
    }
    case "read": {
      const channelId = requireChannelId(rest, 0);
      const resolved = readMessages(channelId).map((m) => {
        if (m.body_ref && !m.body) {
          const body = readBodyFile(channelId, m.body_ref);
          return body !== null ? { ...m, body } : m;
        }
        return m;
      });
      printJson(resolved);
      return;
    }
    case "list": {
      const includeArchived = rest.includes("--include-archived");
      printJson(listChannels({ includeArchived }));
      return;
    }
    case "meta": {
      const channelId = requireChannelId(rest, 0);
      printJson(readMetadata(channelId));
      return;
    }
    case "heartbeat": {
      const channelId = requireChannelId(rest, 0);
      touchHeartbeat(channelId, sid());
      return;
    }
    case "peers": {
      const channelId = requireChannelId(rest, 0);
      const meta = readMetadata(channelId);
      const self = sid();
      const now = Date.now();
      const peers = meta.participants
        .filter((p) => p !== self)
        .map((p) => {
          const m = heartbeatMtime(channelId, p);
          const ageMs = m === null ? null : now - m;
          return {
            session_id: p,
            last_seen_ms: m,
            age_ms: ageMs,
            status: liveness(ageMs),
          };
        });
      printJson({
        self,
        peers,
        newest_heartbeat_ms: newestHeartbeatMtime(channelId),
      });
      return;
    }
    case "body": {
      const channelId = requireChannelId(rest, 0);
      const ref = requireArg(rest, 1, "body-ref");
      const body = readBodyFile(channelId, ref);
      if (body === null)
        die(`body ${ref} not found for channel ${channelId}`, 2);
      process.stdout.write(body);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(
        [
          "channels CLI — see src/channels/cli.ts header for full usage.",
          "",
          "Subcommands: from-handoff | create | join | close | send | read | list | meta | heartbeat | peers | body",
        ].join("\n") + "\n",
      );
      return;
    }
    default:
      die(`unknown subcommand: ${cmd}`);
  }
}

await main();
