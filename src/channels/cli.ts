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
import { parseFlags } from "../cli/flags.ts";
import {
  appendMessage,
  channelIdFromHandoff,
  closeChannel,
  closeStalePeerIdentity,
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
  type ChannelRole,
} from "./index.ts";
import {
  claimIdentity,
  getIdentityForSession,
  IdentityNotHeldError,
  isValidIdentity,
  setRole,
  unlinkIdentitySentinelOrLogOrphan,
  type NatoIdentity,
} from "./identity.ts";

const VALID_KINDS: readonly ChannelKind[] = [
  "note",
  "question",
  "handoff",
  "status",
];
const VALID_ROLES: readonly ChannelRole[] = ["pen", "queue", "out"];
const LIVE_WINDOW_MS = 30 * 60 * 1000;
const ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Heartbeat staleness threshold for `close-peer`. A peer whose heartbeat
 * mtime is older than this is treated as eligible for forced release per
 * Slice 5 RE-6 (60 s gives a peer about 6× the live-window's tail time
 * to refresh; longer than `--quiet` poll cadence; shorter than the
 * 30-min stale-lock-steal window). `--force` overrides for operator
 * intervention against actively-heartbeating peers.
 */
const STALE_THRESHOLD_MS = 60 * 1000;

/**
 * Per-verb help strings shown when a verb is invoked with `--help` or
 * `-h`. POSIX-aligned per Slice 5 RE-7 — printed to stdout, exit 0.
 * Keep each entry to ~3 lines max (synopsis + 1-2 line description) so
 * the output is consumable without scrolling.
 */
const VERB_HELP: Record<string, string> = {
  "from-handoff":
    "from-handoff <handoff-path>\n  Print the channel id derived from a handoff filename.",
  create:
    "create <channel-id> <handoff-id>\n  Create a new channel with metadata for the given handoff id.",
  join: "join <channel-id>\n  Join the channel + atomically claim the next available NATO identity.\n  Idempotent rejoin returns the existing claim.",
  close: "close <channel-id>\n  Mark the channel closed (no further sends).",
  send: "send <channel-id> <kind>\n  Append a message; body read from stdin. kind ∈ {note, question, handoff, status}.",
  read: "read <channel-id>\n  Print messages as JSON (resolving body_ref'd large bodies).",
  list: "list [--include-archived]\n  Print active (or active+archived) channels as JSON.",
  meta: "meta <channel-id>\n  Print parsed metadata as JSON.",
  heartbeat:
    "heartbeat <channel-id>\n  Touch this session's heartbeat file in the channel.",
  peers:
    "peers <channel-id>\n  Print {self, peers[], newest_heartbeat_ms} as JSON.",
  body: "body <channel-id> <body-ref>\n  Print the body content for a body_ref to stdout.",
  whoami:
    "whoami <channel-id>\n  Print this session's NATO identity + role on the channel as JSON.\n  Exits 0 with `null` if the session has no claim.",
  "set-role":
    "set-role <channel-id> --role <pen|queue|out>\n  Update the role of this session's claimed identity. Exits 5 if no\n  identity is held (per RE-6 — silent no-op is the failure mode).",
  "close-peer":
    "close-peer <channel-id> --peer <Identity> [--force]\n  Release a peer's NATO identity if its heartbeat is > 60 s stale.\n  --force overrides the staleness gate (operator escape hatch).",
};

const TOP_LEVEL_HELP =
  "channels CLI — see src/channels/cli.ts header for full usage.\n" +
  "\n" +
  "Subcommands: from-handoff | create | join | close | send | read | list |\n" +
  "             meta | heartbeat | peers | body | whoami | set-role | close-peer\n" +
  "\n" +
  "Run '<subcommand> --help' for verb-specific usage.";

// die() output mode — set once in main() after flag parse. Plain stderr
// is the default; --json emits structured payload per parent plan §247-249.
let outputJson = false;

type DieOptions = {
  /** Exit code (default 1). */
  readonly code?: number;
  /** Coarse error class for structured output (e.g. ARGS / VALIDATION / NOT_FOUND). */
  readonly category?: string;
  /** Operator-facing fix hint shown after the message. */
  readonly remediation?: string;
};

function die(message: string, opts: DieOptions = {}): never {
  const code = opts.code ?? 1;
  const category = opts.category ?? "GENERAL";
  if (outputJson) {
    const payload: {
      code: number;
      category: string;
      message: string;
      remediation?: string;
    } = { code, category, message };
    if (opts.remediation !== undefined) payload.remediation = opts.remediation;
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
    if (opts.remediation !== undefined) {
      process.stderr.write(`  ${opts.remediation}\n`);
    }
  }
  process.exit(code);
}

function requireArg(argv: readonly string[], i: number, name: string): string {
  const v = argv[i];
  if (!v) die(`missing argument: ${name}`, { category: "ARGS" });
  return v;
}

// Defense-in-depth: channel-id flows directly into channelDir → metadataPath →
// heartbeatPath → bodyDir path joins. Without this gate, an argv value like
// "../../etc" would escape the channels root. Symmetric with isValidSessionId
// gating in active-sessions/index.ts:302. Sub-step 0.10 RE-2.
function requireChannelId(argv: readonly string[], i: number): string {
  const v = requireArg(argv, i, "channel-id");
  if (!isValidArtifactId(v)) {
    die(
      `invalid channel-id: "${v}" — must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`,
      { category: "VALIDATION" },
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
  const [, , cmd, ...rawRest] = process.argv;
  // Pull the standard CLI flags out of the verb-arg tail so positional
  // indices (`requireArg(rest, 0, ...)`, etc.) skip past --json/--quiet/-h.
  // outputJson is a module-level toggle consumed by die(); writing it once
  // here means error paths emit structured JSON without needing each verb
  // to thread the flag through.
  const { positional: rest, flags } = parseFlags(rawRest);
  outputJson = flags.json;
  // Slice 5 RE-7 / RE-W1-3 closure — per-verb `--help` is POSIX-routed
  // (stdout, exit 0). When `cmd === undefined`, the switch's existing
  // no-cmd/help/--help/-h case prints top-level help. When `cmd` is a
  // known verb AND `--help` was extracted from the verb-arg tail, we
  // print verb-specific help. Unknown verb + `--help` falls back to
  // top-level help.
  if (flags.help && cmd !== undefined) {
    const verbHelp = VERB_HELP[cmd];
    process.stdout.write(`${verbHelp ?? TOP_LEVEL_HELP}\n`);
    return;
  }
  // try/catch funnels uncaught throws (sid()/readMetadata/spawned-IO
  // failures, etc.) through die() with a stable category so operators see
  // structured output under --json instead of an unhandled rejection. The
  // verb cases below already call die() explicitly for known error
  // shapes — process.exit() in die() short-circuits before reaching this
  // catch, so it only fires on genuinely thrown errors.
  try {
    switch (cmd) {
      case "from-handoff": {
        const path = requireArg(rest, 0, "handoff-path");
        process.stdout.write(`${channelIdFromHandoff(path)}\n`);
        return;
      }
      case "create": {
        const channelId = requireChannelId(rest, 0);
        const handoffId = requireArg(rest, 1, "handoff-id");
        printJson(
          await createChannel({ channelId, handoffId, sessionId: sid() }),
        );
        return;
      }
      case "join": {
        const channelId = requireChannelId(rest, 0);
        const sessionId = sid();
        // Slice 5: post-metadata-join, atomically claim the next
        // available NATO identity. Idempotent rejoin returns the
        // existing claim's letter without re-assignment. Output shape
        // changes from bare metadata to {metadata, identity} so callers
        // can read both in one verb invocation (slash-command friendly).
        const meta = await joinChannel({ channelId, sessionId });
        const claim = await claimIdentity({ channelId, sessionId });
        printJson({
          metadata: meta,
          identity: {
            identity: claim.identity,
            role: claim.role,
            joined_at: claim.joined_at,
            is_new_participant: claim.is_new_participant,
          },
        });
        return;
      }
      case "close": {
        const channelId = requireChannelId(rest, 0);
        printJson(await closeChannel({ channelId, sessionId: sid() }));
        return;
      }
      case "send": {
        const channelId = requireChannelId(rest, 0);
        const kind = requireArg(rest, 1, "kind");
        if (!VALID_KINDS.includes(kind as ChannelKind)) {
          die(
            `invalid kind "${kind}" — must be one of ${VALID_KINDS.join(", ")}`,
            { category: "VALIDATION" },
          );
        }
        const body = (await readStdin()).trim();
        if (body.length === 0)
          die("empty body — send requires a non-empty message on stdin", {
            category: "VALIDATION",
            remediation:
              "pipe a non-empty body via stdin: printf '%s' \"<text>\" | channels send <id> <kind>",
          });
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
          die(`body ${ref} not found for channel ${channelId}`, {
            code: 2,
            category: "NOT_FOUND",
            remediation: `verify the body-ref via 'channels read ${channelId}' and confirm the message has body_ref set`,
          });
        process.stdout.write(body);
        return;
      }
      case "whoami": {
        const channelId = requireChannelId(rest, 0);
        const sessionId = sid();
        const claim = await getIdentityForSession(channelId, sessionId);
        if (claim === null) {
          // Slice 5: no claim is a successful read of "no identity" —
          // exit 0 with `null` payload. Distinguishes from error states.
          printJson(null);
          return;
        }
        printJson({
          identity: claim.identity,
          role: claim.role,
          joined_at: claim.joined_at,
        });
        return;
      }
      case "set-role": {
        const channelId = requireChannelId(rest, 0);
        const roleIdx = rest.indexOf("--role");
        if (roleIdx === -1) {
          die("missing --role <pen|queue|out>", {
            category: "ARGS",
            remediation: "set-role <channel-id> --role <pen|queue|out>",
          });
        }
        const roleArg = rest[roleIdx + 1];
        if (roleArg === undefined) {
          die("--role flag requires a value (pen|queue|out)", {
            category: "ARGS",
          });
        }
        if (!VALID_ROLES.includes(roleArg as ChannelRole)) {
          die(
            `invalid role "${roleArg}" — must be one of ${VALID_ROLES.join(", ")}`,
            { category: "VALIDATION" },
          );
        }
        const role = roleArg as ChannelRole;
        const sessionId = sid();
        // Resolve THIS session's identity before set-role — set-role
        // updates the role of the identity held by THIS session, not an
        // arbitrary one. Race window between get + set is bounded by the
        // commitIdentityClaim lock; if the identity is released between
        // read and update, IdentityNotHeldError surfaces below as exit 5.
        const myClaim = await getIdentityForSession(channelId, sessionId);
        if (myClaim === null) {
          die(
            `[set-role] this session has no identity claim on channel '${channelId}'`,
            {
              code: 5,
              category: "NOT_HELD",
              remediation: `Run 'channels join ${channelId}' first to claim an identity.`,
            },
          );
        }
        try {
          await setRole(channelId, myClaim.identity, role);
        } catch (err: unknown) {
          if (err instanceof IdentityNotHeldError) {
            // Race: identity was released between get and set. Per
            // RE-6, surface as exit 5 — don't silently retry or claim.
            die(
              `[set-role] identity '${myClaim.identity}' is no longer held (released between read and update)`,
              { code: 5, category: "NOT_HELD" },
            );
          }
          throw err;
        }
        printJson({
          identity: myClaim.identity,
          role,
          previous_role: myClaim.role,
        });
        return;
      }
      case "close-peer": {
        const channelId = requireChannelId(rest, 0);
        const peerIdx = rest.indexOf("--peer");
        if (peerIdx === -1) {
          die("missing --peer <Identity>", {
            category: "ARGS",
            remediation:
              "close-peer <channel-id> --peer <NATO-identity> [--force]",
          });
        }
        const peerArg = rest[peerIdx + 1];
        if (peerArg === undefined) {
          die("--peer flag requires a NATO identity value", {
            category: "ARGS",
          });
        }
        if (!isValidIdentity(peerArg)) {
          die(
            `invalid peer identity "${peerArg}" — must be a NATO letter (Alpha, Bravo, ..., Zulu)`,
            { category: "VALIDATION" },
          );
        }
        const peer: NatoIdentity = peerArg;
        const force = rest.includes("--force");
        // Slice 5 RE-6: heartbeat-staleness check + metadata removal in
        // a SINGLE withMetadataLock section (closeStalePeerIdentity).
        // Sentinel unlink follows the metadata-first ordering — orphan
        // sentinel on unlink failure is reconcilable on next claim per
        // Slice 2.2 Decision D.
        const result = await closeStalePeerIdentity({
          channelId,
          identity: peer,
          staleThresholdMs: STALE_THRESHOLD_MS,
          force,
        });
        if (result.kind === "released") {
          unlinkIdentitySentinelOrLogOrphan(
            channelId,
            peer,
            result.releasedClaim,
          );
          // Audit-trail status message so other peers observing the
          // channel see the close. Posted by THIS session (the operator
          // who invoked close-peer), referencing the released session.
          const peerClosedMessage: ChannelMessage = {
            ts: new Date().toISOString(),
            from: sid(),
            kind: "status",
            body: `peer-closed: identity ${peer} (session ${result.releasedClaim.session_id}) released by ${sid()}${force ? " (--force)" : ""}`,
          };
          appendMessage({ channelId, message: peerClosedMessage });
          printJson({
            kind: "released",
            identity: peer,
            previous_session_id: result.releasedClaim.session_id,
          });
          return;
        }
        if (result.kind === "still-active") {
          die(
            `[close-peer] peer '${peer}' is still active (heartbeat age ${result.ageMs ?? "unknown"} ms < ${STALE_THRESHOLD_MS} ms threshold)`,
            {
              code: 6,
              category: "STILL_ACTIVE",
              remediation: "Use --force to override the staleness gate.",
            },
          );
        }
        // result.kind === "not-held" (TS narrows by elimination).
        die(`[close-peer] no identity '${peer}' on channel '${channelId}'`, {
          code: 5,
          category: "NOT_HELD",
        });
      }
      case undefined:
      case "help":
      case "--help":
      case "-h": {
        process.stdout.write(`${TOP_LEVEL_HELP}\n`);
        return;
      }
      default:
        die(`unknown subcommand: ${cmd}`, {
          category: "ARGS",
          remediation: "Run 'channels help' to list valid subcommands",
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    die(message, { category: "UNCAUGHT" });
  }
}

await main();
