// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Bundled-check registrations (16 multi-instance-coordination-machinery checks).
 *
 * Cluster 1 of INVERSIONS arc (2026-05-07): 9 universal-coding-discipline
 * checks (auto-format, branch-enforcement, destructive-cmd, no-any, no-enum,
 * pre-commit, prefer-bun, sensitive-files, test-gate) moved to substrate;
 * imports + register calls removed from this module.
 *
 * Cluster 2 of INVERSIONS arc (2026-05-07): 4 CI verification protocol checks
 * (auth-warn, gate, pre-push-arm, reminder) moved to substrate; imports +
 * register calls removed from this module.
 *
 * Per extraction-manifest §§ 194–225: this module owns the plugin-bound
 * registrations. In batch 4 it moves to the plugin alongside registry.ts and
 * the constructor of plugin's RegistryBuilder will call this register() as a
 * private bootstrap step. Until then, dispatcher.ts calls it explicitly.
 *
 * Lives next to registry.ts so it moves as a single-file extraction (no
 * import-flip choreography across batches per ARCH-2).
 */

import type { RegistryBuilder } from "../registry.ts";
import type { BundledCheckName } from "../bundled-check-names.ts";
import { check as checkSessionCollisionGate } from "./session-collision-gate.ts";
import { check as checkSessionPresenceUnregister } from "./session-presence-unregister.ts";
import { check as checkChannelGc } from "./channel-gc.ts";
import { check as checkChannelsGcReaper } from "./channels-gc-reaper.ts";
import { check as checkActiveChannelsLoad } from "./active-channels-load.ts";
import { check as checkSessionPresenceRegister } from "./session-presence-register.ts";
import { check as checkIdentityInjector } from "./identity-injector.ts";
import { check as checkTaskCoordinator } from "./task-coordinator.ts";
import { check as checkTeammateIdleReminder } from "./teammate-idle-reminder.ts";
import { check as checkDotfilesWorktreeProvisioner } from "./dotfiles-worktree-provisioner.ts";
import { check as checkDotfilesWorktreeGc } from "./dotfiles-worktree-gc.ts";

export function registerBundled(
  builder: RegistryBuilder<BundledCheckName>,
): void {
  // pre-tool-use
  builder.register("pre-tool-use", {
    name: "session-collision-gate",
    fn: checkSessionCollisionGate,
    description:
      "Preventive gate — block when another live Claude session is editing the same artifact",
    canBlock: true,
    profiles: ["standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "task-coordinator",
    fn: checkTaskCoordinator,
    description:
      "Phase 2 Slice 6 — gate Task tool dispatches against this session's NATO role on every claimed channel. Hard-block role=out (sibling-parity with send role-gate); soft-warn role=queue; pass on role=pen or no claim. Fail-open + breadcrumb on read failures.",
    canBlock: true,
    profiles: ["standard", "strict"],
  });

  // post-tool-use (none post-Cluster-2)

  // stop
  builder.register("stop", {
    name: "session-presence-unregister",
    fn: checkSessionPresenceUnregister,
    description:
      "Remove our presence heartbeats so peers detect absence immediately (runs last — skipped when a prior Stop check blocks)",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  // dotfiles-worktree-cleanup removed in cycle-3 fix (channel 2026-05-08_02-15):
  // Stop event fires per-turn (not session-end), and the cleanup hook had no
  // session-end discrimination — destroyed the worktree after the first
  // turn-end Stop, defeating per-session isolation. Cleanup now happens
  // exclusively via dotfiles-worktree-gc reaper at next session-start
  // (mtime + heartbeat-stale based, sibling-parity with dotfiles-catchup).
  // Branch-cleanup ride-along: removeWorktree (in src/worktrees/index.ts)
  // now also `git branch -D`s the worktree branch on directory removal.

  // session-start
  builder.register("session-start", {
    name: "channel-gc",
    fn: checkChannelGc,
    description:
      "Archive stale inter-session channels and prune archive (30-day retention, 100-entry cap)",
    canBlock: false,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("session-start", {
    name: "channels-gc-reaper",
    fn: checkChannelsGcReaper,
    description:
      "Phase 2 Slice 4 — sweep orphan channel-identity sentinels with own-before-unlink discipline; rate-limited 1/5min/channel; 90-s mtime gate (3 × LOCK_STALE_MS) + sweep-phase invariant re-check",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "active-channels-load",
    fn: checkActiveChannelsLoad,
    description:
      "Surface live inter-session channels (self / pending-join / observer) and touch heartbeat for self participation",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "session-presence-register",
    fn: checkSessionPresenceRegister,
    description:
      "Touch a presence heartbeat for the current artifact so peers can detect us before our first Edit",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "identity-injector",
    fn: checkIdentityInjector,
    description:
      "Phase 2 Slice 5 — surface NATO-identity context (identity, role, peer roster) for channels where this session has a claim. Per-session emission cursor avoids re-emitting unchanged context.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "dotfiles-worktree-provisioner",
    fn: checkDotfilesWorktreeProvisioner,
    description:
      "Phase 3 Slice 2 — provision a per-session dotfiles worktree at session-start when CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=1. Anchor-pins the canonical-claude-home heartbeat (REV 0.2 ARCH-1 fix); soft-ceiling at 20 worktrees; mixed-flag-state warning when peers disagree. Default-off in this slice; flip-default lands as a follow-up commit on main after Bravo first-dogfood ack.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("session-start", {
    name: "dotfiles-worktree-gc",
    fn: checkDotfilesWorktreeGc,
    description:
      "Phase 3 Slice 2 — orphan-reaper for per-session dotfiles worktrees. Mirrors channels-gc-reaper rate-gate cursor pattern. Reaps when heartbeat absent OR ageMs > GC_WINDOW_MS=60min, with mtime-filtered safety guards (.git/index.lock < 1hr, node_modules/.bun-tmp-* < 5min) + forensic-marker escape hatch. RE-3 self-heal via unregisterActiveSession + clearSentinelDotfilesRoot.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });

  // user-prompt-submit
  builder.register("user-prompt-submit", {
    name: "teammate-idle-reminder",
    fn: checkTeammateIdleReminder,
    description:
      "Phase 2 Slice 7 — surface idle peers on UserPromptSubmit so operators discover stuck/crashed siblings without manual `peers` queries. Per-peer rate limit (30 min) + clock-skew suppression (>5 min divergence between peer body-ts and mtime). Fail-open + breadcrumb on read failures.",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
}
