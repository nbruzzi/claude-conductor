// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `send-primitive` — programmatic in-process API for posting structured
 * messages to channels without subprocess overhead.
 *
 * T4-X3 cycle 2026-05-22 — sibling-shared module extracted per Alpha
 * plan-tier audit S1 fold. The Stop-hook orchestrator
 * (`pattern-trace-auto-propose`) imports this directly to send
 * kind=memory-proposal envelopes per detection-cycle; subprocess CLI
 * invocation per send would add ~50ms × N-channels × ~N-Stop-events
 * session overhead asymmetric to a silent advisory hook.
 *
 * **Initial scope (v1):** kind=memory-proposal only. Per
 * [[feedback-substrate-precedent-as-design-rescue]] sibling-shared
 * extraction pattern (audit-types.ts cycle 2026-05-19), generalize to
 * other kinds when a second consumer surfaces.
 *
 * **Validation contract:** body is JSON-stringified + parsed via
 * `parseMemoryProposalBody` before append. Mismatched bodies return a
 * structured `Error` rather than throwing — callers fail-isolate per
 * channel (the orchestrator try/catches each channel-send so one bad
 * payload doesn't gate others).
 *
 * **Identity attachment:** `appendMessage` auto-attaches the sender's
 * NATO identity + role from the session's claim under metadata-lock.
 * Pre-claim sessions ship anonymous; post-claim sessions get structured
 * identity fields per the Phase 1 display matrix.
 *
 * **Reference:**
 *   - Plan: T4-X3 v0.2 §"Fold deltas — S1" + FILE 2b spec.
 *   - Sibling-shared pattern: `src/channels/audit-types.ts` (cycle 2026-05-19).
 *   - Schema parser: `src/channels/memory-proposal.ts`.
 *   - Low-level primitive: `src/channels/index.ts:appendMessage`.
 */

import { appendMessage, type ChannelMessage } from "./index.ts";
import { parseMemoryProposalBody } from "./memory-proposal.ts";

export type SendMemoryProposalResult = {
  ts: string;
  body_ref?: string;
};

/**
 * Send a `kind=memory-proposal` envelope to the named channel using the
 * in-process `appendMessage` primitive (no subprocess overhead).
 *
 * @param channelId — target channel id (must match `isValidArtifactId` shape).
 * @param body — pre-constructed payload conforming to `MemoryProposalBody`.
 *               Validated against `parseMemoryProposalBody` before append.
 * @param sessionId — sender's session id (from HookInput.raw.session_id or
 *                    CLAUDE_SESSION_ID env). Caller-provided rather than
 *                    re-discovered to avoid PPID-walk overhead per Stop-hook
 *                    invocation. Validated downstream by `appendMessage`.
 * @returns Resolves to `{ ts, body_ref? }` on success.
 *          Resolves to `Error` on validation failure or append failure
 *          (NEVER throws; the orchestrator pattern wants per-channel
 *          fail-isolation without try/catch noise at the call site).
 */
export async function sendMemoryProposal(
  channelId: string,
  body: Record<string, unknown>,
  sessionId: string,
): Promise<SendMemoryProposalResult | Error> {
  const serialized = JSON.stringify(body);
  if (parseMemoryProposalBody(serialized) === null) {
    return new Error(
      `[send-primitive] memory-proposal body failed schema validation — see src/channels/memory-proposal.ts MemoryProposalBody for required fields (kind_version=1, candidate_name, memory_type, description, reason, proposed_body, amends_existing).`,
    );
  }

  const message: ChannelMessage = {
    ts: new Date().toISOString(),
    from: sessionId,
    kind: "memory-proposal",
    body: serialized,
  };

  try {
    const result = await appendMessage({ channelId, message });
    const out: SendMemoryProposalResult = { ts: result.ts };
    if (result.body_ref !== undefined) out.body_ref = result.body_ref;
    return out;
  } catch (err: unknown) {
    return err instanceof Error
      ? err
      : new Error(`[send-primitive] appendMessage failed: ${String(err)}`);
  }
}
