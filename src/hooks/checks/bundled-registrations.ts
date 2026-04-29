// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Bundled-check registrations (18 generic discipline-as-code checks).
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
import { check as checkHandoffSymlinkWriteGuard } from "./handoff-symlink-write-guard.ts";
import { check as checkFactForce } from "./fact-force.ts";
import { check as checkBranchEnforcement } from "./branch-enforcement.ts";
import { check as checkDestructiveCmd } from "./destructive-cmd.ts";
import { check as checkPreferBun } from "./prefer-bun.ts";
import { check as checkPreCommit } from "./pre-commit.ts";
import { check as checkConfigProtection } from "./config-protection.ts";
import { check as checkSensitiveFiles } from "./sensitive-files.ts";
import { check as checkAutoFormat } from "./auto-format.ts";
import { check as checkNoAny } from "./no-any.ts";
import { check as checkNoEnum } from "./no-enum.ts";
import { check as checkTestGate } from "./test-gate.ts";
import { check as checkHandoffLatestGuard } from "./handoff-latest-guard.ts";
import { check as checkSessionPresenceUnregister } from "./session-presence-unregister.ts";
import { check as checkChannelGc } from "./channel-gc.ts";
import { check as checkActiveChannelsLoad } from "./active-channels-load.ts";
import { check as checkSessionPresenceRegister } from "./session-presence-register.ts";
import { check as checkIdentityInjector } from "./identity-injector.ts";

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
    name: "handoff-symlink-write-guard",
    fn: checkHandoffSymlinkWriteGuard,
    description:
      "Block Edit/Write on symlinked paths under ~/.claude/handoffs/ (prevents write-through clobber of aggregate pointers like LATEST.md)",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "fact-force",
    fn: checkFactForce,
    description:
      "Deny first edit per file — demand investigation before action",
    canBlock: true,
    profiles: ["standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "branch-enforcement",
    fn: checkBranchEnforcement,
    description:
      "Block Edit/Write on main/master once ≥4 distinct files touched (enforces CLAUDE.md branching rule)",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "destructive-cmd",
    fn: checkDestructiveCmd,
    description:
      "Block/warn destructive shell commands (rm -rf, git reset --hard, DROP TABLE, etc.)",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "prefer-bun",
    fn: checkPreferBun,
    description: "Remind to use bun instead of npm",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "pre-commit",
    fn: checkPreCommit,
    description: "Run typecheck/format/lint/test before git commit",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "config-protection",
    fn: checkConfigProtection,
    description: "Block edits to lint/format/typecheck config files",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("pre-tool-use", {
    name: "sensitive-files",
    fn: checkSensitiveFiles,
    description: "Warn when editing .env, CI configs, Docker, Claude settings",
    canBlock: false,
    profiles: ["minimal", "standard", "strict"],
  });

  // post-tool-use
  builder.register("post-tool-use", {
    name: "auto-format",
    fn: checkAutoFormat,
    description: "Run Prettier on saved .ts/.tsx/.js/.jsx/.json/.md files",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("post-tool-use", {
    name: "no-any",
    fn: checkNoAny,
    description:
      "Warn/block `: any` or `as any` in TypeScript files (blocks in strict)",
    canBlock: true,
    profiles: ["standard", "strict"],
  });
  builder.register("post-tool-use", {
    name: "no-enum",
    fn: checkNoEnum,
    description:
      "Warn/block enum declarations in TypeScript files (blocks in strict)",
    canBlock: true,
    profiles: ["standard", "strict"],
  });

  // stop
  builder.register("stop", {
    name: "test-gate",
    fn: checkTestGate,
    description: "Block session end if tests fail (when enabled via flag file)",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  builder.register("stop", {
    name: "handoff-latest-guard",
    fn: checkHandoffLatestGuard,
    description:
      "Warn when ~/.claude/handoffs/LATEST.md is a regular file or a broken symlink",
    canBlock: false,
    profiles: ["standard", "strict"],
  });
  builder.register("stop", {
    name: "session-presence-unregister",
    fn: checkSessionPresenceUnregister,
    description:
      "Remove our presence heartbeats so peers detect absence immediately (runs last — skipped when a prior Stop check blocks)",
    canBlock: false,
    profiles: ["standard", "strict"],
  });

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
}
