// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `key-revoke` message kind — shared body parser + schema type (Cycle 1
 * substrate-core PR-A7; Pair B Delta-pen capacity-take per cohort
 * `feedback-cohort-standby-standoff-anti-pattern` rule + Pair B slice
 * plan body §5 flexibility-clause invocation at Charlie 19:42Z
 * tool-flow-accuracy explicit-defer).
 *
 * Posted by the operator revoking their own Ed25519 key, OR by cohort
 * members co-signing a revocation when a compromise is detected. The
 * audit verify CLI (PR-A6) consumes key-revoke history via the
 * `<nato>.history.json` key file maintenance path: revoked entries map
 * to `breaks[].reason = "revoked-key"` per the 3-class break taxonomy
 * (sub-Obs-6a + DC-5) distinct from `"tamper"` (signature failure) and
 * `"key-rotation-discontinuity"` (chain gap / no covering history entry).
 *
 * **Schema rationale (sibling to `AuditVerdictBody` + `LiveUpdateBody` +
 * `DigestBody` + `AuditAskBody`):** structured body shape earns the new
 * kind. Per Pair B slice plan body §2.5 LOCKED contract + §4.3 key-
 * rotation contract — the wire-format here drives `<nato>.history.json`
 * maintenance which feeds resolveKeyAtTime (key-surface.ts) which feeds
 * verifyChannelAuditChain (verify.ts).
 *
 * **Verification-budget contract for `key-revoke`:** readers trust the
 * SHAPE returned by this parser (validator-enforced) but must primary-
 * source-verify (a) `signed_by[]` actually contains the revoking NATO,
 * (b) `revoked_at` is a Date.parse-valid ISO-8601 string, (c) signature
 * coverage when the body is DSSE-wrapped (future PR-A10 cohort verdict).
 * For compromise scenarios, future cohort design may require N-of-cohort
 * co-signing — deferred per §2.5 prose.
 *
 * **Why a new kind vs extending `note` or `audit-verdict`:** key-revoke
 * has heavily structured body (7 typed fields incl. 3-class reason +
 * nullable replacement_fingerprint + signed_by[] cohort co-sign list)
 * with semantics orthogonal to audit-verdict (which carries audit-loop
 * close-ask + findings). Per the walkie-talkie kinds + verification-
 * budget convention.
 *
 * Plan: `~/.claude/plans/cycle-1-substrate-core-slice-plan-2026-05-26.md`
 * §2.5 + §4.3 + §8 step 7.
 */

/**
 * 3-class revocation reason per Pair B body §2.5 LOCKED. Each variant
 * maps to a distinct cohort-operational-response path:
 *
 *   - `"compromise"` — private key suspected leaked / exfiltrated /
 *     unauthorized signing detected. Triggers cohort key-revoke
 *     co-signing recommendation (future DC); audit verify maps to
 *     `breaks[].reason = "revoked-key"` for all signatures by this key
 *     after `revoked_at`.
 *   - `"rotation"` — operator-intentional key rotation (e.g., periodic
 *     hygiene; no compromise). `replacement_fingerprint` SHOULD be
 *     populated with the new active key's fingerprint to enable
 *     verifier-side continuity.
 *   - `"operator-departure"` — NATO identity retiring from the cohort
 *     (operator no longer participating). `replacement_fingerprint`
 *     typically `null` (no successor). Future Pair-A-PR-A4 lineage verify
 *     may use this signal for content-pointer resolution against
 *     historical artifacts.
 */
export type RevocationReason = "compromise" | "rotation" | "operator-departure";

const REVOCATION_REASONS: readonly RevocationReason[] = [
  "compromise",
  "rotation",
  "operator-departure",
] as const;

/**
 * Type guard for {@link RevocationReason}. Returns true iff the value
 * is one of the three LOCKED reason variants per Pair B body §2.5.
 */
export function isRevocationReason(v: unknown): v is RevocationReason {
  return (
    typeof v === "string" &&
    (REVOCATION_REASONS as readonly string[]).includes(v)
  );
}

/**
 * Body schema for the `key-revoke` kind per Pair B slice plan body §2.5
 * LOCKED. JSON-serialized to the JSONL line `body` field at write time;
 * parsed on read via {@link parseKeyRevokeBody}.
 *
 * `kind_version: 1` matches the sibling-kind schema-version convention
 * (audit-verdict + audit-ask + memory-proposal + wind-down-checkin all
 * stay at literal 1). Today's parser accepts only version `1`; mis-
 * versioned bodies return `null`.
 *
 * **Required fields:** all except `replacement_fingerprint` (nullable
 * per `operator-departure` + `compromise` without successor scenarios).
 *
 * **`signed_by` non-empty invariant:** at minimum the revoking operator
 * themselves. For compromise cases, cohort may require N-of-cohort
 * co-signing (deferred per §2.5 prose; parser enforces ≥1 only).
 */
export type KeyRevokeBody = {
  /** Schema version literal. Stays at 1; future migrations are additive optional. */
  kind_version: 1;
  /**
   * NATO identifier of the operator whose key is being revoked
   * (e.g., "Alpha", "Delta"). Non-empty-post-trim string.
   */
  revoked_nato: string;
  /**
   * SHA-256 fingerprint of the revoked public key (hex; matches
   * `KeyHistoryEntry.fingerprint` per PR-A3 key-surface.ts). Used by
   * verifier-side history-file maintenance to mark the specific key
   * entry as `status: "revoked"`.
   */
  revoked_fingerprint: string;
  /**
   * ISO-8601 timestamp when the key was revoked. Verifier uses this to
   * mark `KeyHistoryEntry.active_until` (transitions the entry from
   * `status: "active"` to `status: "revoked"`). Must be Date.parse-able.
   */
  revoked_at: string;
  /**
   * 3-class reason per §2.5 LOCKED + sub-Obs-6a — distinct operational
   * remediation paths. See {@link RevocationReason} JSDoc for per-class
   * semantics.
   */
  reason: RevocationReason;
  /**
   * SHA-256 fingerprint of the replacement key (when a new active key
   * is taking over). `null` when no replacement exists (compromise
   * without rotation, operator-departure, emergency revocation). Cohort
   * verifier consults the NATO's history file to resolve replacement
   * key path when this is populated.
   */
  replacement_fingerprint: string | null;
  /**
   * NATO identifiers of cohort members signing this revocation. Min-1
   * (revoking operator themselves). For compromise scenarios, future
   * cohort design MAY require N-of-cohort co-signing (deferred per §2.5).
   * Each entry is a non-empty-post-trim string.
   */
  signed_by: readonly string[];
};

/**
 * Parse a `key-revoke` message body into a typed {@link KeyRevokeBody}.
 * Returns `null` on any shape mismatch.
 *
 * Caller-side error policy: `null` is intentional — callers MUST choose
 * between log-and-skip OR adding a NEW shared parser variant
 * (sibling to `parseAuditVerdictBody` + `parseDigestBody` + others).
 *
 * The parser is intentionally permissive on EXTRA fields (forward-
 * compatible). Author may include additional fields on the outer body
 * (e.g., `detail`, `co_signing_thread_ref`) — they are silently passed
 * through without validation OR carried in the returned object.
 *
 * **Trim discipline (mirror of parseLiveUpdateBody + parseAuditVerdictBody):**
 *  `revoked_nato` + `revoked_fingerprint` + each `signed_by[i]` are
 *  whitespace-normalized on OUTPUT. `revoked_at` is NOT trimmed because
 *  ISO-8601 format doesn't tolerate surrounding whitespace at parse time.
 */
export function parseKeyRevokeBody(body: string): KeyRevokeBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  if (obj["kind_version"] !== 1) return null;

  // revoked_nato — required non-empty-post-trim string.
  const revokedNatoRaw = obj["revoked_nato"];
  if (
    typeof revokedNatoRaw !== "string" ||
    revokedNatoRaw.trim().length === 0
  ) {
    return null;
  }

  // revoked_fingerprint — required non-empty-post-trim string. (SHA-256
  // hex format validation deferred; verifier-side check at history-file
  // maintenance time per substrate-precedes-consumer cadence.)
  const revokedFingerprintRaw = obj["revoked_fingerprint"];
  if (
    typeof revokedFingerprintRaw !== "string" ||
    revokedFingerprintRaw.trim().length === 0
  ) {
    return null;
  }

  // revoked_at — required Date.parse-able ISO-8601 string. Reject empty
  // (Date.parse("") returns NaN on V8 but is brittle; explicit length check).
  const revokedAtRaw = obj["revoked_at"];
  if (typeof revokedAtRaw !== "string" || revokedAtRaw.length === 0) {
    return null;
  }
  if (Number.isNaN(Date.parse(revokedAtRaw))) {
    return null;
  }

  // reason — required RevocationReason 3-class literal.
  const reasonRaw = obj["reason"];
  if (!isRevocationReason(reasonRaw)) return null;

  // replacement_fingerprint — required (must be present); nullable
  // (null for departure/compromise without successor). Reject undefined
  // (must be explicit per HYBRID-style canonical write-side discipline).
  // Reject empty-post-trim strings.
  if (!("replacement_fingerprint" in obj)) return null;
  const replacementFingerprintRaw = obj["replacement_fingerprint"];
  let replacementFingerprint: string | null;
  if (replacementFingerprintRaw === null) {
    replacementFingerprint = null;
  } else if (
    typeof replacementFingerprintRaw === "string" &&
    replacementFingerprintRaw.trim().length > 0
  ) {
    replacementFingerprint = replacementFingerprintRaw.trim();
  } else {
    return null;
  }

  // signed_by — required non-empty array of non-empty-post-trim strings.
  const signedByRaw = obj["signed_by"];
  if (!Array.isArray(signedByRaw) || signedByRaw.length === 0) return null;
  const signedBy: string[] = [];
  for (const entry of signedByRaw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return null;
    }
    signedBy.push(entry.trim());
  }

  return {
    kind_version: 1,
    revoked_nato: revokedNatoRaw.trim(),
    revoked_fingerprint: revokedFingerprintRaw.trim(),
    revoked_at: revokedAtRaw,
    reason: reasonRaw,
    replacement_fingerprint: replacementFingerprint,
    signed_by: signedBy,
  };
}

/**
 * Type guard for {@link KeyRevokeBody}. Returns true iff
 * {@link parseKeyRevokeBody} would succeed on the value passed as a
 * JSON-stringified body (no convenience overload — pass JSON strings).
 *
 * Sibling pattern: `isAuditVerdictBody` is NOT exported (parseAuditVerdictBody
 * is the canonical entry point); this guard exists for symmetry with
 * `isLineageEnvelope` (Pair A) for caller-side narrowing on already-
 * validated values.
 */
export function isKeyRevokeBody(v: unknown): v is KeyRevokeBody {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  // Round-trip through JSON to leverage the canonical parser. Cheap
  // for the structured-kind body sizes (under 1KB typical).
  try {
    return parseKeyRevokeBody(JSON.stringify(v)) !== null;
  } catch {
    return false;
  }
}
