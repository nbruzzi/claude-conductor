// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Curated public API surface for the channels module.
 *
 * Phase 1+ hook consumers and dotfiles cross-edge shims (Slice 3b) import
 * via this narrow re-export rather than the full `./channels` flat root.
 * This keeps the public auditable manifest small and explicit; internal
 * helpers (`renderMessage`, migration heuristics, lock primitives) stay
 * private.
 *
 * Re-export rule (per `feedback-type-only-exports-erase-at-runtime.md`):
 * value re-exports and type re-exports are kept in SEPARATE blocks. Value
 * re-exports (`export { foo } from ...`) preserve runtime bindings. Type
 * re-exports (`export type { Foo } from ...`) erase at runtime — mixing
 * them in a single `export { ... }` block can silently turn a value into a
 * type-only export and break the runtime surface. Tests in
 * `test/channels/api.test.ts` (a) verify each value name resolves to a
 * non-undefined runtime binding via the published path
 * `claude-conductor/channels/api`.
 *
 * Plan: ~/.claude/plans/vivid-seeking-crayon.md (Slice 3a) + parent
 * ~/.claude/plans/generic-floating-hanrahan.md (Phase 1 v2 Q4).
 */

// ─── Type-only re-exports ──────────────────────────────────────────
// Erase at runtime. Do NOT mix with the value block below.

export type {
  ChannelKind,
  ChannelLifecycle,
  ChannelMessage,
  ChannelMetadata,
  ChannelRole,
  ChannelSummary,
  IdentityClaim,
  /** Phase 3 Step C (v2.6 fold per cross-audit ARCH-1 / M-1):
   *  re-exported so external consumers calling
   *  `listChannels({ includeUnreachable: true })` via this curated
   *  surface can name the union arm in their own narrowing utilities. */
  UnreachableChannelSummary,
} from "./index.ts";

export type { NatoIdentity } from "./identity.ts";

// ─── Value re-exports ──────────────────────────────────────────────
// Preserve runtime bindings. The 9 functions below were added in Slice 3a
// to widen the surface from 9 → 18 callable exports so Slice 3b's dotfiles
// shim can re-export them via `claude-conductor/channels/api`.
//
// Intentionally NOT re-exported here per Decision E + Wave 2 ARCH-W2-6
// (surface-curation policy):
//   - Identity primitives: `claimIdentity`, `setRole`, `releaseIdentity`,
//     `getIdentityForSession` — Phase 2 hook consumers needing identity
//     primitives import from `claude-conductor/channels/identity` directly.
//   - Internal flow primitives: `commitIdentityClaim`, `removeIdentityClaim`,
//     `closeStalePeerIdentity`, `setIdentityRole` — only Phase 2 GC reapers
//     would call these directly; they import from `claude-conductor/channels`
//     directly.
// All CRUD + identity functions in the channels module return `Promise<...>`
// (async cascade landed Slice 2.1).

export {
  appendMessage,
  archiveChannel,
  ChannelClosedError,
  channelIdFromHandoff,
  closeChannel,
  createChannel,
  heartbeatMtime,
  joinChannel,
  listChannels,
  newestHeartbeatMtime,
  pruneArchive,
  readBodyFile,
  readMessages,
  readMetadata,
  resolveArchiveDir,
  resolveChannelsDir,
  resolveSessionId,
  touchHeartbeat,
  validateChannelMetadata,
} from "./index.ts";

export { NATO_POOL, isValidIdentity } from "./identity.ts";
