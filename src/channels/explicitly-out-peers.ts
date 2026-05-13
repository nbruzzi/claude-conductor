// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `explicitlyOutPeers` predicate (Phase 4 Step A Layer 3).
 *
 * Returns the NATO identities on a channel whose
 * `metadata.identities[<L>].out_posted_at` field is set — i.e., peers
 * that explicitly announced departure (kind=`out`) and have NOT been
 * displaced by a `claim --force` takeover since.
 *
 * **Terminal until takeover (RE-7 semantics):** once `out_posted_at`
 * is written for a letter, the predicate continues returning that
 * letter on every read until a `claimIdentityNamed --force` takeover
 * replaces the entire claim — the new claim record doesn't carry
 * `out_posted_at`, so the predicate naturally drops the letter on
 * the next read.
 *
 * **Sole writer this arc (plan v5):** the CLI send-verb in
 * `src/channels/cli.ts` when `kind === "out"`. The send-role-gate
 * carve-out from the Layer 3 commit lets the `out` kind through;
 * `makeSendOutMutator(sessionId)` (in `src/channels/index.ts`) is
 * passed as the `extraMetadataMutator` so the `kind=out` JSONL line
 * AND the metadata `out_posted_at` + `role` transition land
 * atomically under one `withMetadataLock`.
 *
 * **No Stop-hook auto-writer.** A v4 draft extended
 * `session-presence-unregister` to auto-post `out` at session-end,
 * but Stop fires per-turn (not session-end) — see
 * `src/hooks/checks/bundled-registrations.ts:71-78` for the
 * dotfiles-worktree-cleanup precedent removed for the same bug
 * shape. SessionStart-driven reaper deferred to Phase 4 Step B.
 *
 * **Reader posture:** O(1) lookup over `metadata.identities` (NATO pool
 * size ≤ 26). Skip-on-error per channel: if `readMetadata` throws (or
 * the channel doesn't exist), the predicate returns an empty array
 * silently — consumers (e.g., `listLivePeers({excludeOut: true})`,
 * landing in a follow-up commit) get a non-throwing answer.
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 §"Layer 3
 * design" §"explicitlyOutPeers semantics".
 */

import { readMetadata } from "./index.ts";
import { type NatoIdentity } from "./identity.ts";

/**
 * Returns the NATO letters whose claim on `channelId` has `out_posted_at`
 * set. Empty array on unreadable metadata or no out-peers.
 */
export function explicitlyOutPeers(channelId: string): readonly NatoIdentity[] {
  let meta;
  try {
    meta = readMetadata(channelId);
  } catch {
    return [];
  }
  const identities = meta.identities;
  if (identities === undefined) return [];

  const out: NatoIdentity[] = [];
  for (const [letter, claim] of Object.entries(identities)) {
    if (claim.out_posted_at !== undefined) {
      // Narrowing: validator in `validateChannelMetadata` already
      // ensures the letter is a valid NATO identity (rejecting unknown
      // keys at metadata read time). We cast here because the
      // `Object.entries` typing returns `string` for the key.
      out.push(letter as NatoIdentity);
    }
  }
  return out;
}
