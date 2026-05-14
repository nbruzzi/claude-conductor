// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Stop check — remove heartbeats this session touched during its lifetime.
 *
 * Lets peers detect absence immediately rather than waiting for the 2× TTL
 * opportunistic-GC sweep. Reads the `touched` artifact list from the
 * collision-gate state file and calls removeOwnHeartbeat for each.
 *
 * Chain position: LAST in the Stop handler, earlyReturn "never". Must not
 * run when an earlier Stop check blocked (e.g., test-gate) — in that case
 * the session isn't really ending. Chain semantics give this to us via the
 * earlier checks' earlyReturn: "on-block".
 *
 * Fail-open — any ghost heartbeat is reaped by opportunistic GC on the next
 * peer scan, or manually via /presence clear. Failures ALSO append to the
 * shared presence-failure log so SessionStart briefings can surface silent
 * un-register events (otherwise stale heartbeats would only clear 2× TTL
 * later — and the briefing would lack context for why).
 *
 * **Phase 4 Step A Layer 3 note (plan v5):** an earlier draft of this hook
 * added an auto-`out` extension that posted `kind=out` + set
 * `metadata.identities[<L>].out_posted_at` on every channel the session
 * had a claim on. That extension was DROPPED before merge because Stop
 * fires per-turn (not session-end) — see
 * `src/hooks/checks/bundled-registrations.ts:71-78` for the
 * dotfiles-worktree-cleanup precedent removed for the same bug shape.
 * Manual `channels send <id> out` is the sole writer of `out_posted_at`
 * this arc; a SessionStart-driven reaper for stale-peer auto-out is
 * deferred to Phase 4 Step B.
 */

import { existsSync, readFileSync } from "node:fs";
import { removeOwnHeartbeat } from "../../active-sessions/index.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass } from "../types.ts";
import { stateFile } from "./session-collision-gate.ts";

const SOURCE = "session-presence-unregister";

export async function check(input: HookInput): Promise<HookResult> {
  let sessionId: string | null = null;
  try {
    sessionId = resolveSessionIdOrNull(input);
    if (!sessionId) return pass();

    const touched = readTouchedFromState(sessionId);
    for (const artifactId of touched) {
      removeOwnHeartbeat(artifactId, sessionId);
    }
    return pass();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] failed: ${msg}`);
    appendPresenceFailure({
      timestamp: new Date().toISOString(),
      sessionId,
      source: SOURCE,
      kind: "unhandled",
      artifactPath: null,
      detail: msg,
    });
    return pass();
  }
}

function readTouchedFromState(sessionId: string): string[] {
  const file = stateFile(sessionId);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const obj = parsed as Record<string, unknown>;
    if (obj["session"] !== sessionId) return [];
    const touched = obj["touched"];
    if (!Array.isArray(touched)) return [];
    return touched.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}
