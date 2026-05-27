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

import {
  isValidArtifactId,
  isValidSessionId,
} from "../active-sessions/index.ts";
import { parseFlags } from "../cli/flags.ts";
import { getWallClockNow } from "../shared/clock.ts";
import {
  describeSource,
  formatRecoveryHint,
  resolveSessionId as discoverSessionId,
} from "../shared/session-id-discovery.ts";
import {
  appendMessage,
  channelIdFromHandoff,
  clearLastSeenCursor,
  closeChannel,
  closeStalePeerIdentity,
  createChannel,
  heartbeatMtime,
  isChannelArchived,
  CHANNEL_KINDS,
  joinChannel,
  listChannels,
  makeSendOutMutator,
  newestHeartbeatMtime,
  readBodyFile,
  readLastSeenCursor,
  readMessages,
  readMetadata,
  touchHeartbeat,
  writeLastSeenCursor,
  type ChannelKind,
  type ChannelMessage,
  type ChannelRole,
} from "./index.ts";
import {
  clearPeerMessageCursor,
  readPeerMessageCursor,
  readPendingPeerMessageCursor,
} from "./peer-message-cursors.ts";
import { parseDigestBody } from "./digest.ts";
import { parseAuditAskBody } from "./audit-ask.ts";
import { parseAuditVerdictBody } from "./audit-verdict.ts";
import { autoWrapAuditVerdict } from "./audit-verdict-auto-wrap.ts";
import { isSubstrateClassPR } from "./substrate-class.ts";
import { parseMemoryProposalBody } from "./memory-proposal.ts";
import { parseWindDownCheckinBody } from "./wind-down-checkin.ts";
import { parseKeyRevokeBody } from "./key-revoke.ts";
import {
  resolveActiveChannelForHandoff,
  summarizeChannelForHandoff,
} from "./handoff-resolver.ts";
import { appendPresenceFailure } from "../shared/presence-failure-log.ts";
import { channelsDir } from "../shared/paths.ts";
import {
  claimIdentity,
  claimIdentityNamed,
  getIdentityForSession,
  IdentityActiveError,
  IdentityAlreadyHeldBySelfError,
  IdentityCasMismatchError,
  IdentityNotHeldError,
  isValidIdentity,
  setRole,
  unlinkIdentitySentinelOrLogOrphan,
  type NatoIdentity,
} from "./identity.ts";
import { renderMessage } from "./render.ts";

// Pull directly from the SSOT tuple — `CHANNEL_KINDS` in
// `src/channels/index.ts` is the single edit point. Adding a new kind
// there widens this acceptance set automatically.
const VALID_KINDS: readonly ChannelKind[] = CHANNEL_KINDS;
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
  "resolve-handoff":
    "resolve-handoff <handoff-path>\n  Resolve a handoff to its active channel. Emits JSON with `kind`:\n    derived-active | derived-empty-no-body-refs | mismatch-body-has-live-alternative | derive-failed.\n  L141 — used by /handoff-resume parallel Step 4a to surface the closeout-handoff mismatch case\n  (derived channel has no live peers AND handoff body names a different channel WITH live peers).",
  "summarize-handoff-channel":
    "summarize-handoff-channel <handoff-path>\n  Summarize the derived channel's activity state for a handoff. Emits JSON with `kind`:\n    live | online | stale | missing | derive-failed.\n  L:142 — used by /handoff-resume Step 1a picker to enrich each candidate row with channel-liveness.\n  Live (peer heartbeat <30 min) and online (≥30 min, <24h) peer counts surfaced separately.\n  Excludes CLAUDE_SESSION_ID from peer counts when set (so the operator's own session\n  doesn't count as a live peer).",
  create:
    "create <channel-id> <handoff-id>\n  Create a new channel with metadata for the given handoff id.",
  join: "join <channel-id> [--as <Identity>] [--role <pen|queue|out>] [--force [--from-session <session-id>]]\n  Join the channel + atomically claim a NATO identity.\n  Without --as: claim the next available letter (idempotent rejoin returns the existing claim).\n  With --as <Identity>: claim the named letter (Alpha..Zulu). If held by another session,\n    --force takes over via atomic sentinel replacement. --from-session adds an optional\n    CAS check that the takeover holder matches a specific session id.\n  Optional --role lands the claimant directly in pen/queue/out (default queue).\n  Same-letter rejoin is idempotent; same-session-different-letter is rejected.\n  Recovery flow for parallel-session resume: 'join <ch> --as Alpha --role pen --force'.",
  close: "close <channel-id>\n  Mark the channel closed (no further sends).",
  send: "send <channel-id> <kind>\n  Append a message; body read from stdin (or --body-file <path>).\n  kind ∈ {note, question, handoff, status, ack, roger, over, standby, out, digest, live-update, audit-ask, audit-verdict, memory-proposal, wind-down-checkin, key-revoke}.\n  Run 'channels kinds' for semantic detail + recommended body content per kind.\n  Send is blocked if this session's claimed role is 'out' unless kind=out\n  (announcing departure is the one send allowed from an out-role peer).\n  kind=digest validates body against the DigestBody schema (src/channels/digest.ts) before send.\n  kind=live-update carries the LiveUpdateBody schema (src/channels/live-update.ts) but is currently NOT pre-validated at send time (parser runs at read time per the verification-budget convention).\n  kind=audit-ask validates body against the AuditAskBody schema (src/channels/audit-ask.ts) before send.\n  kind=audit-verdict validates body against the AuditVerdictBody schema (src/channels/audit-verdict.ts) before send.\n  kind=memory-proposal validates body against the MemoryProposalBody schema (src/channels/memory-proposal.ts) before send.\n  kind=wind-down-checkin validates body against the WindDownCheckinBody schema (src/channels/wind-down-checkin.ts) before send.\n  kind=key-revoke validates body against the KeyRevokeBody schema (src/channels/key-revoke.ts) before send.",
  kinds:
    "kinds\n  Print the message-kind reference: semantic gloss + recommended body content\n  per kind + reader verification budget. See also: docs/conventions/message-kinds-and-verification.md.",
  read: "read <channel-id> [--since-mtime <value> | --since-cursor]\n  Print messages as JSON (resolving body_ref'd large bodies).\n  With no flag: returns full message history.\n  --since-mtime <value>: returns messages with Date.parse(msg.ts) > value.\n                         Value is epoch ms (e.g. 1735689600000) or ISO 8601\n                         (e.g. 2025-01-01T00:00:00Z). Mutually exclusive\n                         with --since-cursor.\n  --since-cursor:        returns messages newer than this session's\n                         last read cursor at\n                         ~/.claude/channels/<id>/last-seen-cursors/<sid>.json (legacy: last-seen/; dual-read fallback ≥30d post-Step-G).\n                         First use bootstraps from full history (stderr advisory).\n                         Successful filtered reads update the cursor.\n  Use 'forget-cursor <id>' to reset; 'show-cursor <id>' to inspect.",
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
  "release-self":
    "release-self <channel-id>\n  Release THIS session's NATO identity claim on the channel.\n  Resolves the held letter automatically via getIdentityForSession; uses\n  implicit force (self-heartbeat is fresh by definition). CAS-guarded\n  against takeover races: if another peer claimed your identity between\n  the resolve + release steps, exits 7 RACE_RELEASED rather than\n  mistakenly releasing their fresh claim. Posts a 'self-released' status\n  message (distinct from 'peer-closed') so observers distinguish\n  operator-initiated self-release from peer-side close-peer action.\n  Exits 5 NOT_HELD if no identity is claimed on this channel.",
  "forget-cursor":
    'forget-cursor <channel-id>\n  Reset this session\'s last-seen cursor on the channel.\n  Subsequent --since-cursor reads will return full history (then bootstrap a fresh cursor).\n  Idempotent: kind="cleared" if cursor existed, "absent" otherwise,\n              "archived" if channel is archived, "error" on EACCES/EBUSY.\n  Use \'show-cursor <channel-id>\' to inspect first.\n  Note: this clears the `read --since-cursor` cursor only. For the\n  peer-message-deliverer hook cursor, use \'forget-message-cursor\'.',
  "show-cursor":
    'show-cursor <channel-id>\n  Print this session\'s last-seen cursor as JSON.\n  kind="present" with {mtime, ts} if cursor exists; "absent" if not; "archived" if channel archived.\n  Use \'forget-cursor <channel-id>\' to reset.',
  "forget-message-cursor":
    'forget-message-cursor <channel-id>\n  Reset this session\'s peer-message-deliverer cursor on the channel.\n  Clears BOTH the committed cursor (`<channel>/peer-message-emit-cursors/<sid>.json`)\n  AND the pending cursor (`<sid>.json.pending`). Next UserPromptSubmit fire will\n  bootstrap-without-emit per Phase 4 Step A Layer 1 design.\n  Idempotent: kind="cleared" if either existed, "absent" if neither,\n              "archived" if channel is archived, "error" on EACCES/EBUSY\n              (with `code` ∈ {EACCES, EBUSY, OTHER} + `detail` fields).\n  Use \'show-message-cursor <channel-id>\' to inspect first.\n  Note: this clears the peer-message-deliverer hook cursor only.\n  For `read --since-cursor` stuckness, use \'forget-cursor\'.',
  "show-message-cursor":
    'show-message-cursor <channel-id>\n  Print this session\'s peer-message-deliverer cursor state as JSON.\n  Emits {kind, channelId, sessionId, committed, pending, phase} (kind:\n  "present"|"absent"|"archived"). On "present", `phase` discriminates the\n  lifecycle stage so operators read one field instead of synthesizing\n  state from committed+pending:\n    "bootstrap-pending" — first-scan bootstrap wrote pending; not yet\n                          promoted. committed=null, pending=set.\n    "stable"           — committed set, no in-flight emission. pending=null.\n    "emission-pending" — emit-turn wrote pending; next prompt promotes.\n                         committed=set, pending=set.\n  Use \'forget-message-cursor <channel-id>\' to reset.',
};

/**
 * Per-kind help text printed by the `channels kinds` verb. Single source
 * of operator-facing per-kind documentation (CLI-3 + MINOR-1 folds per
 * plan v4 §Layer 3 design + Layer 4 §Phase 3 — `digest` body schema
 * lives in `src/channels/digest.ts` via the shared `parseDigestBody`).
 *
 * For verification-budget detail per kind, see
 * `docs/conventions/message-kinds-and-verification.md`.
 */
const KINDS_HELP =
  "Channel message kinds:\n" +
  "  note      — informational; trust verbatim. Body: free-form.\n" +
  "  question  — expects a reply; verify any factual claims. Body: the question + context.\n" +
  "  handoff   — full state transfer; trust + verify against named SHAs/paths. Body: structured handoff.\n" +
  "  status    — state change announcement; trust verbatim. Body: state description.\n" +
  '  ack       — receipt only ("I see your message"); no commitment. Body: `received` or `ack` (1-10 chars).\n' +
  '  roger     — receipt + commitment ("understood, will act"); trust verbatim. Body: 1-line commitment (e.g. `will fold MAJOR-1 by next prompt`).\n' +
  '  over      — sender hint ("I posted, expecting reply"). Body: 1-line hint of expected reply (e.g. `your turn on L3`).\n' +
  '  standby   — sender hint ("heard you, working, hold the channel"). Body: 1-line reason (e.g. `running tests; ~5 min`).\n' +
  "  out       — peer terminates this channel (additive; `claim --force` resets). Body: reason (e.g. `session ended`).\n" +
  "  digest    — structured summary (mental-model sync). Trust the SHAPE; primary-source-verify any audit-class claim or SHA. Body: JSON conforming to DigestBody (see src/channels/digest.ts).\n" +
  "  live-update— sibling-onboarding scope-assignment from active peer (L152). Trust the SHAPE; primary-source-verify any cited SHA/PR/path. Body: JSON conforming to LiveUpdateBody (see src/channels/live-update.ts).\n" +
  "  audit-ask — author requests audit on PR/plan from target peer (Tier 1 Slice 1). Trust the SHAPE; primary-source-verify target_pr exists + target_peer is a live NATO identity. Body: JSON conforming to AuditAskBody (see src/channels/audit-ask.ts).\n" +
  "  audit-verdict— auditor reports verdict closing the audit-loop initiated by audit-ask (Tier 1 Slice 2). Trust the SHAPE; primary-source-verify the verdict's lens-set-applied + findings + counts against the actual diff. Body: JSON conforming to AuditVerdictBody (see src/channels/audit-verdict.ts).\n" +
  "  memory-proposal— peer surfaces memorialization candidate to Nick's batch yes/no decision queue (Tier 2 Verb 2). Trust the SHAPE; primary-source-verify slug uniqueness vs existing memories (when amends_existing is null) or the named memory exists on disk (when non-null). Body: JSON conforming to MemoryProposalBody (see src/channels/memory-proposal.ts).\n" +
  "  wind-down-checkin— peer broadcasts structured cycle-close state at wind-down time (Tier 2 Verb 1). Trust the SHAPE; primary-source-verify cycle_character claim against actual cycle artifacts (PR squashes/CI/failed-approach captures) + memory_candidates slug names against the memory directory. Body: JSON conforming to WindDownCheckinBody (see src/channels/wind-down-checkin.ts).\n" +
  "  key-revoke— operator revokes their own Ed25519 key OR cohort co-signs a compromise revocation (Cycle 1 substrate-core PR-A7). Wire-format drives <nato>.history.json maintenance which feeds resolveKeyAtTime + verifyChannelAuditChain (PR-A6 audit verify CLI maps revoked entries to breaks[].reason='revoked-key' distinct from 'tamper' + 'key-rotation-discontinuity'). Trust the SHAPE; primary-source-verify (a) signed_by[] contains the revoking NATO, (b) revoked_at is Date.parse-valid ISO-8601, (c) revoked_fingerprint matches an existing history entry. Body: JSON conforming to KeyRevokeBody (see src/channels/key-revoke.ts).\n" +
  "\n" +
  "Send is blocked when this session's role is 'out' unless kind=out\n" +
  "(announcing departure is the one send allowed from an out-role peer).\n" +
  "\n" +
  "For verification-budget detail per kind, see:\n" +
  "  docs/conventions/message-kinds-and-verification.md";

const TOP_LEVEL_HELP =
  "channels CLI — see src/channels/cli.ts header for full usage.\n" +
  "\n" +
  "Subcommands: from-handoff | resolve-handoff | summarize-handoff-channel | create | join |\n" +
  "             close | send | read | list | meta | heartbeat | peers | body | whoami |\n" +
  "             set-role | close-peer | release-self | forget-cursor | show-cursor |\n" +
  "             forget-message-cursor |\n" +
  "             show-message-cursor | kinds\n" +
  "\n" +
  "Run '<subcommand> --help' for verb-specific usage.";

/** --body-file size cap (256 KiB). Bodies above this are refused outright. */
const BODY_FILE_MAX_BYTES = 256 * 1024;

/** Mirror of channels/index.ts:SMALL_MESSAGE_MAX_BYTES (3 KiB). Bodies above
 *  this trigger the body_ref sidecar shunt; we surface a stderr notice when
 *  --body-file content crosses this threshold. */
const BODY_REF_SHUNT_THRESHOLD_BYTES = 3 * 1024;

/**
 * Per-invocation output-mode context for `die()`. Phase 2 Slice 0 fix for
 * RE-W2-3 (module-state outputJson leak across in-process runChannelsCli
 * calls). Phase 2 hook consumers call `runChannelsCli` programmatically
 * — without per-call context, a `--json`-mode invocation would leak its
 * mode into the next bare-mode invocation through a module-level toggle.
 *
 * Threaded through `runChannelsCli` → helpers (`requireArg`,
 * `requireChannelId`, `readBodyFromFile`, `parseBodyFileFlag`) → every
 * `die()` call site as a REQUIRED first parameter. TypeScript refuses
 * any `die()` invocation that omits the context, providing a compile-
 * time guarantee that no future call site silently inherits global mode.
 *
 * Per parent plan prismatic-orbiting-mesh §Slice 0 (REV 2.1).
 */
type DieContext = {
  /** When true, die() emits a structured JSON payload to stderr;
   *  otherwise plain text. Driven by `--json` flag in `runChannelsCli`. */
  readonly outputJson: boolean;
};

type DieOptions = {
  /** Exit code (default 1). */
  readonly code?: number;
  /** Coarse error class for structured output (e.g. ARGS / VALIDATION / NOT_FOUND). */
  readonly category?: string;
  /** Operator-facing fix hint shown after the message. */
  readonly remediation?: string;
};

/**
 * Sentinel thrown after a successful die() call when `process.exit` was
 * mocked (so the runtime did not actually terminate). Wave 2 RE-W2-6 fix:
 * the runChannelsCli catch-all at the bottom of `runChannelsCli` would
 * otherwise re-fire die() with category=UNCAUGHT, masking the original
 * die's category/code/remediation. Tests that mock `process.exit` (the
 * fd-leak in-process spy in cli-body-file + the Phase 2 Slice 0 outputJson
 * cursor-leak test in cli-import-safety) detect this sentinel via
 * `instanceof` to recognize "die already wrote stderr — let it bubble".
 */
class DieAlreadyHandled extends Error {
  constructor() {
    super("die() already wrote stderr; process.exit was mocked");
    this.name = "DieAlreadyHandled";
  }
}

function die(ctx: DieContext, message: string, opts: DieOptions = {}): never {
  const code = opts.code ?? 1;
  const category = opts.category ?? "GENERAL";
  if (ctx.outputJson) {
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
  // Cast to drop the `: never` return type so TS sees the throw below as
  // reachable. In production process.exit terminates and the throw is dead;
  // when tests mock process.exit (treating it as `void`) the throw fires
  // and the runChannelsCli catch-all re-throws via the DieAlreadyHandled
  // sentinel rather than re-firing die() with UNCAUGHT.
  const mockableExit = process.exit as (code?: number) => void;
  mockableExit(code);
  throw new DieAlreadyHandled();
}

function requireArg(
  ctx: DieContext,
  argv: readonly string[],
  i: number,
  name: string,
): string {
  const v = argv[i];
  if (!v) die(ctx, `missing argument: ${name}`, { category: "ARGS" });
  return v;
}

// Defense-in-depth: channel-id flows directly into channelDir → metadataPath →
// heartbeatPath → bodyDir path joins. Without this gate, an argv value like
// "../../etc" would escape the channels root. Symmetric with isValidSessionId
// gating in active-sessions/index.ts:302. Sub-step 0.10 RE-2.
function requireChannelId(
  ctx: DieContext,
  argv: readonly string[],
  i: number,
): string {
  const v = requireArg(ctx, argv, i, "channel-id");
  if (!isValidArtifactId(v)) {
    die(
      ctx,
      `invalid channel-id: "${v}" — must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`,
      { category: "VALIDATION" },
    );
  }
  return v;
}

/**
 * Resolve the active session id for CLI operations. Fast path is the
 * `CLAUDE_SESSION_ID` env var — the convention every slash command + hook
 * dispatch path already feeds through. When env is absent (manual CLI use
 * from a fresh shell, automation that forgot to export the var), fall back
 * to the PPID-tree-walk + mtime-fallback discovery in
 * `src/shared/session-id-discovery.ts`.
 *
 * L135 closure (backlog 2026-04-21): prior behavior threw immediately on
 * env-absent, forcing every channel op to prepend the env var manually
 * (`CLAUDE_SESSION_ID="$(uuidgen)" bun run ...`). That convention produced
 * UUID churn on the wire when callers minted fresh ids per invocation —
 * the exact ghost-participant hallucination shape from
 * `feedback-convergent-instances.md` R3/R4. The fallback resolves to the
 * SAME stable id Claude Code wrote into its session telemetry, so wire
 * identity is consistent across invocations.
 *
 * Budget: discovery uses default retry ladder (3 × 250ms = ~750ms max)
 * before falling through to mtime — well under CLI startup tolerance.
 */
function sid(): string {
  // Fast path — explicit env var (matches channels/index.ts:resolveSessionId).
  const envOverride = process.env["CLAUDE_SESSION_ID"];
  if (envOverride && envOverride.length > 0 && isValidSessionId(envOverride)) {
    return envOverride;
  }

  // Fallback — PPID-tree walk → mtime telemetry-tracker → fail with
  // recovery hint. The discovery resolver returns kind: "env" only when
  // the env var is set AND passes its stricter UUID check (we already
  // accepted lenient `isValidSessionId` above), so "env" from discovery
  // is uncommon-but-possible (e.g., env was set but didn't pass our
  // lenient check earlier yet matches the strict-UUID check).
  const discovered = discoverSessionId();
  if (
    discovered.kind === "env" ||
    discovered.kind === "ppid" ||
    discovered.kind === "mtime"
  ) {
    if (process.env["VERBOSE"] !== undefined) {
      process.stderr.write(
        `[channels] sid resolved via ${describeSource(discovered)}: ${discovered.sessionId}\n`,
      );
    }
    return discovered.sessionId;
  }

  // Discovery exhausted — surface recovery hint, not bare throw.
  throw new Error(
    `[channels] session_id resolution failed (${discovered.kind}). ${formatRecoveryHint(discovered)}`,
  );
}

/** Default time-to-first-byte deadline for stdin reads (L:145 / TA-2 closure).
 *  Override via env var `CLAUDE_CONDUCTOR_STDIN_TTFB_TIMEOUT_MS` (tests use 500). */
const DEFAULT_STDIN_TTFB_TIMEOUT_MS = 3000;

function resolveStdinTimeoutMs(): number {
  const raw = process.env["CLAUDE_CONDUCTOR_STDIN_TTFB_TIMEOUT_MS"];
  if (raw === undefined) return DEFAULT_STDIN_TTFB_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_STDIN_TTFB_TIMEOUT_MS;
}

/** Raised by `readStdin` when no bytes arrive within the TTFB deadline.
 *  Callers (currently `send`) translate to a `die()` with operator remediation. */
class StdinTimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(
      `no stdin received within ${elapsedMs}ms — either pipe a body via stdin or pass --body-file <path>`,
    );
    this.name = "StdinTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Drain stdin into a UTF-8 string with a time-to-first-byte deadline.
 *
 * Heredoc input to `bun run ... send <id> <kind> <<EOF ... EOF` previously
 * hung indefinitely on Bun (`for await` on `process.stdin` never observes EOF
 * until shell tear-down). This guard rejects with `StdinTimeoutError` if no
 * byte arrives within the TTFB window; once any byte arrives the timer is
 * cleared and natural drain semantics apply (no full-drain deadline — slow
 * pipelines that stream continuously are unaffected).
 *
 * Backlog: L:145 lean (a). Closes TA-2 known-follow-up at the send-case
 * body-order comment below. The original "50ms latency per send" estimate
 * in that comment overstated the cost — `Promise.race` against a setTimeout
 * with `.unref()` adds zero observable latency on the happy path.
 */
async function readStdin(): Promise<string> {
  const timeoutMs = resolveStdinTimeoutMs();
  const chunks: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = performance.now();

  const ttfbTimer = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new StdinTimeoutError(Math.round(performance.now() - start)));
    }, timeoutMs);
    timer.unref?.();
  });

  const drain = (async () => {
    for await (const chunk of process.stdin) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  })();

  try {
    return await Promise.race([drain, ttfbTimer]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
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
function readBodyFromFile(ctx: DieContext, path: string): string {
  let lstat;
  try {
    lstat = lstatSync(path);
  } catch (err) {
    die(ctx, `--body-file: cannot lstat "${path}": ${(err as Error).message}`, {
      code: 2,
      category: "VALIDATION",
    });
  }
  if (lstat.isSymbolicLink()) {
    die(
      ctx,
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
    die(
      ctx,
      `--body-file: cannot resolve "${path}": ${(err as Error).message}`,
      {
        code: 2,
        category: "VALIDATION",
      },
    );
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
    // /tmp is the user's tmpdir on Linux (not sensitive). On macOS,
    // `/tmp` is a symlink chain to `/private/tmp`, caught by `/private`.
    // The realTmpdir allowlist above already excludes legitimate user
    // tmp paths from this list. Cross-platform safe denylist:
    const denied: readonly string[] = [
      "/etc",
      "/var",
      "/private",
      "/Volumes",
      `${realHome}/.ssh`,
      `${realHome}/.aws`,
      `${realHome}/Library/Application Support`,
      `${realHome}/Library/Keychains`,
    ];
    for (const root of denied) {
      if (resolved === root || resolved.startsWith(`${root}/`)) {
        die(
          ctx,
          `--body-file: refusing path under "${root}" — sensitive location. Try a path under ~/scratch/ or another non-sensitive location.`,
          {
            code: 2,
            category: "VALIDATION",
          },
        );
      }
    }
  }

  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    die(ctx, `--body-file: cannot open "${path}": ${(err as Error).message}`, {
      code: 2,
      category: "VALIDATION",
    });
  }

  try {
    const stat = fstatSync(fd);
    if (stat.size > BODY_FILE_MAX_BYTES) {
      die(
        ctx,
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
function parseBodyFileFlag(
  ctx: DieContext,
  args: readonly string[],
): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--body-file") {
      const path = args[i + 1];
      if (path === undefined || path.length === 0) {
        die(ctx, `--body-file requires a path argument`, {
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
 * Phase 2 Slice 8 cursor-write wrapper with RE-4 closure: in-memory
 * per-process backoff for cursor-write failures (EROFS/ENOSPC/EACCES).
 * Surfaces ONE breadcrumb + one stderr advisory per channel per session;
 * subsequent failures are silently dropped (in-process retry would just
 * spam logs).
 */
const cursorWriteFailureSurfaced = new Set<string>();

function tryWriteLastSeenCursor(
  channelId: string,
  mtime: number,
  ts: string,
  quiet: boolean,
): void {
  try {
    writeLastSeenCursor(channelId, sid(), mtime, ts);
  } catch (err) {
    if (cursorWriteFailureSurfaced.has(channelId)) return;
    cursorWriteFailureSurfaced.add(channelId);
    const detail = err instanceof Error ? err.message : String(err);
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "write-failed",
      sessionId: sid(),
      artifactPath: channelId,
      detail: `since-cursor write failed: ${detail}`,
    });
    if (!quiet) {
      process.stderr.write(
        `[since-cursor] cursor write failed for ${channelId}; next --since-cursor will re-read same range. detail: ${detail}\n`,
      );
    }
  }
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
  // indices (`requireArg(ctx, rest, 0, ...)`, etc.) skip past --json/--quiet/-h.
  // outputJson is a module-level toggle consumed by die(); writing it once
  // here means error paths emit structured JSON without needing each verb
  // to thread the flag through.
  const {
    positional: rest,
    flags,
    parseErrors,
  } = parseFlags([...rawRest], {
    json: true,
    quiet: true,
    help: true,
    sinceMtime: true,
    sinceCursor: true,
    // P2 — opt-in `--as <Identity>` / `--role <r>` / `--force` /
    // `--from-session <sid>` for the `join` verb (the only verb that
    // currently consumes them). Other verbs ignore these flags as
    // standard FlagValues fields default to undefined/false. Per plan
    // giggly-bouncing-spark.md §change-list #2 + #4-5.
    as: true,
    role: true,
    force: true,
    fromSession: true,
  });
  // Phase 2 Slice 0 RE-W2-3 fix: per-invocation DieContext replaces the
  // prior module-level `outputJson` toggle. Threaded through every die()
  // call site so in-process callers (Phase 2 hooks) get isolated output
  // mode without state leak across invocations.
  const ctx: DieContext = { outputJson: flags.json };
  // Phase 2 Slice 8: surface flag-parse errors via the standard die()
  // path (RE-2/RE-14/CLI-3/CLI-9/CLI-10 closure — invalid --since-mtime,
  // missing value, mutual exclusivity with --since-cursor, etc.).
  if (parseErrors.length > 0) {
    const first = parseErrors[0];
    if (first !== undefined) {
      die(ctx, first, { code: 2, category: "ARGS" });
    }
  }
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
        const path = requireArg(ctx, rest, 0, "handoff-path");
        process.stdout.write(`${channelIdFromHandoff(path)}\n`);
        return;
      }
      case "resolve-handoff": {
        const path = requireArg(ctx, rest, 0, "handoff-path");
        printJson(resolveActiveChannelForHandoff(path));
        return;
      }
      case "summarize-handoff-channel": {
        const path = requireArg(ctx, rest, 0, "handoff-path");
        const self = process.env["CLAUDE_SESSION_ID"] ?? null;
        printJson(summarizeChannelForHandoff(path, self));
        return;
      }
      case "create": {
        const channelId = requireChannelId(ctx, rest, 0);
        const handoffId = requireArg(ctx, rest, 1, "handoff-id");
        printJson(
          await createChannel({ channelId, handoffId, sessionId: sid() }),
        );
        return;
      }
      case "join": {
        const channelId = requireChannelId(ctx, rest, 0);
        const sessionId = sid();
        // Slice 5: post-metadata-join, atomically claim the next
        // available NATO identity. Idempotent rejoin returns the
        // existing claim's letter without re-assignment. Output shape
        // changes from bare metadata to {metadata, identity} so callers
        // can read both in one verb invocation (slash-command friendly).
        //
        // P2: when `--as <Identity>` is present, dispatch
        // `claimIdentityNamed` instead of the next-available
        // `claimIdentity`. Optional `--role <r>` lands the claimant
        // directly in a role (default `queue`); optional `--force`
        // permits takeover of an active claim per Decision §4; optional
        // `--from-session <sid>` adds CAS-check on the takeover holder
        // per Decision §9. Error classes from identity.ts translated to
        // structured `die()` calls.
        const meta = await joinChannel({ channelId, sessionId });
        let claim:
          | Awaited<ReturnType<typeof claimIdentity>>
          | Awaited<ReturnType<typeof claimIdentityNamed>>;
        if (flags.as !== undefined) {
          // --as path: validate NATO + role at verb-level (parser is
          // value-extraction only). isValidIdentity returns the type
          // predicate `s is NatoIdentity` so the cast on success is sound.
          if (!isValidIdentity(flags.as)) {
            die(
              ctx,
              `--as: invalid identity "${flags.as}" — must be a NATO letter (Alpha..Zulu)`,
              { code: 2, category: "VALIDATION" },
            );
          }
          let defaultRole: ChannelRole | undefined;
          if (flags.role !== undefined) {
            if (!VALID_ROLES.includes(flags.role as ChannelRole)) {
              die(
                ctx,
                `--role: invalid role "${flags.role}" — must be one of ${VALID_ROLES.join(", ")}`,
                { code: 2, category: "VALIDATION" },
              );
            }
            defaultRole = flags.role as ChannelRole;
          }
          if (flags.fromSession !== undefined) {
            if (!isValidSessionId(flags.fromSession)) {
              die(
                ctx,
                `--from-session: invalid session id "${flags.fromSession}" — must match path-safe pattern`,
                { code: 2, category: "VALIDATION" },
              );
            }
            // RE-8 closure: --from-session only meaningful with --force
            // (CAS gate guards the takeover path; without --force, no
            // takeover is permitted regardless). Surface as ARGS error
            // so operator UX is explicit.
            if (!flags.force) {
              die(
                ctx,
                `--from-session: requires --force (CAS check is only consulted on takeover)`,
                {
                  code: 2,
                  category: "ARGS",
                  remediation: "add --force, or drop --from-session",
                },
              );
            }
          }
          try {
            claim = await claimIdentityNamed({
              channelId,
              sessionId,
              identity: flags.as,
              ...(defaultRole !== undefined ? { defaultRole } : {}),
              force: flags.force,
              ...(flags.fromSession !== undefined
                ? { fromSession: flags.fromSession }
                : {}),
            });
          } catch (err: unknown) {
            // Translate the 3 new identity-domain error classes to die()
            // shapes with appropriate exit codes. Ordering matters:
            // narrow class checks first (each has a unique constructor).
            if (err instanceof IdentityActiveError) {
              die(ctx, err.message, {
                code: 6,
                category: "STILL_ACTIVE",
              });
            }
            if (err instanceof IdentityAlreadyHeldBySelfError) {
              die(ctx, err.message, {
                code: 5,
                category: "ALREADY_HELD_SELF",
              });
            }
            if (err instanceof IdentityCasMismatchError) {
              die(ctx, err.message, {
                code: 7,
                category: "CAS_MISMATCH",
              });
            }
            // Unknown — re-throw to bubble through the catch-all at
            // runChannelsCli's bottom (UNCAUGHT category).
            throw err;
          }
        } else {
          claim = await claimIdentity({ channelId, sessionId });
        }
        const identityPayload: {
          identity: string;
          role: ChannelRole;
          joined_at: string;
          is_new_participant: boolean;
          takeover_displaced_session_id?: string | null;
        } = {
          identity: claim.identity,
          role: claim.role,
          joined_at: claim.joined_at,
          is_new_participant: claim.is_new_participant,
        };
        if (
          "takeover_displaced_session_id" in claim &&
          claim.takeover_displaced_session_id !== undefined
        ) {
          identityPayload.takeover_displaced_session_id =
            claim.takeover_displaced_session_id;
        }
        printJson({
          metadata: meta,
          identity: identityPayload,
        });
        return;
      }
      case "close": {
        const channelId = requireChannelId(ctx, rest, 0);
        printJson(await closeChannel({ channelId, sessionId: sid() }));
        return;
      }
      case "send": {
        const channelId = requireChannelId(ctx, rest, 0);
        const kind = requireArg(ctx, rest, 1, "kind");
        if (!VALID_KINDS.includes(kind as ChannelKind)) {
          die(
            ctx,
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
        const bodyFilePath = parseBodyFileFlag(ctx, rest);
        // Mutex with stdin: documented as caller-responsibility for now.
        // Bun's `process.stdin.isTTY` is `undefined` for both piped and
        // closed/ignored stdin (verified empirically), so there is no
        // reliable way to detect "stdin piped with data" before reading.
        // When --body-file is set, file content wins silently; stdin is
        // not read.
        //
        // TA-2 follow-up: CLOSED 2026-05-17 (slice 4 Bravo lane, L:145).
        // Async-readable + TTFB timeout now lives in `readStdin` above;
        // happy-path latency is zero (Promise.race against an unref'd
        // setTimeout), refuting the original 50ms estimate. Heredoc-hang
        // surface fails loud after 3s via `StdinTimeoutError` caught below.

        let body: string;
        if (bodyFilePath !== null) {
          body = readBodyFromFile(ctx, bodyFilePath).trim();
          if (body.length === 0) {
            die(
              ctx,
              `--body-file: "${bodyFilePath}" produced empty body after trim — file is empty or whitespace-only`,
              { code: 2, category: "VALIDATION" },
            );
          }
        } else {
          try {
            body = (await readStdin()).trim();
          } catch (err) {
            if (!(err instanceof StdinTimeoutError)) throw err;
            die(
              ctx,
              `empty stdin (${err.elapsedMs}ms TTFB) — pipe a body via stdin or pass --body-file <path>`,
              {
                code: 2,
                category: "VALIDATION",
                remediation:
                  "pipe a body: printf '%s' \"<text>\" | channels send <id> <kind>\n  or pass --body-file: channels send <id> <kind> --body-file <path>",
              },
            );
          }
          if (body.length === 0) {
            die(
              ctx,
              "empty body — send requires a non-empty message on stdin",
              {
                category: "VALIDATION",
                remediation:
                  "pipe a non-empty body via stdin: printf '%s' \"<text>\" | channels send <id> <kind>",
              },
            );
          }
        }

        // Slice 6 ARCH-4 step (3) — role-gate after body is read but
        // before appendMessage. Body-read-before-role-reject is the
        // contract locked by `cli-send-merged.test.ts` (a): a sender
        // with role==='out' attempting `--body-file <denylisted-path>`
        // dies with the DENYLIST die above (cheap-fail-late on path
        // safety) NOT this role-die. If body validation passes, THIS
        // gate runs and rejects role==='out' with exit 4.
        //
        // Pass-through if no claim (legacy/anonymous send): the role
        // gate only blocks an explicitly-claimed `out` role. A peer
        // that hasn't called `join` has no role attached and isn't
        // bound by this rule.
        // Layer 3 carve-out (per plan v4 §"Send-role-gate carve-out"):
        // role==='out' blocks all sends EXCEPT kind==='out'. The 'out'
        // kind is the channel-departure announcement — letting an
        // out-role peer post it is the documented escape hatch (RE-7
        // "terminal until takeover" + sibling auto-`out` extension of
        // `session-presence-unregister.ts`).
        const claim = await getIdentityForSession(channelId, sid());
        if (claim?.role === "out" && kind !== "out") {
          die(
            ctx,
            `[send] role 'out' blocks '${kind}' sends (and other non-out kinds) for identity '${claim.identity}' on channel '${channelId}'; use kind=out to announce departure, or 'set-role <channel-id> --role pen|queue' to rejoin active.`,
            {
              code: 4,
              category: "ROLE_OUT_BLOCKED",
              remediation: `claude-conductor channels set-role ${channelId} --role pen`,
            },
          );
        }

        // `message` construction was moved from here to after the
        // kind-specific validator gates so that the audit-verdict
        // auto-wrap dispatcher (Lane P CLI integration follow-up to
        // PR #146) can mutate `body` post-validation. The validators
        // below only `die()` on schema failure — none of them needs
        // `message` in scope. See construction site just before the
        // `const result =` appendMessage call below.
        //
        // appendMessage auto-attaches identity+role from the sender's
        // claim (Slice 6 — see src/channels/index.ts:appendMessage). If
        // the sender has no claim (legacy / pre-join), the message
        // ships without identity+role and renders as `<unknown>: <body>`
        // per matrix row 5.
        //
        // Phase 4 Step A Layer 4 (plan v5 §Phase 3 + CLI-2 fold from
        // staged-diff audit): validate `digest` body against the
        // DigestBody schema BEFORE appendMessage. Operators get
        // immediate feedback at the send-side rather than discovering
        // mis-shape via silently-dropped downstream parses. The
        // shared parser at `src/channels/digest.ts` is the SSOT for
        // shape; any divergence between send-side and read-side
        // would be the exact drift the convention-layer is built to
        // prevent. Note: claimless / pre-join senders pass through
        // the same gate (parse is body-content-only; identity is
        // attached later inside appendMessage's lock callback).
        if (kind === "digest" && parseDigestBody(body) === null) {
          die(
            ctx,
            `[send] digest body failed schema validation — body must be JSON conforming to DigestBody (see src/channels/digest.ts + docs/conventions/message-kinds-and-verification.md). Required fields: kind_version=1, what_shipped/what_verified/audit_class_paid/blockers (string arrays), next_pickable (string), verification_budget_consumed_ms (finite non-negative number).`,
            {
              code: 2,
              category: "VALIDATION",
              remediation:
                "Run 'channels kinds' for the per-kind reference, or read docs/conventions/message-kinds-and-verification.md for the verification-budget contract.",
            },
          );
        }

        // Tier 1 Slice 1 2026-05-19 — `audit-ask` validator gate
        // (parallel to digest above). Body must JSON.parse into the
        // AuditAskBody shape per src/channels/audit-ask.ts. Validating
        // at send-time gives operators immediate feedback rather than
        // dropping silently on downstream parse failure.
        if (kind === "audit-ask" && parseAuditAskBody(body) === null) {
          die(
            ctx,
            `[send] audit-ask body failed schema validation — body must be JSON conforming to AuditAskBody (see src/channels/audit-ask.ts + docs/conventions/message-kinds-and-verification.md). Required fields: kind_version=1, target_pr={repo,number}, target_peer (non-empty string), tier (light-touch | 1-lens-substantive | 3-lens-convergence), lens_set_requested (non-empty array of RE | Architecture | TA | Security | Contract), audit_class (inside-pair | outside-pair | cross-pair-shadow).`,
            {
              code: 2,
              category: "VALIDATION",
              remediation:
                "Run 'channels kinds' for the per-kind reference, or read docs/conventions/message-kinds-and-verification.md. Use inferAuditAskTier(loc, invariantRich) from claude-conductor/channels/api to compute the default tier.",
            },
          );
        }

        // Tier 1 Slice 2 2026-05-19 — `audit-verdict` validator gate
        // (parallel to audit-ask above). Body must JSON.parse into the
        // AuditVerdictBody shape per src/channels/audit-verdict.ts.
        // Counts-coherence cross-field validation is enforced inside
        // the parser (N1) — counts.blocker/fold/nit must equal the
        // severity-grouped findings length.
        //
        // Cycle 2026-05-25 substrate-evolution slice (Bravo-pen): after
        // shape validation, a second gate enforces non-empty
        // cross_edge_consumers_verified for substrate-class PRs per
        // isSubstrateClassPR(target_pr). Concretizes the
        // feedback-audit-cohort-missed-cross-edge-shim-consumer
        // discipline from PR #119 4-instance audit-cohort gap.
        if (kind === "audit-verdict") {
          const parsedVerdict = parseAuditVerdictBody(body);
          if (parsedVerdict === null) {
            die(
              ctx,
              `[send] audit-verdict body failed schema validation — body must be JSON conforming to AuditVerdictBody (see src/channels/audit-verdict.ts + docs/conventions/message-kinds-and-verification.md). Required fields: kind_version=1, target_pr={repo,number}, target_peer (non-empty string), lens_set_applied (non-empty array of LensClass), audit_class (inside-pair | outside-pair | cross-pair-shadow), audit_axes (non-empty array of surface | depth | distance), verdict (SHIP-CLEAN | SHIP-WITH-FOLDS | NEEDS-REWORK), counts={blocker,fold,nit} non-negative integers, three_option_ask={a_ratify,b_fold_if_applicable,c_reframe_if_applicable} ALWAYS REQUIRED (sub-fields nullable), findings[] (each {kind,lens,title,detail}), cross_edge_consumers_verified[] (optional readonly string[]; required non-empty for substrate-class PRs per isSubstrateClassPR). counts must equal severity-grouped findings length.`,
              {
                code: 2,
                category: "VALIDATION",
                remediation:
                  "Run 'channels kinds' for the per-kind reference, or read docs/conventions/message-kinds-and-verification.md.",
              },
            );
          }
          // Substrate-class cross-edge-consumer-coverage gate.
          if (
            isSubstrateClassPR(parsedVerdict.target_pr) &&
            (parsedVerdict.cross_edge_consumers_verified === undefined ||
              parsedVerdict.cross_edge_consumers_verified.length === 0)
          ) {
            die(
              ctx,
              `[send] audit-verdict body for substrate-class PR (repo: ${parsedVerdict.target_pr.repo}#${parsedVerdict.target_pr.number}) requires non-empty cross_edge_consumers_verified array. Enumerate the consumer-edges your audit verified (e.g., dashboard adapter path, dotfiles shim path). Empty/absent means no cross-edge consumer was verified — surfaces the audit-cohort-gap the schema is designed to prevent.`,
              {
                code: 2,
                category: "VALIDATION",
                remediation:
                  'Add cross_edge_consumers_verified: ["<consumer-path-1>", "<consumer-path-2>", ...] to your audit-verdict body. See feedback-audit-cohort-missed-cross-edge-shim-consumer.md for the discipline rationale + enumerate-all-consumers primitive.',
              },
            );
          }
          // Cycle 2 Pair B substrate-debt Lane P CLI integration follow-up
          // (Charlie-pen, follow-on to PR #146 MVP). Wires the
          // `autoWrapAuditVerdict` dispatcher into the operator-send path so
          // `bun run src/channels/cli.ts send <ch> audit-verdict --body-file
          // <body>` engages Mode A auto-wrap when (a) the operator has
          // claimed a NATO identity on this channel AND (b) the cohort key
          // file is resolvable AND (c) the body has no malformed chain ref.
          // Mode C fallback: raw body unchanged + stderr WARN. Claimless
          // senders skip the dispatcher entirely (no NATO to sign with;
          // matches pre-Lane-P emit shape).
          //
          // Per `[[feedback-substrate-fix-pattern-must-self-mirror]]`: the
          // operator-path bridge IS the substrate-API-affordance fix; this
          // CLI wiring is what closes the gap Charlie's empirical-43
          // substrate-finding identified (`e74b0971` 2026-05-27T11:05Z —
          // 0/43 audit-verdicts DSSE-wrapped + 10/43 UUID-shaped chain refs
          // prior cycle despite Layer 1.5 primitives existing).
          if (claim !== null) {
            // Per `src/channels/audit-verdict-auto-wrap.ts:88` JSDoc + cohort
            // file-naming convention at `keyPaths(nato, cohortDir)` (see
            // `src/channels/key-surface.ts:74`): cohort key files live at
            // `<cohortDir>/<lowercase-nato>.ed25519.{pub,sec}`. `NatoIdentity`
            // claims surface as capitalized (`"Alpha"`, `"Charlie"`, ...);
            // lowercasing here aligns the dispatcher's key-resolution path
            // + keyid emission with the canonical file-naming + the verifier's
            // lookup convention. Caught locally by macOS case-insensitive FS
            // masking; would fail on Linux CI without this normalization.
            const wrap = await autoWrapAuditVerdict({
              parsedBody: parsedVerdict,
              rawBody: body,
              channelId,
              channelsDir: channelsDir(),
              nato: claim.identity.toLowerCase(),
            });
            if (wrap.warn !== undefined) {
              process.stderr.write(wrap.warn);
            }
            body = wrap.body;
          }
        }

        // INVARIANT (Lane P CLI integration follow-up — PR #148; Delta NIT
        // 2026-05-27T18:50Z preemptive-fold-on-OBS): validators below this
        // line MUST NOT mutate `body`. The `const message` construction at
        // the end of this block (just before the `appendMessage` call)
        // captures the final body string; only the audit-verdict path above
        // is permitted to mutate body (via autoWrapAuditVerdict's Mode A
        // wrap). Future kind-validators added here must either preserve
        // `body` unchanged (die-on-fail-only pattern, like memory-proposal /
        // wind-down-checkin / key-revoke below) OR refactor `const message`
        // construction to follow the audit-verdict pattern.
        //
        // Per `[[feedback-substrate-fix-pattern-must-self-mirror]]`:
        // documenting the body-immutability invariant structurally (here +
        // at the message-construction site) prevents the regression class
        // where a future validator silently breaks the refactor's safety.

        // Tier 2 Verb 2 2026-05-20 — `memory-proposal` validator gate
        // (parallel to audit-ask + audit-verdict above). Body must
        // JSON.parse into the MemoryProposalBody shape per
        // src/channels/memory-proposal.ts. Validating at send-time gives
        // operators immediate feedback rather than dropping silently on
        // downstream parse failure. Per F1 symmetric trim discipline:
        // every string field rejects whitespace-only values.
        if (
          kind === "memory-proposal" &&
          parseMemoryProposalBody(body) === null
        ) {
          die(
            ctx,
            `[send] memory-proposal body failed schema validation — body must be JSON conforming to MemoryProposalBody (see src/channels/memory-proposal.ts + docs/conventions/message-kinds-and-verification.md). Required fields: kind_version=1, candidate_name (non-empty post-trim string; slug-form preferred), memory_type (user | feedback | project | reference), description (non-empty post-trim string; one-line frontmatter summary), reason (non-empty post-trim string), proposed_body (non-empty post-trim string; multi-paragraph markdown without frontmatter). Optional: amends_existing (null OR non-empty post-trim string; pointer to existing memory's name slug).`,
            {
              code: 2,
              category: "VALIDATION",
              remediation:
                "Run 'channels kinds' for the per-kind reference, or read docs/conventions/message-kinds-and-verification.md. Substrate does NOT auto-file memories; this kind structures the surface for Nick's batch yes/no decision per feedback-memory-authoring-surface-dont-auto-file.",
            },
          );
        }

        // Tier 2 Verb 1 2026-05-20 — `wind-down-checkin` validator gate
        // (parallel to audit-ask + audit-verdict + memory-proposal above).
        // Body must JSON.parse into the WindDownCheckinBody shape per
        // src/channels/wind-down-checkin.ts. Validating at send-time
        // gives operators immediate feedback rather than dropping
        // silently on downstream parse failure. Per F1 symmetric trim
        // discipline (carried preemptively from Slice 2 B1 + V2 F1):
        // every string-array entry rejects whitespace-only values.
        // Min-1 invariants on next_steps + decisions_logged per Q3
        // (cycle-close without explicit next-step or decision is
        // incoherent).
        if (
          kind === "wind-down-checkin" &&
          parseWindDownCheckinBody(body) === null
        ) {
          die(
            ctx,
            `[send] wind-down-checkin body failed schema validation — body must be JSON conforming to WindDownCheckinBody (see src/channels/wind-down-checkin.ts + docs/conventions/message-kinds-and-verification.md). Required fields: kind_version=1, next_steps (non-empty array of non-empty post-trim strings; min 1 entry per Q3), decisions_logged (same shape as next_steps; min 1 entry), failed_approaches (array; CAN be empty; each entry non-empty post-trim), memory_candidates (array; CAN be empty; each entry non-empty post-trim), cycle_character (PRISTINE | RECOVERED | INCIDENT-DRIVEN | COHORT-PASS | STALLED).`,
            {
              code: 2,
              category: "VALIDATION",
              remediation:
                "Run 'channels kinds' for the per-kind reference, or read docs/conventions/message-kinds-and-verification.md. Substrate-mediates cycle-end summary; downstream Tier-3 consumers (T3-F classifier; T3-G reciprocation ledger) parse the body without regex-scraping handoff prose.",
            },
          );
        }

        // Cycle 1 substrate-core PR-A7 2026-05-26 — `key-revoke` validator
        // gate (parallel to audit-ask + audit-verdict + memory-proposal +
        // wind-down-checkin above). Body must JSON.parse into the
        // KeyRevokeBody shape per src/channels/key-revoke.ts. Validating
        // at send-time gives operators immediate feedback rather than
        // dropping silently on downstream history-file maintenance OR
        // audit verify resolveKeyAtTime lookup failure. Per Pair B slice
        // plan body §2.5 LOCKED: 3-class reason union + non-empty
        // signed_by[] + nullable replacement_fingerprint (must be
        // explicit per HYBRID-style write-side canonical discipline;
        // undefined rejected).
        //
        // Pair B Delta-pen capacity-take per Pair B §5 flexibility-
        // clause + `feedback-cohort-standby-standoff-anti-pattern`
        // named-alternate-owner rule (Charlie 19:42Z tool-flow-accuracy
        // explicit-defer; Charlie audit-shadow inverted at next resume).
        if (kind === "key-revoke" && parseKeyRevokeBody(body) === null) {
          die(
            ctx,
            `[send] key-revoke body failed schema validation — body must be JSON conforming to KeyRevokeBody (see src/channels/key-revoke.ts + docs/conventions/message-kinds-and-verification.md). Required fields: kind_version=1, revoked_nato (non-empty post-trim string; NATO identifier of the operator whose key is being revoked), revoked_fingerprint (non-empty post-trim string; SHA-256 hex of revoked pubkey), revoked_at (Date.parse-able ISO-8601 timestamp), reason (compromise | rotation | operator-departure), replacement_fingerprint (MUST be present; non-empty post-trim string OR null when no successor), signed_by (non-empty array of non-empty post-trim strings; NATO identifiers signing the revocation — min-1 = revoking operator themselves).`,
            {
              code: 2,
              category: "VALIDATION",
              remediation:
                "Run 'channels kinds' for the per-kind reference, or read docs/conventions/message-kinds-and-verification.md. Per Pair B slice plan body §2.5 + §4.3 — wire-format drives <nato>.history.json maintenance which feeds resolveKeyAtTime + verifyChannelAuditChain (PR-A6 audit verify CLI). For compromise scenarios, cohort may require N-of-cohort co-signing in signed_by[] (deferred per §2.5).",
            },
          );
        }

        // `message` construction moved here (post-validators + post Lane P
        // auto-wrap dispatch) so the audit-verdict auto-wrap path can
        // mutate `body` before this constant captures the final string.
        // For non-audit-verdict kinds, `body` is unchanged since the last
        // validator runs, so the move is behavior-preserving.
        const message: ChannelMessage = {
          ts: new Date().toISOString(),
          from: sid(),
          kind: kind as ChannelKind,
          body,
        };

        // Phase 4 Step A Layer 3 (plan v5 RE-3 fold): manual `send out`
        // is a true terminal transition — pass `makeSendOutMutator(sid)`
        // so the same withMetadataLock callback that appends the JSONL
        // line ALSO sets `metadata.identities[<L>].role = "out"` and
        // `out_posted_at = ts` on the sender's identity. Three reader
        // predicates (whoami / explicitlyOutPeers / message+metadata
        // join) converge on the post-mutation state. Claimless senders
        // get a no-op mutator return (the message still lands).
        const result =
          kind === "out"
            ? await appendMessage({
                channelId,
                message,
                extraMetadataMutator: makeSendOutMutator(sid(), message.ts),
              })
            : await appendMessage({ channelId, message });
        printJson(result);
        return;
      }
      case "read": {
        const channelId = requireChannelId(ctx, rest, 0);
        // Slice 8 since-cursor logic: resolve threshold + bootstrap state
        // before filtering. flags.sinceMtime is the parsed numeric ms;
        // flags.sinceCursor is the no-value alias that auto-resolves to
        // the per-session cursor at <channel-dir>/last-seen-cursors/<sid>.json
        // (Step G renamed from last-seen/; dual-read fallback ≥30d).
        let sinceMtime: number | null = null;
        let bootstrap = false;
        if (flags.sinceMtime !== undefined) {
          sinceMtime = flags.sinceMtime;
        } else if (flags.sinceCursor) {
          const cursor = readLastSeenCursor(channelId, sid());
          if (cursor !== null) {
            sinceMtime = cursor.mtime;
          } else {
            bootstrap = true;
          }
        }
        const allMessages = readMessages(channelId);
        // RE-1 closure: filter + maxTs both gate via Number.isFinite to
        // prevent NaN poisoning a cursor. Malformed msg.ts → silently
        // dropped from filter result + breadcrumb (one-per-channel-per-read).
        let corruptTsSurfaced = false;
        const filtered =
          sinceMtime === null
            ? allMessages
            : allMessages.filter((m) => {
                const ms = Date.parse(m.ts);
                if (!Number.isFinite(ms)) {
                  if (!corruptTsSurfaced) {
                    appendPresenceFailure({
                      timestamp: new Date().toISOString(),
                      source: "channels-identity",
                      kind: "registry-contention",
                      sessionId: sid(),
                      artifactPath: channelId,
                      detail: `corrupt-cursor: malformed msg.ts during --since read: ${m.ts}`,
                    });
                    corruptTsSurfaced = true;
                  }
                  return false;
                }
                return ms > sinceMtime;
              });
        const resolved = filtered.map((m) => {
          if (m.body_ref && !m.body) {
            const body = readBodyFile(channelId, m.body_ref);
            if (body !== null) return { ...m, body };
            // L:140 — attribute the read failure instead of silently
            // returning the message with body_ref but no body. Stderr
            // breadcrumb surfaces the failure in real-time; the
            // body_read_error field lets downstream consumers distinguish
            // "no body" from "body unreadable".
            const errMsg = `body_ref "${m.body_ref}" unreadable (file missing, permission denied, or IO error)`;
            process.stderr.write(`[channels] ${errMsg}\n`);
            return { ...m, body_read_error: errMsg };
          }
          return m;
        });
        // CLI-2 bootstrap advisory: stderr + JSON meta field (suppressed
        // stderr by --quiet; JSON meta retained regardless per CLI-NEW-3
        // interaction matrix).
        if (bootstrap && !flags.quiet) {
          process.stderr.write(
            `[since-cursor] no prior cursor for ${sid()} on ${channelId}; reading full history (${resolved.length} messages). Subsequent --since-cursor calls will be incremental.\n`,
          );
        }
        // Cursor-write decision (RE-7 baseline closure):
        // - non-empty filtered batch → write cursor with maxTs.
        // - bootstrap (sinceCursor=true, no prior cursor) AND empty batch
        //   → write baseline {mtime: 0, ts: "1970-..."} so subsequent reads
        //   have a starting point.
        if (sinceMtime !== null || flags.sinceCursor) {
          const finiteMs = filtered
            .map((m) => Date.parse(m.ts))
            .filter((n): n is number => Number.isFinite(n));
          if (finiteMs.length > 0) {
            const maxTs = Math.max(...finiteMs);
            tryWriteLastSeenCursor(
              channelId,
              maxTs,
              new Date(maxTs).toISOString(),
              flags.quiet,
            );
          } else if (bootstrap) {
            tryWriteLastSeenCursor(
              channelId,
              0,
              "1970-01-01T00:00:00.000Z",
              flags.quiet,
            );
          }
        }
        // Slice 6: default output is renderMessage one-per-line
        // (human-readable). `--json` (already extracted by parseFlags)
        // keeps the structured output for piping to jq / consumer apps
        // that want raw `ChannelMessage[]`. Phase 2 Slice 8: --json
        // bootstrap mode adds meta.since_cursor_status: "bootstrap" so
        // scripts can detect the bootstrap read.
        if (flags.json) {
          if (bootstrap) {
            printJson({
              meta: { since_cursor_status: "bootstrap" },
              messages: resolved,
            });
          } else {
            printJson(resolved);
          }
          return;
        }
        for (const m of resolved) {
          process.stdout.write(`${renderMessage(m)}\n`);
        }
        return;
      }
      case "forget-cursor": {
        const channelId = requireChannelId(ctx, rest, 0);
        const sessionId = sid();
        // RE-11 closure (round 2): symmetric idempotent archive handling.
        // Archived channels can't have a live cursor; return kind:"archived"
        // exit 0 (matches show-cursor's stance for the same precondition).
        if (isChannelArchived(channelId)) {
          printJson({ kind: "archived", channelId, sessionId });
          return;
        }
        const result = clearLastSeenCursor(channelId, sessionId);
        printJson({ ...result, channelId, sessionId });
        return;
      }
      case "show-cursor": {
        const channelId = requireChannelId(ctx, rest, 0);
        const sessionId = sid();
        if (isChannelArchived(channelId)) {
          printJson({ kind: "archived", channelId, sessionId });
          return;
        }
        const cursor = readLastSeenCursor(channelId, sessionId);
        if (cursor === null) {
          printJson({ kind: "absent", channelId, sessionId });
          return;
        }
        printJson({ kind: "present", channelId, sessionId, cursor });
        return;
      }
      case "forget-message-cursor": {
        // Phase 4 Step A Layer 1 — sibling-pattern to forget-cursor.
        // Clears BOTH committed + pending peer-message-deliverer cursors.
        const channelId = requireChannelId(ctx, rest, 0);
        const sessionId = sid();
        if (isChannelArchived(channelId)) {
          printJson({ kind: "archived", channelId, sessionId });
          return;
        }
        const result = clearPeerMessageCursor(channelId, sessionId);
        printJson({ ...result, channelId, sessionId });
        return;
      }
      case "show-message-cursor": {
        // Phase 4 Step A Layer 1 — sibling-pattern to show-cursor. Reports
        // BOTH committed + pending so operators can debug stuck pending
        // state (e.g., a session that crashed between emit + promote).
        //
        // CLI-1 fold: emits a derived `phase` discriminator alongside the
        // raw cursors so operators read one field instead of mentally
        // synthesizing the lifecycle stage from (committed, pending) tuple
        // presence/absence. "bootstrap-pending" → first-scan bootstrap;
        // "stable" → committed set, no in-flight emission; "emission-pending"
        // → emit-turn wrote pending awaiting next-prompt promote.
        const channelId = requireChannelId(ctx, rest, 0);
        const sessionId = sid();
        if (isChannelArchived(channelId)) {
          printJson({ kind: "archived", channelId, sessionId });
          return;
        }
        const committed = readPeerMessageCursor(channelId, sessionId);
        const pending = readPendingPeerMessageCursor(channelId, sessionId);
        if (committed === null && pending === null) {
          printJson({ kind: "absent", channelId, sessionId });
          return;
        }
        const phase: "bootstrap-pending" | "stable" | "emission-pending" =
          committed === null && pending !== null
            ? "bootstrap-pending"
            : pending === null
              ? "stable"
              : "emission-pending";
        printJson({
          kind: "present",
          channelId,
          sessionId,
          committed,
          pending,
          phase,
        });
        return;
      }
      case "list": {
        const includeArchived = rest.includes("--include-archived");
        printJson(listChannels({ includeArchived }));
        return;
      }
      case "meta": {
        const channelId = requireChannelId(ctx, rest, 0);
        printJson(readMetadata(channelId));
        return;
      }
      case "heartbeat": {
        const channelId = requireChannelId(ctx, rest, 0);
        touchHeartbeat(channelId, sid());
        return;
      }
      case "peers": {
        const channelId = requireChannelId(ctx, rest, 0);
        const meta = readMetadata(channelId);
        const self = sid();
        const now = getWallClockNow();
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
        const channelId = requireChannelId(ctx, rest, 0);
        const ref = requireArg(ctx, rest, 1, "body-ref");
        const body = readBodyFile(channelId, ref);
        if (body === null)
          die(ctx, `body ${ref} not found for channel ${channelId}`, {
            code: 2,
            category: "NOT_FOUND",
            remediation: `verify the body-ref via 'claude-conductor channels read ${channelId}' and confirm the message has body_ref set`,
          });
        process.stdout.write(body);
        return;
      }
      case "whoami": {
        const channelId = requireChannelId(ctx, rest, 0);
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
        const channelId = requireChannelId(ctx, rest, 0);
        // P2 (channel-as-flag) — `--role` is now a globally-recognized
        // value-consuming flag in `parseFlags`. The set-role verb reads
        // `flags.role` rather than re-scanning `rest` (which would miss
        // the flag entirely since the parser consumed it). The semantics
        // are identical: missing → die ARGS; invalid role → die
        // VALIDATION. Per plan giggly-bouncing-spark.md §change-list #5.
        const roleArg = flags.role;
        if (roleArg === undefined) {
          die(ctx, "missing --role <pen|queue|out>", {
            category: "ARGS",
            remediation: "set-role <channel-id> --role <pen|queue|out>",
          });
        }
        if (!VALID_ROLES.includes(roleArg as ChannelRole)) {
          die(
            ctx,
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
            ctx,
            `[set-role] this session has no identity claim on channel '${channelId}'`,
            {
              code: 5,
              category: "NOT_HELD",
              remediation: `Run 'claude-conductor channels join ${channelId}' first to claim an identity.`,
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
              ctx,
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
        const channelId = requireChannelId(ctx, rest, 0);
        const peerIdx = rest.indexOf("--peer");
        if (peerIdx === -1) {
          die(ctx, "missing --peer <Identity>", {
            category: "ARGS",
            remediation:
              "close-peer <channel-id> --peer <NATO-identity> [--force]",
          });
        }
        const peerArg = rest[peerIdx + 1];
        if (peerArg === undefined) {
          die(ctx, "--peer flag requires a NATO identity value", {
            category: "ARGS",
          });
        }
        if (!isValidIdentity(peerArg)) {
          die(
            ctx,
            `invalid peer identity "${peerArg}" — must be a NATO letter (Alpha, Bravo, ..., Zulu)`,
            { category: "VALIDATION" },
          );
        }
        const peer: NatoIdentity = peerArg;
        // P2 (channel-as-flag) — `--force` is now a globally-recognized
        // standalone flag in `parseFlags`. The close-peer verb reads
        // `flags.force` rather than `rest.includes("--force")` (which
        // would miss the flag since the parser consumed it). Semantics
        // identical. Per plan giggly-bouncing-spark.md §change-list #5.
        const force = flags.force;
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
          // Slice 3 RE-W2-4: capture discriminated unlink result so we
          // can surface orphan_sentinel state in the JSON response. A
          // true orphan is `ok: false` with a non-ENOENT code (the
          // sentinel is still on disk, recoverable on next claim).
          // ENOENT means "race-cleared" — sentinel was already gone, no
          // orphan exists; we treat it as non-orphan in the response.
          const unlinkResult = unlinkIdentitySentinelOrLogOrphan(
            channelId,
            peer,
            result.releasedClaim,
          );
          const orphanSentinel =
            unlinkResult.ok === false && unlinkResult.code !== "ENOENT";
          // Audit-trail status message so other peers observing the
          // channel see the close. Posted by THIS session (the operator
          // who invoked close-peer), referencing the released session.
          const peerClosedMessage: ChannelMessage = {
            ts: new Date().toISOString(),
            from: sid(),
            kind: "status",
            body: `peer-closed: identity ${peer} (session ${result.releasedClaim.session_id}) released by ${sid()}${force ? " (--force)" : ""}${orphanSentinel ? " (orphan-sentinel)" : ""}`,
          };
          await appendMessage({ channelId, message: peerClosedMessage });
          const responseBody: {
            kind: "released";
            identity: string;
            previous_session_id: string;
            orphan_sentinel: boolean;
            sentinel_error?: { code: string; detail: string };
          } = {
            kind: "released",
            identity: peer,
            previous_session_id: result.releasedClaim.session_id,
            orphan_sentinel: orphanSentinel,
          };
          if (orphanSentinel && unlinkResult.ok === false) {
            responseBody.sentinel_error = {
              code: unlinkResult.code,
              detail: unlinkResult.detail,
            };
          }
          printJson(responseBody);
          return;
        }
        if (result.kind === "still-active") {
          die(
            ctx,
            `[close-peer] peer '${peer}' is still active (heartbeat age ${result.ageMs ?? "unknown"} ms < ${STALE_THRESHOLD_MS} ms threshold)`,
            {
              code: 6,
              category: "STILL_ACTIVE",
              remediation: "Use --force to override the staleness gate.",
            },
          );
        }
        if (result.kind === "not-held") {
          die(
            ctx,
            `[close-peer] no identity '${peer}' on channel '${channelId}'`,
            {
              code: 5,
              category: "NOT_HELD",
            },
          );
        }
        // result.kind === "session-mismatch" — unreachable from close-peer
        // (doesn't pass casSessionId). Defensive die catches future
        // substrate-shape changes; mirrors the exhaustive-handler pattern
        // used in release-self. Bravo L2 NIT fold (2026-05-24).
        die(
          ctx,
          `[close-peer] unexpected closeStalePeerIdentity result kind '${result.kind}' for peer '${peer}' — close-peer does not pass casSessionId so session-mismatch should be unreachable`,
          {
            code: 1,
            category: "UNEXPECTED",
          },
        );
      }
      case "release-self": {
        // Self-targeted sibling of `close-peer` — releases THIS session's
        // claim on the channel. Auto-resolves the held letter (no --peer
        // flag) and uses implicit force (self-heartbeat is fresh by
        // definition; staleness gate would always block otherwise).
        //
        // CAS-guarded: the inner closeStalePeerIdentity call passes
        // `casSessionId: sessionId` so a concurrent peer takeover via
        // `join --as <my-letter> --force --from-session <my-uuid>` fails
        // the in-lock check and returns kind: "session-mismatch" instead
        // of silently releasing the new holder's claim. Maps to exit 7
        // RACE_RELEASED — distinct from NOT_HELD (5) and STILL_ACTIVE (6)
        // so operators can tell from the exit code why the verb refused.
        const channelId = requireChannelId(ctx, rest, 0);
        const sessionId = sid();
        const claim = await getIdentityForSession(channelId, sessionId);
        if (claim === null) {
          die(
            ctx,
            `[release-self] this session has no identity claim on channel '${channelId}'`,
            {
              code: 5,
              category: "NOT_HELD",
              remediation: `Run 'channels join ${channelId}' first to claim an identity.`,
            },
          );
        }
        const identity = claim.identity;
        const result = await closeStalePeerIdentity({
          channelId,
          identity,
          staleThresholdMs: STALE_THRESHOLD_MS,
          force: true,
          casSessionId: sessionId,
        });
        if (result.kind === "released") {
          const unlinkResult = unlinkIdentitySentinelOrLogOrphan(
            channelId,
            identity,
            result.releasedClaim,
          );
          const orphanSentinel =
            unlinkResult.ok === false && unlinkResult.code !== "ENOENT";
          // Audit-trail status message — `self-released` prefix
          // distinguishes operator-initiated self-release from the
          // `peer-closed` pattern emitted by close-peer (actor ≠
          // subject). Same broad shape (identity + session + sentinel
          // hint) so observers can grep both with the same parser.
          const selfReleasedMessage: ChannelMessage = {
            ts: new Date().toISOString(),
            from: sid(),
            kind: "status",
            body: `self-released: identity ${identity} (session ${sessionId}) released by self${orphanSentinel ? " (orphan-sentinel)" : ""}`,
          };
          await appendMessage({
            channelId,
            message: selfReleasedMessage,
          });
          const responseBody: {
            kind: "released";
            identity: string;
            previous_session_id: string;
            orphan_sentinel: boolean;
            sentinel_error?: { code: string; detail: string };
          } = {
            kind: "released",
            identity,
            previous_session_id: sessionId,
            orphan_sentinel: orphanSentinel,
          };
          if (orphanSentinel && unlinkResult.ok === false) {
            responseBody.sentinel_error = {
              code: unlinkResult.code,
              detail: unlinkResult.detail,
            };
          }
          printJson(responseBody);
          return;
        }
        if (result.kind === "session-mismatch") {
          die(
            ctx,
            `[release-self] race detected: identity '${identity}' is now held by session '${result.actualSessionId}' (someone took over between resolve and release)`,
            {
              code: 7,
              category: "RACE_RELEASED",
              remediation: `Re-run 'channels whoami ${channelId}' to verify current claim before retrying.`,
            },
          );
        }
        if (result.kind === "not-held") {
          // Race window: getIdentityForSession saw a claim, but a
          // concurrent removeIdentityClaim cleared it before our
          // closeStalePeerIdentity lock acquired. Treat as success-shape
          // not-held (the operator's intent — "drop my claim" — is
          // already satisfied).
          die(
            ctx,
            `[release-self] identity '${identity}' was already released between resolve and close (concurrent close-peer or session re-spawn)`,
            {
              code: 5,
              category: "NOT_HELD",
            },
          );
        }
        // result.kind === "still-active" — impossible with force=true.
        // Defensive die in case substrate semantics change.
        die(
          ctx,
          `[release-self] unexpected closeStalePeerIdentity result kind '${result.kind}' (expected released | session-mismatch | not-held)`,
          {
            code: 1,
            category: "UNEXPECTED",
          },
        );
      }
      case "kinds": {
        // Per-kind help reference (CLI-3 + MINOR-1 fold per plan v4):
        // semantic gloss + recommended body content per kind +
        // verification-budget pointer. Read-only; exits 0.
        process.stdout.write(`${KINDS_HELP}\n`);
        return;
      }
      case undefined:
      case "help":
      case "--help":
      case "-h": {
        process.stdout.write(`${TOP_LEVEL_HELP}\n`);
        return;
      }
      default:
        die(ctx, `unknown subcommand: ${cmd}`, {
          category: "ARGS",
          remediation:
            "Run 'claude-conductor channels --help' to list valid subcommands",
        });
    }
  } catch (err) {
    // Wave 2 RE-W2-6: if die() already ran (only possible when process.exit
    // is mocked in tests), the original stderr write + category are already
    // out. Re-throw the sentinel rather than firing die() again with
    // UNCAUGHT, which would mask the original category/code/remediation.
    if (err instanceof DieAlreadyHandled) throw err;
    const message = err instanceof Error ? err.message : String(err);
    die(ctx, message, { category: "UNCAUGHT" });
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
