// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 6 hook — coordinate Task tool dispatches against this
 * session's NATO role on every claimed channel.
 *
 * Fires PreToolUse on the `Task` tool only. For each channel where this
 * session has a claim:
 *   - role=out  → hard-BLOCK (exit 2). Sibling-parity with the `send`
 *                 role-gate per `feedback-sibling-parity-at-merge-time.md`;
 *                 dispatching subagents while observing-only would
 *                 produce side effects (file writes, channel posts) that
 *                 a `out` role explicitly disallows.
 *   - role=queue → soft-warn (exit 0 + system-reminder). Operator can
 *                 still dispatch but is reminded that another peer holds
 *                 the pen and they may want to transition first.
 *   - role=pen  → no emission. Dispatching is exactly the action the pen
 *                 holder is expected to take.
 *
 * Multi-channel evaluation: if ANY channel reports role=out, block. Else
 * if ANY reports role=queue, warn (concatenating per-channel guidance).
 * Else allow without comment. Per plan REV 2.1 §Slice 6.
 *
 * No-claim sessions: zero emission. Subagent dispatch outside any
 * channel is the dominant case and must NEVER be interrupted by this hook.
 *
 * Failure-mode class: **fail-open + breadcrumb**. Read failures (corrupt
 * metadata, IO error, etc.) are caught + breadcrumb'd via
 * `appendPresenceFailure` + the hook returns pass(). Subagent dispatch is
 * never blocked on an internal hook fault.
 *
 * Plan: ~/.claude/plans/prismatic-orbiting-mesh.md REV 2.1 §Slice 6.
 */

import {
  getIdentityContextForSession,
  type IdentityContext,
} from "../../channels/identity-context.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { extractValidSessionId } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { block, pass, warn } from "../types.ts";

const SOURCE = "task-coordinator";

export async function check(input: HookInput): Promise<HookResult> {
  // Only fires on Task tool invocations. Every other tool is a pass-
  // through — this hook has no opinion on Bash/Edit/Write/etc.
  if (input.toolName !== "Task") return pass();

  const sessionId = extractValidSessionId(input.raw);
  if (sessionId === undefined) {
    // No session id (or invalid shape) — fail-open per RE-W0-3 + ARCH-W0-9.
    // Hook can't reason about role without a session id; let the dispatch
    // proceed rather than block on a missing-context state.
    return pass();
  }

  let contexts: readonly IdentityContext[];
  try {
    contexts = getIdentityContextForSession(sessionId);
  } catch (err: unknown) {
    // Helper itself failed (e.g., listChannels threw despite its own
    // try/catch). Breadcrumb + pass — we don't want a hook fault to
    // block legitimate Task dispatches.
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      source: "channels-identity",
      kind: "registry-contention",
      sessionId,
      artifactPath: null,
      detail: `${SOURCE}: getIdentityContextForSession threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    return pass();
  }

  // No-claim sessions are the dominant case. Subagent dispatch outside
  // any channel must produce ZERO output from this hook.
  if (contexts.length === 0) return pass();

  // Evaluate roles across all claimed channels. Hard-block wins over
  // soft-warn wins over no-emission. Multi-channel state aggregates so
  // a single `out` claim anywhere is sufficient to block.
  const blockingChannels = contexts.filter((c) => c.self.role === "out");
  if (blockingChannels.length > 0) {
    return block(SOURCE, formatBlockMessage(blockingChannels));
  }

  const queueChannels = contexts.filter((c) => c.self.role === "queue");
  if (queueChannels.length > 0) {
    return warn(SOURCE, formatQueueWarning(queueChannels));
  }

  // All claims are role=pen — no emission needed. Dispatching is the
  // expected pen-holder action.
  return pass();
}

/**
 * Format the hard-block message. One bullet per blocking channel so an
 * operator with multiple `out` claims sees each one + its remediation.
 *
 * Template per plan REV 2.1 §Hook message templates appendix.
 */
function formatBlockMessage(blocking: readonly IdentityContext[]): string {
  if (blocking.length === 1) {
    const ch = blocking[0];
    if (ch === undefined) {
      // Unreachable per the length === 1 guard; satisfies the lint rule.
      return `[${SOURCE}] BLOCKED: role=out (channel state unreadable).`;
    }
    return [
      `[${SOURCE}] BLOCKED: your role on channel ${ch.channelId} is 'out' (observing only).`,
      `Sends and Task dispatches are gated. Transition first:`,
      `  claude-conductor channels set-role ${ch.channelId} --role pen`,
    ].join("\n");
  }
  const channelList = blocking.map((c) => `  - ${c.channelId}`).join("\n");
  const firstId = blocking[0]?.channelId ?? "<channel-id>";
  return [
    `[${SOURCE}] BLOCKED: your role is 'out' on multiple channels:`,
    channelList,
    `Sends and Task dispatches are gated. Transition first (per channel):`,
    `  claude-conductor channels set-role ${firstId} --role pen`,
  ].join("\n");
}

/**
 * Format the soft-warn message. Includes pen-holder peer letter so the
 * operator knows who to coordinate with.
 *
 * Template per plan REV 2.1 §Hook message templates appendix.
 */
function formatQueueWarning(queueing: readonly IdentityContext[]): string {
  const lines: string[] = [];
  for (const ch of queueing) {
    const penHolder = findPenHolder(ch);
    const penLabel = penHolder !== null ? penHolder : "<no current pen>";
    lines.push(
      `[${SOURCE}] You are 'queue' on channel ${ch.channelId}; current pen-holder is ${penLabel}.`,
    );
  }
  // First channel id used in the remediation hint; multi-channel callers
  // can repeat the command per channel.
  const firstId = queueing[0]?.channelId ?? "<channel-id>";
  lines.push(
    `Proceeding; switch role first if you want to coordinate:`,
    `  claude-conductor channels set-role ${firstId} --role pen`,
  );
  return lines.join("\n");
}

/**
 * Locate the NATO letter currently holding the pen on a channel.
 * Returns `null` if no peer is in `pen` role (the channel may be in a
 * partial-claim state where every claim is queue/out — this is rare but
 * possible during role-transition windows).
 */
function findPenHolder(ctx: IdentityContext): string | null {
  if (ctx.self.role === "pen") return ctx.self.identity;
  for (const peer of ctx.peers) {
    if (peer.role === "pen") return peer.identity;
  }
  return null;
}
