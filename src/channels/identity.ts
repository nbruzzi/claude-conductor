// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * NATO identity pool + role primitive for the Phase 1 convention layer.
 *
 * Phase 1 ships per-channel identity assignment so two coordinating sessions
 * (Alpha + Bravo) get distinct, race-free letters that survive across
 * `/handoff-resume parallel` cycles. The pool is the 26 NATO letters; the
 * registry lives in `metadata.identities` of each channel; the atomic claim
 * primitive (Slice 2) mirrors `active-sessions/index.ts:writeMetaIfMissing`
 * via `linkSync`-on-tmp for true POSIX EEXIST semantics.
 *
 * This file ships the constants + validators in Slice 1 (zero-behavior
 * groundwork). Slice 2 will add the actual `claimIdentity`, `setRole`,
 * `getIdentityForSession`, and `releaseIdentity` primitives.
 *
 * Sibling-parity reference: `src/active-sessions/index.ts:247-255`
 * (`isValidArtifactId`) — Phase 1's `isValidIdentity` mirrors the
 * boundary-validation pattern.
 *
 * Plan: ~/.claude/plans/generic-floating-hanrahan.md (Phase 1 v2 Slice 1).
 */

/** The 26 NATO phonetic letters in alphabetical order. Per parent plan
 *  §159, identities are NEVER recycled within a channel — once Alpha is
 *  claimed and released, the next claimant gets the lowest unused letter
 *  (Bravo, Charlie, …) until exhaustion at 27. */
export const NATO_POOL = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliet",
  "Kilo",
  "Lima",
  "Mike",
  "November",
  "Oscar",
  "Papa",
  "Quebec",
  "Romeo",
  "Sierra",
  "Tango",
  "Uniform",
  "Victor",
  "Whiskey",
  "X-ray",
  "Yankee",
  "Zulu",
] as const satisfies readonly string[];

/** A NATO identity letter as a literal-union string type. */
export type NatoIdentity = (typeof NATO_POOL)[number];

/** Set form of `NATO_POOL` for O(1) membership checks. */
const NATO_SET: ReadonlySet<string> = new Set(NATO_POOL);

/**
 * Validates that `s` is a NATO identity letter. Mirrors the boundary-
 * validation pattern from `active-sessions/index.ts:247-255`'s
 * `isValidArtifactId`. Phase 1 enforces this at module API boundaries
 * (`claimIdentity`, `setRole`, `getIdentityForSession`, `releaseIdentity`)
 * to prevent path-traversal-class hazards from external CLI input.
 */
export function isValidIdentity(s: unknown): s is NatoIdentity {
  return typeof s === "string" && NATO_SET.has(s);
}

// ─── claimIdentity primitive ────────────────────────────────────

import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isValidArtifactId } from "../active-sessions/index.ts";
import { appendPresenceFailure } from "../shared/presence-failure-log.ts";
import { channelsDir } from "../shared/paths.ts";
import {
  appendMessage,
  claimNamedIdentityWithLock,
  commitIdentityClaim,
  readMetadata,
  removeIdentityClaim,
  setIdentityRole,
  type ChannelMessage,
  type ChannelRole,
  type IdentityClaim,
} from "./index.ts";
import { validateIdentityClaim } from "./claim.ts";

/**
 * Thrown when all 26 NATO letters are claimed and the channel is full.
 * Per parent plan §287, the recovery hint points at the `close-peer` verb
 * (implemented in Slice 5) for manual remediation.
 */
export class NatoExhaustedError extends Error {
  constructor(channelId: string) {
    super(
      `[channels-identity] channel '${channelId}' has assigned all 26 NATO ` +
        `identities. Recovery: close idle peers via 'claude-conductor channels ` +
        `close-peer ${channelId} --peer <Identity>' (add --force to override active heartbeat).`,
    );
    this.name = "NatoExhaustedError";
  }
}

/** Per-channel directory holding per-identity sentinel files. The
 *  sentinel is the atomic create-only marker (linkSync EEXIST primitive);
 *  metadata.identities is the materialized cache.
 *
 *  Exported per Phase 2 Slice 4 — the channels-gc-reaper hook iterates
 *  this directory to detect orphan sentinels (sentinel exists with no
 *  matching `metadata.identities[L]` entry). Pure path-construction
 *  function with no side effects; safe to expose. */
export function identitiesDir(channelId: string): string {
  return join(channelsDir(), channelId, "identities");
}

/** Per-letter sentinel file path within `identitiesDir(channelId)`.
 *  Exported per Phase 2 Slice 4 alongside `identitiesDir` so the reaper
 *  can compose the path for race-detection breadcrumb writes
 *  (`linkSync(reaperTmp, identitySentinelPath(...))`). */
export function identitySentinelPath(
  channelId: string,
  letter: NatoIdentity,
): string {
  return join(identitiesDir(channelId), letter);
}

/**
 * Atomically claim a NATO identity letter for `sessionId` on `channelId`.
 * Race-free via `linkSync(tmp, sentinel)` create-only POSIX EEXIST
 * primitive — sibling pattern of `active-sessions/index.ts:writeMetaIfMissing`
 * (lines 335-360). Per Wave 0 RE-CRIT-3 + ARCH-CRIT-3, the prior plan's
 * "withMetadataLock + writeMetadataRaw is linkSync-equivalent" claim was
 * false (renameSync unconditionally clobbers under stale-lock-steal); the
 * per-letter sentinel + linkSync gives true mutual exclusion regardless
 * of the channels metadata lock state.
 *
 * Idempotent rejoin: if a sentinel exists for `sessionId`, returns the
 * existing claim without reassignment.
 *
 * Throws `NatoExhaustedError` after all 26 letters are claimed.
 *
 * Plan: ~/.claude/plans/generic-floating-hanrahan.md (Phase 1 v2 Slice 2).
 */
export async function claimIdentity(args: {
  channelId: string;
  sessionId: string;
  defaultRole?: ChannelRole;
}): Promise<
  IdentityClaim & { identity: NatoIdentity; is_new_participant: boolean }
> {
  const { channelId, sessionId } = args;
  const defaultRole: ChannelRole = args.defaultRole ?? "queue";

  // Defense-in-depth boundary validation per Wave 1 RE-W1-2. claimIdentity
  // is exported via `./channels/identity` for direct Phase 2 hook consumers
  // (Decision Q4); an attacker-controlled `channelId="../etc"` would
  // otherwise escape the channels root via the `identitiesDir` join.
  // Mirrors the active-sessions:isValidArtifactId boundary discipline.
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels-identity] invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("[channels-identity] sessionId must be a non-empty string");
  }

  const dir = identitiesDir(channelId);
  mkdirSync(dir, { recursive: true });

  // Idempotent rejoin: scan sentinels for an existing claim by this session.
  // Reconcile the materialized cache before returning — handles the
  // sentinel/metadata torn-write window (Slice 2.2 verification round
  // RE-NEW-1). If a prior claimIdentity died after linkSync but before
  // commitIdentityClaim, the sentinel exists but metadata.identities
  // doesn't. Best-effort idempotent re-commit closes the gap before
  // Slice 5 verbs read the materialized cache.
  const existing = findExistingClaim(channelId, sessionId);
  if (existing !== null) {
    try {
      await commitIdentityClaim({
        channelId,
        identity: existing.identity,
        claim: existing.claim,
      });
    } catch (err: unknown) {
      // Reconcile is best-effort; log but don't block the rejoin path.
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: "channels-identity",
        kind: "write-failed",
        sessionId,
        artifactPath: identitySentinelPath(channelId, existing.identity),
        detail: `reconcile-on-rejoin commitIdentityClaim failed: ${(err as Error).message}`,
      });
    }
    return {
      identity: existing.identity,
      session_id: sessionId,
      role: existing.claim.role,
      joined_at: existing.claim.joined_at,
      is_new_participant: false,
    };
  }

  // Try each letter in NATO order. linkSync is the atomic decision point.
  const joinedAt = new Date().toISOString();
  const claim: IdentityClaim = {
    session_id: sessionId,
    role: defaultRole,
    joined_at: joinedAt,
  };
  const tmpPath = join(
    dir,
    `.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
  );
  // wx flag (O_CREAT|O_EXCL) per Wave 1 RE-W1-4 — sibling pattern of
  // active-sessions/index.ts:writeMetaIfMissing. EEXIST on tmp collision
  // is near-zero in practice (pid+timestamp+random) but the stronger
  // primitive matches review-proven correctness.
  writeFileSync(tmpPath, `${JSON.stringify(claim)}\n`, {
    flag: "wx",
    mode: 0o600,
  });

  try {
    for (const letter of NATO_POOL) {
      const sentinel = identitySentinelPath(channelId, letter);
      try {
        linkSync(tmpPath, sentinel);
        // Won the race for this letter. Now commit-after-claim per plan
        // §122: write the materialized cache to metadata.identities so
        // downstream verbs (whoami, set-role, peers, read render) can
        // observe the claim. Sentinel = canonical; metadata = cache.
        // Wave 1 ARCH-1 fix.
        await commitIdentityClaim({
          channelId,
          identity: letter,
          claim,
        });
        return {
          identity: letter,
          session_id: sessionId,
          role: defaultRole,
          joined_at: joinedAt,
          is_new_participant: true,
        };
      } catch (err: unknown) {
        // EEXIST = another session owns this letter; try next.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === "EEXIST") continue;
        // Non-EEXIST errors are write failures.
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          source: "channels-identity",
          kind: "write-failed",
          sessionId,
          artifactPath: sentinel,
          detail: `linkSync failed: ${(err as Error).message}`,
        });
        throw err;
      }
    }
    // All 26 letters taken.
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "registry-contention",
      sessionId,
      artifactPath: dir,
      detail: `NATO pool exhausted (26/26 claimed)`,
    });
    throw new NatoExhaustedError(channelId);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp already gone (linkSync may have moved it); ignore.
    }
  }
}

// ─── IdentityNotHeldError ──────────────────────────────────────────

/**
 * Thrown when `set-role` is called for an identity that is not claimed
 * on the channel. Per Slice 5 RE-6, `set-role` MUST NOT silently no-op
 * on an absent identity — that would let an operator run `set-role`
 * against a dropped peer and assume the role change took effect. The
 * CLI verb maps this error to exit 5 with `"identity '<x>' not held"`
 * on stderr.
 */
export class IdentityNotHeldError extends Error {
  constructor(channelId: string, identity: string) {
    super(
      `[channels-identity] channel '${channelId}' identity '${identity}' is not held — no metadata change applied`,
    );
    this.name = "IdentityNotHeldError";
  }
}

// ─── getIdentityForSession ─────────────────────────────────────────

/**
 * Return the NATO identity claim held by `sessionId` on `channelId`, or
 * `null` if the session has no claim. Used by the `whoami` verb (Slice
 * 5) and as a building block for peer discovery.
 *
 * Defensive against legacy channels (no `identities` field) and against
 * partial reconciliation states (a metadata key that isn't a valid NATO
 * letter — `validateChannelMetadata` already enforces shape, but the
 * defensive filter here keeps the failure mode obvious if validation is
 * ever bypassed).
 *
 * Async API for consistency with `claimIdentity` / `setRole` /
 * `releaseIdentity`; the underlying read is synchronous.
 */
export async function getIdentityForSession(
  channelId: string,
  sessionId: string,
): Promise<{
  identity: NatoIdentity;
  role: ChannelRole;
  joined_at: string;
} | null> {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels-identity] getIdentityForSession: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(
      "[channels-identity] getIdentityForSession: sessionId must be a non-empty string",
    );
  }
  const meta = readMetadata(channelId);
  if (meta.identities === undefined) return null;
  for (const [letter, claim] of Object.entries(meta.identities)) {
    if (!isValidIdentity(letter)) continue;
    if (claim.session_id !== sessionId) continue;
    return {
      identity: letter,
      role: claim.role,
      joined_at: claim.joined_at,
    };
  }
  return null;
}

// ─── setRole ───────────────────────────────────────────────────────

/**
 * Atomically update the role of a held identity. Wraps `setIdentityRole`
 * from index.ts, mapping the `not-held` discriminated case to
 * `IdentityNotHeldError` per Slice 5 RE-6 (no silent no-op on absence).
 */
export async function setRole(
  channelId: string,
  identity: NatoIdentity,
  role: ChannelRole,
): Promise<void> {
  // channelId is gated downstream by setIdentityRole's isValidArtifactId
  // check; identity + role gates here block invalid input before
  // reaching the lock.
  if (!isValidIdentity(identity)) {
    throw new Error(
      `[channels-identity] setRole: invalid identity "${identity}" — must be a NATO letter`,
    );
  }
  if (role !== "pen" && role !== "queue" && role !== "out") {
    throw new Error(
      `[channels-identity] setRole: invalid role "${role}" — must be one of pen|queue|out`,
    );
  }
  const result = await setIdentityRole({ channelId, identity, role });
  if (result.kind === "not-held") {
    throw new IdentityNotHeldError(channelId, identity);
  }
}

// ─── releaseIdentity ───────────────────────────────────────────────

/**
 * Release a NATO identity claim — remove the materialized metadata entry
 * AND unlink the per-letter sentinel. RE-6 ordering:
 *
 *   1. `removeIdentityClaim` first (atomic metadata write under
 *      `withMetadataLock`).
 *   2. On metadata-write failure → propagate the error WITHOUT unlinking
 *      the sentinel. The sentinel remains as canonical evidence of the
 *      claim; the caller surfaces the error.
 *   3. On metadata-write success → unlink the sentinel via
 *      `INTERNAL.unlinkSentinel`. Idempotent on ENOENT (sentinel already
 *      gone). On any non-ENOENT unlink failure → log a warning via
 *      `appendPresenceFailure` and continue. The metadata removal already
 *      succeeded, so the orphan sentinel is reconcilable on the NEXT
 *      `claimIdentity` for this letter via the reconcile-on-rejoin path
 *      (Slice 2.2 Decision D).
 *
 * **Why metadata-first:** the failure mode being prevented is "phantom
 * metadata entry with no sentinel" — Slice 5 verbs (`whoami`, `peers`,
 * `send` with role gate) read `metadata.identities` and would mistakenly
 * trust an entry whose sentinel is gone. Conversely, "orphan sentinel
 * without metadata" is benign: the next `claimIdentity` reconciles via
 * `findExistingClaim`'s best-effort `commitIdentityClaim` (Slice 2.2).
 *
 * Idempotent on absence: releasing an already-absent identity is a no-op
 * (no error). Matches the expected close-peer flow where a peer may have
 * already self-released between the operator's intent and the verb call.
 */
export async function releaseIdentity(
  channelId: string,
  identity: NatoIdentity,
): Promise<void> {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels-identity] releaseIdentity: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (!isValidIdentity(identity)) {
    throw new Error(
      `[channels-identity] releaseIdentity: invalid identity "${identity}" — must be a NATO letter`,
    );
  }

  const removed = await removeIdentityClaim({ channelId, identity });
  if (removed === null) {
    // Idempotent: nothing to release. If a sentinel exists without
    // metadata (pre-Phase-1 channel or a torn-write orphan), the next
    // `claimIdentity` reconciliation handles it.
    return;
  }
  unlinkIdentitySentinelOrLogOrphan(channelId, identity, removed);
}

/**
 * Step 2 of the metadata-first release ordering — unlink the per-letter
 * sentinel after a successful metadata removal. Idempotent on ENOENT;
 * logs an orphan-sentinel warning via `appendPresenceFailure` on any
 * other failure (EACCES, EPERM, EBUSY, etc.) without re-throwing. The
 * orphan is reconcilable on the next `claimIdentity` for this letter
 * via the reconcile-on-rejoin path (Slice 2.2 Decision D).
 *
 * Exported so `close-peer` (CLI verb invoking `closeStalePeerIdentity`)
 * can reuse the same orphan-handling discipline without duplicating the
 * try/catch.
 */
/**
 * Discriminated result of `unlinkIdentitySentinelOrLogOrphan`. Phase 2
 * Slice 3 closure (RE-W2-4) — replaces the prior `void` return so callers
 * (notably `close-peer` CLI verb) can surface orphan-sentinel state in
 * structured output without re-doing the unlink.
 *
 * `ok: true` → sentinel was successfully unlinked.
 * `ok: false, code: "ENOENT"` → sentinel was already absent at unlink time
 *   (race with concurrent reconciler or pre-released sentinel). NOT a true
 *   orphan; metadata is consistent.
 * `ok: false, code: "EACCES" | "EBUSY"` → unlink rejected by the OS for a
 *   specific reason. Sentinel persists as a TRUE orphan, recoverable on
 *   next `claimIdentity` reconcile-on-rejoin (Slice 2.2 Decision D).
 * `ok: false, code: "OTHER"` → unlink failed for an unrecognized reason
 *   (errno not in the typed set). `detail` carries the original message.
 *
 * Per plan prismatic-orbiting-mesh §Slice 3.
 */
export type UnlinkResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "EACCES" | "EBUSY" | "ENOENT" | "OTHER";
      readonly detail: string;
    };

export function unlinkIdentitySentinelOrLogOrphan(
  channelId: string,
  identity: NatoIdentity,
  releasedClaim: IdentityClaim,
  opts: { readonly suppressLog?: boolean } = {},
): UnlinkResult {
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels-identity] unlinkIdentitySentinelOrLogOrphan: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (!isValidIdentity(identity)) {
    throw new Error(
      `[channels-identity] unlinkIdentitySentinelOrLogOrphan: invalid identity "${identity}" — must be a NATO letter`,
    );
  }
  const sentinel = identitySentinelPath(channelId, identity);
  try {
    INTERNAL.unlinkSentinel(sentinel);
    return { ok: true };
  } catch (err: unknown) {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    const detail = err instanceof Error ? err.message : String(err);
    if (errno === "ENOENT") {
      // Already gone — metadata was the canonical mutation. Surface
      // discriminated for callers that want to distinguish "race-cleared"
      // from a true orphan; do NOT log to presence-failure-log because
      // ENOENT is the expected race outcome.
      return { ok: false, code: "ENOENT", detail };
    }
    // True orphan: metadata removal already succeeded so the released
    // identity won't be visible to Slice 5 verbs, but the sentinel
    // persists. Reconcilable on next claim via Slice 2.2 Decision D.
    // Log for operator visibility (presence-failure-log is the
    // breadcrumb channel); do NOT throw — propagation would obscure
    // the successful metadata removal.
    //
    // Wave 2 RE-W2-3 closure: callers that wrap this primitive with
    // their own appendPresenceFailure (e.g. channels-gc-reaper's
    // `handleUnlinkFailure`) pass `suppressLog: true` to avoid the
    // duplicate-breadcrumb pattern (~2,016 dupes per stuck orphan over
    // 7-day suppression marker TTL). Default behavior preserves the
    // logging discipline for direct callers (releaseIdentityClaim,
    // close-peer CLI verb).
    if (!opts.suppressLog) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: "channels-identity",
        kind: "write-failed",
        sessionId: releasedClaim.session_id,
        artifactPath: sentinel,
        detail: `orphan sentinel after metadata-release (reconcile on next claim): ${detail}`,
      });
    }
    if (errno === "EACCES" || errno === "EBUSY") {
      return { ok: false, code: errno, detail };
    }
    return { ok: false, code: "OTHER", detail };
  }
}

// ─── INTERNAL test-only mockable layer ─────────────────────────────

/**
 * Test-only mockable layer for filesystem operations whose failure modes
 * Slice 5 ordering tests need to inject. Mirrors the
 * `session-id-discovery.ts` `INTERNAL` pattern — production code paths
 * funnel through these wrappers; tests reassign properties to verify the
 * surrounding control flow.
 *
 * Usage:
 *   const original = INTERNAL.unlinkSentinel;
 *   INTERNAL.unlinkSentinel = () => { throw Object.assign(new Error(), {code: "EACCES"}); };
 *   try { await releaseIdentity(...); } finally { INTERNAL.unlinkSentinel = original; }
 */
export const INTERNAL = {
  /** Wraps `unlinkSync` for the sentinel-unlink step in
   *  `releaseIdentity`. Tests inject failures here to exercise the
   *  metadata-first ordering guarantee (Slice 5 RE-6). */
  unlinkSentinel: (path: string): void => {
    unlinkSync(path);
  },
};

/**
 * Scan the identities/ directory for an existing claim by `sessionId`.
 * Returns the {identity, claim} pair on first match, or null. Used for
 * idempotent rejoin in `claimIdentity`.
 *
 * Delegates the 4-step shape-validation (JSON.parse → non-null object →
 * `string`-typed `session_id`/`role`/`joined_at`) to
 * {@link validateIdentityClaim} in `./claim.ts` (Phase 3 Step D2 close-out
 * per Decision A ARCH-2 + Charlie's pre-flight scout M.0 disposition). The
 * role-enum narrowing (`"pen" | "queue" | "out"`) and the `sessionId`
 * filter stay at this call site — `validateIdentityClaim` intentionally
 * treats `role` as opaque-string (see `test/channels/claim.test.ts` test 9
 * pinning the contract). Behavior contract: byte-for-byte equivalent to
 * the pre-D2 inline 4-step check + 2 additional narrows; same
 * skip-vs-match outcome for every observable sentinel-file shape.
 */
function findExistingClaim(
  channelId: string,
  sessionId: string,
): { identity: NatoIdentity; claim: IdentityClaim } | null {
  const dir = identitiesDir(channelId);
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!isValidIdentity(entry)) continue;
    const path = identitySentinelPath(channelId, entry);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const claim = validateIdentityClaim(raw);
    if (claim === null || claim.session_id !== sessionId) continue;
    // `validateIdentityClaim` treats `role` as opaque-string per
    // `test/channels/claim.test.ts` test 9 — the runtime value may
    // legitimately be outside `ChannelRole`'s compile-time union. Widen to
    // `string` so the inequality chain isn't TS-narrowed to `never` (the
    // narrow stays runtime-live; lint will not flag as unreachable).
    const roleRuntime: string = claim.role;
    if (
      roleRuntime !== "pen" &&
      roleRuntime !== "queue" &&
      roleRuntime !== "out"
    ) {
      continue;
    }
    return { identity: entry, claim };
  }
  return null;
}

// ─── claimIdentityNamed primitive (P2 — `--as <Identity>` flag) ────

/**
 * Thrown when `claimIdentityNamed` refuses a takeover because the named
 * identity is held by a different session and `--force` was not passed.
 * Per plan giggly-bouncing-spark.md Decision §10 (RE-7 closure): the error
 * message frames operator intent as "I want to BE this identity" and points
 * at both `--force` and `close-peer` recovery paths. CLI verb maps to exit
 * code 6, mirroring `close-peer`'s STILL_ACTIVE shape (`cli.ts:1029`).
 */
export class IdentityActiveError extends Error {
  readonly channelId: string;
  readonly identity: NatoIdentity;
  readonly holderSessionId: string;
  readonly ageMs: number | null;
  constructor(
    channelId: string,
    identity: NatoIdentity,
    holderSessionId: string,
    ageMs: number | null,
  ) {
    const ageStr =
      ageMs === null ? "(unknown)" : `${Math.round(ageMs / 1000)}s`;
    super(
      `[join] identity '${identity}' is held by session ${holderSessionId} (heartbeat age ${ageStr}). ` +
        `Pass --force to take over the active claim, or run 'close-peer ${channelId} --peer ${identity} --force' first.`,
    );
    this.name = "IdentityActiveError";
    this.channelId = channelId;
    this.identity = identity;
    this.holderSessionId = holderSessionId;
    this.ageMs = ageMs;
  }
}

/**
 * Thrown when `claimIdentityNamed` is called by a session that already
 * holds a DIFFERENT NATO letter on the same channel. Per Decision §11(b):
 * silent atomic-move would obscure the operator's prior claim; reject and
 * point at the deferred `release-self` verb so the operator's intent is
 * explicit. Same-letter rejoin (per §11(a)) is idempotent and does NOT
 * throw.
 */
export class IdentityAlreadyHeldBySelfError extends Error {
  readonly channelId: string;
  readonly currentIdentity: NatoIdentity;
  readonly requestedIdentity: NatoIdentity;
  constructor(
    channelId: string,
    currentIdentity: NatoIdentity,
    requestedIdentity: NatoIdentity,
  ) {
    super(
      `[join] this session already holds identity '${currentIdentity}' on channel '${channelId}'; ` +
        `cannot claim '${requestedIdentity}' without releasing first. ` +
        `(release-self verb is a backlog ride-along; for now, run 'close-peer ${channelId} --peer ${currentIdentity} --force' from a peer session OR re-spawn.)`,
    );
    this.name = "IdentityAlreadyHeldBySelfError";
    this.channelId = channelId;
    this.currentIdentity = currentIdentity;
    this.requestedIdentity = requestedIdentity;
  }
}

/**
 * Thrown when `claimIdentityNamed --force --from-session <uuid>` fails the
 * CAS check — the named identity's holder session_id does not match the
 * passed `--from-session` value. Per Decision §9: optional CAS gate
 * mitigates the ping-pong-takeover hazard for paranoid invocations by
 * requiring the operator to name whose claim they expect to displace.
 */
export class IdentityCasMismatchError extends Error {
  readonly channelId: string;
  readonly identity: NatoIdentity;
  readonly expected: string;
  readonly actual: string | null;
  constructor(
    channelId: string,
    identity: NatoIdentity,
    expected: string,
    actual: string | null,
  ) {
    super(
      `[join] --from-session CAS check failed for identity '${identity}' on channel '${channelId}': ` +
        `expected holder session '${expected}', got '${actual ?? "(none)"}'. ` +
        `Re-run 'meta ${channelId}' to inspect the current holder, or drop --from-session for unconditional --force takeover.`,
    );
    this.name = "IdentityCasMismatchError";
    this.channelId = channelId;
    this.identity = identity;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Atomically claim a NAMED NATO identity letter for `sessionId` on
 * `channelId` — the P2 sibling of `claimIdentity` for `join --as <Identity>`
 * semantics per plan giggly-bouncing-spark.md.
 *
 * **Three-phase claim** (Decision §3, post Bravo LB2-MAJ-1):
 *
 *   - **(P0) Same-session pre-check.** `findExistingClaim(sessionId)` first.
 *     - Same-letter (existing.identity === args.identity) → idempotent
 *       rejoin: best-effort `commitIdentityClaim` reconciliation (mirrors
 *       `claimIdentity:191-208`) + return existing claim. NOT a takeover.
 *     - Different-letter (existing.identity !== args.identity) → throw
 *       `IdentityAlreadyHeldBySelfError` per §11(b).
 *     - No existing claim → fall through to P1.
 *
 *   - **(P1) Pre-lock atomic-create.** `linkSync(tmpPath, sentinelPath)` —
 *     POSIX EEXIST primitive. On success: enter `withMetadataLock`,
 *     `commitIdentityClaim` to materialize metadata, return new claim. NO
 *     audit-trail message in this path (it's a fresh claim, not a takeover).
 *
 *   - **(P2) On EEXIST → takeover branch.** Delegate to
 *     `claimNamedIdentityWithLock` (sibling of `closeStalePeerIdentity`)
 *     which performs heartbeat snapshot + CAS check + force gate + atomic
 *     `renameSync(tmpPath, sentinelPath)` overwrite-replace + metadata
 *     commit, all under one `withMetadataLock` cycle. Translate the
 *     discriminated result to the appropriate error class:
 *     - `cas-mismatch` → throw `IdentityCasMismatchError`
 *     - `active` → throw `IdentityActiveError`
 *     - `claimed` → continue to post-lock audit-trail + return.
 *
 * **Post-lock audit-trail** (Decision §3 RE-3 closure): on a successful
 * takeover, post a `status` channel message documenting the
 * `claimer ↔ displaced` transition. Best-effort — on `appendMessage`
 * failure, write `appendPresenceFailure({kind: "takeover-audit-failed",
 * source: "channels-identity"})` so the forensic gap is observable to
 * operators via the session-active registry rather than silent.
 *
 * **Lock-domain note** (per RE-1 / Bravo MAJ-1 cross-audit): see
 * `claimNamedIdentityWithLock` in `index.ts` for the metadata-vs-sentinel
 * lock-domain boundary documentation. The renameSync inside the metadata
 * lock bounds the racing window with concurrent metadata mutators; residual
 * race with vanilla `claimIdentity:240-259`'s pre-lock linkSync is bounded
 * to operator-only `--force` + concurrent vanilla join (acceptable defer).
 *
 * Returns same shape as `claimIdentity` PLUS optional
 * `takeover_displaced_session_id` field set on takeover paths so callers
 * can render forensic info.
 *
 * Plan: ~/.claude/plans/giggly-bouncing-spark.md (P2 — Plan v1.3 final).
 */
export async function claimIdentityNamed(args: {
  channelId: string;
  sessionId: string;
  identity: NatoIdentity;
  defaultRole?: ChannelRole;
  force?: boolean;
  fromSession?: string;
}): Promise<
  IdentityClaim & {
    identity: NatoIdentity;
    is_new_participant: boolean;
    takeover_displaced_session_id?: string | null;
  }
> {
  const { channelId, sessionId, identity } = args;
  const defaultRole: ChannelRole = args.defaultRole ?? "queue";
  const force = args.force ?? false;
  const fromSession = args.fromSession;

  // Boundary validation (mirrors claimIdentity:170-178 + adds NATO-letter
  // gate). Identity gate is the new-claim domain check; sessionId/channelId
  // gates mirror existing primitives' defense-in-depth shape.
  if (!isValidArtifactId(channelId)) {
    throw new Error(
      `[channels-identity] claimIdentityNamed: invalid channelId "${channelId}" — must match isValidArtifactId pattern`,
    );
  }
  if (!isValidIdentity(identity)) {
    throw new Error(
      `[channels-identity] claimIdentityNamed: invalid identity "${String(identity)}" — must be a NATO letter (Alpha..Zulu)`,
    );
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(
      "[channels-identity] claimIdentityNamed: sessionId must be a non-empty string",
    );
  }

  // P0: same-session pre-check (Decision §11). Bifurcate idempotent rejoin
  // (same-letter) from operator-error (different-letter) BEFORE any
  // filesystem mutation, so the new-claim path doesn't see a stale state.
  const existing = findExistingClaim(channelId, sessionId);
  if (existing !== null) {
    if (existing.identity === identity) {
      // Same-letter idempotent rejoin per §11(a). Best-effort reconcile
      // metadata in case the previous claimIdentityNamed died after
      // linkSync but before commitIdentityClaim (mirrors claimIdentity's
      // reconcile-on-rejoin path at lines 191-208).
      try {
        await commitIdentityClaim({
          channelId,
          identity: existing.identity,
          claim: existing.claim,
        });
      } catch (err: unknown) {
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          source: "channels-identity",
          kind: "write-failed",
          sessionId,
          artifactPath: identitySentinelPath(channelId, existing.identity),
          detail: `reconcile-on-rejoin commitIdentityClaim failed: ${(err as Error).message}`,
        });
      }
      return {
        identity: existing.identity,
        session_id: sessionId,
        role: existing.claim.role,
        joined_at: existing.claim.joined_at,
        is_new_participant: false,
      };
    }
    // Different-letter rejection per §11(b). Operator must explicitly
    // release the current claim (deferred release-self verb) before
    // claiming a different letter; silent atomic-move would obscure the
    // prior claim and confuse downstream tooling.
    throw new IdentityAlreadyHeldBySelfError(
      channelId,
      existing.identity,
      identity,
    );
  }

  // P1: pre-lock linkSync atomic-create. Mirrors claimIdentity's tmpPath +
  // linkSync(tmp, sentinel) discipline (lines 218-274) but targets a single
  // named letter rather than walking NATO_POOL.
  const dir = identitiesDir(channelId);
  // RE-9 fix: legacy channels lack the identities/ subdir; mkdirSync first
  // (recursive:true is idempotent on existing dirs).
  mkdirSync(dir, { recursive: true });

  const joinedAt = new Date().toISOString();
  const newClaim: IdentityClaim = {
    session_id: sessionId,
    role: defaultRole,
    joined_at: joinedAt,
  };
  const sentinelPath = identitySentinelPath(channelId, identity);
  const tmpPath = join(
    dir,
    `.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
  );
  // wx flag (O_CREAT|O_EXCL) per Wave 1 RE-W1-4 — sibling pattern of
  // active-sessions/index.ts:writeMetaIfMissing. Match claimIdentity:233-236.
  writeFileSync(tmpPath, `${JSON.stringify(newClaim)}\n`, {
    flag: "wx",
    mode: 0o600,
  });

  let renameSyncConsumedTmpPath = false;
  try {
    try {
      linkSync(tmpPath, sentinelPath);
      // P1 success — no prior holder. Commit metadata under the lock and
      // return. NO audit-trail message; this is a fresh claim, not a
      // takeover.
      await commitIdentityClaim({
        channelId,
        identity,
        claim: newClaim,
      });
      return {
        identity,
        session_id: sessionId,
        role: defaultRole,
        joined_at: joinedAt,
        is_new_participant: true,
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        // Unexpected linkSync failure — surface via presence-failure-log
        // and rethrow. Mirrors claimIdentity:265-274 shape.
        appendPresenceFailure({
          timestamp: new Date().toISOString(),
          source: "channels-identity",
          kind: "write-failed",
          sessionId,
          artifactPath: sentinelPath,
          detail: `claimIdentityNamed P1 linkSync failed: ${(err as Error).message}`,
        });
        throw err;
      }
      // EEXIST — sentinel held by another session. Fall through to P2.
    }

    // P2: takeover branch. Delegate atomic lock+CAS+force+rename+commit to
    // the index.ts primitive (sibling of closeStalePeerIdentity).
    const result = await claimNamedIdentityWithLock({
      channelId,
      identity,
      newClaim,
      tmpPath,
      sentinelPath,
      force,
      fromSession,
    });

    if (result.kind === "cas-mismatch") {
      throw new IdentityCasMismatchError(
        channelId,
        identity,
        result.expected,
        result.actual,
      );
    }
    if (result.kind === "active") {
      throw new IdentityActiveError(
        channelId,
        identity,
        result.holderSessionId,
        result.ageMs,
      );
    }
    // result.kind === "claimed" — takeover succeeded under the lock.
    // renameSync moved tmpPath into sentinelPath; finally cleanup will
    // ENOENT-tolerantly skip.
    renameSyncConsumedTmpPath = true;

    // Post-lock audit-trail (Decision §3 RE-3 closure). Best-effort — on
    // appendMessage failure, write appendPresenceFailure breadcrumb so the
    // forensic gap is observable rather than silent.
    const auditMessage: ChannelMessage = {
      ts: new Date().toISOString(),
      from: sessionId,
      kind: "status",
      body: `[takeover] identity '${identity}' claimed by session ${sessionId}, displacing ${result.displacedSessionId ?? "(unknown)"}`,
    };
    try {
      await appendMessage({ channelId, message: auditMessage });
    } catch (err: unknown) {
      appendPresenceFailure({
        timestamp: new Date().toISOString(),
        source: "channels-identity",
        kind: "takeover-audit-failed",
        sessionId,
        artifactPath: channelId,
        detail: `claimIdentityNamed takeover audit-trail failed: ${(err as Error).message}`,
      });
    }

    return {
      identity,
      session_id: sessionId,
      role: defaultRole,
      joined_at: joinedAt,
      is_new_participant: true,
      takeover_displaced_session_id: result.displacedSessionId,
    };
  } finally {
    if (!renameSyncConsumedTmpPath) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // tmp already gone (linkSync may have moved it via inode-link or
        // another path); ignore.
      }
    }
  }
}
