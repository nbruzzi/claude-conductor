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
