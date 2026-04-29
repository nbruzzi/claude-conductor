// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 7 hook — surface idle peers on UserPromptSubmit so operators
 * discover stuck/crashed siblings without manual `peers` queries.
 *
 * **Phase 1 stub.** This module currently no-ops. The hook is wired into the
 * plugin's bundled-check-names + bundled-registrations + package.json exports
 * map AND the dotfiles canonical's user-prompt-submit ORDER + check-names +
 * registry shim — all in lockstep — to satisfy `assertWiringComplete` across
 * the cross-repo edge before the real implementation lands. Phase 2 swaps the
 * stub body for the full implementation (cursor IO, clock-skew detection,
 * rate-limit). Plan: ~/.claude/plans/stateful-munching-volcano.md REV 2
 * §F.
 *
 * Failure-mode class (Phase 2): **fail-open + breadcrumb**. The stub is
 * trivially fail-open since it never reads anything.
 */

import type { HookInput, HookResult } from "../types.ts";
import { pass } from "../types.ts";

export async function check(_input: HookInput): Promise<HookResult> {
  return pass();
}
