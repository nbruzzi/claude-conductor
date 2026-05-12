// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SessionStart check — register our presence for the current working artifact.
 *
 * When a session starts inside a tracked artifact (git repo or coordination
 * root), touch a heartbeat so peers can see us before our first Edit. This
 * surfaces collisions at the earliest possible moment — downstream SessionStart
 * briefings (active-channels-load, pending-threads-briefing) can assume that
 * presence is already visible to peers.
 *
 * Fail-open on any error, but append to the shared presence-failure log so
 * SessionStart briefings can surface silent miss events. Symmetric with
 * session-collision-gate's lock-timeout logging — the prior asymmetry allowed
 * a register fail-soft to silently hide the peer from downstream scans.
 */

import {
  artifactIdFromPath,
  artifactPathFromFile,
  touchHeartbeat,
} from "../../active-sessions/index.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass } from "../types.ts";

const SOURCE = "session-presence-register";

export async function check(input: HookInput): Promise<HookResult> {
  let sessionId: string | null = null;
  let artifactPath: string | null = null;
  try {
    sessionId = resolveSessionIdOrNull(input);
    if (!sessionId) return pass();

    const cwd = input.cwd;
    if (!cwd) return pass();

    artifactPath = artifactPathFromFile(cwd);
    if (!artifactPath) return pass();

    const artifactId = artifactIdFromPath(artifactPath);
    touchHeartbeat({
      artifactId,
      sessionId,
      artifactPath,
      now: getWallClockNow(),
    });
    return pass();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] failed: ${msg}`);
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: SOURCE,
      kind: "unhandled",
      artifactPath,
      detail: msg,
    });
    return pass();
  }
}
