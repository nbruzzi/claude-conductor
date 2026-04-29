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

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";

import { isValidArtifactId } from "../active-sessions/index.ts";
import { parseFlags } from "../cli/flags.ts";
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

/** --body-file size cap (256 KiB). Bodies above this are refused outright. */
const BODY_FILE_MAX_BYTES = 256 * 1024;

/** Mirror of channels/index.ts:SMALL_MESSAGE_MAX_BYTES (3 KiB). Bodies above
 *  this trigger the body_ref sidecar shunt; we surface a stderr notice when
 *  --body-file content crosses this threshold. */
const BODY_REF_SHUNT_THRESHOLD_BYTES = 3 * 1024;

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

/**
 * Read body content from a file path. Validation pipeline (per parent plan
 * SE-3 + RE-1 fix from `vivid-seeking-crayon` audit, §3):
 *
 *   1. lstatSync at user-supplied path → reject if symlink (catches
 *      direct symlink-to-sensitive-target).
 *   2. realpathSync → resolve to canonical absolute path. Catches paths
 *      INSIDE symlinked sensitive directories (e.g., `/private/etc/...`
 *      via macOS's `/etc → /private/etc` symlink) AND symlinked $HOME
 *      (NAS-mounted home). ENOENT on realpath → die early.
 *   3. Path policy → refuse paths under sensitive system / credential
 *      dirs. The denylist applies to the REALPATH, not the user-supplied
 *      path; lexical-prefix match on the unresolved input would miss
 *      symlink-equivalent sensitive paths.
 *   4. openSync with O_RDONLY | O_NOFOLLOW → race-safe leaf protection
 *      against symlink-swap between lstat and open.
 *   5. fstatSync size → reject if > BODY_FILE_MAX_BYTES (256 KiB).
 *   6. Read content via fd, with try/finally ensuring fd closure on any
 *      throw mid-read (RE inline-fix prevents fd leak; tested in
 *      `cli-body-file.test.ts` fd-leak scenario).
 *   7. Stderr notice when body crosses BODY_REF_SHUNT_THRESHOLD_BYTES so
 *      operators know the body will be sidecarred to bodies/<uuid>.txt.
 *
 * Returns the body string. Dies with a clear message on any rejection.
 */
function readBodyFromFile(path: string): string {
  let lstat;
  try {
    lstat = lstatSync(path);
  } catch (err) {
    die(`--body-file: cannot lstat "${path}": ${(err as Error).message}`, {
      code: 2,
      category: "VALIDATION",
    });
  }
  if (lstat.isSymbolicLink()) {
    die(
      `--body-file: refusing symlink "${path}" — pass the target file directly`,
      { code: 2, category: "VALIDATION" },
    );
  }

  // RE-1 fix: realpath-resolve before denylist match. Catches macOS
  // path-equivalents (`/etc` ↔ `/private/etc`), $HOME-as-symlink, and
  // paths inside symlinked sensitive dirs.
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch (err) {
    die(`--body-file: cannot resolve "${path}": ${(err as Error).message}`, {
      code: 2,
      category: "VALIDATION",
    });
  }

  const realHome = realpathSync(homedir());
  // OS tmpdir is user-writable scratch space; on macOS it resolves under
  // `/private/var/folders/...` which would trip both /var and /private
  // denylist prefixes. Allow tmpdir explicitly so legitimate temp-file
  // body-file reads work; the denylist still catches sensitive system
  // paths under /etc, /var (non-tmpdir), /private (non-tmpdir), etc.
  const realTmpdir = realpathSync(tmpdir());
  const inTmpdir =
    resolved === realTmpdir || resolved.startsWith(`${realTmpdir}/`);
  if (!inTmpdir) {
    const denied: readonly string[] = [
      "/etc",
      "/var",
      "/private",
      "/tmp",
      "/Volumes",
      `${realHome}/.ssh`,
      `${realHome}/.aws`,
      `${realHome}/Library/Application Support`,
      `${realHome}/Library/Keychains`,
    ];
    for (const root of denied) {
      if (resolved === root || resolved.startsWith(`${root}/`)) {
        die(`--body-file: refusing path under "${root}" — sensitive location`, {
          code: 2,
          category: "VALIDATION",
        });
      }
    }
  }

  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    die(`--body-file: cannot open "${path}": ${(err as Error).message}`, {
      code: 2,
      category: "VALIDATION",
    });
  }

  try {
    const stat = fstatSync(fd);
    if (stat.size > BODY_FILE_MAX_BYTES) {
      die(
        `--body-file: "${path}" is ${stat.size} bytes; exceeds ${BODY_FILE_MAX_BYTES} cap`,
        { code: 2, category: "VALIDATION" },
      );
    }
    const buf = Buffer.alloc(stat.size);
    let total = 0;
    while (total < stat.size) {
      const n = readSync(fd, buf, total, stat.size - total, total);
      if (n <= 0) break;
      total += n;
    }
    const body = buf.subarray(0, total).toString("utf-8");
    if (Buffer.byteLength(body, "utf-8") > BODY_REF_SHUNT_THRESHOLD_BYTES) {
      process.stderr.write(
        `[channels] body ${stat.size} bytes — exceeds ${BODY_REF_SHUNT_THRESHOLD_BYTES}-byte inline limit; will be stored as body_ref to bodies/<uuid>.txt\n`,
      );
    }
    return body;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* close-on-cleanup; ignore */
    }
  }
}

/** Extract `--body-file <path>` from an argv tail. Returns null when absent. */
function parseBodyFileFlag(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--body-file") {
      const path = args[i + 1];
      if (path === undefined || path.length === 0) {
        die(`--body-file requires a path argument`, {
          code: 2,
          category: "ARGS",
        });
      }
      return path;
    }
  }
  return null;
}

/**
 * Entry point for the channels CLI. Exported so callers (dispatcher.ts,
 * tests, future cross-edge consumers) can invoke programmatically without
 * relying on the `import.meta.main` side-effect at the bottom of this file.
 *
 * Atomic-wiring note (per `feedback-atomic-wiring-discipline.md` + plan
 * vivid-seeking-crayon §3): this export, the `import.meta.main` guard at
 * EOF, and the body-file plumbing land in a single commit. The
 * `cli-import-safety.test.ts` triplet asserts: (1) importing this file
 * does NOT auto-execute the CLI (guard works), (2) `runChannelsCli(["help"])`
 * returns programmatically (export reachable), (3) subprocess
 * `bun run src/channels/cli.ts help` succeeds (guard's import.meta.main
 * branch fires under direct invocation).
 */
export async function runChannelsCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [cmd, ...rawRest] = argv;
  // Pull the standard CLI flags out of the verb-arg tail so positional
  // indices (`requireArg(rest, 0, ...)`, etc.) skip past --json/--quiet/-h.
  // outputJson is a module-level toggle consumed by die(); writing it once
  // here means error paths emit structured JSON without needing each verb
  // to thread the flag through.
  const { positional: rest, flags } = parseFlags([...rawRest]);
  outputJson = flags.json;
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
        printJson(await joinChannel({ channelId, sessionId: sid() }));
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
        // ARCH-4 send-case body order (per plan vivid-seeking-crayon §3):
        //   1. parse flags + body-file
        //   2. read body (if --body-file)
        //   3. role-gate (Bravo's Slice 6 will insert here at merge)
        //   4. appendMessage
        // Body is read BEFORE role rejection (cheap-fail-late). The
        // merge-time integration test `cli-send-merged.test.ts` (added by
        // the second-merging lane) locks the ordering: --body-file with
        // role==='out' must die with the DENYLIST die, NOT the role-die.
        const bodyFilePath = parseBodyFileFlag(rest);
        // Mutex with stdin: documented as caller-responsibility for now.
        // Bun's `process.stdin.isTTY` is `undefined` for both piped and
        // closed/ignored stdin (verified empirically), so there is no
        // reliable way to detect "stdin piped with data" before reading.
        // When --body-file is set, file content wins silently; stdin is
        // not read. Async-readable + timeout detection is feasible but
        // adds 50ms latency per send and is deferred to a future revision
        // (TA-2 known-follow-up in plan §Known follow-ups).

        let body: string;
        if (bodyFilePath !== null) {
          body = readBodyFromFile(bodyFilePath).trim();
          if (body.length === 0) {
            die(
              `--body-file: "${bodyFilePath}" produced empty body after trim — file is empty or whitespace-only`,
              { code: 2, category: "VALIDATION" },
            );
          }
        } else {
          body = (await readStdin()).trim();
          if (body.length === 0) {
            die("empty body — send requires a non-empty message on stdin", {
              category: "VALIDATION",
              remediation:
                "pipe a non-empty body via stdin: printf '%s' \"<text>\" | channels send <id> <kind>",
            });
          }
        }

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

// import.meta.main guard (per `feedback-atomic-wiring-discipline.md` +
// plan vivid-seeking-crayon §3): this guard prevents auto-execution when
// the file is imported as a module (test runner, dispatcher.ts, future
// programmatic callers). When run as the entry point (`bun run src/channels/cli.ts`),
// import.meta.main is true and the CLI executes. When imported, it is
// false and `runChannelsCli` is callable but not invoked.
//
// Validated by `test/channels/cli-import-safety.test.ts` (3 tests):
// (1) module import does not exit/hang (guard catches missing-guard regression),
// (2) programmatic `runChannelsCli(["help"])` returns (export reachable),
// (3) subprocess entry-path execution succeeds (guard's true branch works).
if (import.meta.main) {
  await runChannelsCli();
}
