// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Classifiers for the conductor channels-module RE-3 boundary throws.
 *
 * The channels module emits a stable wire shape on `isValidArtifactId`
 * rejection — all guarded fns include both the substring `invalid channelId`
 * AND the quoted offending id `"<id>"` in the thrown `Error.message`.
 * `test/channels/api-channelid-guards.test.ts` pins that shape across 13+
 * exported fns.
 *
 * Downstream consumers (today: dashboard's channel-stream adapter at
 * `src/lib/server/adapters/channel-stream.ts` lines 65-68) classify these
 * errors via inline string-match. Per
 * `feedback-cross-edge-contract-via-paired-tests.md`, exposing the
 * classifier here removes the inline-string-match anti-pattern: the
 * caller imports `isInvalidChannelIdError` from
 * `claude-conductor/channels/api` and the wire shape stays the substrate's
 * concern, not the consumer's.
 *
 * Companion: vault `wiki/backlog.md` L991+ "paired cross-edge contract
 * test for isInvalidIdError string-match boundary" — this module is the
 * substrate-side closure for that backlog item.
 */

/** Stable substring present in every channels-module RE-3 boundary throw.
 *  Exposed so the contract is auditable from the import site without
 *  reaching into the classifier internals. */
export const INVALID_CHANNEL_ID_MESSAGE_FRAGMENT = "invalid channelId";

/**
 * Returns `true` iff `e` is the canonical "invalid channelId" boundary
 * throw emitted by a conductor channels-module read/write fn when the
 * passed id failed `isValidArtifactId`.
 *
 * Recognition criteria (both must hold; mirrors the loose-but-anchored
 * shape Delta's PR #9 channel-stream adapter classifier used):
 *   1. `e instanceof Error`
 *   2. `e.message` contains the literal substring `invalid channelId`
 *   3. `e.message` contains the quoted offending id (`"<channelId>"`)
 *
 * Per-fn prefixes (`[channels] readMessages: ...`, `[channels-identity]
 * releaseIdentity: ...`, etc.) and suffixes (`— must match
 * isValidArtifactId pattern`) are tolerated — the classifier asserts
 * only on the two anchor substrings the boundary contract guarantees.
 */
export function isInvalidChannelIdError(
  e: unknown,
  channelId: string,
): boolean {
  return (
    e instanceof Error &&
    e.message.includes(INVALID_CHANNEL_ID_MESSAGE_FRAGMENT) &&
    e.message.includes(`"${channelId}"`)
  );
}
