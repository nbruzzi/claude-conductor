// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Send-CLI auto-wrap dispatch for audit-verdict messages
 * (Cycle 2 Pair B substrate-debt — Charlie-pen Lane P per slice plan body
 * `~/.claude/plans/cycle-2-substrate-debt-pair-b-2026-05-27.md` §3).
 *
 * **Substrate-API-affordance bridge.** Layer 1.5 primitives (audit-signature-chain.ts
 * + key-surface.ts + canonical-json.ts + wrapAuditVerdictBody) have been
 * built since Cycle 1 substrate-core, but operators bypassed them entirely:
 * per Charlie substrate-finding (Pair B private `e74b0971` 2026-05-27T11:05Z +
 * cohort visibility `159c8dfc` 11:38Z), 0/43 audit-verdicts on bernstein arc
 * prior cycle were DSSE-wrapped (v0.3) and 10/43 hand-filled `prev_audit_body_ref`
 * as UUIDs (not SHA-256 of canonical-JSON payload). This module closes the
 * operator-path gap.
 *
 * **Mode dispatch (per slice plan body §3.3):**
 *
 * - **Mode A (auto-wrap)**: cohort key file resolvable + body has no manually-
 *   set `prev_audit_body_ref` OR has explicit `null` → auto-compute chain from
 *   prior audit-verdict on channel (SHA-256 of prior canonical-JSON payload)
 *   + auto-construct DSSE envelope via `wrapAuditVerdictBody` → return
 *   envelope JSON as the message body.
 * - **Mode C (legacy raw + WARN)**: cohort key file unresolvable OR body has
 *   non-SHA-256-shaped `prev_audit_body_ref` (UUID or other) → emit raw body
 *   unchanged + stderr WARN explaining how to engage Mode A.
 *
 * Mode B (operator-supplied SHA-256 chain) + Mode D (`--no-chain` opt-out)
 * are slice plan §3.3 candidates DEFERRED to follow-up scope per Charlie
 * Lane P MVP framing — Mode A + Mode C cover the substrate-API-affordance
 * bridge for cohort-canonical use.
 *
 * **Back-compat invariant:** if cohort key file is unresolvable (operator
 * hasn't run `bun run conductor audit bootstrap` yet), Mode C emits the same
 * raw body shape as pre-Lane-P behavior. Adding this auto-wrap layer does
 * NOT break operators who haven't bootstrapped keys.
 *
 * Per `[[feedback-substrate-fix-pattern-must-self-mirror]]` — the Layer 1.5
 * substrate fix is THIS module wiring the operator-path bridge so the
 * existing primitives become canonical-cohort-discipline.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COHORT_KEYS_DEFAULT_DIR,
  importPrivateKey,
  keyPaths,
} from "./key-surface.ts";
import {
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "./audit-verdict.ts";
import {
  computePayloadHash,
  parseDsseEnvelope,
} from "./audit-signature-chain.ts";

/**
 * Dispatch result returned by {@link autoWrapAuditVerdict}.
 *
 * `mode`: which Mode the dispatch resolved to.
 * `body`: the message body string to write to channel JSONL — either the
 *         DSSE envelope JSON (Mode A) or the original raw body unchanged
 *         (Mode C).
 * `warn`: stderr WARN message to emit when Mode C engaged (operator-discipline
 *         signal explaining how to engage Mode A). Undefined for Mode A.
 */
export type AutoWrapResult = {
  mode: "A" | "C";
  body: string;
  warn?: string;
};

/**
 * Options for {@link autoWrapAuditVerdict}.
 */
export type AutoWrapOptions = {
  /** Validated AuditVerdictBody (caller has already round-tripped through parseAuditVerdictBody). */
  parsedBody: AuditVerdictBody;
  /** Original body string (used as Mode C fallback emit; preserves operator intent on raw shape). */
  rawBody: string;
  /** Cohort channel id (used for prior-audit-lookup walk). */
  channelId: string;
  /** Channels directory (typically `~/.claude/channels/`); resolved via paths.ts in caller. */
  channelsDir: string;
  /** NATO identity for cohort key lookup (e.g., "charlie", "delta"). Caller resolves from CLAUDE_CONDUCTOR_NATO env or channel-meta. */
  nato: string;
  /** Cohort keys directory; defaults to `cohortKeysDir()` per paths.ts. */
  cohortDir?: string;
};

/**
 * SHA-256 shape predicate: exactly 64 hex characters [0-9a-f]. Used to
 * distinguish operator-supplied SHA-256 chain refs from UUID-shaped (36 char
 * with dashes) or other malformed values.
 */
function isSha256Hex(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length !== 64) return false;
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Walk a channel's JSONL backwards to find the most-recent audit-verdict
 * message. Returns the payload (base64-encoded canonical-JSON for v0.3 DSSE
 * envelopes; raw body bytes for pre-v0.3) suitable as input to
 * `computePayloadHash`, or null if no prior audit-verdict exists.
 *
 * Body resolution:
 *   - Inline `body` field on the JSONL line → use directly
 *   - `body_ref` UUID → read `bodies/<uuid>.txt` in the channel directory
 *
 * Per slice plan body §3.1 step 2: cheapest = walk back N entries find first
 * `kind=audit-verdict`. For channels with ~1-10 audit-verdicts (typical
 * Cycle 2 cohort use), linear-walk is acceptable; index optimization
 * deferred to Cycle 3 per slice plan §9 Q4.
 *
 * Returns `null` for:
 *   - Channel JSONL absent
 *   - No audit-verdict kind message present
 *   - Most-recent audit-verdict body unparseable
 *   - Most-recent audit-verdict body_ref file missing
 *
 * The null return is intentional — Mode A handler treats null prior as
 * "bootstrap audit-verdict on this channel" + sets `prev_audit_body_ref: null`.
 */
export function lookupPriorAuditVerdictPayload(
  channelsDir: string,
  channelId: string,
): string | null {
  const messagesPath = join(channelsDir, channelId, "messages.jsonl");
  if (!existsSync(messagesPath)) return null;
  const raw = readFileSync(messagesPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineStr = lines[i];
    if (lineStr === undefined) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(lineStr);
    } catch {
      continue;
    }
    if (msg["kind"] !== "audit-verdict") continue;
    let bodyStr: string | undefined;
    if (typeof msg["body"] === "string" && msg["body"].length > 0) {
      bodyStr = msg["body"];
    } else if (typeof msg["body_ref"] === "string") {
      const bodyPath = join(
        channelsDir,
        channelId,
        "bodies",
        `${msg["body_ref"]}.txt`,
      );
      if (existsSync(bodyPath)) {
        bodyStr = readFileSync(bodyPath, "utf-8");
      }
    }
    if (bodyStr === undefined) continue;
    const envelope = parseDsseEnvelope(bodyStr);
    if (envelope !== null) {
      return envelope.payload;
    }
    return bodyStr;
  }
  return null;
}

/**
 * Sync existsSync wrapper for cohort key file presence check. Used by
 * Mode dispatch — if neither pub nor sec key exists, fallback to Mode C.
 */
function cohortKeyResolvable(nato: string, cohortDir?: string): boolean {
  try {
    const paths = keyPaths(nato, cohortDir ?? COHORT_KEYS_DEFAULT_DIR);
    return existsSync(paths.secretKeyPath) && existsSync(paths.publicKeyPath);
  } catch {
    return false;
  }
}

/**
 * Auto-wrap dispatcher (Mode A vs Mode C) per slice plan body §3.3 behavior
 * matrix.
 *
 * Caller usage:
 *
 * ```ts
 * const parsedBody = parseAuditVerdictBody(rawBody);
 * if (parsedBody === null) die(...);
 * const result = await autoWrapAuditVerdict({
 *   parsedBody,
 *   rawBody,
 *   channelId,
 *   channelsDir: channelsDir(),
 *   nato: resolveNato(),
 * });
 * if (result.warn !== undefined) process.stderr.write(result.warn);
 * // Use result.body as the message body for channel send.
 * ```
 *
 * Per `[[feedback-substrate-fix-pattern-must-self-mirror]]` — bridges
 * operator-send path to the Layer 1.5 chain primitive.
 */
export async function autoWrapAuditVerdict(
  opts: AutoWrapOptions,
): Promise<AutoWrapResult> {
  const { parsedBody, rawBody, channelId, channelsDir, nato, cohortDir } = opts;

  // Body-shape gate: if operator-supplied prev_audit_body_ref is non-null and
  // non-SHA-256-shaped (UUID 36-char, literal "null" string, etc.) → Mode C
  // WARN.
  const operatorChainRef = parsedBody.prev_audit_body_ref;
  if (
    operatorChainRef !== undefined &&
    operatorChainRef !== null &&
    !isSha256Hex(operatorChainRef)
  ) {
    return {
      mode: "C",
      body: rawBody,
      warn:
        `[send] audit-verdict v0.3 chain auto-wrap NOT engaged: operator-supplied ` +
        `prev_audit_body_ref shape '${operatorChainRef.slice(0, 16)}${operatorChainRef.length > 16 ? "..." : ""}' ` +
        `does not match SHA-256 hex (expected 64 hex chars; got ${operatorChainRef.length} chars). ` +
        `Emitting legacy raw body with operator-supplied chain preserved. ` +
        `Per Cycle 2 substrate-debt slice plan body §3.3 Mode C. ` +
        `To engage Mode A auto-wrap: omit the field (let CLI compute) OR provide SHA-256 of prior canonical-JSON payload via computePayloadHash helper.\n`,
    };
  }

  // Cohort key gate: if cohort key file unresolvable, fall back to Mode C.
  if (!cohortKeyResolvable(nato, cohortDir)) {
    const expectedSec = keyPaths(
      nato,
      cohortDir ?? COHORT_KEYS_DEFAULT_DIR,
    ).secretKeyPath;
    return {
      mode: "C",
      body: rawBody,
      warn:
        `[send] audit-verdict v0.3 chain auto-wrap NOT engaged: cohort key file ` +
        `unresolvable for NATO '${nato}' (expected at ` +
        `\`${expectedSec}\`). ` +
        `Emitting legacy raw body (back-compat preserved). ` +
        `To engage Mode A v0.3 chain: run \`bun run conductor audit bootstrap\` to generate the cohort keypair, then re-send.\n`,
    };
  }

  // Mode A: cohort key resolvable + chain ref absent or null → auto-wrap.
  const paths = keyPaths(nato, cohortDir ?? COHORT_KEYS_DEFAULT_DIR);
  let secretKey: CryptoKey | null;
  try {
    secretKey = await importPrivateKey(paths.secretKeyPath);
  } catch {
    secretKey = null;
  }
  if (secretKey === null) {
    return {
      mode: "C",
      body: rawBody,
      warn:
        `[send] audit-verdict v0.3 chain auto-wrap NOT engaged: cohort key file ` +
        `present but failed to import for NATO '${nato}' (path: ` +
        `\`${paths.secretKeyPath}\`). Emitting legacy raw body. ` +
        `Check file permissions + format; run \`bun run conductor audit bootstrap --force\` to regenerate if corrupted.\n`,
    };
  }

  // Resolve chain ref: walk channel JSONL backwards for prior audit-verdict.
  const priorPayload = lookupPriorAuditVerdictPayload(channelsDir, channelId);
  let chainRef: string | null;
  if (priorPayload === null) {
    chainRef = null;
  } else {
    chainRef = await computePayloadHash(priorPayload);
  }

  // Construct new body with chain ref injected; clone parsedBody for immutability.
  const innerBody: AuditVerdictBody = {
    ...parsedBody,
    prev_audit_body_ref: chainRef,
  };

  const envelopeJson = await wrapAuditVerdictBody(innerBody, secretKey, nato);

  return {
    mode: "A",
    body: envelopeJson,
  };
}
