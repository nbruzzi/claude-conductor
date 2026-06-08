// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Lifecycle-bound inter-session channels.
 *
 * A channel is a local filesystem inbox shared between two sessions that are
 * coordinating through a `/handoff-resume parallel` workflow. Storage lives
 * under ~/.claude/channels/<channel-id>/ with an append-only JSONL message
 * log, a metadata.json participants file, and heartbeat marker files.
 *
 * Design invariants (see ~/.claude/plans/ancient-waddling-tulip.md):
 *   - Append-only — messages are never mutated or deleted.
 *   - Atomic append for small messages (≤ SMALL_MESSAGE_MAX_BYTES) via
 *     O_APPEND. Oversized bodies are written to bodies/<uuid>.txt first
 *     (temp+rename) and a pointer message is appended.
 *   - Metadata mutations are serialized with an O_EXCL lockfile and
 *     written temp+rename. Stale locks (>30s) are stolen with jittered retry.
 *   - Tolerant reader — a corrupt JSONL line never throws upward; it's
 *     skipped with a single warning per channel per session.
 *   - Session identity is NEVER inferred from mtime; it comes from the
 *     hook-input session_id (or CLAUDE_SESSION_ID for tests).
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  isValidArtifactId,
  isValidSessionId,
} from "../active-sessions/index.ts";
import { getWallClockNow } from "../shared/clock.ts";
import { extractValidSessionId } from "../hooks/session-id.ts";
import { channelsDir } from "../shared/paths.ts";
import { appendPresenceFailure } from "../shared/presence-failure-log.ts";
import { validateIdentityClaim } from "./claim.ts";

/** Conservative atomic-append threshold. POSIX guarantees PIPE_BUF (512 on
 *  macOS); Linux regular-file O_APPEND is typically safe up to 4096. We
 *  use 3KB as a safe middle ground — anything larger redirects the body
 *  to a sidecar file and only a pointer message is appended. */
const SMALL_MESSAGE_MAX_BYTES = 3 * 1024;

/** L409: max codepoints in a shunt-time `body_preview` (see {@link buildBodyPreview}).
 *  Bounded at or below the smallest downstream preview window (the Monitor recipe
 *  slices [0:220]; the peer deliverer caps at MAX_INLINE_BODY_CHARS = 200) so no
 *  consumer re-truncates it awkwardly. */
const BODY_PREVIEW_MAX_CHARS = 200;

/** Lock-stale-steal threshold — `acquireLock` reclaims a lockfile whose
 *  mtime exceeds this age, on the assumption the holder crashed. Exported
 *  per Phase 2 Slice 4 — the channels-gc-reaper computes its mtime gate
 *  as `3 * LOCK_STALE_MS` so future tuning of this constant automatically
 *  tightens the reaper's race-safety margin (per `feedback-atomic-wiring-discipline.md`
 *  + plan `lovely-dreaming-willow.md` §Race correctness). */
export const LOCK_STALE_MS = 30 * 1000;
const LOCK_MAX_ATTEMPTS = 5;
const LOCK_BASE_DELAY_MS = 50;

/**
 * The one global, fixed-name, eternal coordination channel id. Every
 * session — solo or cohort — joins this constant (via join-or-create)
 * rather than forking a per-handoff/per-cycle channel; the channel
 * persists forever while sessions come and go through NATO-identity
 * claim/release.
 *
 * Two coupled invariants keep the eternal channel healthy — NEITHER holds
 * without the other:
 *   1. `channel-gc.ts:sweepStale` EXEMPTS this id from whole-channel
 *      archival. An eternal channel must never be archived-on-idle, else
 *      the next session recreates the constant into a fresh empty dir →
 *      silent history loss + continuity break.
 *   2. Because that exemption removes the per-cycle archival that used to
 *      implicitly recycle the 26-letter NATO pool, the stale-identity
 *      reaper (`reclaim.ts:reclaimStaleIdentities`, wired into
 *      `channels-gc-reaper.ts`) reclaims dead sessions' letters so the
 *      pool never exhausts under real come-and-go cadence.
 *
 * Design: plans-durable/channel-coordination-fixed-eternal-design-2026-05-31.md
 */
export const COORDINATION_CHANNEL_ID = "coordination";

export type ChannelLifecycle = "parallel";

/**
 * Single source of truth for the set of channel message kinds. The
 * `ChannelKind` union derives from this tuple via
 * `(typeof CHANNEL_KINDS)[number]`, and runtime validators import
 * `CHANNEL_KINDS` so the type-level and runtime acceptance stay in
 * lockstep (no 3-sync-point drift bait when extending the set).
 *
 * Sibling pattern: `BUNDLED_CHECKS_BY_EVENT` `as const` at
 * `src/hooks/bundled-check-names.ts:58-72`. Extension order is the
 * declaration order shown here — Phase 1 kinds first; future kinds
 * (e.g., Phase 4 Step A Layer 3 walkie-talkie primitives, Layer 4
 * `digest`) append after.
 */
export const CHANNEL_KINDS = [
  // Phase 1 kinds (informational + protocol carriers)
  "note",
  "question",
  "handoff",
  "status",
  // Phase 4 Step A Layer 3 — walkie-talkie protocol primitives
  // (see `docs/conventions/message-kinds-and-verification.md`):
  //   - `ack`      — receipt confirmation; presence-of-message is the signal
  //   - `roger`    — receipt + commitment; sender will act on what was read
  //   - `over`     — sender hint: "I posted, expecting reply"
  //   - `standby`  — sender hint: "heard you, working, hold the channel"
  //   - `out`      — peer terminates this channel (additive; `claim --force` resets)
  "ack",
  "roger",
  "over",
  "standby",
  "out",
  // Phase 4 Step A Layer 4 — mental-model-sync structured summary
  // (see `src/channels/digest.ts` for the shared parser + body schema,
  // and `docs/conventions/message-kinds-and-verification.md` for the
  // verification-budget convention per kind):
  //   - `digest` — JSON body conforming to `DigestBody`; readers
  //                trust the SHAPE but primary-source-verify any
  //                audit-class claim or SHA cited within.
  "digest",
  // L152 closure 2026-05-15 — sibling-onboarding live-update primitive
  // (see `src/channels/live-update.ts` for the shared parser + body
  // schema). Posted by an active peer within seconds of a sibling's
  // `joined` post in parallel-mode handoff-resume; carries structured
  // YAML-shaped body with keys: since-handoff, current-focus,
  // your-scope, hands-off. Bridges the long-arc handoff (frozen at
  // write-time) and the live channel (volatile) at sibling-join time
  // — removes Nick from the sibling-onboarding critical path.
  "live-update",
  // Tier 1 Slice 1 2026-05-19 — audit-ask schema for audit-discipline
  // kind cohort (schemas-first substrate per ratified plan
  // `~/.claude/plans/claude-conductor-development-plan-2026-05-19.md`).
  // See `src/channels/audit-ask.ts` for `AuditAskBody` + parser; readers
  // trust the SHAPE returned by the parser but primary-source-verify
  // target_pr exists + target_peer is a live NATO identity before
  // acting on the ask. Audit-verdict (Slice 2) closes the loop.
  "audit-ask",
  // Tier 1 Slice 2 2026-05-19 — audit-verdict closes the audit-loop
  // initiated by audit-ask. See `src/channels/audit-verdict.ts` for
  // `AuditVerdictBody` + parser; carries the 3-axis audit-coverage
  // answer (surface/depth/distance per
  // `feedback-audit-convergence-three-axes`) + verdict outcome + nested
  // findings + canonical 3-option close-ask. Readers trust the SHAPE
  // but primary-source-verify the verdict's claims (lens-set actually
  // applied; findings actually surfaced).
  "audit-verdict",
  // Tier 2 Verb 2 2026-05-20 — memory-proposal surfaces memorialization
  // candidates for Nick's batch yes/no decision per
  // `feedback-memory-authoring-surface-dont-auto-file`. See
  // `src/channels/memory-proposal.ts` for `MemoryProposalBody` + parser;
  // 6 typed fields (candidate_name + memory_type + description + reason
  // + proposed_body + optional amends_existing). Substrate does NOT
  // auto-file memories — a deferred Tier-2 ratification verb consumes
  // ratified proposals and writes the file. Readers trust the SHAPE
  // but primary-source-verify slug uniqueness vs existing memories
  // (when amends_existing is null) or the named memory exists on disk
  // (when amends_existing is non-null).
  "memory-proposal",
  // Tier 2 Verb 1 2026-05-20 — wind-down-checkin surfaces structured
  // cycle-close state (next_steps + decisions_logged + failed_approaches
  // + memory_candidates + cycle_character per the T3-F rubric). See
  // `src/channels/wind-down-checkin.ts` for `WindDownCheckinBody` +
  // parser; 6 typed fields with min-1 invariants on next_steps +
  // decisions_logged (empty-allowed on failed_approaches +
  // memory_candidates). Substrate-mediates the wind-down summary —
  // today's channel-prose `kind=status` checkin becomes a typed body
  // downstream consumers (T3-F classifier; T3-G reciprocation ledger)
  // can parse without regex-scraping handoff prose. Readers trust the
  // SHAPE but primary-source-verify cycle_character claim against
  // actual cycle artifacts (PR squashes / CI / failed-approach captures)
  // and memory_candidates slug names against the memory directory.
  "wind-down-checkin",
  // Cycle 1 substrate-core PR-A7 2026-05-26 — key-revoke kind per
  // Pair B slice plan body §2.5 + §4.3 + §8 step 7. Posted by an
  // operator revoking their own Ed25519 key OR by cohort members
  // co-signing a compromise revocation. See `src/channels/key-revoke.ts`
  // for `KeyRevokeBody` + parser; 7 typed fields incl. 3-class
  // `reason` (compromise | rotation | operator-departure) + nullable
  // `replacement_fingerprint` + non-empty `signed_by[]` cohort co-sign
  // list. Wire-format drives `<nato>.history.json` maintenance which
  // feeds resolveKeyAtTime (key-surface.ts) which feeds the audit
  // verify CLI (PR-A6 verify.ts) — revoked entries map to
  // `breaks[].reason = "revoked-key"` per the 3-class break taxonomy
  // (DC-5 + sub-Obs-6a) distinct from `"tamper"` (sig failure) and
  // `"key-rotation-discontinuity"` (chain gap). Readers trust the
  // SHAPE but primary-source-verify (a) `signed_by[]` contains the
  // revoking NATO + (b) `revoked_at` is Date.parse-valid ISO-8601.
  // Pair B Delta-pen impl via capacity-take per Pair B §5 flexibility-
  // clause invocation at Charlie 19:42Z tool-flow-accuracy explicit-
  // defer + `feedback-cohort-standby-standoff-anti-pattern` named-
  // alternate-owner rule.
  "key-revoke",
  // Cycle 6 item-2 (Sundry-P1; agetor steal-list A-P1-4) 2026-05-29 — `poll`
  // structured-choice question kind. A NEW kind (NOT an extension of the
  // free-form `question`) per the "structured shape earns a new kind"
  // convention (see audit-ask.ts § "Why a new kind vs extending question").
  // Carries a typed body (question + >=2 validated options + optional
  // multi_select / free_text flags) for cohort decisions / votes /
  // structured approvals. See `src/channels/poll.ts` for `PollBody` +
  // `parsePollBody`; readers trust the SHAPE, the option set is an
  // author-claim.
  "poll",
  // Phase 4.5 dashboard limited-mutation slice (N1) 2026-06-04 — `nudge`
  // directive wake-signal. Posted by the dashboard's Nudge / Check-comms
  // write actions to wake a hung/idle peer (the substrate equivalent of
  // Nick's manual "type in the sibling's terminal to wake them"). A NEW
  // kind, NOT free-form `note`/`question`/`status`: a nudge is a distinct
  // directive (wake / check-comms), not informational and not expecting an
  // answer — reusing those would make a dashboard-nudge indistinguishable
  // from a genuine peer message in every renderer/filter. Free-form body
  // (no schema); the two modes differ only in body prose ("working?" /
  // "check your channel — directed from dashboard"). Joins the urgent-kinds
  // set sibling Monitor wake-filters honor (convention-level; there is no
  // code urgent-kinds set today). See
  // docs/conventions/message-kinds-and-verification.md + dashboard spec
  // v2.1 §17.13. Consumer: claude-conductor-dashboard Phase 4.5
  // (sendChannelMessage → appendMessage).
  "nudge",
] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Role posture per parent plan §266-271. `pen` = actively writing;
 *  `queue` = ready to take pen; `out` = observing only (sends blocked). */
export type ChannelRole = "pen" | "queue" | "out";

export type ChannelMessage = {
  ts: string;
  from: string;
  kind: ChannelKind;
  body?: string;
  body_ref?: string;
  /** L409: single-line, codepoint-bounded preview of a body that was shunted
   *  to a `body_ref` sidecar (set at send-time when the body exceeds the inline
   *  limit). Lets raw-JSONL preview consumers (the Monitor/tail recipe, the peer
   *  message deliverer) render content instead of a blank, while `body_ref`
   *  stays the authoritative full body. Absent on small (inline-body) and legacy
   *  messages — purely additive; the body/body_ref XOR is preserved. */
  body_preview?: string;
  /** Populated when `body_ref` is set on the message but the referenced
   *  body file could not be read (missing, permission denied, IO error).
   *  Surfaces what was previously a silent fallback (message returned with
   *  `body_ref` but no `body`) so downstream consumers can distinguish
   *  "message has no body" from "message had a body but we couldn't load
   *  it." L:140 reader-attribution fix. */
  body_read_error?: string;
  /** NATO identity letter (e.g., "Alpha", "Bravo") — Phase 1 structured
   *  field. Absent on legacy messages; renders as `<unknown>` per the
   *  display matrix at parent plan §311-321 row 5. */
  identity?: string;
  /** Role at write time. Absent on legacy messages. */
  role?: ChannelRole;
  /** Forward-compat marker. Phase 1 messages omit this; future schema
   *  evolutions may set explicit version values. */
  version?: 1;
  /** How the message body was composed at send time — provenance/audit of
   *  the body SOURCE, set universally by the CLI `send` verb (#3a). Additive:
   *  legacy messages omit it. `ref` is the source-file BASENAME for
   *  file-sourced bodies only (basename, not full path — no machine-coupling,
   *  mirrors the audit-target ref convention). */
  provenance?: { source: "file" | "stdin" | "inline"; ref?: string };
};

/** Per-identity claim record stored under metadata.identities[<letter>]. */
export type IdentityClaim = {
  session_id: string;
  role: ChannelRole;
  joined_at: string;
  /**
   * ISO timestamp set when this identity posted `kind="out"` on the
   * channel.
   *
   * **Sole writer this arc (plan v5):** the CLI send-verb in
   * `src/channels/cli.ts` when `kind === "out"`. The send-role-gate
   * carve-out from the Layer 3 commit lets the `out` kind through,
   * and `makeSendOutMutator(sessionId)` (this module) is passed as the
   * `appendMessage` `extraMetadataMutator` to atomically set BOTH
   * `role = "out"` AND `out_posted_at = ts` on the sender's claim
   * under a single `withMetadataLock`.
   *
   * **No Stop-hook auto-writer.** A v4 draft extended
   * `session-presence-unregister` to auto-post `out` at session-end,
   * but Stop fires per-turn (not session-end) — see
   * `src/hooks/checks/bundled-registrations.ts:71-78` for the
   * dotfiles-worktree-cleanup precedent removed for the same bug
   * shape. SessionStart-driven reaper deferred to Phase 4 Step B.
   *
   * Read by `explicitlyOutPeers` (`src/channels/explicitly-out-peers.ts`)
   * for the "terminal until takeover" predicate per RE-7 fold. Reset
   * via the existing identity-takeover path (`claim --force` clears the
   * claim entirely, which drops `out_posted_at`).
   */
  out_posted_at?: string;
};

export type ChannelMetadata = {
  /** Schema-evolution gate. Sibling pattern: `kind_version: 1` on
   *  `digest.ts:51` + `live-update.ts:51` (body-schema versioning).
   *  Asymmetric semantics (FOLD-1, slice-6 plan v2):
   *    - READ: `validateChannelMetadata` accepts missing field (legacy
   *      pre-version channels) AND `version === 1`; injects `version: 1`
   *      into the returned in-memory ChannelMetadata.
   *    - WRITE: every persisted metadata.json gets `version: 1` explicitly
   *      (createChannel emits it; identity mutators inherit via `{...meta}`
   *      spread on validated input).
   *    - REJECT: `version >= 2` fails-closed — future schema evolutions
   *      that change the wire format must bump consumers in lockstep.
   *  Lazy migration: legacy channels read OK, write-back lands explicit
   *  field on next mutation (commitIdentityClaim / setIdentityRole / etc).
   *  Pattern parallels slice-5 RE-2 extractValidSessionId deprecate-keep
   *  migration: safe-by-default on the read side, strict on the write side. */
  readonly version: 1;
  created_at: string;
  lifecycle: ChannelLifecycle;
  handoff_id: string;
  participants: string[];
  closed_at?: string;
  /** NATO identity claims keyed by letter (e.g., "Alpha", "Bravo"). Absent
   *  on legacy channels; populated lazily on first `claimIdentity` call. */
  identities?: Record<string, IdentityClaim>;
};

export type ChannelSummary = {
  id: string;
  metadata: ChannelMetadata;
  lastMessageTs: string | null;
  archived: boolean;
};

/** Sentinel for channels whose `metadata.json` cannot be read or parsed.
 *  Surfaced ONLY by `listChannels({ includeUnreachable: true })`. The default
 *  zero-arg / `{ includeArchived }`-only signatures continue to silently skip
 *  such channels (legacy semantics — list must not throw).
 *
 *  Discriminator: callers narrow via `"kind" in entry && entry.kind === "unreachable"`.
 *  `ChannelSummary` deliberately has no `kind` field — adding one would change
 *  `JSON.stringify(listChannels())` output and break the `channels list --json`
 *  contract (Step C exit-criterion). The discriminator lives only on the
 *  unreachable arm, and only flows into return types when opted into.
 *
 *  Use case: `channels-gc-reaper` consumes the new variant to walk channels
 *  whose orphan sentinels would otherwise be unreachable (RE-W2-1 closure;
 *  see `decisions/phase-2.md` Decision A RE-1 + Decision C). */
export type UnreachableChannelSummary = {
  kind: "unreachable";
  id: string;
  /** Human-readable diagnostic; not stable for programmatic matching. */
  reason: string;
};

/** Root directory for all channel state. Delegates to the centralized
 *  resolver in `src/shared/paths.ts` which honors `CLAUDE_CONDUCTOR_CHANNELS_DIR`
 *  (per-component env), `CLAUDE_CONDUCTOR_ROOT` (root prefix), and falls back
 *  to `~/.claude/channels` (per Decision N: shared canonical with dotfiles,
 *  not under `conductor/`). */
export function resolveChannelsDir(): string {
  return channelsDir();
}

/** Archive subdirectory. Never synced. */
export function resolveArchiveDir(): string {
  return join(resolveChannelsDir(), ".archive");
}

/**
 * Path to the `~/.claude/channels/LATEST` aggregate-pointer symlink. The
 * symlink points to the channel directory of the most-recently-active
 * channel (touched on `createChannel` + `appendMessage`; cleared on
 * `closeChannel` + `archiveChannel` if it points to the channel being
 * closed/archived). Sibling to `~/.claude/handoffs/LATEST.md` — same
 * discoverability semantic at the channels layer.
 *
 * See backlog L143 design — option (a) was selected. Aggregate-pointer
 * symlinks are write-through-fragile if written via `>` (per the L146
 * "tool wired, pathway broken" cluster instance 5); writes here always go
 * through `writeLatestSymlink` which uses mkstemp + rename for race-safety.
 */
export function resolveLatestSymlinkPath(): string {
  return join(resolveChannelsDir(), LATEST_BASENAME);
}

/**
 * Canonicalize a handoff path to a channel ID.
 *
 *   HANDOFF_2026-04-19_11-30.md     → 2026-04-19_11-30
 *   /any/prefix/HANDOFF_2026-04-19_11-30  → 2026-04-19_11-30
 *   LATEST.md / any non-HANDOFF name      → throws
 */
export function channelIdFromHandoff(handoffPath: string): string {
  const name = basename(handoffPath).replace(/\.md$/u, "");
  if (!name.startsWith("HANDOFF_")) {
    throw new Error(
      `[channels] cannot derive channel id from "${handoffPath}" — handoff filenames must start with "HANDOFF_"`,
    );
  }
  const id = name.slice("HANDOFF_".length);
  if (id.length === 0) {
    throw new Error(
      `[channels] empty channel id derived from "${handoffPath}"`,
    );
  }
  return id;
}

/**
 * Canonical session-id resolver for channels-internal callers. Prefers
 * `CLAUDE_SESSION_ID` (tests) then the hook input's raw session_id. Throws
 * loudly if neither is available — never guesses.
 *
 * **Cross-edge env-var contract (ARCH-1, plan vivid-seeking-crayon §1):**
 * The plugin hosts TWO resolvers reading `CLAUDE_SESSION_ID`:
 *   (a) THIS function — lenient `isValidSessionId` gate (path-safety only).
 *       Reachable as `claude-conductor/channels/api`. Used here because
 *       channel paths only need a path-safe id; tightening to UUID-shape
 *       would break test fixtures that use short ids ("alice", "bob").
 *   (b) `shared/session-id-discovery.ts:resolveSessionId` — strict UUID
 *       gate, with mtime/ppid fallback discovery. Reachable as
 *       `claude-conductor/shared/session-id-discovery`. Used in CLI-context
 *       where there's no hook input payload.
 * The divergence is intentional. A non-UUID `CLAUDE_SESSION_ID` (e.g.,
 * `"test-session"`) is accepted here verbatim but falls through (b)'s
 * strict path to ppid/missing. Tests in `test/channels/api.test.ts` (case c)
 * lock the divergence.
 *
 * @see src/shared/session-id-discovery.ts — strict-UUID CLI-context resolver
 */
export function resolveSessionId(
  raw: Record<string, unknown> | undefined,
): string {
  // Defense-in-depth: every session-id consumed here flows into filesystem
  // paths (channelDir, heartbeatPath, body file names). isValidSessionId
  // gates against `..`/`/`/empty/etc. — symmetric with session-id.ts:42 and
  // active-sessions/index.ts:302. Sub-step 0.10 RE-2.
  const envOverride = process.env["CLAUDE_SESSION_ID"];
  if (envOverride && envOverride.length > 0 && isValidSessionId(envOverride)) {
    return envOverride;
  }
  const fromInput = raw ? extractValidSessionId(raw) : undefined;
  if (fromInput) return fromInput;
  throw new Error(
    "[channels] session_id not found or invalid — pass hook input with raw.session_id (matching isValidSessionId) or set CLAUDE_SESSION_ID",
  );
}

// ─── Paths ──────────────────────────────────────────────────────

// ─── Per-channel substrate subdirs (CLI-12 closure) ──────────────────
// Each channel directory `<channelsDir>/<channel-id>/` contains:
//   - metadata.json + metadata.json.lock — channel metadata + RMW lock
//   - messages.jsonl                     — append-only message log
//   - bodies/                            — large message bodies (body_ref)
//   - heartbeats/<sid>                   — per-session liveness markers (renamed from heartbeat/ in Step G; dual-read fallback to heartbeat/ retained ≥30d)
//   - identities/<NATO-letter>           — per-letter sentinel files (Phase 1 Slice 2)
//   - identity-emit-cursors/<sid>.json   — identity-injector emission cursors (Phase 2 Slice 5; renamed from identity-emit/ in Step G; dual-read fallback ≥30d)
//   - reap-cursors/cursor                — channels-gc-reaper rate-gate cursor (Phase 2 Slice 4; renamed from gc-reap/ in Step G; dual-read fallback ≥30d)
//   - last-seen-cursors/<sid>.json       — channels read --since-cursor cursors (Phase 2 Slice 8; renamed from last-seen/ in Step G; dual-read fallback ≥30d)
//   - idle-emit-cursors/<sid>.json       — teammate-idle-reminder emission cursors (Phase 2 Slice 7; renamed from idle-emit/ in Step G; dual-read fallback ≥30d)
// ─────────────────────────────────────────────────────────────────────

function channelDir(id: string): string {
  return join(resolveChannelsDir(), id);
}
function metadataPath(id: string): string {
  return join(channelDir(id), "metadata.json");
}
function metadataLockPath(id: string): string {
  return join(channelDir(id), "metadata.json.lock");
}
function messagesPath(id: string): string {
  return join(channelDir(id), "messages.jsonl");
}
function bodyDir(id: string): string {
  return join(channelDir(id), "bodies");
}
// ─── Step G (ARCH-W2-4) substrate-rename: noun-form standardization ───
// Per-channel subdir names standardized to noun-form per `feedback-live-substrate-sequencing.md`
// additive-first discipline. Each subdir has a NEW name (current) + LEGACY name (pre-rename).
// Readers consult NEW first, fall back to LEGACY (dual-read). Writers write to NEW only.
// Legacy names retained ≥30 days; removal commit deferred to follow-up cycle.
const HEARTBEAT_SUBDIR = "heartbeats";
const LEGACY_HEARTBEAT_SUBDIR = "heartbeat";
const LAST_SEEN_SUBDIR = "last-seen-cursors";
const LEGACY_LAST_SEEN_SUBDIR = "last-seen";

// Aggregate-pointer symlink for active-arc discoverability (backlog L143).
// Sibling to `~/.claude/handoffs/LATEST.md`. Writes go through
// `writeLatestSymlink` (mkstemp+rename for race-safety per L143 concern (i));
// reads via `resolveLatestSymlinkPath` + `readlinkSync`. The handoff guard at
// `~/.claude-dotfiles/src/hooks/checks/handoff-symlink-write-guard.ts` is the
// PreToolUse precedent that prevents Edit/Write through this symlink — a
// parallel `channels-latest-symlink-write-guard.ts` lands on the dotfiles
// consumer side (paired Bravo PR per plan §LATEST symlink lane split).
const LATEST_BASENAME = "LATEST";

/**
 * Touch the `~/.claude/channels/LATEST` symlink so it points at `channelId`'s
 * directory. Called on `createChannel` + `appendMessage` (touch-on-activity
 * semantic). Atomic via mkstemp + `renameSync` per L143 concern (i) on
 * concurrent-create races. **Fail-open + breadcrumb** per plan Q4: a write
 * failure (read-only filesystem, EACCES, ELOOP) emits an
 * `appendPresenceFailure` event and the caller continues. LATEST is a
 * discoverability primitive, not a correctness one — throwing in
 * `appendMessage` for a discoverability fault would be the wrong tradeoff.
 */
function writeLatestSymlink(channelId: string): void {
  const target = channelDir(channelId);
  const symlinkPath = resolveLatestSymlinkPath();
  const tmpPath = `${symlinkPath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(resolveChannelsDir(), { recursive: true });
    symlinkSync(target, tmpPath);
    renameSync(tmpPath, symlinkPath);
  } catch (err: unknown) {
    // Cleanup tmp if the rename failed; ignore secondary errors.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* tmp may not exist if symlinkSync failed first */
    }
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId: null,
      source: "channels-identity",
      kind: "write-failed",
      artifactPath: symlinkPath,
      detail: `[channels-latest-symlink] write failed for channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Clear the `~/.claude/channels/LATEST` symlink iff it currently points to
 * `channelId`. Called on `closeChannel` + `archiveChannel` (defensive
 * touch-on-end semantic). Idempotent — silent no-op if the symlink is
 * missing, points elsewhere, or is unreadable. Same fail-open + breadcrumb
 * discipline as `writeLatestSymlink`.
 */
function clearLatestSymlinkIfPointsTo(channelId: string): void {
  const symlinkPath = resolveLatestSymlinkPath();
  let currentTarget: string;
  try {
    const stat = lstatSync(symlinkPath);
    if (!stat.isSymbolicLink()) return;
    currentTarget = readlinkSync(symlinkPath);
  } catch {
    // ENOENT / EACCES / ELOOP — nothing to clear.
    return;
  }
  // `readlinkSync` returns the symlink's target as it was created. We wrote
  // the absolute path of `channelDir(channelId)`, so compare against that.
  if (currentTarget !== channelDir(channelId)) return;
  try {
    unlinkSync(symlinkPath);
  } catch (err: unknown) {
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId: null,
      source: "channels-identity",
      kind: "write-failed",
      artifactPath: symlinkPath,
      detail: `[channels-latest-symlink] clear failed for channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function heartbeatDir(id: string): string {
  return join(channelDir(id), HEARTBEAT_SUBDIR);
}
function legacyHeartbeatDir(id: string): string {
  return join(channelDir(id), LEGACY_HEARTBEAT_SUBDIR);
}
function heartbeatPath(id: string, sessionId: string): string {
  return join(heartbeatDir(id), sessionId);
}
function legacyHeartbeatPath(id: string, sessionId: string): string {
  return join(legacyHeartbeatDir(id), sessionId);
}
function lastSeenDir(id: string): string {
  return join(channelDir(id), LAST_SEEN_SUBDIR);
}
function legacyLastSeenDir(id: string): string {
  return join(channelDir(id), LEGACY_LAST_SEEN_SUBDIR);
}
function lastSeenCursorPath(id: string, sessionId: string): string {
  return join(lastSeenDir(id), `${sessionId}.json`);
}
function legacyLastSeenCursorPath(id: string, sessionId: string): string {
  return join(legacyLastSeenDir(id), `${sessionId}.json`);
}
function archivedChannelDir(id: string): string {
  return join(resolveArchiveDir(), id);
}

// ─── Metadata RMW (O_EXCL lock + temp+rename) ───────────────────

/**
 * Acquire an O_EXCL lockfile with jittered exponential backoff. Async to
 * avoid blocking the event loop during retry — Wave 0 RE-CRIT-2 surfaced
 * that the prior sync spin-wait deadlocks in-process Promise.all fuzz
 * tests (every waiter holds the loop, no waiters can release).
 *
 * Stale-lock detection at LOCK_STALE_MS (30s); steals + retries.
 */
async function acquireLock(lockPath: string): Promise<number> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      );
      // Wave 2 RE-W2-5: write owner pid into the lockfile so future
      // acquireLock failures can surface the holder's pid in the error.
      // Sibling pattern of `active-sessions/index.ts:writeMetaIfMissing`'s
      // owner-of-meta convention. Best-effort — a writeSync failure does
      // not invalidate the lock (we still hold the fd via O_EXCL).
      try {
        writeSync(fd, `${process.pid}\n`);
      } catch {
        /* ignore — fd ownership via O_EXCL is the load-bearing primitive */
      }
      return fd;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      try {
        const st = statSync(lockPath);
        if (getWallClockNow() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* lock disappeared between EEXIST and stat */
      }
      const jitter = Math.floor(Math.random() * LOCK_BASE_DELAY_MS);
      const delay = LOCK_BASE_DELAY_MS * (attempt + 1) + jitter;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  // Wave 2 RE-W2-5: read the lockfile content to surface the holder pid in
  // the failure message. Best-effort — an unreadable lockfile means we just
  // omit the holder hint.
  let holderHint = "";
  try {
    const holderPid = readFileSync(lockPath, "utf-8").trim();
    if (holderPid !== "") holderHint = ` (held by pid ${holderPid})`;
  } catch {
    /* lockfile vanished between final attempt and read; no hint */
  }
  throw new Error(
    `[channels] failed to acquire lock ${lockPath}${holderHint}: ${lastErr?.message ?? "unknown"}`,
  );
}

function releaseLock(fd: number, lockPath: string): void {
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/** Run `fn` while holding the per-channel metadata lock. Atomic vs other
 *  metadata mutations on the same channel; does NOT serialize against
 *  sentinel-file `linkSync` operations (claimIdentity acquires sentinels
 *  BEFORE entering the lock).
 *
 *  Exported per Phase 2 Slice 4 — the channels-gc-reaper holds this lock
 *  during its mark-and-sweep passes for atomic-snapshot semantics vs
 *  concurrent metadata writers (commitIdentityClaim, removeIdentityClaim,
 *  setIdentityRole). Sentinel-side race protection is the reaper's mtime
 *  gate + sweep-phase invariant re-check, NOT this lock. See
 *  `feedback-atomic-wiring-discipline.md` ARCH-3 inline comment. */
export async function withMetadataLock<T>(
  id: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  // RE-3 boundary guard (slice 6 / A3) — fail fast on path-traversal
  // shapes before mkdirSync constructs a filesystem path. Sibling parity
  // with commitIdentityClaim et al.
  if (!isValidArtifactId(id)) {
    throw new Error(
      `[channels] withMetadataLock: invalid channelId "${id}" — must match isValidArtifactId pattern`,
    );
  }
  mkdirSync(channelDir(id), { recursive: true });
  const lockPath = metadataLockPath(id);
  const fd = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    releaseLock(fd, lockPath);
  }
}

/**
 * Pure validator for unmarshalled `ChannelMetadata` JSON. No filesystem
 * touches; throws with a path-agnostic `sourceLabel` so the same validator
 * works for both the active-channel branch (label = channel id) and the
 * archive branch (label = archived entry name).
 *
 * Sub-step 0.10 TS-1 + cross-audit TS-A6 — path-parameterized split. Replaces
 * the inline shape-check that lived only in `readMetadataRaw` and was bypassed
 * by the archive branch's `as ChannelMetadata` cast.
 */
export function validateChannelMetadata(
  parsed: unknown,
  sourceLabel: string,
): ChannelMetadata {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`[channels] metadata for ${sourceLabel} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const created_at = obj["created_at"];
  const lifecycle = obj["lifecycle"];
  const handoff_id = obj["handoff_id"];
  const participants = obj["participants"];
  if (
    typeof created_at !== "string" ||
    lifecycle !== "parallel" ||
    typeof handoff_id !== "string" ||
    !Array.isArray(participants) ||
    !participants.every((p): p is string => typeof p === "string")
  ) {
    throw new Error(
      `[channels] metadata for ${sourceLabel} has an invalid shape`,
    );
  }
  // Schema-version gate (FOLD-1, slice-6 plan v2). Asymmetric:
  //   READ accepts `undefined` (legacy pre-version channels) or `1`;
  //   REJECTS any other value (incl. `2+`, strings, etc.) — fail-closed
  //   on unknown-future-version. WRITE always emits `1` (see createChannel
  //   + identity mutators which inherit via `{...meta}` spread).
  const versionRaw = obj["version"];
  if (versionRaw !== undefined && versionRaw !== 1) {
    throw new Error(
      `[channels] metadata for ${sourceLabel} has unsupported schema version ${JSON.stringify(versionRaw)} (expected 1 or absent)`,
    );
  }
  const meta: ChannelMetadata = {
    version: 1,
    created_at,
    lifecycle,
    handoff_id,
    participants,
  };
  const closed_at = obj["closed_at"];
  if (typeof closed_at === "string") meta.closed_at = closed_at;

  // Phase 1 additive field: validate `identities?` shape if present, ignore absence.
  // Legacy channels (pre-Phase-1) have no `identities` field — read-with-default `?? {}`.
  const identities = obj["identities"];
  if (identities !== undefined) {
    if (
      typeof identities !== "object" ||
      identities === null ||
      Array.isArray(identities)
    ) {
      throw new Error(
        `[channels] metadata for ${sourceLabel} has invalid 'identities' shape (expected object)`,
      );
    }
    const validated: Record<string, IdentityClaim> = {};
    for (const [letter, claim] of Object.entries(
      identities as Record<string, unknown>,
    )) {
      if (typeof claim !== "object" || claim === null) {
        throw new Error(
          `[channels] metadata for ${sourceLabel} has invalid 'identities[${letter}]' (not an object)`,
        );
      }
      const c = claim as Record<string, unknown>;
      const session_id = c["session_id"];
      const role = c["role"];
      const joined_at = c["joined_at"];
      if (
        typeof session_id !== "string" ||
        (role !== "pen" && role !== "queue" && role !== "out") ||
        typeof joined_at !== "string"
      ) {
        throw new Error(
          `[channels] metadata for ${sourceLabel} has invalid 'identities[${letter}]' fields`,
        );
      }
      // Phase 4 Step A Layer 3 — additive optional `out_posted_at`
      // (ISO timestamp; sole writer this arc is the CLI send-verb
      // when `kind === "out"` via `makeSendOutMutator`). Validate
      // shape if present; ignore absence.
      const out_posted_at = c["out_posted_at"];
      if (out_posted_at !== undefined && typeof out_posted_at !== "string") {
        throw new Error(
          `[channels] metadata for ${sourceLabel} has invalid 'identities[${letter}].out_posted_at' (expected string or absent)`,
        );
      }
      const claimRecord: IdentityClaim = { session_id, role, joined_at };
      if (out_posted_at !== undefined)
        claimRecord.out_posted_at = out_posted_at;
      validated[letter] = claimRecord;
    }
    meta.identities = validated;
  }

  return meta;
}

/**
 * FS + validate. Both call sites (active-channel `readMetadataRaw` and
 * archive-branch listChannels iteration) flow through here so the validator
 * is impossible to bypass via the path-shape choice.
 */
function readAndValidateMetadata(
  path: string,
  sourceLabel: string,
): ChannelMetadata {
  const text = readFileSync(path, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  return validateChannelMetadata(parsed, sourceLabel);
}

function readMetadataRaw(id: string): ChannelMetadata {
  return readAndValidateMetadata(metadataPath(id), id);
}

function writeMetadataRaw(
  id: string,
  meta: ChannelMetadata,
  sessionId: string,
): void {
  const tmp = `${metadataPath(id)}.tmp.${sessionId}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  renameSync(tmp, metadataPath(id));
}

/** Read metadata without mutation. Retries once on race. */
export function readMetadata(id: string): ChannelMetadata {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(id)) {
    throw new Error(
      `[channels] readMetadata: invalid channelId "${id}" — must match isValidArtifactId pattern`,
    );
  }
  try {
    return readMetadataRaw(id);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof SyntaxError || code === "ENOENT") {
      return readMetadataRaw(id);
    }
    throw err;
  }
}

// ─── JSONL append ───────────────────────────────────────────────

function serializeLine(msg: ChannelMessage): string {
  const obj: Record<string, unknown> = {
    ts: msg.ts,
    from: msg.from,
    kind: msg.kind,
  };
  if (msg.body !== undefined) obj["body"] = msg.body;
  if (msg.body_ref !== undefined) obj["body_ref"] = msg.body_ref;
  if (msg.body_preview !== undefined) obj["body_preview"] = msg.body_preview;
  // Phase 1 structured fields: write only when defined; preserves existing
  // line shape on legacy messages (forward-compat with pre-Phase-1 readers).
  if (msg.identity !== undefined) obj["identity"] = msg.identity;
  if (msg.role !== undefined) obj["role"] = msg.role;
  if (msg.version !== undefined) obj["version"] = msg.version;
  if (msg.provenance !== undefined) obj["provenance"] = msg.provenance;
  return `${JSON.stringify(obj)}\n`;
}

/** L409: build a single-line, codepoint-bounded preview of a body being shunted
 *  to a `body_ref` sidecar, so raw-JSONL preview consumers (the Monitor recipe,
 *  the peer message deliverer) render content instead of a blank.
 *  - Newlines/CRs collapse to a single space: JSONL is one-line-per-message and
 *    a raw newline would also fracture a `tail` preview across lines.
 *  - Truncation is codepoint-safe (`Array.from`, not `.slice`) so an astral
 *    surrogate pair (emoji, some CJK) is never split into a lone surrogate.
 *  Returns "" for a whitespace-only body — the caller omits the field then. */
function buildBodyPreview(body: string): string {
  const singleLine = body.replace(/[\r\n]+/g, " ").trim();
  const cps = Array.from(singleLine);
  if (cps.length <= BODY_PREVIEW_MAX_CHARS) return singleLine;
  return `${cps.slice(0, BODY_PREVIEW_MAX_CHARS).join("")}…`;
}

function appendLineAtomically(path: string, line: string): void {
  const buf = Buffer.from(line, "utf-8");
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
    0o644,
  );
  try {
    let written = 0;
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) throw new Error(`[channels] writeSync returned ${String(n)}`);
      written += n;
    }
  } finally {
    closeSync(fd);
  }
}

function writeBodyFile(id: string, body: string): string {
  mkdirSync(bodyDir(id), { recursive: true });
  const uuid = randomUUID();
  const dest = join(bodyDir(id), `${uuid}.txt`);
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, dest);
  return uuid;
}

export function readBodyFile(id: string, ref: string): string | null {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(id)) {
    throw new Error(
      `[channels] readBodyFile: invalid channelId "${id}" — must match isValidArtifactId pattern`,
    );
  }
  // body_ref is peer-controlled (a peer can append JSONL directly), so an
  // unvalidated ref interpolated into `${ref}.txt` below would allow ../, /,
  // or NUL to traverse out of bodyDir. Unlike a bad channelId (caller bug →
  // throw), an unsafe ref is untrusted input → return null ("unresolvable"),
  // matching the ENOENT path. The sole legitimate producer is writeBodyFile's
  // randomUUID(), which always satisfies isValidArtifactId.
  if (!isValidArtifactId(ref)) return null;
  try {
    return readFileSync(join(bodyDir(id), `${ref}.txt`), "utf-8");
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/** Create a new channel. Throws if one already exists at this id. */
export async function createChannel(args: {
  channelId: string;
  handoffId: string;
  sessionId: string;
}): Promise<ChannelMetadata> {
  const { channelId, handoffId, sessionId } = args;
  // RE-3 boundary guard (slice 6 / A3) — guard before withMetadataLock
  // (which guards on its own input but defense-in-depth at module-API
  // entry preserves the call-site provenance in the error message).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] createChannel: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return withMetadataLock(channelId, () => {
    if (existsSync(metadataPath(channelId))) {
      throw new Error(`[channels] channel ${channelId} already exists`);
    }
    const meta: ChannelMetadata = {
      version: 1,
      created_at: new Date().toISOString(),
      lifecycle: "parallel",
      handoff_id: handoffId,
      participants: [sessionId],
    };
    writeMetadataRaw(channelId, meta, sessionId);
    touchHeartbeat(channelId, sessionId);
    writeLatestSymlink(channelId);
    return meta;
  });
}

/** Join an existing channel. Idempotent. */
export async function joinChannel(args: {
  channelId: string;
  sessionId: string;
  /** L171 participants-prune (prune-on-join): when supplied, stale participants
   *  are dropped in place during this join — bounding the otherwise append-only
   *  list on the eternal channel. The predicate is INJECTED (not imported here)
   *  because channels/index.ts importing classifySessionLiveness would re-close
   *  the active-sessions<->channels module cycle (session-liveness.ts:14-20):
   *  mechanism lives here, policy is supplied by the CLI edge. Self and current
   *  identity-holders are never pruned regardless of the predicate. */
  pruneStale?: (sessionId: string) => boolean;
}): Promise<ChannelMetadata> {
  const { channelId, sessionId, pruneStale } = args;
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] joinChannel: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    if (meta.closed_at) {
      throw new Error(
        `[channels] channel ${channelId} is closed (at ${meta.closed_at})`,
      );
    }
    let changed = false;
    if (!meta.participants.includes(sessionId)) {
      meta.participants.push(sessionId);
      changed = true;
    }
    if (pruneStale !== undefined) {
      // Never prune self or a session that currently holds a NATO identity.
      const identityHolders = new Set(
        Object.values(meta.identities ?? {}).map((claim) => claim.session_id),
      );
      const kept = meta.participants.filter(
        (sid) =>
          sid === sessionId || identityHolders.has(sid) || !pruneStale(sid),
      );
      if (kept.length !== meta.participants.length) {
        meta.participants = kept;
        changed = true;
      }
    }
    if (changed) {
      writeMetadataRaw(channelId, meta, sessionId);
    }
    touchHeartbeat(channelId, sessionId);
    return meta;
  });
}

/**
 * Join the channel if it exists, else create it then join — the eternal
 * coordination channel's bootstrap path. Unlike {@link joinChannel} (which
 * requires the channel to pre-exist) and {@link createChannel} (which throws
 * if it already exists), this is the idempotent "ensure I am a participant
 * of `channelId`, creating it from nothing if needed" primitive.
 *
 * The eternal channel is NOT handoff-derived, so there is no handoff id to
 * seed `metadata.handoff_id`. `handoffId` defaults to `channelId` itself — a
 * self/sentinel anchor (the channel is its own provenance).
 *
 * Concurrency: cold-start sessions may race to create the channel. We avoid a
 * fragile error-message match by re-checking existence after a failed
 * `createChannel` — if the channel now exists, another session won the create
 * race (benign) and we fall through to join; otherwise the failure was real
 * (invalid id, IO error) and is rethrown. `createChannel`/`joinChannel` each
 * take the per-channel metadata lock, so the create itself is atomic.
 *
 * Used by the `join` CLI verb for {@link COORDINATION_CHANNEL_ID}.
 */
export async function joinOrCreateChannel(args: {
  channelId: string;
  sessionId: string;
  handoffId?: string;
  /** L171 participants-prune — forwarded to {@link joinChannel} on the join
   *  path (a freshly created channel has only the creator, so nothing to
   *  prune). See joinChannel's `pruneStale` for the cycle-avoidance rationale. */
  pruneStale?: (sessionId: string) => boolean;
}): Promise<ChannelMetadata> {
  const { channelId, sessionId, pruneStale } = args;
  const handoffId = args.handoffId ?? channelId;
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] joinOrCreateChannel: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (!existsSync(metadataPath(channelId))) {
    try {
      return await createChannel({ channelId, handoffId, sessionId });
    } catch (err) {
      // Benign create race: a concurrent cold-start session created the
      // channel between our existsSync check and createChannel's in-lock
      // guard. If it exists now, fall through to join; else the error was
      // real — rethrow.
      if (!existsSync(metadataPath(channelId))) throw err;
    }
  }
  return joinChannel({
    channelId,
    sessionId,
    ...(pruneStale !== undefined ? { pruneStale } : {}),
  });
}

/** Close a channel. Idempotent. Prevents new messages. */
export async function closeChannel(args: {
  channelId: string;
  sessionId: string;
}): Promise<ChannelMetadata> {
  const { channelId, sessionId } = args;
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] closeChannel: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    if (!meta.closed_at) {
      meta.closed_at = new Date().toISOString();
      writeMetadataRaw(channelId, meta, sessionId);
    }
    // Defensive: clear LATEST if it pointed at this channel. Idempotent close
    // means we always check (re-close on a channel that LATEST migrated away
    // from is a no-op). Tiny race window vs concurrent appendMessage on
    // another channel is documented in clearLatestSymlinkIfPointsTo.
    clearLatestSymlinkIfPointsTo(channelId);
    return meta;
  });
}

/**
 * Commit an identity claim to `metadata.identities` after a successful
 * sentinel-file linkSync. Phase 1 v2 §122 commit-after-claim ordering:
 * the per-letter sentinel file (atomic via linkSync EEXIST) is the
 * canonical claim; the metadata.identities map is a materialized cache
 * that downstream verbs (whoami / set-role / peers / read render) read
 * from. Without this commit, those verbs see `{}` after successful
 * claims (Wave 1 ARCH-1 finding).
 *
 * Used by `claimIdentity` (src/channels/identity.ts). Idempotent: writing
 * the same claim twice is a no-op semantically (overwrites with identical
 * content). Called under `withMetadataLock` for atomicity against
 * concurrent `joinChannel` / `closeChannel` mutations.
 */
export async function commitIdentityClaim(args: {
  channelId: string;
  identity: string;
  claim: IdentityClaim;
}): Promise<void> {
  const { channelId, identity, claim } = args;
  // Defense-in-depth: this function is exported on the public surface
  // (Decision Q4 enables direct primitive import for Phase 2 hooks).
  // claimIdentity already validates upstream, but a direct caller
  // wouldn't. Sibling-parity with claimIdentity's own boundary gate.
  // Slice 2.2 verification round RE-NEW-2.
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] commitIdentityClaim: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const identities = { ...(meta.identities ?? {}), [identity]: claim };
    const next: ChannelMetadata = { ...meta, identities };
    writeMetadataRaw(channelId, next, claim.session_id);
  });
}

/**
 * Remove a NATO identity claim from `metadata.identities`. Sibling-write to
 * `commitIdentityClaim` for the release path (Slice 5 close-peer + future
 * manual release flows). Sub-write under `withMetadataLock` for atomicity
 * against concurrent claim/join/close mutations.
 *
 * Returns the removed `IdentityClaim` so callers can attribute audit log
 * events (e.g., orphan-sentinel warnings) to the original claimant session.
 * Idempotent on absence: returns `null` and writes nothing.
 *
 * Used by `releaseIdentity` (src/channels/identity.ts) — RE-6 ordering
 * requires this metadata write to succeed before the sentinel unlink so a
 * crash mid-release leaves an orphan sentinel (recoverable on next claim
 * via the reconcile-on-rejoin path per Slice 2.2 Decision D) rather than a
 * phantom metadata entry with no sentinel (Slice 5 verbs would mistakenly
 * trust it).
 */
export async function removeIdentityClaim(args: {
  channelId: string;
  identity: string;
}): Promise<IdentityClaim | null> {
  const { channelId, identity } = args;
  // Defense-in-depth boundary validation per Slice 2.2 verification round
  // RE-NEW-2 (sibling-parity with commitIdentityClaim). Direct callers
  // outside identity.ts (Decision Q4 enables Phase 2 hook consumers) get
  // the same path-traversal guard.
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] removeIdentityClaim: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const existing = meta.identities;
    if (existing === undefined) return null;
    const removed = existing[identity];
    if (removed === undefined) return null;
    const nextIdentities: Record<string, IdentityClaim> = { ...existing };
    delete nextIdentities[identity];
    const next: ChannelMetadata = { ...meta, identities: nextIdentities };
    writeMetadataRaw(channelId, next, removed.session_id);
    return removed;
  });
}

/**
 * Atomically check a peer's heartbeat staleness AND remove its identity
 * claim under a SINGLE `withMetadataLock` section. Slice 5 RE-6 close-peer
 * race fix — without the same-lock sequence, a check-then-release split
 * lets a second concurrent metadata mutator squeeze in between, and the
 * staleness snapshot becomes irrelevant by the time the metadata write
 * lands. (The peer's own `touchHeartbeat` is independent of this lock —
 * heartbeat writes are not metadata-locked. The atomicity guarantee here
 * is against OTHER metadata mutators (claim/setRole/release), which is
 * the load-bearing race; the peer-heartbeat-write race is a tiny window
 * relative to the > 60 s stale threshold and `--force` covers operator
 * override.)
 *
 * Returns a discriminated result:
 *   - `{kind: "released", releasedClaim}` — heartbeat was stale (or
 *     `force === true`); metadata entry removed. Sentinel unlink is the
 *     caller's responsibility (use
 *     `unlinkIdentitySentinelOrLogOrphan` from `./identity.ts` for
 *     RE-6-aligned orphan handling).
 *   - `{kind: "still-active", ageMs}` — heartbeat is fresh; refused. The
 *     CLI verb maps this to a non-zero exit with a `--force` hint.
 *   - `{kind: "not-held"}` — the identity isn't claimed; nothing to
 *     close.
 *
 * `ageMs === null` means the peer has no heartbeat file at all (never
 * touched). Treated as stale (the most conservative interpretation —
 * a peer that never heartbeated is presumed dead).
 *
 * **Phase 2 Slice 1+2 RE-W0-8 audit-trail caveat:** the `peer-closed`
 * status message that documents the close (posted by the operator's CLI
 * via `appendMessage`) is best-effort post-metadata-commit. If the
 * audit-trail JSONL append fails (disk full, fd cap, etc.), the metadata
 * removal here is already committed — the close happened, but the audit
 * line may be missing. Failure surfaces via `appendPresenceFailure`
 * source=`channels-identity` and does NOT roll back the close. Operators
 * cross-referencing audit lines should treat absence as a forensic gap,
 * not as evidence the close didn't happen.
 */
export async function closeStalePeerIdentity(args: {
  channelId: string;
  identity: string;
  staleThresholdMs: number;
  force: boolean;
  /**
   * Optional CAS gate: when set, the in-lock claim-read MUST match this
   * session_id. Mismatch returns `{kind: "session-mismatch", ...}` without
   * mutating metadata or sentinel state. Added for the `release-self` CLI
   * verb (cycle 2026-05-24 Alpha Tier 4) to close the resolve-then-release
   * race: if another peer's `claim --as <Identity> --force` lands between
   * `getIdentityForSession` and `closeStalePeerIdentity`, force=true alone
   * would mistakenly release THEIR fresh claim. With casSessionId set, the
   * race fails closed rather than silently corrupting peer state.
   *
   * Unset = legacy behavior (no CAS check; close-peer's operator-escape-
   * hatch shape is preserved).
   */
  casSessionId?: string;
}): Promise<
  | { kind: "released"; releasedClaim: IdentityClaim }
  | { kind: "still-active"; ageMs: number | null }
  | { kind: "not-held" }
  | { kind: "session-mismatch"; actualSessionId: string }
> {
  const { channelId, identity, staleThresholdMs, force, casSessionId } = args;
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] closeStalePeerIdentity: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const claim = meta.identities?.[identity];
    if (claim === undefined) {
      return { kind: "not-held" } as const;
    }
    // CAS gate — verify holder matches expected before any mutation.
    // Runs BEFORE staleness check so a session-mismatch never gets
    // misattributed as still-active.
    if (casSessionId !== undefined && claim.session_id !== casSessionId) {
      return {
        kind: "session-mismatch",
        actualSessionId: claim.session_id,
      } as const;
    }
    // Heartbeat snapshot — read inside the lock so it's stable w/r/t
    // other metadata mutators (the peer's own touchHeartbeat is
    // independent; that's the documented narrow race).
    const peerMtime = heartbeatMtime(channelId, claim.session_id);
    const ageMs = peerMtime === null ? null : getWallClockNow() - peerMtime;
    const isStale = ageMs === null || ageMs > staleThresholdMs;
    if (!isStale && !force) {
      return { kind: "still-active", ageMs } as const;
    }
    const nextIdentities: Record<string, IdentityClaim> = {
      ...meta.identities,
    };
    delete nextIdentities[identity];
    const next: ChannelMetadata = { ...meta, identities: nextIdentities };
    writeMetadataRaw(channelId, next, claim.session_id);
    return { kind: "released", releasedClaim: claim } as const;
  });
}

/**
 * Read the `session_id` recorded in an on-disk identity sentinel, or `null`
 * if the sentinel is absent, unreadable, or shape-invalid. Used by
 * `claimNamedIdentityWithLock`'s sentinel-reverify-under-lock guard to detect
 * a lock-free vanilla `claimIdentity` reclaim before an unconditional
 * `renameSync` clobbers it. Treating "present-but-corrupt" the same as
 * "absent" (null) is conservative: the takeover yields rather than overwrites.
 */
function readSentinelSessionId(sentinelPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(sentinelPath, "utf-8");
  } catch {
    return null;
  }
  const claim = validateIdentityClaim(raw);
  return claim === null ? null : claim.session_id;
}

/**
 * Atomically commit a named-identity takeover under `withMetadataLock`.
 * Sibling-of `closeStalePeerIdentity` for the P2 `claim --as <Identity>`
 * flow per plan giggly-bouncing-spark.md Decisions §3 + §4 + §9.
 *
 * **Two-phase contract.** Caller (`claimIdentityNamed` in identity.ts) does
 * P1's pre-lock `linkSync(tmpPath, sentinelPath)` first; on EEXIST, it calls
 * THIS function to perform P2 — heartbeat snapshot + CAS check + force gate
 * + atomic `renameSync(tmpPath, sentinelPath)` overwrite + metadata commit
 * — all under one `withMetadataLock` cycle. NO sentinel unlink ever; the
 * `renameSync` is the takeover atomicity primitive.
 *
 * **Lock-domain note** (per RE-1 / Bravo MAJ-1 cross-audit): `withMetadataLock`
 * serializes metadata writes only — sentinel filesystem operations are NOT
 * serialized by the lock. This function therefore performs the renameSync
 * inside the lock to bound the racing window with concurrent metadata
 * mutators (`commitIdentityClaim` / `removeIdentityClaim` / `setIdentityRole`
 * / `closeStalePeerIdentity`). The residual race with vanilla
 * `claimIdentity`'s pre-lock linkSync (formerly an acceptable operator-only
 * `--force` defer) is now CLOSED by the sentinel-reverify-under-lock guard
 * below: before mutating, the on-disk sentinel is re-read and compared to the
 * metadata snapshot, and a divergence (lock-free vanilla reclaim) yields
 * `{kind: "raced"}` instead of clobbering. The unheld-letter sub-case uses
 * create-only `linkSync` (EEXIST -> raced) so a racing vanilla create is
 * detected, not overwritten.
 *
 * **Discriminated result:**
 *   - `{kind: "claimed", displacedSessionId}` — takeover succeeded; sentinel
 *     replaced + metadata committed. `displacedSessionId` is the prior
 *     holder's session_id (`null` if metadata had no entry — orphan-like
 *     sentinel-only state). Caller posts the audit-trail message post-lock.
 *   - `{kind: "active", holderSessionId, ageMs}` — refused: identity is held
 *     and `--force` was not passed. Caller throws `IdentityActiveError`.
 *   - `{kind: "cas-mismatch", expected, actual}` — refused: `--from-session`
 *     was passed but did not match the holder's session_id. Caller throws
 *     `IdentityCasMismatchError`.
 *   - `{kind: "raced", expectedHolder, actualHolder}` — refused: the on-disk
 *     sentinel diverged from the metadata snapshot (a lock-free vanilla
 *     `claimIdentity` reclaim landed in our window), so the takeover yielded
 *     rather than clobber it. Caller throws `IdentityRacedError`.
 *
 * `tmpPath` MUST exist on the same filesystem as `sentinelPath` (renameSync
 * requires same-fs); the caller's `mkdirSync(identitiesDir, {recursive:true})`
 * + `writeFileSync(tmpPath)` discipline already satisfies this.
 */
export async function claimNamedIdentityWithLock(args: {
  channelId: string;
  identity: string;
  newClaim: IdentityClaim;
  tmpPath: string;
  sentinelPath: string;
  force: boolean;
  fromSession: string | undefined;
}): Promise<
  | { kind: "claimed"; displacedSessionId: string | null }
  | { kind: "active"; holderSessionId: string; ageMs: number | null }
  | { kind: "cas-mismatch"; expected: string; actual: string | null }
  | {
      kind: "raced";
      expectedHolder: string | null;
      actualHolder: string | null;
    }
> {
  const { channelId, identity, newClaim, tmpPath, sentinelPath, force } = args;
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] claimNamedIdentityWithLock: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const existingMeta = meta.identities?.[identity];
    const holderSessionId = existingMeta?.session_id ?? null;

    // CAS gate (Decision §9). Operator passed --from-session — verify the
    // holder's session_id matches before takeover proceeds. Mismatch is
    // refused with discriminated kind so the CLI verb can emit a clear
    // forensic-style error without triggering the active-error path.
    if (args.fromSession !== undefined) {
      if (holderSessionId !== args.fromSession) {
        return {
          kind: "cas-mismatch",
          expected: args.fromSession,
          actual: holderSessionId,
        } as const;
      }
    }

    // Force gate (Decision §4). REQUIRE --force for ALL --as takeovers.
    // Drops the staleness-auto path (RE-5 closure) — 60s STALE_THRESHOLD_MS
    // can false-positive on Monitor-wake-delayed sessions.
    if (!force) {
      const heartbeatMs =
        holderSessionId !== null
          ? heartbeatMtime(channelId, holderSessionId)
          : null;
      const ageMs =
        heartbeatMs === null ? null : getWallClockNow() - heartbeatMs;
      return {
        kind: "active",
        holderSessionId: holderSessionId ?? "(unknown)",
        ageMs,
      } as const;
    }

    // Force=true: atomic takeover, guarded by sentinel-reverify-under-lock.
    //
    // The metadata snapshot (`holderSessionId`, read above in this lock cycle)
    // is our reference for whom we believe we are displacing. But the on-disk
    // sentinel is the canonical claim marker, and vanilla `claimIdentity`'s
    // sentinel `linkSync` runs OUTSIDE this lock — so a vanilla join can
    // reclaim the letter in the window between our metadata read and now. An
    // unconditional `renameSync` (create-or-replace) would then clobber that
    // fresh vanilla sentinel, producing a permanent sentinel/metadata
    // divergence + double-claim (the Slice-7 residual race). Reverify first.
    const sentinelHolder = readSentinelSessionId(sentinelPath);
    if (sentinelHolder !== holderSessionId) {
      // Sentinel diverged from the metadata snapshot — a lock-free vanilla
      // reclaim (or a torn release) landed under us. Do NOT clobber it. We
      // have mutated neither sentinel nor metadata, so just yield; the caller
      // surfaces a re-runnable race error.
      return {
        kind: "raced",
        expectedHolder: holderSessionId,
        actualHolder: sentinelHolder,
      } as const;
    }
    if (sentinelHolder === null) {
      // `sentinelHolder === null` means the on-disk sentinel is either ABSENT
      // or PRESENT-but-unparseable (corrupt/torn). `holderSessionId` is null
      // too (we reached here via the equality check above), so metadata records
      // no live claim either way. Split on file presence:
      if (existsSync(sentinelPath)) {
        // Present-but-unparseable + no metadata entry = a CORRUPT ORPHAN (a
        // VALID orphan would parse -> `sentinelHolder !== null` -> the diverged
        // branch above, which yields `raced`). It is NOT a live claim, so a
        // `--force` takeover RECOVERS it by clobbering. This restores the
        // recovery the pre-reverify unconditional `renameSync` gave: without it
        // the corrupt sentinel EEXISTs every create-only `linkSync` forever and
        // permanently wedges the letter. Safe under the lock — no release can
        // unlink it (lock-gated) and no vanilla can replace a present sentinel
        // (EEXIST), so it is stable until this renameSync.
        renameSync(tmpPath, sentinelPath);
      } else {
        // Truly absent: the letter is unheld right now (prior holder fully
        // released inside our window). Use create-only `linkSync` so a vanilla
        // `linkSync` racing in is DETECTED via EEXIST rather than silently
        // clobbered by a create-or-replace `renameSync`.
        try {
          linkSync(tmpPath, sentinelPath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
            return {
              kind: "raced",
              expectedHolder: null,
              actualHolder: readSentinelSessionId(sentinelPath),
            } as const;
          }
          throw err;
        }
        // `linkSync` created a second hardlink; `tmpPath` still exists. Remove
        // it so the caller's "claimed => tmpPath consumed" contract holds
        // uniformly with the `renameSync` branches.
        try {
          unlinkSync(tmpPath);
        } catch {
          // tmp already gone; ignore.
        }
      }
    } else {
      // Sentinel present AND === the metadata snapshot holder. Under this lock
      // no release can unlink it (`removeIdentityClaim` is lock-gated) and no
      // vanilla `linkSync` can replace it (EEXIST on a present sentinel), so it
      // is stable === holder until we replace it. `renameSync` atomically
      // overwrites it in one syscall (POSIX rename(2), same-filesystem).
      renameSync(tmpPath, sentinelPath);
    }

    // Update metadata.identities under the same lock cycle so concurrent
    // metadata mutators see consistent post-state.
    const nextIdentities: Record<string, IdentityClaim> = {
      ...(meta.identities ?? {}),
      [identity]: newClaim,
    };
    const next: ChannelMetadata = { ...meta, identities: nextIdentities };
    writeMetadataRaw(channelId, next, newClaim.session_id);

    return {
      kind: "claimed",
      displacedSessionId: holderSessionId,
    } as const;
  });
}

/**
 * Atomically update the role of an existing identity claim. Read-modify-
 * write under `withMetadataLock` so set-role races against concurrent
 * claim/release/heartbeat operations are race-safe.
 *
 * Returns a discriminated result:
 *   - `{kind: "updated", previousRole}` — the role was changed (or set to
 *     the same value, idempotently).
 *   - `{kind: "not-held"}` — the identity isn't claimed; no write is
 *     performed. Callers (CLI's `set-role` verb) map this to exit 5 per
 *     Slice 5 RE-6 — silent no-op is the failure mode being prevented.
 *
 * The discriminated return avoids importing `IdentityNotHeldError` from
 * identity.ts (which would create a circular import); the caller wraps the
 * `not-held` case in the appropriate error class.
 */
export async function setIdentityRole(args: {
  channelId: string;
  identity: string;
  role: ChannelRole;
}): Promise<
  { kind: "updated"; previousRole: ChannelRole } | { kind: "not-held" }
> {
  const { channelId, identity, role } = args;
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] setIdentityRole: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  return await withMetadataLock(channelId, () => {
    const meta = readMetadataRaw(channelId);
    const existing = meta.identities?.[identity];
    if (existing === undefined) {
      return { kind: "not-held" } as const;
    }
    const updated: IdentityClaim = { ...existing, role };
    const identities: Record<string, IdentityClaim> = {
      ...(meta.identities ?? {}),
      [identity]: updated,
    };
    const next: ChannelMetadata = { ...meta, identities };
    writeMetadataRaw(channelId, next, existing.session_id);
    return { kind: "updated", previousRole: existing.role } as const;
  });
}

/**
 * Thrown by `appendMessage` when the target channel's `metadata.closed_at`
 * is set. Lets callers discriminate closed-channel rejection via
 * `instanceof` rather than substring-matching on `Error.message` —
 * future channel-substrate refactors that change the message text will
 * not silently break discrimination at consumer sites.
 *
 * Sibling pattern to identity-error classes in `./identity.ts`
 * (`NatoExhaustedError`, `IdentityNotHeldError`, etc.) — same `extends
 * Error` shape, same name-via-super convention, same `this.name`
 * assignment so structured logs surface the discriminator.
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v3 MAJOR-3 fold (b);
 * backlog item under `wiki/backlog.md` "Plugin (`claude-conductor`) —
 * `ChannelClosedError` typed exception class" (filed 2026-05-13).
 */
export class ChannelClosedError extends Error {
  constructor(channelId: string, closedAt: string) {
    super(
      `[channels] channel '${channelId}' is closed (at ${closedAt}); cannot append. ` +
        `Recovery: open a new channel via 'claude-conductor channels create <new-id> <handoff-id>', ` +
        `or pick a non-closed channel via 'claude-conductor channels list'.`,
    );
    this.name = "ChannelClosedError";
  }
}

/**
 * Append a message. Large bodies are redirected to a sidecar file.
 *
 * Phase 2 Slice 1+2 (RE-W2-1 closure): the metadata-read + auto-attach +
 * JSONL append cycle runs inside `withMetadataLock` so concurrent
 * `setIdentityRole` / `closeStalePeerIdentity` / `removeIdentityClaim`
 * cannot race the auto-attach scan and produce wrong-attribution messages
 * (where the appended `role` disagrees with the role at-or-after-write
 * time). The lock domain is per-channel; cross-channel sends remain
 * parallel.
 *
 * **API-shape break (REV 2 ARCH-W0-7 acknowledgment):** this function was
 * sync prior to Phase 2; it now returns `Promise<ChannelMessage>`. Every
 * caller updates to `await`; cross-edge dotfiles consumers reach this via
 * the Slice 3a shim which already exposes the new async signature.
 *
 * **Risk #1 mitigation:** the lock-hold cost is one `withMetadataLock`
 * acquire per send; the metadata read + auto-attach scan are O(26) (NATO
 * pool size). If 1000-iter property-fuzz throughput regresses > 20%
 * post-merge, the follow-up is an RW-lock split (read for the auto-attach
 * scan, exclusive only for metadata mutations) — not promised in this
 * slice, just reserved as a Phase 3 follow-up slot.
 *
 * **Closed-channel rejection** (plan v3 MAJOR-3 fold (b)): throws
 * `ChannelClosedError` (defined just above) when `metadata.closed_at` is
 * set. Callers wanting to discriminate closed-channel rejection from
 * other failure modes should `catch (err) { if (err instanceof
 * ChannelClosedError) ... }` rather than substring-matching the message.
 */
export async function appendMessage(args: {
  channelId: string;
  message: ChannelMessage;
  /**
   * Optional metadata mutator run under the same `withMetadataLock` as
   * the message append. If provided, the mutator is called with the
   * current metadata (post-read, post-close-check); when it returns an
   * object that differs from the input by reference, the new metadata
   * is written back via `writeMetadataRaw` **AFTER** the JSONL line
   * lands (audit-trail-as-anchor per plan v5 RE-2 fold; see the inline
   * ordering note at the bottom of this function's lock callback for
   * the rationale).
   *
   * **Use case (Phase 4 Step A Layer 3):** atomic
   * "post-out-and-mark-self" for the CLI `kind=out` send path — the
   * caller (`makeSendOutMutator`) returns a mutator that sets BOTH
   * `role = "out"` AND `out_posted_at = ts` on the sender's claim.
   * Both the JSONL audit line and the metadata cache land under one
   * lock acquisition; readers (whoami / explicitlyOutPeers /
   * message-record) converge post-mutation.
   *
   * **Semantics:**
   *   - Mutator is sync; throwing from it aborts the entire transaction
   *     (no message lands, no metadata change). Validation also runs
   *     up-front; a mutator that returns a mis-shaped object throws
   *     before the JSONL append.
   *   - Reference-equality is the write-back signal — return the input
   *     `meta` unchanged to skip the write; return any other object
   *     (including a structural copy) to trigger `writeMetadataRaw`.
   *     **Do NOT mutate `meta` in place** — that returns reference-
   *     equal and silently skips disk-write while the in-memory object
   *     diverges.
   *   - Mutator runs AFTER auto-attach + closed-channel check. The
   *     auto-attach scan reads `meta.identities`; if the mutator
   *     depends on the post-write `identities` value, structure it to
   *     merge against the `meta` it receives.
   *   - Validates the returned metadata via `validateChannelMetadata`
   *     before the JSONL append, so a mis-shaped mutator output dies
   *     before either disk write.
   *   - **Single mutator per call.** If a future caller needs to
   *     compose multiple field mutations (e.g., Layer 4 digest +
   *     out-transition), wrap them in a single mutator function or
   *     add a `composeMutators(...mutators)` helper at that time.
   *
   * **Failure-mode tolerance (per plan v5 RE-2):** if the JSONL
   * append succeeds and the subsequent `writeMetadataRaw` fails
   * (ENOSPC, EACCES, EBUSY), the durable audit trail (JSONL line)
   * still lands but the metadata cache stays stale. There is NO
   * automatic JSONL → metadata reconciliation reader; recovery is
   * external (operator `claim --force` displaces the entire claim,
   * or hand-edit the metadata.json). The opposite ordering would
   * leave a permanently lying cache when the JSONL append fails,
   * which is the worse posture; JSONL-first preserves audit trail.
   */
  extraMetadataMutator?: (meta: ChannelMetadata) => ChannelMetadata;
}): Promise<ChannelMessage> {
  const { channelId } = args;
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] appendMessage: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (!existsSync(metadataPath(channelId))) {
    throw new Error(`[channels] channel ${channelId} does not exist`);
  }
  return withMetadataLock(channelId, () => {
    const meta = readMetadata(channelId);
    if (meta.closed_at) {
      throw new ChannelClosedError(channelId, meta.closed_at);
    }

    let message = args.message;

    // Slice 6: auto-attach `identity` + `role` from `metadata.identities`
    // if the sender holds a claim. Legacy senders (no claim) keep both
    // fields absent → `renderMessage` shows them as `<unknown>: <body>`
    // (matrix row 5). Caller-wins: if the message already specifies
    // either field, leave it untouched (allows tests + callers that need
    // explicit override to bypass the auto-attach).
    //
    // Inline scan instead of importing `getIdentityForSession` from
    // `./identity.ts` — identity.ts already imports from this module
    // (`commitIdentityClaim`/`removeIdentityClaim`/etc.), so reverse-
    // importing would create a cycle. The scan is O(26) max (NATO pool
    // size) and `meta` is already in scope; no extra IO.
    //
    // Phase 2 Slice 1+2: this read is now serialized under
    // `withMetadataLock` against `setIdentityRole`/`closeStalePeerIdentity`/
    // `removeIdentityClaim`; the attached `role` matches metadata's role
    // at-or-before append time even under concurrent role flips.
    if (message.identity === undefined && message.role === undefined) {
      const identities = meta.identities;
      if (identities !== undefined) {
        for (const [letter, claim] of Object.entries(identities)) {
          if (claim.session_id === message.from) {
            message = { ...message, identity: letter, role: claim.role };
            break;
          }
        }
      }
    }

    // Phase 4 Step A Layer 3 — compute the post-mutation metadata
    // candidate UP FRONT (under the lock), but DO NOT write it yet.
    // The write follows after the JSONL append per the audit-trail-as-
    // anchor ordering (RE-2 fold). Validation runs here so a mis-shaped
    // mutator output throws BEFORE the JSONL line lands (no half-write
    // where the log gets the message but the cache write is rejected).
    let mutatedMetadata: ChannelMetadata | null = null;
    if (args.extraMetadataMutator !== undefined) {
      const nextMeta = args.extraMetadataMutator(meta);
      if (nextMeta !== meta) {
        // validateChannelMetadata throws on mis-shape — the throw
        // unwinds withMetadataLock and rejects appendMessage's promise,
        // so the caller sees a typed error (no message lands, no
        // metadata change).
        mutatedMetadata = validateChannelMetadata(
          nextMeta,
          `${channelId} (extraMetadataMutator)`,
        );
      }
    }

    const initialLine = serializeLine(message);
    if (
      Buffer.byteLength(initialLine, "utf-8") > SMALL_MESSAGE_MAX_BYTES &&
      message.body
    ) {
      const ref = writeBodyFile(channelId, message.body);
      // Preserve identity/role/version on the body-shunt rewrite — Slice 6
      // attribution must survive the sidecar redirect (otherwise large
      // bodies render as `<unknown> [body-ref:<ref>]` which is incorrect
      // when the sender held a claim).
      const shunted: ChannelMessage = {
        ts: message.ts,
        from: message.from,
        kind: message.kind,
        body_ref: ref,
      };
      // L409: a single-line content preview so raw-JSONL consumers (the
      // Monitor/tail recipe, the peer message deliverer) render content rather
      // than a blank. Omitted when the body is whitespace-only (empty preview).
      const preview = buildBodyPreview(message.body);
      if (preview.length > 0) shunted.body_preview = preview;
      if (message.identity !== undefined) shunted.identity = message.identity;
      if (message.role !== undefined) shunted.role = message.role;
      if (message.version !== undefined) shunted.version = message.version;
      message = shunted;
    }

    // RE-2 fold (audit-trail-as-anchor): JSONL append runs BEFORE the
    // metadata write. On JSONL-append failure (ENOSPC, EACCES, EBUSY),
    // the metadata stays unchanged — clean transaction failure. On
    // metadata-write failure AFTER a successful JSONL append, the
    // durable audit trail still lands but the cache stays stale; there
    // is NO automatic JSONL → metadata reconciliation reader, so
    // recovery is external (operator `claim --force` replaces the
    // entire claim record, OR hand-edit metadata.json). The opposite
    // ordering (metadata-first) is worse: a JSONL-append failure
    // post-metadata-write leaves a permanently lying cache with no
    // durable audit line to recover from. Sibling pattern: Layer 1
    // two-phase cursor commit (pending → committed) treats the durable
    // event as the anchor.
    const line = serializeLine(message);
    appendLineAtomically(messagesPath(channelId), line);
    if (mutatedMetadata !== null) {
      writeMetadataRaw(channelId, mutatedMetadata, message.from);
    }
    touchHeartbeat(channelId, message.from);
    // L143 — touch LATEST symlink so the most-recently-active channel is
    // discoverable as `~/.claude/channels/LATEST`. Sibling pattern to
    // `~/.claude/handoffs/LATEST.md`. Inside the metadata lock for the
    // SOURCE channel; the symlink itself is a cross-channel primitive but
    // the atomic mkstemp+rename in writeLatestSymlink handles cross-channel
    // race against other appendMessage callers.
    writeLatestSymlink(channelId);
    return message;
  });
}

/**
 * Build an `extraMetadataMutator` for the manual-`out` send path. The
 * returned mutator finds the identity claim belonging to `sessionId`
 * and atomically updates it with `role = "out"` AND
 * `out_posted_at = ts` (defaults to "now" if omitted).
 *
 * **Three predicates converge post-mutation:**
 *   - `whoami` reads `metadata.identities[<L>].role` → `"out"`
 *   - `explicitlyOutPeers` reads `metadata.identities[<L>].out_posted_at` → present
 *   - JSONL `kind=out` line carries `role: "out"` via the auto-attach
 *     scan (auto-attach happens before the mutator in the lock callback;
 *     attach uses the PRE-mutation role, so the message's `role` field
 *     reflects "what the sender was at write-start". For first-time
 *     departure, this is the sender's prior role — consumers reading
 *     the `out` line know the prior posture from the message field and
 *     the new posture from the metadata).
 *
 * **Caller-wins / no-op:** if the session has no identity claim on the
 * channel (legacy / pre-join send), returns the input metadata by
 * reference → no metadata write-back, message still lands. The CLI
 * role-gate carve-out already permits `kind=out` from claimless
 * senders; the mutator gracefully no-ops in that case.
 *
 * Used by `src/channels/cli.ts` send-verb when `kind === "out"` to
 * make the manual `channels send <id> out` a true terminal transition
 * — sole writer of `out_posted_at` this arc per plan v5 (auto-out
 * extension dropped; SessionStart-reaper deferred to Phase 4 Step B).
 */
export function makeSendOutMutator(
  sessionId: string,
  postedAt: string = new Date().toISOString(),
): (meta: ChannelMetadata) => ChannelMetadata {
  return (meta) => {
    const identities = meta.identities;
    if (identities === undefined) return meta;
    for (const [letter, claim] of Object.entries(identities)) {
      if (claim.session_id === sessionId) {
        return {
          ...meta,
          identities: {
            ...identities,
            [letter]: {
              ...claim,
              role: "out",
              out_posted_at: postedAt,
            },
          },
        };
      }
    }
    return meta;
  };
}

// ─── messages.jsonl rotation (intra-channel archive) ────────────────
//
// An eternal channel's `messages.jsonl` grows unbounded. `rotateChannelMessages`
// seals the live file into a numbered archive (`messages.<seq>.archive.jsonl`)
// via a single atomic `renameSync`, after which the next append O_CREATs a
// fresh live file. The rename is the ONLY mutation that is zero-loss against
// the lockless O_APPEND hot path (`appendLineAtomically` opens by path per
// call): a racing append either lands in the just-sealed archive inode
// (preserved, in append-order) or O_CREATs the new live file — never dropped.
// A partial rewrite (truncate-prefix-keep-tail) would NOT be safe, because
// `withMetadataLock` guards metadata only and does not serialize appends.
//
// Archive files are siblings of `messages.jsonl` inside the channel dir
// (distinct from `archiveChannel`/`.archive/`, which moves a WHOLE channel).
// Readers opt into the archive via `readMessages(id, { includeArchive: true })`;
// the verdict-signature-chain verifier MUST opt in so the chain stays fully
// verifiable across the rotation boundary.

/** Matches a sealed message archive: `messages.<seq>.archive.jsonl`. */
const MESSAGE_ARCHIVE_RE = /^messages\.(\d+)\.archive\.jsonl$/;

/** Path of the sealed archive for sequence `seq` (sibling of messages.jsonl). */
function messageArchivePath(channelId: string, seq: number): string {
  return join(channelDir(channelId), `messages.${seq}.archive.jsonl`);
}

/** Sealed-archive sequence numbers found directly in a channel directory
 *  (unsorted). Operates on an explicit dir path so both resolveChannelsDir-
 *  based and explicit-channelsDir callers share one scan. */
function archiveSeqsInDir(channelDirPath: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(channelDirPath);
  } catch {
    return [];
  }
  const seqs: number[] = [];
  for (const name of entries) {
    const m = name.match(MESSAGE_ARCHIVE_RE);
    if (m?.[1] === undefined) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isInteger(n) && n >= 0) seqs.push(n);
  }
  return seqs;
}

/** Sequence numbers of all sealed archives for a channel (unsorted). */
function listMessageArchiveSeqs(channelId: string): number[] {
  return archiveSeqsInDir(channelDir(channelId));
}

/** Sealed-archive file paths for a channel directory, seq-ASCENDING (oldest
 *  first). `channelDirPath` is the channel's own directory
 *  (`join(channelsDir, channelId)`). Exposed so readers that scan
 *  `messages.jsonl` via a RAW path (not `readMessages`) can span the rotation
 *  archives in the same append-order the live file continues — the verdict-
 *  chain CONSTRUCTOR + the analytics / cursor / tail readers that a
 *  `readMessages`-caller audit does not surface. */
export function listChannelArchiveFilePaths(channelDirPath: string): string[] {
  return archiveSeqsInDir(channelDirPath)
    .sort((a, b) => a - b)
    .map((seq) => join(channelDirPath, `messages.${seq}.archive.jsonl`));
}

/** Parse one JSONL message file. Tolerant: a corrupt line is skipped, never
 *  thrown upward. Returns the parsed messages plus a skipped-count so callers
 *  can aggregate a single warning across multiple files. Missing file → empty. */
function parseJsonlMessages(path: string): {
  messages: ChannelMessage[];
  skipped: number;
} {
  if (!existsSync(path)) return { messages: [], skipped: 0 };
  const text = readFileSync(path, "utf-8");
  const messages: ChannelMessage[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isChannelMessage(parsed)) {
        skipped++;
        continue;
      }
      messages.push(parsed);
    } catch {
      skipped++;
    }
  }
  return { messages, skipped };
}

/** Options for {@link readMessages}. */
export type ReadMessagesOptions = {
  /** When true, also read sealed archive files (`messages.<seq>.archive.jsonl`)
   *  in ascending `seq` order BEFORE the live `messages.jsonl`. This preserves
   *  global append-order (archives hold older appends; live holds the newest)
   *  — the same order the verdict-signature chain was constructed in. Default
   *  false (live file only — bounded, the fast path for hot full-scan readers).
   *  NOTE: distinct from `listChannels`' `includeArchived` (whole-channel
   *  archive listing). */
  includeArchive?: boolean;
};

/** Read all messages in order. Skips corrupt lines with a single warning.
 *  By default reads only the live `messages.jsonl`; pass `{ includeArchive:
 *  true }` to span sealed rotation archives + live in append-order. */
export function readMessages(
  channelId: string,
  opts: ReadMessagesOptions = {},
): ChannelMessage[] {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readMessages: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  const paths: string[] = [];
  if (opts.includeArchive) {
    for (const seq of listMessageArchiveSeqs(channelId).sort((a, b) => a - b)) {
      paths.push(messageArchivePath(channelId, seq));
    }
  }
  paths.push(messagesPath(channelId)); // live file last (newest appends)

  const out: ChannelMessage[] = [];
  let skipped = 0;
  for (const path of paths) {
    const parsed = parseJsonlMessages(path);
    out.push(...parsed.messages);
    skipped += parsed.skipped;
  }
  if (skipped > 0) {
    console.error(
      `[channels] ${skipped} corrupt line(s) skipped in channel ${channelId}`,
    );
  }
  return out;
}

/** Read the most recent `limit` messages in order. Exposed for external
 *  consumers (e.g., dashboard channel-stream adapter) that need a bounded
 *  tail of a large JSONL file without loading the full transcript into
 *  caller-side memory.
 *
 *  v1 impl filters from `readMessages(channelId)` — still loads the full
 *  file into the process before slicing. For very-large channels (10K+
 *  messages or >10MB JSONL), a reverse-stream-by-bytes optimization is a
 *  follow-up that can land without changing this signature. Defer-trigger:
 *  perf observability flags channel-file read time exceeding a budget
 *  threshold. Tracking: dashboard spec §6.1 / §13 ring-buffer cap.
 *
 *  `limit <= 0` returns `[]`. `limit > total` returns all messages.
 *  Inherits `readMessages` corrupt-line tolerance + RE-3 boundary guard. */
export function readMessagesTail(
  channelId: string,
  limit: number,
): ChannelMessage[] {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readMessagesTail: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (limit <= 0) return [];
  // Live file first; if it holds fewer than `limit` (e.g., just after a
  // rotation reset it), pull sealed archives newest-first until we have
  // enough — or run out — preserving global append-order. Bounded: stops as
  // soon as `limit` is reached.
  let acc = parseJsonlMessages(messagesPath(channelId)).messages;
  if (acc.length < limit) {
    for (const seq of listMessageArchiveSeqs(channelId).sort((a, b) => b - a)) {
      const older = parseJsonlMessages(
        messageArchivePath(channelId, seq),
      ).messages;
      acc = older.concat(acc);
      if (acc.length >= limit) break;
    }
  }
  return acc.slice(-limit);
}

/** Read messages with `ts > afterTs` (strict-greater, ISO-8601 lexicographic
 *  compare). Exposed for external consumers that need to read incrementally
 *  past a last-seen timestamp without re-reading the full transcript.
 *
 *  ISO-8601 ordering is lexicographic for the `YYYY-MM-DDTHH:MM:SS.sssZ`
 *  shape conductor emits — string `>` is sufficient; no Date parse needed.
 *  Exclusive boundary mirrors the SSE `lastEmittedOffset` semantics in the
 *  dashboard spec §3.2 / §4.7 (dedup state machine).
 *
 *  v1 impl filters from `readMessages(channelId)` — same full-file caveat
 *  as `readMessagesTail`. Empty channel / no-match returns `[]`. Inherits
 *  corrupt-line tolerance + RE-3 boundary guard. */
export function readMessagesAfter(
  channelId: string,
  afterTs: string,
): ChannelMessage[] {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readMessagesAfter: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  // New messages (ts > afterTs) always land in the live file, so a near-live
  // cursor reads live only. If the live file's earliest message still
  // postdates `afterTs` (or live is empty after a rotation reset), a
  // far-behind cursor may have matching messages in a sealed archive — span
  // archives newest-first until one starts at/before `afterTs`.
  const live = parseJsonlMessages(messagesPath(channelId)).messages;
  const out = live.filter((m) => m.ts > afterTs);
  const liveEarliest = live[0]?.ts;
  if (liveEarliest === undefined || liveEarliest > afterTs) {
    for (const seq of listMessageArchiveSeqs(channelId).sort((a, b) => b - a)) {
      const older = parseJsonlMessages(
        messageArchivePath(channelId, seq),
      ).messages;
      out.unshift(...older.filter((m) => m.ts > afterTs));
      const archEarliest = older[0]?.ts;
      if (archEarliest !== undefined && archEarliest <= afterTs) break;
    }
  }
  return out;
}

/** Default rotation threshold (bytes). `rotateChannelMessages` seals the live
 *  `messages.jsonl` into a numbered archive once it reaches this size. ~4 MB is
 *  high enough that rotation does not fire during a normal cohort cycle (the
 *  live full-scan stays bounded without churn) yet bounds an eternal channel's
 *  growth. Tunable per call via {@link RotateMessagesOptions.thresholdBytes}.
 *  Anti-default: rotation never fires without a documented threshold — this
 *  constant IS that documentation. */
export const ROTATION_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** Kill-switch file DISABLING the AUTOMATIC (SessionStart gc-reaper) rotation
 *  trigger: a bare flag file in the channels root. PRESENT → no automatic
 *  rotation; ABSENT (the default) → rotate. The `rotateChannelMessages` primitive
 *  stays directly callable for tests + manual ops regardless of this flag.
 *
 *  Default-ON is the G4-flip (was opt-in `.rotation-enabled`, default-off). The
 *  default-off was deliberate live-substrate sequencing for the `tail -f` blocker
 *  — a `tail -f` Monitor follows the file by DESCRIPTOR, so a rename leaves it
 *  silently tailing the sealed archive. That precondition is now MET: PR-1
 *  (dotfiles #198) converted the last `tail -f` reader to `tail -F` (name-follow,
 *  re-opens across the rename), and every other consumer is rotation-survivable —
 *  Monitor recipes use `tail -F`, and the substrate read APIs span the archive
 *  (`readMessages{,Tail,After}` with archive-awareness). `touch .rotation-disabled`
 *  is the emergency kill-switch (inverted polarity from the old opt-in flag). */
function channelRotationDisabledFlagPath(): string {
  return join(resolveChannelsDir(), ".rotation-disabled");
}

/** True when the automatic rotation trigger is active. Default-ON: rotation runs
 *  unless the `.rotation-disabled` kill-switch flag is present. Consulted by the
 *  SessionStart gc-reaper trigger, NOT by the primitive (always callable). On a
 *  stat error we fail to `false` (skip rotation this cycle) — conservative: never
 *  rotate when the kill-switch cannot be confirmed absent. */
export function isChannelRotationAutoEnabled(): boolean {
  try {
    return !existsSync(channelRotationDisabledFlagPath());
  } catch {
    return false;
  }
}

/** Options for {@link rotateChannelMessages}. */
export type RotateMessagesOptions = {
  /** Seal the live file only when its byte size is at least this. Default
   *  {@link ROTATION_THRESHOLD_BYTES}. */
  thresholdBytes?: number;
};

/** Outcome of a {@link rotateChannelMessages} call. */
export type RotateMessagesResult =
  | { readonly kind: "skipped"; readonly reason: "below-threshold" | "absent" }
  | {
      readonly kind: "rotated";
      readonly seq: number;
      readonly archivePath: string;
      readonly archivedBytes: number;
    };

/** Seal the live `messages.jsonl` into the next sealed archive
 *  (`messages.<seq>.archive.jsonl`) via a single atomic `renameSync` when it
 *  has reached the threshold. Zero-loss against the lockless O_APPEND hot path
 *  (see the rotation note above {@link readMessages}). Serialized against
 *  concurrent rotations via `withMetadataLock`, with a re-check INSIDE the lock
 *  (TOCTOU: another session may have rotated since the pre-check).
 *
 *  Does NOT consult the auto-enable flag — that gate lives at the SessionStart
 *  trigger (channels-gc-reaper). Directly callable for tests + manual ops. */
export async function rotateChannelMessages(
  channelId: string,
  opts: RotateMessagesOptions = {},
): Promise<RotateMessagesResult> {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] rotateChannelMessages: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  const threshold = opts.thresholdBytes ?? ROTATION_THRESHOLD_BYTES;
  const path = messagesPath(channelId);
  // Cheap O(1) pre-check OUTSIDE the lock — the common case is no-op, and we
  // must not churn the metadata lock every SessionStart on every channel.
  let preSize: number;
  try {
    preSize = statSync(path).size;
  } catch {
    return { kind: "skipped", reason: "absent" };
  }
  if (preSize < threshold) {
    return { kind: "skipped", reason: "below-threshold" };
  }

  return await withMetadataLock(channelId, () => {
    // Re-check under the lock: another session may have rotated between the
    // pre-check and here (TOCTOU), shrinking the live file below threshold.
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { kind: "skipped", reason: "absent" } as RotateMessagesResult;
    }
    if (size < threshold) {
      return { kind: "skipped", reason: "below-threshold" };
    }
    // Fresh sequence (max existing + 1) computed under the lock, so dest cannot
    // pre-exist and two concurrent rotations cannot collide on a seq.
    const seq =
      listMessageArchiveSeqs(channelId).reduce((mx, n) => Math.max(mx, n), 0) +
      1;
    const dest = messageArchivePath(channelId, seq);
    // Atomic rename: a concurrent appender either lands its write in this
    // just-sealed inode (preserved, in append-order) or O_CREATs the fresh
    // live file — never dropped. The live file resets to absent until the
    // next append re-creates it.
    renameSync(path, dest);
    return { kind: "rotated", seq, archivePath: dest, archivedBytes: size };
  });
}

/** Count of complete (newline-terminated) JSONL records in the channel's
 *  messages.jsonl. Constant memory via streaming byte-level newline count.
 *
 *  Semantically equivalent to `readMessages(channelId).length` but avoids
 *  the full JSONL parse cost — useful when the caller only needs the
 *  count (e.g., dashboard Channel composite pagination math per spec §6.1).
 *  Per L991+ vault backlog "Plugin (`claude-conductor`) — lightweight
 *  `messageCount(id)` primitive in `channels/api`" (2026-05-19 batch).
 *
 *  Counts ONLY complete `\n`-terminated records — a mid-write trailing
 *  partial line (no final `\n`) is excluded. Mirrors `readMessages`
 *  semantics where the trailing empty split-element is dropped. Inherits
 *  the RE-3 boundary guard. Returns 0 for an empty or missing channel
 *  file (sibling pattern of `readMessages` which returns `[]`).
 *
 *  Implementation note: byte-level scan for `0x0A` (LF). UTF-8-correct by
 *  construction — LF (0x0A) does not appear as a continuation byte in
 *  any multi-byte UTF-8 sequence, so the count is identical to the JS-
 *  string `\n` count without requiring full file decode.
 *
 *  Archive-aware (G4 default-ON rotation): sums complete records across the
 *  live file AND every sealed `messages.<seq>.archive.jsonl`, so the count is
 *  the TOTAL channel history — not just the post-rotation live tail. Mirrors the
 *  archive-span of `readMessagesTail` / `readMessagesAfter`; pre-rotation (no
 *  archives) it is identical to the prior live-only count. */
export async function messageCount(channelId: string): Promise<number> {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] messageCount: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  // Live file + every sealed archive seq — the TOTAL across the rotated span.
  // A missing live file (the post-rotation window before the next append) still
  // counts the archives, so the total never drops at the rotation boundary.
  let total = await countCompleteLines(messagesPath(channelId));
  for (const seq of listMessageArchiveSeqs(channelId)) {
    total += await countCompleteLines(messageArchivePath(channelId, seq));
  }
  return total;
}

/** Count complete (LF-terminated) records in ONE JSONL file; 0 for a missing
 *  file. Byte-level LF scan (UTF-8-correct: 0x0A never appears as a continuation
 *  byte). `messageCount` sums this across the live file + every sealed archive. */
function countCompleteLines(path: string): Promise<number> {
  if (!existsSync(path)) return Promise.resolve(0);
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      if (typeof chunk === "string") {
        for (let i = 0; i < chunk.length; i += 1) {
          if (chunk.charCodeAt(i) === 0x0a) count += 1;
        }
        return;
      }
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 0x0a) count += 1;
      }
    });
    stream.on("end", () => resolve(count));
    stream.on("error", (err) => reject(err));
  });
}

/** Strict ChannelMessage shape validator. Exported per Phase 4 Step A Layer 1
 *  RE-1 / ARCH-4 convergent fold (2026-05-14) — `peer-message-deliverer` hook
 *  consumes this primitive instead of re-implementing a weaker `typeof === "object"`
 *  check that would let prompt-injected schema metadata (non-string `from`,
 *  non-`ChannelKind` `kind`, etc.) slip past the body-fencing surface. Substrate
 *  is the SSOT; consumers validate via this exported predicate. */
export function isChannelMessage(v: unknown): v is ChannelMessage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  // Validator pulls directly from the SSOT tuple — adding a new kind to
  // `CHANNEL_KINDS` automatically widens this acceptance set (no separate
  // edit required here).
  if (typeof o["ts"] !== "string") return false;
  if (typeof o["from"] !== "string") return false;
  if (!CHANNEL_KINDS.includes(o["kind"] as ChannelKind)) return false;
  if (o["body"] !== undefined && typeof o["body"] !== "string") return false;
  if (o["body_ref"] !== undefined && typeof o["body_ref"] !== "string")
    return false;
  if (o["body_preview"] !== undefined && typeof o["body_preview"] !== "string")
    return false;
  // Phase 1 additive optional fields: validate shape if present, ignore absence.
  if (o["identity"] !== undefined && typeof o["identity"] !== "string")
    return false;
  if (o["role"] !== undefined) {
    const role = o["role"];
    if (role !== "pen" && role !== "queue" && role !== "out") return false;
  }
  if (o["version"] !== undefined && o["version"] !== 1) return false;
  return true;
}

// ─── Heartbeat ──────────────────────────────────────────────────

/**
 * Touch the heartbeat marker for (channel, session). Signals liveness.
 *
 * Phase 2 Slice 7 schema extension: writes `Date.now()` (peer's user-space
 * wall-clock) into the file body. Pairs with `readHeartbeatBody` so peers
 * can detect clock-skew between this peer's user-space clock and the
 * filesystem-mtime stamp set by the kernel at the same write instant.
 *
 * Backwards-compat: legacy heartbeats with empty bodies still resolve via
 * mtime (`heartbeatMtime` is unchanged); body content is purely additive.
 * `writeFileSync` updates mtime as a side effect, so no separate
 * `utimesSync` is needed.
 */
export function touchHeartbeat(channelId: string, sessionId: string): void {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] touchHeartbeat: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  mkdirSync(heartbeatDir(channelId), { recursive: true });
  writeFileSync(
    heartbeatPath(channelId, sessionId),
    String(getWallClockNow()),
    "utf-8",
  );
}

/** mtimeMs of the heartbeat marker, or null if none exists.
 *  Step G dual-read: tries NEW `heartbeats/` first, falls back to LEGACY
 *  `heartbeat/` for pre-rename peers. */
export function heartbeatMtime(
  channelId: string,
  sessionId: string,
): number | null {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] heartbeatMtime: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  try {
    return statSync(heartbeatPath(channelId, sessionId)).mtimeMs;
  } catch {
    try {
      return statSync(legacyHeartbeatPath(channelId, sessionId)).mtimeMs;
    } catch {
      return null;
    }
  }
}

/**
 * Parse the heartbeat file body as the peer's `Date.now()` ms timestamp.
 *
 * Phase 2 Slice 7 reader: pairs with `touchHeartbeat`'s body-write to
 * support clock-skew detection. Returns `null` for missing/empty/corrupt
 * bodies (legacy peers, IO errors, malformed content). Strict parser —
 * only non-negative finite integer ms values are accepted.
 */
export function readHeartbeatBody(
  channelId: string,
  sessionId: string,
): number | null {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readHeartbeatBody: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(heartbeatPath(channelId, sessionId), "utf-8");
  } catch {
    // Step G dual-read fallback: try LEGACY `heartbeat/` for pre-rename peers.
    try {
      raw = readFileSync(legacyHeartbeatPath(channelId, sessionId), "utf-8");
    } catch {
      return null;
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0) return null;
  return n;
}

/** Newest heartbeat mtime across all participants. Null if no heartbeats.
 *  Step G dual-read: UNIONs NEW `heartbeats/` + LEGACY `heartbeat/` entries
 *  so pre-rename peers' heartbeats stay visible during 30-day transition. */
export function newestHeartbeatMtime(channelId: string): number | null {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] newestHeartbeatMtime: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  let newest: number | null = null;
  for (const dir of [heartbeatDir(channelId), legacyHeartbeatDir(channelId)]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      try {
        const m = statSync(join(dir, name)).mtimeMs;
        if (newest === null || m > newest) newest = m;
      } catch {
        /* skip */
      }
    }
  }
  return newest;
}

/** The cohort-bump cron's pinned sender sid (source of truth: scratch
 *  `cohort-bump.sh`). It heartbeats on the coordination channel WITHOUT owning a
 *  worktree, so worktree-liveness scans must exclude it — otherwise a (vanishing)
 *  8-hex prefix collision could let the bump's heartbeat false-protect a reap.
 *  Backtick-quoted (template literal) so check-generic-paths CGP-004 reads the
 *  UUID as an intentional documented constant, not an anonymization leak — do
 *  NOT "simplify" to a double-quoted string (that re-trips the gate). */
const COHORT_BUMP_SENTINEL_SID = `c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0`;

/**
 * True iff some session whose full sid starts with `sidPrefix` has a FRESH
 * heartbeat (mtime age `< windowMs`) on `channelId`'s heartbeat store.
 *
 * Cross-store companion to active-sessions `isSessionLiveByPrefix` (L1049
 * slice-2b). A worktree reaper holds only the 8-hex sid PREFIX (the worktree
 * path encodes the prefix, not the full sid), and cohort activity (`cli.ts
 * send`) refreshes ONLY the channel store — so a channel-active session reads
 * dead by the active-sessions gate and its worktree gets reaped. The reapers
 * OR this in to close that gap.
 *
 * Mirrors `isSessionLiveByPrefix` prefix-scan + `ageMs >= 0 && ageMs < windowMs`
 * but reads the CHANNEL store, UNIONing NEW `heartbeats/` + LEGACY `heartbeat/`
 * (same as {@link newestHeartbeatMtime}) so a pre-rename peer mid-transition is
 * not missed. First match short-circuits. Excludes the bump-cron sentinel.
 *
 * Boundary: THROWS on an invalid `channelId` (parity with `touchHeartbeat` /
 * `heartbeatMtime` / `newestHeartbeatMtime`). I/O is fail-soft — a
 * missing/unreadable dir or a per-file stat error yields not-live, never throws.
 *
 * UNSAFE as a SOLE reap-gate: fail-soft-to-`false` biases toward reap, so a
 * caller treating `false` as "dead" fails CLOSED (data loss) on a transient I/O
 * error. MUST be OR'd with an independent liveness signal. The age guard is
 * STRICTER than `isSessionLiveByPrefix` (any future mtime → not-live; it does
 * NOT route through `defensiveAgeMs`'s ≤5min skew tolerance) — safe under OR, a
 * bug if ever AND'd.
 */
export function isSidPrefixLiveOnChannel(
  sidPrefix: string,
  channelId: string,
  now: number,
  windowMs: number,
): boolean {
  // Parity with the sibling channel-store fns: an invalid channelId THROWS.
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] isSidPrefixLiveOnChannel: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (sidPrefix.length === 0) return false;
  for (const dir of [heartbeatDir(channelId), legacyHeartbeatDir(channelId)]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // missing / unreadable dir → fail-soft (not-live)
    }
    for (const name of names) {
      if (!name.startsWith(sidPrefix)) continue;
      // Defense-in-depth: the bump sentinel heartbeats without owning a
      // worktree — never let it false-protect a reap.
      if (name === COHORT_BUMP_SENTINEL_SID) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(join(dir, name)).mtimeMs;
      } catch {
        continue; // per-file stat error → skip (fail-soft)
      }
      const ageMs = now - mtimeMs;
      if (ageMs >= 0 && ageMs < windowMs) return true;
    }
  }
  return false;
}

// ─── Listing / GC ───────────────────────────────────────────────

/** Enumerate all channels.
 *
 *  Archived channels are included only when asked.
 *
 *  By default (zero-arg or `{ includeArchived }`-only), channels whose
 *  `metadata.json` cannot be read/parsed are silently skipped — preserving
 *  legacy semantics ("list must not throw").
 *
 *  Phase 3 Step C addition (RE-W2-1 closure): opting in via
 *  `{ includeUnreachable: true }` surfaces such channels as
 *  `UnreachableChannelSummary` entries in the result, so consumers (the
 *  channel GC reaper, in particular) can act on them — e.g., emit
 *  operator-actionable breadcrumbs about orphan-sentinel state that would
 *  otherwise accumulate invisibly.
 *
 *  Overload ordering note: the specific `{ includeUnreachable: true }`
 *  overload is declared FIRST for call-site resolution; the legacy overload
 *  is declared LAST so `ReturnType<typeof listChannels>` resolves to
 *  `ChannelSummary[]` and pre-existing callers using that pattern (in
 *  hooks/checks/{active-channels-load,channel-gc,channels-gc-reaper}.ts)
 *  see no inferred-type drift.
 */
export function listChannels(opts: {
  includeUnreachable: true;
  includeArchived?: boolean;
}): Array<ChannelSummary | UnreachableChannelSummary>;
export function listChannels(opts?: {
  includeArchived?: boolean;
}): ChannelSummary[];
export function listChannels(opts?: {
  includeArchived?: boolean;
  includeUnreachable?: boolean;
}): Array<ChannelSummary | UnreachableChannelSummary> {
  const root = resolveChannelsDir();
  const out: Array<ChannelSummary | UnreachableChannelSummary> = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    if (entry === ".archive") continue;
    if (entry === LATEST_BASENAME) continue; // L143 aggregate-pointer symlink — not a channel
    // Defense in depth: skip any symlink entry. The channels dir SHOULD contain
    // only the LATEST symlink today, but other future aggregate pointers (per
    // the L146 "tool wired, pathway broken" cluster) would also be symlinks
    // and must not surface as channel candidates.
    try {
      if (lstatSync(join(root, entry)).isSymbolicLink()) continue;
    } catch {
      /* lstat failed — fall through, the metadata read below will catch */
    }
    const id = entry;
    // Split try/catch (RE-1 v2.6 fold per Step C cross-audit): a failure
    // reading `metadata.json` is what defines "unreachable" — orphan
    // sentinels cannot be safely GC'd without a valid metadata anchor. A
    // failure reading `messages.jsonl` (via `lastMessageTs`) is a DIFFERENT
    // failure class (the channel's metadata is fine; just its message log
    // is unreadable) and must NOT misclassify the channel. Splitting the
    // catches keeps `UnreachableChannelSummary` semantics honest.
    let metadata: ChannelMetadata;
    try {
      metadata = readMetadata(id);
    } catch (err) {
      if (opts?.includeUnreachable) {
        out.push({
          kind: "unreachable",
          id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      /* else: skip malformed channel dirs — list must not throw */
      continue;
    }
    let lastTs: string | null;
    try {
      lastTs = lastMessageTs(id);
    } catch {
      /* messages.jsonl unreadable but metadata is fine — surface the channel
       *  with a null lastMessageTs (legacy semantics: list must not throw). */
      lastTs = null;
    }
    out.push({
      id,
      metadata,
      lastMessageTs: lastTs,
      archived: false,
    });
  }
  if (opts?.includeArchived) {
    const archive = resolveArchiveDir();
    if (existsSync(archive)) {
      for (const entry of readdirSync(archive)) {
        try {
          // Sub-step 0.10 TS-1 + TS-A6: archive branch routed through the
          // same validator as the active-channel branch via the
          // path-parameterized `readAndValidateMetadata`. Replaces the
          // unchecked `as ChannelMetadata` cast that previously trusted
          // archive metadata shape.
          const meta = readAndValidateMetadata(
            join(archive, entry, "metadata.json"),
            entry,
          );
          out.push({
            id: entry,
            metadata: meta,
            lastMessageTs: null,
            archived: true,
          });
        } catch (err) {
          if (opts?.includeUnreachable) {
            out.push({
              kind: "unreachable",
              id: entry,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          /* else: skip */
        }
      }
    }
  }
  return out;
}

function lastMessageTs(id: string): string | null {
  // readMessagesTail spans the rotation boundary (it pulls the newest archive
  // when the live file is short), so a just-rotated channel still reports its
  // true last-message ts instead of null.
  const tail = readMessagesTail(id, 1);
  return tail[0]?.ts ?? null;
}

/** Move a channel dir into .archive/. Used by channel-gc. */
export function archiveChannel(channelId: string): void {
  // RE-3 boundary guard (slice 6 / A3).
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] archiveChannel: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  // L143 — clear LATEST first so a brief window where LATEST points at a
  // half-renamed source dir doesn't surface. Concurrent appendMessage on
  // another channel can still race and re-establish LATEST → that channel
  // during the window between this clear and the renameSync below; that's
  // fine (LATEST tracks activity, not archive-state).
  clearLatestSymlinkIfPointsTo(channelId);
  const src = channelDir(channelId);
  const archive = resolveArchiveDir();
  mkdirSync(archive, { recursive: true });
  const dest = join(archive, channelId);
  if (existsSync(dest)) {
    const stamped = `${channelId}__${getWallClockNow()}`;
    renameSync(src, join(archive, stamped));
    return;
  }
  renameSync(src, dest);
}

/** Purge archive entries older than `retentionDays` and cap at `maxEntries`
 *  (oldest first). Returns the list of channel IDs purged. */
export function pruneArchive(opts: {
  retentionDays: number;
  maxEntries: number;
}): string[] {
  const archive = resolveArchiveDir();
  if (!existsSync(archive)) return [];
  const now = getWallClockNow();
  const retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;
  type ArchiveEntry = { id: string; path: string; mtimeMs: number };
  const entries: ArchiveEntry[] = [];
  for (const id of readdirSync(archive)) {
    const path = join(archive, id);
    try {
      entries.push({ id, path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      /* skip */
    }
  }
  const purged: string[] = [];
  for (const e of entries) {
    if (now - e.mtimeMs > retentionMs) {
      rmSync(e.path, { recursive: true, force: true });
      purged.push(e.id);
    }
  }
  const remaining = entries.filter((e) => !purged.includes(e.id));
  if (remaining.length > opts.maxEntries) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = remaining.length - opts.maxEntries;
    for (let i = 0; i < excess; i++) {
      const entry = remaining[i];
      if (!entry) continue;
      rmSync(entry.path, { recursive: true, force: true });
      purged.push(entry.id);
    }
  }
  return purged;
}

// ─── Last-seen cursor helpers (Phase 2 Slice 8) ──────────────────────

/** Discriminated result of `clearLastSeenCursor`. */
export type ClearLastSeenCursorResult =
  | { readonly kind: "cleared" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "error";
      readonly code: "EACCES" | "EBUSY" | "OTHER";
      readonly detail: string;
    };

/** Last-seen cursor shape: per-session, per-channel.
 *  - `mtime`: max `Date.parse(msg.ts)` across the last filtered batch
 *    (with `Number.isFinite` filter — RE-1 closure). NOT the file mtime.
 *  - `ts`: ISO 8601 form for human/debug. */
export type LastSeenCursor = {
  readonly mtime: number;
  readonly ts: string;
};

/** Read the per-session cursor for `channelId`. Returns null when absent
 *  or malformed. RE-1 closure: validates `Number.isFinite(parsed.mtime)`,
 *  not just `typeof === "number"` (NaN passes typeof check). RE-8 closure:
 *  `isValidArtifactId(channelId)` + `isValidSessionId(sessionId)` boundary
 *  checks. RE-13 closure: try/catch around readFileSync handles ENOENT
 *  during read (race with concurrent prune unlinking the file). */
export function readLastSeenCursor(
  channelId: string,
  sessionId: string,
): LastSeenCursor | null {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] readLastSeenCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] readLastSeenCursor: invalid sessionId "${sessionId}"`,
    );
  }
  // Step G dual-read: try NEW `last-seen-cursors/` first, fall back to LEGACY
  // `last-seen/` so pre-rename peers' cursors remain readable during the
  // 30-day transition window.
  let raw: string;
  try {
    raw = readFileSync(lastSeenCursorPath(channelId, sessionId), "utf-8");
  } catch {
    try {
      raw = readFileSync(
        legacyLastSeenCursorPath(channelId, sessionId),
        "utf-8",
      );
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as LastSeenCursor;
    if (!Number.isFinite(c.mtime)) return null;
    if (typeof c.ts !== "string") return null;
    return { mtime: c.mtime, ts: c.ts };
  } catch {
    return null;
  }
}

/** Write the per-session cursor for `channelId`. Atomic via tmp+rename
 *  (RE-5 closure): `writeFileSync(tmpPath, ..., { flag: "wx" })` then
 *  `renameSync(tmpPath, finalPath)`. Concurrent writers race on rename;
 *  one wins, file always valid. RE-1 closure: rejects non-finite mtime.
 *  RE-8 closure: boundary checks. RE-12 closure: tmpPath includes
 *  `${pid}.${random}` suffix to avoid EEXIST collision on stale orphan. */
export function writeLastSeenCursor(
  channelId: string,
  sessionId: string,
  mtime: number,
  ts: string,
): void {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] writeLastSeenCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] writeLastSeenCursor: invalid sessionId "${sessionId}"`,
    );
  }
  if (!Number.isFinite(mtime)) {
    throw new Error(
      `[channels] writeLastSeenCursor: mtime must be finite, got ${mtime}`,
    );
  }
  const dir = lastSeenDir(channelId);
  mkdirSync(dir, { recursive: true });
  const finalPath = lastSeenCursorPath(channelId, sessionId);
  const tmpSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = `${finalPath}.${tmpSuffix}.tmp`;
  const cursor: LastSeenCursor = { mtime, ts };
  writeFileSync(tmpPath, `${JSON.stringify(cursor)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* tmp already gone; ignore */
    }
    throw err;
  }
}

/** Clear the per-session cursor for `channelId`. Idempotent — returns
 *  `{kind: "absent"}` on ENOENT (RE-10 closure: discriminated result for
 *  EACCES/EBUSY too). RE-8 closure: boundary checks. */
export function clearLastSeenCursor(
  channelId: string,
  sessionId: string,
): ClearLastSeenCursorResult {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] clearLastSeenCursor: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] clearLastSeenCursor: invalid sessionId "${sessionId}"`,
    );
  }
  // Step G dual-clear: unlink BOTH NEW + LEGACY paths so the cursor is fully
  // cleared regardless of which path the writer used. Return "cleared" if
  // EITHER unlink succeeds; "absent" only if both ENOENT.
  let anyCleared = false;
  let firstError: { code: string; detail: string } | null = null;
  for (const path of [
    lastSeenCursorPath(channelId, sessionId),
    legacyLastSeenCursorPath(channelId, sessionId),
  ]) {
    try {
      unlinkSync(path);
      anyCleared = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") continue;
      const detail = err instanceof Error ? err.message : String(err);
      if (firstError === null) {
        firstError = {
          code: code === "EACCES" || code === "EBUSY" ? code : "OTHER",
          detail,
        };
      }
    }
  }
  if (anyCleared) return { kind: "cleared" };
  if (firstError !== null) {
    return {
      kind: "error",
      code: firstError.code as "EACCES" | "EBUSY" | "OTHER",
      detail: firstError.detail,
    };
  }
  return { kind: "absent" };
}

/** True iff the channel exists in the archive directory (per-channel
 *  archive dir at `<archiveDir>/<channelId>/`). Used by Slice 8's
 *  `forget-cursor` + `show-cursor` verbs to short-circuit on archived
 *  channels (CLI-11 closure). */
export function isChannelArchived(channelId: string): boolean {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] isChannelArchived: invalid channelId "${channelId}"`,
    );
  }
  return existsSync(archivedChannelDir(channelId));
}

/** Path to the per-channel `last-seen-cursors/` subdirectory (renamed in
 *  Step G from `last-seen/`). Exported so the Slice 4 GC reaper can scan +
 *  prune stale cursors (RE-W0-5). Reaper should ALSO consult
 *  `resolveLegacyLastSeenDir` for legacy-named entries during the 30-day
 *  dual-read transition window. */
export function resolveLastSeenDir(channelId: string): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveLastSeenDir: invalid channelId "${channelId}"`,
    );
  }
  return lastSeenDir(channelId);
}

/** Step G dual-read: path to the LEGACY per-channel `last-seen/`
 *  subdirectory. Exported so the GC reaper can enumerate + prune stale
 *  cursors written by pre-rename peers. Reaper unlinks stale entries from
 *  BOTH new + legacy dirs during the dual-read transition window. */
export function resolveLegacyLastSeenDir(channelId: string): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveLegacyLastSeenDir: invalid channelId "${channelId}"`,
    );
  }
  return legacyLastSeenDir(channelId);
}

/** Path to the per-channel `heartbeats/` subdirectory. Exported so the GC
 *  reaper can scan + prune stale heartbeat marker files (channelHB-GC / M3:
 *  the channel heartbeat store was never GC'd → unbounded growth → an
 *  ever-slower isSidPrefixLiveOnChannel scan on the reaper/boot hot path).
 *  Reaper should ALSO consult `resolveLegacyHeartbeatDir` for legacy-named
 *  entries during the dual-read transition window. */
export function resolveHeartbeatDir(channelId: string): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveHeartbeatDir: invalid channelId "${channelId}"`,
    );
  }
  return heartbeatDir(channelId);
}

/** Dual-read: path to the LEGACY per-channel `heartbeat/` subdirectory.
 *  Exported so the GC reaper can enumerate + prune stale heartbeats written
 *  by pre-rename peers (unlinks from BOTH new + legacy dirs). */
export function resolveLegacyHeartbeatDir(channelId: string): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveLegacyHeartbeatDir: invalid channelId "${channelId}"`,
    );
  }
  return legacyHeartbeatDir(channelId);
}

/** Path to a specific session's last-seen cursor file. Exported for the
 *  Slice 4 GC reaper's per-cursor unlink path. */
export function resolveLastSeenCursorPath(
  channelId: string,
  sessionId: string,
): string {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels] resolveLastSeenCursorPath: invalid channelId "${channelId}"`,
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `[channels] resolveLastSeenCursorPath: invalid sessionId "${sessionId}"`,
    );
  }
  return lastSeenCursorPath(channelId, sessionId);
}
