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
  commitIdentityClaim,
  type ChannelRole,
  type IdentityClaim,
} from "./index.ts";

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
        `close-peer ${channelId} <identity>'.`,
    );
    this.name = "NatoExhaustedError";
  }
}

/** Per-channel directory holding per-identity sentinel files. The
 *  sentinel is the atomic create-only marker (linkSync EEXIST primitive);
 *  metadata.identities is the materialized cache. */
function identitiesDir(channelId: string): string {
  return join(channelsDir(), channelId, "identities");
}

function identitySentinelPath(channelId: string, letter: NatoIdentity): string {
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

/**
 * Scan the identities/ directory for an existing claim by `sessionId`.
 * Returns the {identity, claim} pair on first match, or null. Used for
 * idempotent rejoin in `claimIdentity`.
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { session_id?: unknown }).session_id !== sessionId
    ) {
      continue;
    }
    const c = parsed as Record<string, unknown>;
    const role = c["role"];
    const joined_at = c["joined_at"];
    if (
      (role !== "pen" && role !== "queue" && role !== "out") ||
      typeof joined_at !== "string"
    ) {
      continue;
    }
    return {
      identity: entry,
      claim: { session_id: sessionId, role, joined_at },
    };
  }
  return null;
}
