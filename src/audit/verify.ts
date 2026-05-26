// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Stateless verifier for the audit-verdict signature chain (Cycle 1
 * substrate-core PR-A6; Pair B Charlie-pen per slice plan
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §2.3 + §8 step 6).
 *
 * Composes PR-A2 (audit-signature-chain primitives: PAE + Ed25519 sign /
 * verify + computePayloadHash) + PR-A3 (key-surface module: readKeyHistory
 * + resolveKeyAtTime + importPublicKey) + PR-A5 (parseAuditVerdictV0_3Wrapped
 * DSSE-aware parser) + existing channels module (readMessages JSONL reader)
 * into the operator-facing verifier verb dispatched by PR-A4's audit CLI.
 *
 * **Layer 1.5 verifier** — composes substrate-primitives into the audit-
 * trail integrity-check surface. Consumers: PR-A4 audit CLI verb (operator
 * workflow); Pair-A-PR-A4 `lineage verify` CLI (Layer 2 composability;
 * invokes `audit verify` internally per Pair A §3.1 LOCKED contract and
 * derives LineageVerifyOutput from AuditVerifyOutput state).
 *
 * **Verb-shape contract (§2.3 LOCKED):**
 *
 * ```bash
 * bun run conductor audit verify <channel-id> [--pubkey-dir <dir>] [--output json|human] [--strict]
 * ```
 *
 * Returns {@link AuditVerifyOutput} JSON (CLI default) or human-readable
 * text. Exit codes 0/1/2/3 per §2.3 4-state mapping (DC-3).
 *
 * **3-class break reasons (DC-5 + Charlie sub-Obs-6a):** `"tamper"` (signature
 * verify failed; payload bytes mutated post-sign OR keyid points to wrong
 * key); `"revoked-key"` (history entry status=revoked at signed_at; distinct
 * from tamper to preserve revocation visibility); `"key-rotation-discontinuity"`
 * (chain gap: `prev_audit_body_ref` doesn't match prior payload's SHA-256,
 * OR no active key in history covers signed_at timestamp).
 *
 * **Skipped-pre-v0.3 partial state:** legacy v0.1/v0.2 raw audit-verdict
 * bodies (unsigned; pre-DSSE-wrapper migration) cannot be chain-verified.
 * They count toward partial state via the internal scan counter but DO NOT
 * enter `breaks[]` (no signature failure; just outside chain scope).
 * Triggers exit code 2 (partial) at CLI layer when v0.3 entries coexist
 * with pre-v0.3; future PR `audit migrate <channel-id>` verb (deferred
 * per CC-2 fold) retroactively signs to close the gap.
 *
 * Per the verification-budget convention: this module trusts SHAPE of
 * inputs (channelId from CLI; pubkeyDir resolvable on filesystem) but
 * validates cryptographic correctness + 3-class break attribution +
 * chain integrity walk. Pure functions modulo filesystem read (no
 * mutations; no I/O writes; no network).
 */

import { join } from "node:path";
import {
  readBodyFile,
  readMessages,
  type ChannelMessage,
} from "../channels/index.ts";
import {
  parseAuditVerdictV0_3Wrapped,
  parseAuditVerdictBody,
} from "../channels/audit-verdict.ts";
import {
  computePayloadHash,
  verifyEnvelope,
} from "../channels/audit-signature-chain.ts";
import {
  importPublicKey,
  readKeyHistory,
  resolveKeyAtTime,
} from "../channels/key-surface.ts";
import { cohortKeysDir } from "../shared/paths.ts";

/**
 * 3-class break reason per DC-5 + Charlie sub-Obs-6a. Each variant maps
 * to a distinct operator-facing remediation path:
 *
 *   - `"tamper"`: signature verify failed against resolved pubkey. Either
 *     payload bytes were mutated post-sign, OR envelope keyid points to a
 *     different operator's key. Investigate channel JSONL contents +
 *     cross-check envelope.signatures[i].keyid vs JSONL line identity.
 *   - `"revoked-key"`: key history at signed_at has the resolved entry in
 *     status="revoked". The signature itself is valid but the key was
 *     revoked (compromise OR explicit invalidation). Distinct from tamper
 *     so operators can react to revocation events without conflating with
 *     attacker-mutation attempts.
 *   - `"key-rotation-discontinuity"`: chain integrity broken. Either
 *     `prev_audit_body_ref` doesn't match prior payload's SHA-256 (chain
 *     gap or mutation), OR no key history entry covers signed_at (gap
 *     between rotations OR clock skew). Distinct from tamper because the
 *     individual sig may verify but the chain semantics fail.
 */
export type BreakReason =
  | "tamper"
  | "revoked-key"
  | "key-rotation-discontinuity";

/**
 * Single break entry in {@link AuditVerifyOutput.breaks}. Schema-locked
 * per §2.3 + §4.1 cross-pair contract; Pair-A-PR-A4 LineageVerifyOutput
 * derives `sig_chain_status` from `breaks[]` non-emptiness.
 */
export type AuditVerifyBreak = {
  /** 0-indexed position of the audit-verdict in channel JSONL. */
  at_msg_seq: number;
  /** body_ref of the audit-verdict that failed (may differ from JSONL line). */
  body_ref: string;
  /** 3-class reason for the break. */
  reason: BreakReason;
  /** Human-readable diagnostic for operator investigation. */
  detail: string;
  /** keyid from envelope.signatures[i].keyid if known at break-detection time. */
  key_id?: string;
};

/**
 * JSON output shape per §2.3 LOCKED contract. Returned by
 * {@link verifyChannelAuditChain}; serialized as `--output json` payload
 * by the audit verify CLI.
 */
export type AuditVerifyOutput = {
  /** true iff entire chain verifies (zero breaks; pre-v0.3 skip is non-fatal at OUTPUT level). */
  ok: boolean;
  /**
   * Ordered first-occurrence list of keyids that signed audit-verdicts in
   * this channel. Charlie Obs-1 cardinality fix (was single string in v0
   * spec drafts); preserves rotation visibility for operator audit reports.
   */
  key_ids_used: string[];
  /** Count of v0.3 DSSE-wrapped audit-verdicts in channel (chain-eligible). */
  total_audit_verdicts: number;
  /** Empty array iff ok=true. Charlie Obs-1 + Delta multi-break resolution. */
  breaks: AuditVerifyBreak[];
};

/**
 * Internal verifier state — exposed to the CLI dispatcher for exit-code
 * mapping. Not serialized into {@link AuditVerifyOutput} JSON; consumers
 * derive partial/unsupported state from these counters.
 *
 * `skipped_pre_v0_3`: count of raw v0.1/v0.2 audit-verdict bodies (unsigned;
 * outside chain scope). Triggers partial state when > 0 alongside v0.3 entries.
 *
 * `unparseable`: count of `kind=audit-verdict` messages whose body neither
 * parsed as DSSE envelope nor as raw v0.2 body. Triggers unsupported state
 * (exit 3).
 */
export type AuditVerifyInternalState = {
  skipped_pre_v0_3: number;
  unparseable: number;
};

/**
 * Combined return shape — caller (CLI) consumes both the §2.3 output JSON
 * and the internal partial/unsupported state for exit-code mapping. The
 * `output` field is what gets serialized to stdout; the `internal` field
 * never leaves the process.
 */
export type AuditVerifyResult = {
  output: AuditVerifyOutput;
  internal: AuditVerifyInternalState;
};

/**
 * Options for {@link verifyChannelAuditChain}. All optional; defaults
 * defined inline.
 */
export type AuditVerifyOptions = {
  /**
   * Override the cohort key directory. Defaults to
   * `paths.ts cohortKeysDir()` (typically `~/.claude/keys/cohort/`).
   * Test fixtures + operator overrides use this; production verifier
   * uses the canonical SSOT.
   */
  pubkeyDir?: string;
};

/**
 * Verify the audit-verdict signature chain in a channel JSONL.
 *
 * Walks all `kind=audit-verdict` messages in JSONL order (msg_seq
 * 0-indexed). For each v0.3 DSSE-wrapped entry: resolves the signing
 * NATO's key history, verifies the envelope signature against the
 * historical pubkey resolved by `signed_at`, checks chain integrity via
 * `prev_audit_body_ref` matching SHA-256 of prior payload. Legacy
 * v0.1/v0.2 raw bodies are counted toward `skipped_pre_v0_3` (partial
 * state) but do NOT enter `breaks[]`.
 *
 * Returns both the §2.3 output JSON shape AND internal state for CLI
 * exit-code mapping.
 */
export async function verifyChannelAuditChain(
  channelId: string,
  options: AuditVerifyOptions = {},
): Promise<AuditVerifyResult> {
  const pubkeyDir = options.pubkeyDir ?? cohortKeysDir();

  const messages = readMessages(channelId);
  const breaks: AuditVerifyBreak[] = [];
  const keyIdsUsed: string[] = [];
  let totalAuditVerdicts = 0;
  let skippedPreV0_3 = 0;
  let unparseable = 0;

  let prevV0_3Payload: string | null = null;

  for (let msgSeq = 0; msgSeq < messages.length; msgSeq++) {
    const msg = messages[msgSeq];
    if (msg === undefined) continue;
    if (msg.kind !== "audit-verdict") continue;

    const body = resolveBody(channelId, msg);
    if (body === null) {
      unparseable += 1;
      continue;
    }

    const wrapped = parseAuditVerdictV0_3Wrapped(body);
    if (wrapped === null) {
      // Not a DSSE-wrapped envelope; try raw v0.1/v0.2 body
      const rawBody = parseAuditVerdictBody(body);
      if (rawBody === null) {
        unparseable += 1;
        continue;
      }
      // Legacy unsigned body — outside chain scope; count toward partial
      skippedPreV0_3 += 1;
      continue;
    }

    totalAuditVerdicts += 1;
    const envelope = wrapped.envelope;
    const innerBody = wrapped.body;
    const bodyRef = msg.body_ref ?? "(inline)";

    const sigEntry = envelope.signatures[0];
    const keyid = sigEntry?.keyid;
    if (keyid !== undefined && !keyIdsUsed.includes(keyid)) {
      keyIdsUsed.push(keyid);
    }

    // Chain integrity: for non-bootstrap, prev_audit_body_ref MUST equal
    // SHA-256 of prior v0.3 envelope's payload bytes.
    if (prevV0_3Payload !== null) {
      const expectedPrevHash = await computePayloadHash(prevV0_3Payload);
      const actualPrevRef = innerBody.prev_audit_body_ref;
      if (actualPrevRef !== expectedPrevHash) {
        breaks.push({
          at_msg_seq: msgSeq,
          body_ref: bodyRef,
          reason: "key-rotation-discontinuity",
          detail: `prev_audit_body_ref mismatch — expected SHA-256 ${expectedPrevHash} of prior payload; got ${actualPrevRef ?? "null/absent"}`,
          ...(keyid !== undefined ? { key_id: keyid } : {}),
        });
        prevV0_3Payload = envelope.payload;
        continue;
      }
    }

    // Key resolution: load history file for the signing NATO; resolve by signed_at
    if (keyid === undefined) {
      breaks.push({
        at_msg_seq: msgSeq,
        body_ref: bodyRef,
        reason: "tamper",
        detail:
          "envelope.signatures[0].keyid missing — cannot resolve signing key",
      });
      prevV0_3Payload = envelope.payload;
      continue;
    }

    const signedAt = innerBody.signed_at;
    if (signedAt === undefined || signedAt === null) {
      breaks.push({
        at_msg_seq: msgSeq,
        body_ref: bodyRef,
        reason: "key-rotation-discontinuity",
        detail: "inner body missing signed_at — cannot resolve historical key",
        key_id: keyid,
      });
      prevV0_3Payload = envelope.payload;
      continue;
    }

    const historyPath = join(pubkeyDir, `${keyid}.history.json`);
    const history = await readKeyHistory(historyPath);
    if (history === null) {
      breaks.push({
        at_msg_seq: msgSeq,
        body_ref: bodyRef,
        reason: "key-rotation-discontinuity",
        detail: `key history not found at ${historyPath} — cannot verify signature`,
        key_id: keyid,
      });
      prevV0_3Payload = envelope.payload;
      continue;
    }

    const resolved = resolveKeyAtTime(history, signedAt);
    if (!resolved.ok) {
      const reason: BreakReason =
        resolved.error.kind === "key-revoked"
          ? "revoked-key"
          : "key-rotation-discontinuity";
      breaks.push({
        at_msg_seq: msgSeq,
        body_ref: bodyRef,
        reason,
        detail: resolved.error.detail,
        key_id: keyid,
      });
      prevV0_3Payload = envelope.payload;
      continue;
    }

    const pubkeyPath = join(pubkeyDir, resolved.entry.pubkey_path);
    const pubkey = await importPublicKey(pubkeyPath);
    if (pubkey === null) {
      breaks.push({
        at_msg_seq: msgSeq,
        body_ref: bodyRef,
        reason: "key-rotation-discontinuity",
        detail: `failed to import pubkey at ${pubkeyPath}`,
        key_id: keyid,
      });
      prevV0_3Payload = envelope.payload;
      continue;
    }

    const verifyResult = await verifyEnvelope(envelope, pubkey);
    if (!verifyResult.ok) {
      breaks.push({
        at_msg_seq: msgSeq,
        body_ref: bodyRef,
        reason: "tamper",
        detail: verifyResult.error.detail,
        key_id: keyid,
      });
      prevV0_3Payload = envelope.payload;
      continue;
    }

    // Success: track this payload for the next chain-integrity check
    prevV0_3Payload = envelope.payload;
  }

  const output: AuditVerifyOutput = {
    ok: breaks.length === 0,
    key_ids_used: keyIdsUsed,
    total_audit_verdicts: totalAuditVerdicts,
    breaks,
  };
  const internal: AuditVerifyInternalState = {
    skipped_pre_v0_3: skippedPreV0_3,
    unparseable,
  };
  return { output, internal };
}

/**
 * Resolve the body content of a channel message. Inline `body` field is
 * preferred; falls back to `body_ref` lookup via {@link readBodyFile}.
 * Returns null if neither resolves (e.g., body_ref present but body file
 * missing — `body_read_error` would be set on the message).
 */
function resolveBody(channelId: string, msg: ChannelMessage): string | null {
  if (msg.body !== undefined) return msg.body;
  if (msg.body_ref !== undefined) {
    return readBodyFile(channelId, msg.body_ref);
  }
  return null;
}

/**
 * Render the verifier output as human-readable plain text. CLI dispatches
 * to this when `--output human` is passed (default is `--output json`).
 *
 * Grep-friendly + log-friendly format per §2.3 prose ("grep-able + log-
 * friendly"). One field per line; structured headers for breaks[].
 */
export function renderHuman(
  output: AuditVerifyOutput,
  internal: AuditVerifyInternalState,
): string {
  const lines: string[] = [];
  lines.push(`ok: ${output.ok}`);
  lines.push(`total_audit_verdicts: ${output.total_audit_verdicts}`);
  lines.push(`key_ids_used: [${output.key_ids_used.join(", ")}]`);
  lines.push(`breaks: ${output.breaks.length}`);
  for (const b of output.breaks) {
    lines.push(`  - at_msg_seq=${b.at_msg_seq} body_ref=${b.body_ref}`);
    lines.push(`    reason=${b.reason}`);
    lines.push(`    detail=${b.detail}`);
    if (b.key_id !== undefined) lines.push(`    key_id=${b.key_id}`);
  }
  if (internal.skipped_pre_v0_3 > 0) {
    lines.push(`skipped_pre_v0_3: ${internal.skipped_pre_v0_3}`);
  }
  if (internal.unparseable > 0) {
    lines.push(`unparseable: ${internal.unparseable}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Map {@link AuditVerifyResult} state to a CLI exit code per §2.3
 * 4-state contract (DC-3):
 *
 *   - `0` = ok (all v0.3 entries verify; may be vacuously ok with zero entries)
 *   - `1` = broken (one or more breaks[] entries; sig/chain/key failures)
 *   - `2` = partial (skipped pre-v0.3 entries OR unparseable; non-failure
 *     anomalies). `--strict` collapses to `1`.
 *   - `3` = unsupported (unparseable audit-verdict bodies; structural
 *     failures distinct from partial)
 *
 * Precedence: broken > unsupported > partial > ok. Unparseable specifically
 * maps to `3` rather than `2` because it indicates structural failure
 * (e.g., unknown DSSE payloadType OR corrupted body) that operators must
 * triage distinct from pre-v0.3 chain-gap.
 */
export function exitCodeFor(
  result: AuditVerifyResult,
  strict: boolean,
): number {
  if (result.output.breaks.length > 0) return 1;
  if (result.internal.unparseable > 0) return 3;
  if (result.internal.skipped_pre_v0_3 > 0) return strict ? 1 : 2;
  return 0;
}
