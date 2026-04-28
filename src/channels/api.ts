// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Curated public API surface for the channels module.
 *
 * Phase 2 hook consumers (and downstream Phase 3 work) import via this
 * narrow re-export rather than the full `./channels` flat root. This keeps
 * the public auditable manifest small and explicit; internal helpers
 * (`renderMessage`, migration heuristics, lock primitives) stay private.
 *
 * Plan: ~/.claude/plans/generic-floating-hanrahan.md (Phase 1 v2 Q4).
 */

export type {
  ChannelKind,
  ChannelLifecycle,
  ChannelMessage,
  ChannelMetadata,
  ChannelRole,
  ChannelSummary,
  IdentityClaim,
} from "./index.ts";

export {
  channelIdFromHandoff,
  closeChannel,
  createChannel,
  joinChannel,
  listChannels,
  readMessages,
  readMetadata,
  resolveChannelsDir,
  validateChannelMetadata,
} from "./index.ts";

export type { NatoIdentity } from "./identity.ts";
export { NATO_POOL, isValidIdentity } from "./identity.ts";
