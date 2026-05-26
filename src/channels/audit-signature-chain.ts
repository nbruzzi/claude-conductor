// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Audit-verdict signature chain primitive (Cycle 1 substrate-core PR-A2;
 * Pair B Charlie-pen per slice plan `cycle-1-substrate-core-slice-plan-
 * 2026-05-26.md` §2.2 + §8 step 2).
 *
 * DSSE-wrapped per-message Ed25519 signature chain — resolves OBS-A
 * (HMAC framing was incorrect crypto-primitive naming per Delta Phase 0
 * fact-base catch; DSSE+Ed25519 is asymmetric not symmetric MAC).
 *
 * **Layer 1.5 substrate primitive.** Pure functions; no I/O; no CLI surface.
 * Consumers (PR-A6 `audit verify` CLI verb) compose these primitives with
 * key surface (PR-A3 `key-surface.ts` module) + storage (PR-A5 v0.3 DSSE
 * schema migration) to deliver verifier semantics.
 *
 * **PAE input format** per DSSE protocol §2
 * (https://github.com/secure-systems-lab/dsse/blob/master/protocol.md):
 *
 *     PAE = "DSSEv1" + SP + LEN(payloadType) + SP + payloadType
 *                    + SP + LEN(payload)     + SP + payload
 *
 * Where `LEN(x)` is ASCII-decimal byte-length and `SP` is single space
 * (0x20). Signature = `Ed25519.Sign(secret_key, PAE(payloadType, payload))`.
 *
 * **HYBRID lock 4-NATO ratify-clean** (cohort cycle 2026-05-26 OQ-2):
 *   - Identity attestation handled by DSSE `signatures[i].keyid`
 *     (outer envelope; advisory; verifier-side line-vs-envelope
 *     cross-check on `identity`); NO in-payload `signer_nato` field
 *   - Role attestation via in-payload `signer_role` field
 *     (signature-covered via PAE); line-vs-payload cross-check
 *     catches role-tamper at verify time
 *
 * **Chain construction (DC-2):**
 *   - In-payload `prev_audit_body_ref` field carries SHA-256 of the
 *     prior audit-verdict's canonical-JSON payload bytes
 *   - First audit-verdict in a channel: `prev_audit_body_ref: null`
 *     per Charlie Obs-5 HYBRID write-side canonical
 *   - Verifier walks the chain by reading audit-verdicts in `ts` order,
 *     hashing each payload, and verifying it matches the next entry's
 *     `prev_audit_body_ref`
 *
 * **Why per-message + payload-graph chain vs Signal-style key-graph
 * ratchet:** tamper-evidence (cohort goal) is not forward secrecy
 * (Signal goal); per-message sig is simpler to verify; chain integrity
 * comes from payload graph not key graph. Each individual sig is
 * independently verifiable given the public key.
 *
 * Per the verification-budget convention: this module trusts SHAPE of
 * inputs (caller is responsible for providing parseable JSON for
 * `payload` and a valid Ed25519 key for `secretKey`); validates
 * cryptographic correctness; surfaces concrete error types for
 * caller-side error policy decisions.
 */

/**
 * Canonical DSSE payloadType for audit-verdict bodies in
 * claude-conductor cohort cycle.
 *
 * Per RFC 6838 (Media Type Specifications and Registration Procedures)
 * `application/vnd.<vendor>.<product>+<suffix>` structure.
 */
export const AUDIT_VERDICT_PAYLOAD_TYPE =
  "application/vnd.claude-conductor.audit-verdict+json";

/**
 * DSSE envelope shape per DSSE protocol §3
 * (https://github.com/secure-systems-lab/dsse/blob/master/protocol.md).
 *
 * Caller serializes this to JSON for storage on the channel JSONL line
 * `body` field; reader parses + validates via {@link parseDsseEnvelope}.
 *
 * `signatures` is a non-empty array per DSSE spec. For claude-conductor
 * cohort cycle Cycle 1: single-signer per envelope (each NATO signs
 * their own audit-verdicts); future cycles may extend to multi-signer
 * for compromise-revocation co-signing per OQ-4.
 */
export type DsseEnvelope = {
  /**
   * MIME-type-style payload identifier. Required per DSSE spec; enables
   * envelope-type dispatch on read-side.
   */
  payloadType: string;
  /**
   * Base64-encoded canonical-JSON of the inner audit-verdict body.
   * Signature scope (PAE input) covers this string; envelope-level
   * fields (`payloadType`, `signatures[i].keyid`) are NOT in the
   * signature scope.
   */
  payload: string;
  /**
   * Non-empty array of signer attestations. Each entry has the
   * verifier key lookup hint (`keyid`; advisory; NOT signature-covered)
   * and the Ed25519 signature bytes (base64-encoded).
   */
  signatures: readonly { keyid: string; sig: string }[];
};

/**
 * Single signature entry inside a {@link DsseEnvelope}.
 *
 * `keyid` is the NATO identifier (e.g., `"charlie"`); verifier resolves
 * this against the cohort's pubkey trust set (per PR-A3 key surface +
 * PR-A4 bootstrap). Tampering with `keyid` post-sign does NOT break the
 * signature (per DSSE spec §2 PAE input excludes envelope fields);
 * line-vs-envelope cross-check on JSONL `identity` field catches the
 * tamper at verify time.
 *
 * `sig` is the base64-encoded Ed25519 signature over
 * `PAE(payloadType, payload)`. Verifier reproduces PAE input from
 * envelope payloadType + payload and validates signature against the
 * resolved pubkey.
 */
export type DsseSignature = DsseEnvelope["signatures"][number];

/**
 * Concrete error variants raised by signature-chain operations.
 * Caller-side error policy: pattern-match on `kind` to dispatch.
 *
 * Per the cohort error-policy discipline (sibling to
 * `parseAuditVerdictBody` returning `null`): structured error variants
 * give callers actionable distinctions rather than a single opaque
 * exception type.
 */
export type SignatureChainError =
  | { kind: "envelope-shape-invalid"; detail: string }
  | { kind: "payload-decode-failed"; detail: string }
  | { kind: "signature-verify-failed"; detail: string }
  | { kind: "key-resolution-failed"; detail: string };

/**
 * Construct DSSE PAE (Pre-Authentication Encoding) input bytes per
 * DSSE protocol §2.
 *
 * PAE input format:
 *
 *     "DSSEv1" + SP + LEN(payloadType) + SP + payloadType
 *              + SP + LEN(payload)     + SP + payload
 *
 * Where `LEN(x)` is ASCII-decimal byte-length and `SP` is single space.
 *
 * `payload` is the base64-encoded canonical-JSON of the inner body
 * (matches DSSE envelope `payload` field; both PAE input and envelope
 * field use the same base64 string).
 *
 * Returns `Uint8Array` of PAE bytes suitable as Ed25519 sign/verify
 * input. Pure function (no I/O; no side effects).
 */
export function constructPae(
  payloadType: string,
  payload: string,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const payloadTypeBytes = encoder.encode(payloadType);
  const payloadBytes = encoder.encode(payload);
  const prefix = `DSSEv1 ${payloadTypeBytes.length} ${payloadType} ${payloadBytes.length} `;
  const prefixBytes = encoder.encode(prefix);
  // Explicit ArrayBuffer (not ArrayBufferLike) for crypto.subtle compatibility
  // — Bun + TS 5.x narrowed Uint8Array's ArrayBufferLike to require an
  // explicit ArrayBuffer (not SharedArrayBuffer) for WebCrypto API parameters.
  const buffer = new ArrayBuffer(prefixBytes.length + payloadBytes.length);
  const out = new Uint8Array(buffer);
  out.set(prefixBytes, 0);
  out.set(payloadBytes, prefixBytes.length);
  return out;
}

/**
 * Encode bytes as base64 string per RFC 4648 §4 canonical encoding
 * (no line breaks; trailing `=` padding present).
 *
 * Uses Bun's built-in `Buffer.toString("base64")` which produces
 * canonical no-line-break output suitable for DSSE envelope `payload`
 * and `signatures[i].sig` fields.
 */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Decode base64 string per RFC 4648 §4. Returns `Uint8Array` on success.
 * Returns null on malformed base64 (lets caller dispatch on
 * decode-failure separately from verify-failure).
 *
 * Bun's `Buffer.from(str, "base64")` is permissive (silently truncates
 * on malformed input rather than throwing). Round-trip equality check
 * detects malformed input.
 */
export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.toString("base64") !== b64) {
      return null;
    }
    // Copy into a fresh ArrayBuffer-backed Uint8Array so the return type
    // satisfies crypto.subtle.{sign,verify}(BufferSource) which requires
    // Uint8Array<ArrayBuffer> (not ArrayBufferLike) under TS 5.x lib types.
    const copy = new ArrayBuffer(buf.byteLength);
    new Uint8Array(copy).set(buf);
    return new Uint8Array(copy);
  } catch {
    return null;
  }
}

/**
 * Sign a payload via Ed25519 per RFC 8032 + wrap in a DSSE envelope.
 *
 * `payload` is the base64-encoded canonical-JSON of the inner
 * audit-verdict body; caller is responsible for canonical-JSON
 * serialization + base64 encoding before calling this function.
 * (Rationale: PAE covers the base64 string verbatim; canonical-JSON
 * shape is a caller-side concern decoupled from signature primitive.)
 *
 * `secretKey` is a `CryptoKey` produced by Bun's Web Crypto API
 * `crypto.subtle.generateKey({name: "Ed25519"}, ...)`. Caller-side key
 * mgmt is the responsibility of PR-A3 `key-surface.ts` module.
 *
 * `keyid` is the NATO identifier (e.g., `"charlie"`); placed in DSSE
 * envelope `signatures[0].keyid` for verifier key lookup.
 *
 * Returns `DsseEnvelope` on success; throws on Web Crypto signing
 * failure (key-shape mismatch; algorithm mismatch). Throwing vs
 * returning null: cryptographic signing failure is exceptional
 * (caller likely has a bug); reserve error-variant returns for
 * shape-level + recoverable failures.
 */
export async function signPayload(
  payload: string,
  secretKey: CryptoKey,
  keyid: string,
): Promise<DsseEnvelope> {
  const pae = constructPae(AUDIT_VERDICT_PAYLOAD_TYPE, payload);
  const sigBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    secretKey,
    pae,
  );
  const sig = encodeBase64(new Uint8Array(sigBytes));
  return {
    payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
    payload,
    signatures: [{ keyid, sig }],
  };
}

/**
 * Verify a DSSE envelope's signature against a resolved public key.
 *
 * Returns `{ ok: true }` on successful Ed25519 verify. Returns
 * `{ ok: false, error }` with concrete error variant on failure.
 *
 * `publicKey` is a `CryptoKey` produced by Bun's Web Crypto API
 * import of the verifier-side pubkey (see PR-A3 + PR-A6).
 *
 * Caller is responsible for:
 *   - Resolving the correct pubkey via `envelope.signatures[i].keyid`
 *     (e.g., looking up `~/.claude/keys/cohort/<nato>.ed25519.pub`)
 *   - Pattern-matching on envelope.signatures[] for multi-signer
 *     envelopes (Cycle 1 ships single-signer per envelope)
 *   - Cross-checking JSONL line `identity` vs `envelope.signatures[i].keyid`
 *     (verifier-side line-vs-envelope cross-check per HYBRID lock
 *     identity-tamper-detection rule)
 */
export async function verifyEnvelope(
  envelope: DsseEnvelope,
  publicKey: CryptoKey,
  signatureIndex: number = 0,
): Promise<{ ok: true } | { ok: false; error: SignatureChainError }> {
  const sigEntry = envelope.signatures[signatureIndex];
  if (sigEntry === undefined) {
    return {
      ok: false,
      error: {
        kind: "envelope-shape-invalid",
        detail: `signatures[${signatureIndex}] not present (envelope has ${envelope.signatures.length} signatures)`,
      },
    };
  }
  const sigBytes = decodeBase64(sigEntry.sig);
  if (sigBytes === null) {
    return {
      ok: false,
      error: {
        kind: "envelope-shape-invalid",
        detail: `signatures[${signatureIndex}].sig is not valid base64`,
      },
    };
  }
  const pae = constructPae(envelope.payloadType, envelope.payload);
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    sigBytes,
    pae,
  );
  if (!ok) {
    return {
      ok: false,
      error: {
        kind: "signature-verify-failed",
        detail: `Ed25519 signature verify returned false (tamper detected OR wrong key OR malformed payload)`,
      },
    };
  }
  return { ok: true };
}

/**
 * Parse a DSSE envelope from JSON-serialized string. Returns the
 * envelope on success; null on shape mismatch.
 *
 * Sibling discipline to {@link parseAuditVerdictBody} — permissive on
 * extra fields; strict on required-field shape.
 */
export function parseDsseEnvelope(json: string): DsseEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const payloadType = obj["payloadType"];
  if (typeof payloadType !== "string" || payloadType.length === 0) return null;
  const payload = obj["payload"];
  if (typeof payload !== "string" || payload.length === 0) return null;
  const signaturesRaw = obj["signatures"];
  if (!Array.isArray(signaturesRaw) || signaturesRaw.length === 0) return null;
  const signatures: DsseSignature[] = [];
  for (const sigEntry of signaturesRaw) {
    if (
      sigEntry === null ||
      typeof sigEntry !== "object" ||
      Array.isArray(sigEntry)
    ) {
      return null;
    }
    const sigObj = sigEntry as Record<string, unknown>;
    const keyid = sigObj["keyid"];
    if (typeof keyid !== "string" || keyid.trim().length === 0) return null;
    const sig = sigObj["sig"];
    if (typeof sig !== "string" || sig.length === 0) return null;
    signatures.push({ keyid, sig });
  }
  return { payloadType, payload, signatures };
}

/**
 * Compute SHA-256 of a payload string (envelope.payload field; base64
 * canonical-JSON) — used as the in-payload `prev_audit_body_ref` chain
 * pointer per DC-2.
 *
 * Returns the hash as lowercase hex string (64 chars). Pure function;
 * no I/O.
 *
 * Verifier-side: walk audit-verdicts in `ts` order; for each entry
 * after the bootstrap, verify `entry.body.prev_audit_body_ref ===
 * await computePayloadHash(prevEntry.envelope.payload)`. Mismatch =
 * chain break = `breaks[].reason: "tamper"`.
 */
export async function computePayloadHash(payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (const byte of hashArray) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Encode a canonical-JSON-serialized body string as the DSSE envelope
 * `payload` field (base64-encoded). Convenience wrapper around
 * {@link encodeBase64} for caller-side use during envelope construction.
 */
export function encodePayload(canonicalJson: string): string {
  return encodeBase64(new TextEncoder().encode(canonicalJson));
}

/**
 * Decode a DSSE envelope `payload` field back to canonical-JSON string.
 * Returns null on base64-decode failure.
 *
 * Use `parseAuditVerdictBody` on the decoded string to parse the
 * inner audit-verdict body.
 */
export function decodePayload(payload: string): string | null {
  const bytes = decodeBase64(payload);
  if (bytes === null) return null;
  return new TextDecoder().decode(bytes);
}
