// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Curated public API surface for the channels module.
 *
 * Phase 1+ hook consumers and dotfiles cross-edge shims (Slice 3b) import
 * via this narrow re-export rather than the full `./channels` flat root.
 * This keeps the public auditable manifest small and explicit; internal
 * helpers (`renderMessage`, migration heuristics, lock primitives) stay
 * private. The one render.ts seam exposed on the public surface is
 * `renderKindPrefix` (added in Phase 0 of Phase 4 Step A) — a kind→prefix
 * lookup consumed by kind-aware renderer callers (Layer 1 hook in plugin,
 * and any future dotfiles cross-edge surface that wants consistent kind
 * markers).
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

// Phase 4 Step A Layer 4 — `digest` kind body schema type. Consumers
// that pattern-match on the parsed body (operator tools, future arc
// analysis tooling, dotfiles cross-edge consumers) import this type
// from `claude-conductor/channels/api` alongside `parseDigestBody`.
export type { DigestBody } from "./digest.ts";

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
  CHANNEL_KINDS,
  ChannelClosedError,
  channelIdFromHandoff,
  closeChannel,
  createChannel,
  heartbeatMtime,
  /** Strict ChannelMessage shape validator. Exposed on the curated
   *  surface so external consumers (dashboard channel-stream adapter,
   *  any other paired-cross-edge-contract-test consumer) can validate
   *  a JSON.parse'd JSONL line at the import boundary without dropping
   *  to the full `./channels` flat root. Sibling pattern: `parseDigestBody`
   *  for kind-aware body validation. Per `feedback-cross-edge-contract-via-paired-tests`. */
  isChannelMessage,
  joinChannel,
  listChannels,
  makeSendOutMutator,
  newestHeartbeatMtime,
  pruneArchive,
  readBodyFile,
  readMessages,
  /** Read messages with `ts > afterTs` (strict-greater, ISO-8601 lex
   *  compare). Exposed for incremental-read consumers (dashboard
   *  channel-stream adapter past last-seen-ts). Exclusive boundary
   *  mirrors the SSE `lastEmittedOffset` semantics. */
  readMessagesAfter,
  /** Read the most recent `limit` messages. Exposed for tail-N readers
   *  (dashboard `/api/channel/[id]?from=<ts>` paged route). v1 impl
   *  loads full file; reverse-stream optimization is a follow-up. */
  readMessagesTail,
  readMetadata,
  resolveArchiveDir,
  resolveChannelsDir,
  resolveLatestSymlinkPath,
  resolveSessionId,
  touchHeartbeat,
  validateChannelMetadata,
} from "./index.ts";

// Layer 1 / Layer 3 fold (Phase 4 Step A): kind-aware renderer helper.
// Exposed on the curated surface so dotfiles cross-edge consumers can
// render peer messages with consistent kind prefixes if needed; primary
// in-plugin consumer is `src/hooks/checks/peer-message-deliverer.ts`.
export { renderKindPrefix } from "./render.ts";

// Layer 3 fold (Phase 4 Step A): explicit-out predicate. Returns the
// NATO letters whose claim has `out_posted_at` set on a channel.
// Consumed by `active-sessions/listLivePeers({excludeOut: true})` (lands
// in follow-up commit) and by any operator-facing surface that needs to
// filter "terminal until takeover" peers.
export { explicitlyOutPeers } from "./explicitly-out-peers.ts";

// Layer 4 (Phase 4 Step A — B2): `digest` kind shared parser. Any
// reader consuming `digest` messages should use this single parser
// rather than re-implementing JSON-parse + shape-check per call site
// (sibling-shape to the SSOT pattern at index.ts). The verification-
// budget contract for `digest` (trust SHAPE; primary-source-verify
// audit-class/SHA citations) lives in
// `docs/conventions/message-kinds-and-verification.md`.
export { parseDigestBody } from "./digest.ts";

export { NATO_POOL, isValidIdentity } from "./identity.ts";
