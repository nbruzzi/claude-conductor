// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Classifiers for the active-sessions module boundary throws.
 *
 * The module emits two stable wire shapes on `isValidArtifactId` /
 * `isValidSessionId` rejection — every guarded fn's throw includes both the
 * canonical prefix substring AND the offending id substring in the thrown
 * `Error.message`. Throw sites today (`src/active-sessions/index.ts`):
 *
 *   - `touchHeartbeat`        — line 391 (artifactId), line 393 (sessionId)
 *   - `resetArtifactRegistry` — line 922 (artifactId)
 *
 * The remaining `isValidArtifactId` / `isValidSessionId` call sites in
 * `index.ts` return silently (no throw) — those are the "best-effort" surfaces
 * that pre-filter listings without raising.
 *
 * Mirrors `src/channels/boundary-errors.ts` per
 * `feedback-cross-edge-contract-via-paired-tests.md` — exposes the
 * classifier here so downstream adapters (today: dashboard's
 * `active-sessions` adapter at
 * `src/lib/server/adapters/active-sessions.ts`) can discriminate
 * `kind: "invalid-input"` from `kind: "malformed"` without inline
 * string-matching.
 *
 * Wire-shape DIFFERS from channels' analog:
 *   - channels: `[channels-x] readY: invalid channelId "<id>" — must match isValidArtifactId pattern`
 *   - active-sessions: `invalid artifactId: <id>` (no per-fn prefix, no quotes, colon delimiter)
 *
 * Helper signatures stay analogous (two anchors: prefix substring + id
 * substring) but the prefix strings + id-anchor format differ. Callers
 * import the constants alongside the classifiers when they need to assert
 * the wire-shape contract directly.
 */

/** Stable substring present in every active-sessions artifactId-rejection throw. */
export const INVALID_ARTIFACT_ID_MESSAGE_FRAGMENT = "invalid artifactId:";

/** Stable substring present in every active-sessions sessionId-rejection throw. */
export const INVALID_SESSION_ID_MESSAGE_FRAGMENT = "invalid sessionId:";

/**
 * Returns `true` iff `e` is the canonical "invalid artifactId" boundary
 * throw emitted by an active-sessions exported fn (today: `touchHeartbeat`,
 * `resetArtifactRegistry`) when the passed id failed `isValidArtifactId`.
 *
 * Recognition criteria (all must hold):
 *   1. `e instanceof Error`
 *   2. `e.message` contains the literal substring `invalid artifactId:`
 *   3. `e.message` contains the offending id (passed as `artifactId`)
 *
 * Per-fn prefixes are tolerated — the classifier asserts only on the two
 * anchor substrings the boundary contract guarantees.
 */
export function isInvalidArtifactIdError(
  e: unknown,
  artifactId: string,
): boolean {
  return (
    e instanceof Error &&
    e.message.includes(INVALID_ARTIFACT_ID_MESSAGE_FRAGMENT) &&
    e.message.includes(artifactId)
  );
}

/**
 * Returns `true` iff `e` is the canonical "invalid sessionId" boundary
 * throw emitted by an active-sessions exported fn (today: `touchHeartbeat`)
 * when the passed id failed `isValidSessionId`.
 *
 * Recognition criteria (all must hold):
 *   1. `e instanceof Error`
 *   2. `e.message` contains the literal substring `invalid sessionId:`
 *   3. `e.message` contains the offending id (passed as `sessionId`)
 */
export function isInvalidSessionIdError(
  e: unknown,
  sessionId: string,
): boolean {
  return (
    e instanceof Error &&
    e.message.includes(INVALID_SESSION_ID_MESSAGE_FRAGMENT) &&
    e.message.includes(sessionId)
  );
}
