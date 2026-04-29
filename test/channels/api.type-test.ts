// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 3a type-export integrity sentinels (TA-1 fix, plan vivid-seeking-crayon §6b).
 *
 * Compile-only file — runs under `bun run typecheck` (tsc --noEmit) per
 * tsconfig.json:33 (`include: ["src/**\/*", "test/**\/*"]`). Zero runtime
 * tests; the sentinels below cause compilation to FAIL if any type
 * re-exported from `api.ts` structurally drifts from its source module.
 *
 * Pattern: bidirectional assignability cycle.
 *   - `Api extends Source ? true : never` — fails compile if api type is
 *     wider than source (extra/different members).
 *   - `Source extends Api ? true : never` — fails compile if api type is
 *     narrower than source (missing members).
 * Both must be `true`, asserting structural equality (via mutual extension)
 * over the 8 type re-exports.
 */

import type {
  ChannelKind as ApiChannelKind,
  ChannelLifecycle as ApiChannelLifecycle,
  ChannelMessage as ApiChannelMessage,
  ChannelMetadata as ApiChannelMetadata,
  ChannelRole as ApiChannelRole,
  ChannelSummary as ApiChannelSummary,
  IdentityClaim as ApiIdentityClaim,
  NatoIdentity as ApiNatoIdentity,
} from "claude-conductor/channels/api";

import type {
  ChannelKind as SourceChannelKind,
  ChannelLifecycle as SourceChannelLifecycle,
  ChannelMessage as SourceChannelMessage,
  ChannelMetadata as SourceChannelMetadata,
  ChannelRole as SourceChannelRole,
  ChannelSummary as SourceChannelSummary,
  IdentityClaim as SourceIdentityClaim,
} from "../../src/channels/index.ts";

import type { NatoIdentity as SourceNatoIdentity } from "../../src/channels/identity.ts";

// ─── Bidirectional assignability cycles ───────────────────────────

type _AssertChannelKindForward = ApiChannelKind extends SourceChannelKind
  ? true
  : never;
type _AssertChannelKindBackward = SourceChannelKind extends ApiChannelKind
  ? true
  : never;
const _channelKindForward: _AssertChannelKindForward = true;
const _channelKindBackward: _AssertChannelKindBackward = true;

type _AssertChannelLifecycleForward =
  ApiChannelLifecycle extends SourceChannelLifecycle ? true : never;
type _AssertChannelLifecycleBackward =
  SourceChannelLifecycle extends ApiChannelLifecycle ? true : never;
const _channelLifecycleForward: _AssertChannelLifecycleForward = true;
const _channelLifecycleBackward: _AssertChannelLifecycleBackward = true;

type _AssertChannelMessageForward =
  ApiChannelMessage extends SourceChannelMessage ? true : never;
type _AssertChannelMessageBackward =
  SourceChannelMessage extends ApiChannelMessage ? true : never;
const _channelMessageForward: _AssertChannelMessageForward = true;
const _channelMessageBackward: _AssertChannelMessageBackward = true;

type _AssertChannelMetadataForward =
  ApiChannelMetadata extends SourceChannelMetadata ? true : never;
type _AssertChannelMetadataBackward =
  SourceChannelMetadata extends ApiChannelMetadata ? true : never;
const _channelMetadataForward: _AssertChannelMetadataForward = true;
const _channelMetadataBackward: _AssertChannelMetadataBackward = true;

type _AssertChannelRoleForward = ApiChannelRole extends SourceChannelRole
  ? true
  : never;
type _AssertChannelRoleBackward = SourceChannelRole extends ApiChannelRole
  ? true
  : never;
const _channelRoleForward: _AssertChannelRoleForward = true;
const _channelRoleBackward: _AssertChannelRoleBackward = true;

type _AssertChannelSummaryForward =
  ApiChannelSummary extends SourceChannelSummary ? true : never;
type _AssertChannelSummaryBackward =
  SourceChannelSummary extends ApiChannelSummary ? true : never;
const _channelSummaryForward: _AssertChannelSummaryForward = true;
const _channelSummaryBackward: _AssertChannelSummaryBackward = true;

type _AssertIdentityClaimForward = ApiIdentityClaim extends SourceIdentityClaim
  ? true
  : never;
type _AssertIdentityClaimBackward = SourceIdentityClaim extends ApiIdentityClaim
  ? true
  : never;
const _identityClaimForward: _AssertIdentityClaimForward = true;
const _identityClaimBackward: _AssertIdentityClaimBackward = true;

type _AssertNatoIdentityForward = ApiNatoIdentity extends SourceNatoIdentity
  ? true
  : never;
type _AssertNatoIdentityBackward = SourceNatoIdentity extends ApiNatoIdentity
  ? true
  : never;
const _natoIdentityForward: _AssertNatoIdentityForward = true;
const _natoIdentityBackward: _AssertNatoIdentityBackward = true;

// Suppress unused-variable lint warnings — the const declarations ARE the
// assertions (their types must be `true` not `never` to compile).
void _channelKindForward;
void _channelKindBackward;
void _channelLifecycleForward;
void _channelLifecycleBackward;
void _channelMessageForward;
void _channelMessageBackward;
void _channelMetadataForward;
void _channelMetadataBackward;
void _channelRoleForward;
void _channelRoleBackward;
void _channelSummaryForward;
void _channelSummaryBackward;
void _identityClaimForward;
void _identityClaimBackward;
void _natoIdentityForward;
void _natoIdentityBackward;
