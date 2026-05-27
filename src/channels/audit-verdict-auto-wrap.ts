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
 *   - `"A"`: cohort key resolvable + chain ref absent or null + no opt-out →
 *     auto-computed chain ref from channel JSONL walk + DSSE envelope.
 *   - `"B"`: cohort key resolvable + operator-supplied SHA-256-hex chain ref →
 *     operator value trusted as-is + DSSE envelope (no channel-JSONL walk;
 *     no overwrite). Per Cycle 2 Stage 2 slice plan body §3.3 + Charlie S2-A.
 *   - `"C"`: cohort key unresolvable OR operator chain ref non-SHA-256-shaped →
 *     raw body emitted unchanged + stderr WARN.
 *   - `"D"`: cohort key resolvable + operator-explicit opt-out via
 *     `forceNoChain: true` → DSSE envelope with `prev_audit_body_ref: null`,
 *     bypassing both Mode A walk + Mode B operator-trust. Per Cycle 2 Stage 3
 *     slice plan body §3.3 + Charlie S3-A.
 * `body`: the message body string to write to channel JSONL — either the
 *         DSSE envelope JSON (Mode A, B, or D) or the original raw body unchanged
 *         (Mode C).
 * `warn`: stderr WARN message to emit when Mode C engaged (operator-discipline
 *         signal explaining how to engage Mode A). Undefined for Mode A, B, and D.
 */
export type AutoWrapResult = {
  mode: "A" | "B" | "C" | "D";
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
  /**
   * Operator-explicit chain-ref opt-out flag (Mode D engagement signal). When
   * `true` AND cohort key resolvable, dispatcher engages Mode D: produces DSSE
   * envelope with `prev_audit_body_ref: null`, bypassing both Mode A walk-and-
   * compute AND Mode B operator-trust paths. The CLI surfaces this via a
   * `--no-chain` flag (cli.ts send subcommand). When `true` but cohort key
   * unresolvable, dispatcher falls back to Mode C (raw + WARN) — same as
   * Mode A's unresolvable-key behavior. Default undefined / false. Per Cycle
   * 2 Stage 3 slice plan body §3.3 Mode D framing.
   *
   * **Mutual exclusion**: CLI caller must reject the combination of
   * `forceNoChain: true` AND a non-null operator-supplied `prev_audit_body_ref`
   * BEFORE invoking the dispatcher — that combination is semantically
   * contradictory (operator asked to opt out AND supplied a chain ref). The
   * dispatcher does NOT re-verify the mutex; it engages Mode D unconditionally
   * when `forceNoChain` is true. CLI-side mutex is sufficient because the
   * dispatcher is internal substrate; the operator-path mutex is the
   * affordance-layer enforcement.
   */
  forceNoChain?: boolean;
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
  const {
    parsedBody,
    rawBody,
    channelId,
    channelsDir,
    nato,
    cohortDir,
    forceNoChain,
  } = opts;

  // Body-shape gate: if operator-supplied prev_audit_body_ref is non-null and
  // non-SHA-256-shaped (UUID 36-char, literal "null" string, etc.) → Mode C
  // WARN. Note: this gate runs BEFORE the Mode D check because operator-
  // supplied malformed chain refs should always surface as Mode C operator-
  // discipline signals, regardless of whether the CLI also passed
  // `--no-chain`. The CLI-side mutex (see JSDoc on AutoWrapOptions.
  // forceNoChain) prevents the legitimate combination of forceNoChain=true
  // + valid SHA-256 chain ref from reaching this branch — any such combination
  // here indicates a malformed operator body that should fail Mode C anyway.
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

  // Mode D (Stage 3 S3-A — Charlie-pen Lane P Mode D per slice plan body §3.3):
  // operator-explicit chain-ref opt-out via `forceNoChain: true` + cohort key
  // resolvable → produce DSSE envelope with `prev_audit_body_ref: null`,
  // bypassing BOTH the Mode A channel-JSONL walk + computePayloadHash AND the
  // Mode B operator-supplied trust path. Mode D is the operator-explicit
  // alternative to Mode A's implicit-null behavior (when channel JSONL has no
  // prior audit-verdict).
  //
  // Use cases for Mode D:
  //   - Operator wants this audit-verdict to be standalone (no chain to prior);
  //     cross-cohort interop scenarios where chaining across cohorts has no
  //     semantic meaning.
  //   - Bootstrap audit-verdict on a fresh channel where prior is intentionally
  //     absent (semantically equivalent envelope to Mode A's null-prior path
  //     but operator-intent-tagged via explicit flag).
  //   - Cohort-policy override: cohort decides certain audit-verdicts should
  //     not chain (e.g., test-fixture audits in development; out-of-band ad
  //     hoc audits).
  //
  // Mode D placement is BEFORE Mode B because forceNoChain is an operator-
  // explicit signal that takes precedence over operator-supplied chain ref
  // (operator MUST NOT supply both — CLI-side mutex enforces this). If the
  // dispatcher receives forceNoChain=true AND a SHA-256 chain ref, the
  // CLI-side mutex has failed; Mode D still engages (defense-in-depth — opt-
  // out wins on ambiguity since it's the operator's explicit safety signal).
  if (forceNoChain === true) {
    const innerBody: AuditVerdictBody = {
      ...parsedBody,
      prev_audit_body_ref: null,
    };
    const envelopeJson = await wrapAuditVerdictBody(innerBody, secretKey, nato);
    return {
      mode: "D",
      body: envelopeJson,
    };
  }

  // Mode B (Stage 2 S2-A — Charlie-pen Lane P Mode B per slice plan body §3.3):
  // operator-supplied SHA-256-hex chain ref + cohort key resolvable → trust the
  // operator value + wrap in DSSE envelope. Skips the channel-JSONL walk +
  // `computePayloadHash` steps that Mode A performs; operator's explicit chain
  // ref is preserved as-is in the inner body.
  //
  // Use cases for Mode B:
  //   - Operator has external context about which prior audit-verdict the
  //     cohort chains to (e.g., cross-channel chain reference where the
  //     channel-JSONL walk would not find the prior payload).
  //   - Operator builds programmatic envelope flows that pre-compute chain ref
  //     via `computePayloadHash` against a payload not visible on the active
  //     channel JSONL.
  //   - Operator wants to chain to a specific historical audit-verdict
  //     (e.g., bypassing intermediate audit-verdicts on the same channel).
  //
  // Mode B does NOT verify that the operator-supplied SHA-256 hex is the
  // RIGHT SHA-256 — that would require knowing which prior payload was
  // intended, which is precisely the context Mode B trusts the operator to
  // supply. Cohort discipline depends on the trust chain (operator supplying
  // legitimate chain refs); Mode B is the canonical operator path for
  // explicit-chain-ref scenarios. Pre-Mode-B behavior at this code site
  // OVERWROTE the operator's chain ref with the channel-JSONL-walk-computed
  // value — that was the substrate-debt this branch closes per slice plan
  // §3.3 Mode B framing.
  if (
    operatorChainRef !== undefined &&
    operatorChainRef !== null &&
    isSha256Hex(operatorChainRef)
  ) {
    const innerBody: AuditVerdictBody = {
      ...parsedBody,
      prev_audit_body_ref: operatorChainRef,
    };
    const envelopeJson = await wrapAuditVerdictBody(innerBody, secretKey, nato);
    return {
      mode: "B",
      body: envelopeJson,
    };
  }

  // Mode A: cohort key resolvable + chain ref absent or null → auto-wrap.
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
