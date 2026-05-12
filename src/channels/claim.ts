// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Identity-claim validation primitive (Phase 3 Step D / RE-W2-4 lift).
 *
 * Pure helper: parse a raw sentinel-file body string into an
 * {@link IdentityClaim}, or return `null` if the body is malformed.
 *
 * **Lifted from** `src/hooks/checks/channels-gc-reaper.ts` (was the local
 * helper `parseClaim`) per `decisions/phase-2.md` Decision A ARCH-2 +
 * Decision C RE-W2-4. The reaper was the sole `parseClaim`-named reader
 * at lift-time (empirically rediscovered 2026-05-12 via
 * `rg -n 'parseClaim|validateIdentityClaim' src/`). This module hosts the
 * primitive at a stable namespace (`claude-conductor/channels/claim`) so
 * future consumers — for instance, an integrity-check tool that scans
 * stored sentinels, or a substrate-rename migration that needs to
 * re-validate legacy claims — can import it without re-rolling the
 * shape check.
 *
 * **Sibling shape-reader survives this slice (Step D2 candidate):**
 * `findExistingClaim` in `src/channels/identity.ts` (~line 593-619)
 * inlines the same 4-step `IdentityClaim` shape check PLUS a stricter
 * role enum-narrow (`role !== "pen" && role !== "queue" && role !== "out"`)
 * + a caller-supplied `sessionId` filter. The original Decision A ARCH-2
 * rationale intended consolidating both readers. Step D's narrow-scope
 * disposition (C.0 per channel transcript 2026-05-12) defers the
 * `findExistingClaim` migration to a sibling slice (Step D2) because
 * (a) the role-enum narrowing must stay at `findExistingClaim`'s call
 * site — this primitive intentionally treats role as opaque-string
 * (see `test/channels/claim.test.ts` test 9 pinning the contract); and
 * (b) `feedback-live-substrate-sequencing.md` additive-first discipline
 * favors one-step-at-a-time over batched migration. File Step D2 as a
 * follow-up backlog entry when scheduling Phase 3 close-out.
 *
 * **Behavior contract** (preserved byte-for-byte from the pre-lift
 * `parseClaim` to satisfy the SHA-audit / behavioral-equivalence gate of
 * Step D):
 *   - Returns the parsed claim ONLY if all four shape checks pass
 *     (`JSON.parse` succeeds; result is a non-null object; `session_id`,
 *     `role`, `joined_at` are all `string`-typed).
 *   - Returns `null` on ANY parse or validation failure. Never throws.
 *
 * **Not in `src/channels/api.ts` curated re-exports this slice.** The
 * function is plugin-internal at lift-time. The api.ts curation policy
 * (per `src/channels/api.ts:5-12` + Decision E + ARCH-W2-6) governs
 * **cross-edge contract surface** — re-exports there are for
 * dotfiles + future external consumers, NOT for plugin-internal
 * sibling-reader migrations. When a **dotfiles cross-edge consumer**
 * materializes (e.g., a dotfiles hook needs to validate stored
 * sentinels at the cross-edge), add the re-export then per
 * `feedback-live-substrate-sequencing.md` additive-first discipline. A
 * 2nd plugin-internal reader (the deferred `findExistingClaim`
 * migration) is irrelevant to api.ts disposition.
 */

import type { IdentityClaim } from "./index.ts";

/**
 * Parse + shape-validate a sentinel-file body as an {@link IdentityClaim}.
 *
 * @param raw - Raw UTF-8 contents of a per-letter identity sentinel
 *   (`<channel-dir>/identities/<letter>`), as written by
 *   `commitIdentityClaim` in `src/channels/identity.ts`.
 * @returns The parsed `IdentityClaim` on shape-clean input; `null` on any
 *   parse or validation failure. Never throws.
 */
export function validateIdentityClaim(raw: string): IdentityClaim | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as IdentityClaim;
    if (typeof c.session_id !== "string") return null;
    if (typeof c.role !== "string") return null;
    if (typeof c.joined_at !== "string") return null;
    return c;
  } catch {
    return null;
  }
}
