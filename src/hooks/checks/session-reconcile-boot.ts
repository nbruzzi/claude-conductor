// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SessionStart check — report-mode boot-reconciliation briefing.
 *
 * Runs reconcile-boot in REPORT-MODE (never `--apply`) at session start and
 * surfaces any gc-eligible stale presence (plus malformed entries) as a
 * non-blocking briefing, so the operator becomes aware and can invoke the
 * operator-explicit `reconcile-boot --apply` GC at their own discretion.
 *
 * REPORT-MODE, not auto-apply — see DLOG decisions/phase-3.md (2026-05-30,
 * Cycle-3). `applyGc`'s NEVER-auto-kill rests on FOUR guards, the first being
 * operator-explicit `--apply`. Auto-applying at every session-start would strip
 * that guard for ALL sessions — deleting coordination state with zero operator
 * action. "Operator-reachable" is satisfied by SURFACING here (the operator
 * closes the loop via the CLI); auto-apply-at-boot would be a deliberate mode-2
 * relaxation escalated to the operator, not a hook default.
 *
 * Fail-open + presence-failure-log breadcrumb on any error. Per the
 * `runReconcileBoot` caller note (reconcile-boot.ts): an fs-level listing throw
 * is a distinct class from the in-band malformed-entry `errors[]`; a hook
 * crashing at session-start is worse than a CLI exit, so `runReconcileBoot` is
 * try/catch-wrapped here.
 */

import { runReconcileBoot } from "../../active-sessions/index.ts";
import { getWallClockNow } from "../../shared/clock.ts";
import { appendPresenceFailure } from "../../shared/presence-failure-log.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "session-reconcile-boot";

export async function check(input: HookInput): Promise<HookResult> {
  let sessionId: string | null = null;
  try {
    sessionId = resolveSessionIdOrNull(input);

    // REPORT-MODE: no `apply` → enumerate + classify only, never delete.
    const report = runReconcileBoot({ now: getWallClockNow() });

    const gcEligible = report.gc_eligible_count;
    const malformed = report.errors.length;
    if (gcEligible === 0 && malformed === 0) return pass();

    const parts: string[] = [];
    if (gcEligible > 0) {
      parts.push(
        `${gcEligible} gc-eligible stale presence artifact(s) at boot — ` +
          "run `reconcile-boot --apply` to garbage-collect",
      );
    }
    if (malformed > 0) {
      parts.push(
        `${malformed} malformed/unreadable presence ` +
          `entr${malformed === 1 ? "y" : "ies"} — inspect`,
      );
    }
    return warn(SOURCE, parts.join("; "));
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
