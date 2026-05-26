// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for audit-verdict signature chain primitive (Cycle 1 substrate-core
 * PR-A2; Pair B Charlie-pen per slice plan
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §6.1 test plan).
 *
 * Coverage:
 *   - Section 1: PAE construction (DSSE protocol §2)
 *   - Section 2: base64 roundtrip + malformed-input rejection
 *   - Section 3: Ed25519 sign + verify roundtrip
 *   - Section 4: tamper detection (payload + signature + envelope mutation)
 *   - Section 5: DSSE envelope parse + shape validation
 *   - Section 6: payload hash + chain construction
 *   - Section 7: payload encode/decode roundtrip
 *   - Section 8: end-to-end chain smoke test (3-entry sign + verify)
 */

import { describe, expect, it } from "bun:test";
import {
  AUDIT_VERDICT_PAYLOAD_TYPE,
  constructPae,
  decodeBase64,
  decodePayload,
  encodeBase64,
  encodePayload,
  computePayloadHash,
  parseDsseEnvelope,
  signPayload,
  verifyEnvelope,
} from "../../src/channels/audit-signature-chain.ts";

/**
 * Helper: generate a fresh Ed25519 keypair for sign/verify tests.
 * Uses Bun's Web Crypto API which supports Ed25519 since Bun 1.0+.
 */
async function generateTestKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
}

/**
 * Unwrap nullable value with explicit assertion. Replaces forbidden `!`
 * non-null assertions per cohort lint discipline
 * (@typescript-eslint/no-non-null-assertion). Throws if value is null
 * or undefined (caller-side has already verified via `expect(...).not.toBeNull()`).
 */
function unwrap<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`unwrap: expected non-null/non-undefined ${label}`);
  }
  return value;
}

// Section 1: PAE construction (DSSE protocol §2)
describe("constructPae — Section 1: PAE input format per DSSE spec §2", () => {
  it("T1.1: produces correctly-formatted PAE bytes for empty payload", () => {
    const pae = constructPae("application/json", "");
    // PAE = "DSSEv1" + SP + "16" + SP + "application/json" + SP + "0" + SP + ""
    expect(new TextDecoder().decode(pae)).toBe("DSSEv1 16 application/json 0 ");
  });

  it("T1.2: produces correctly-formatted PAE bytes for non-empty payload", () => {
    const pae = constructPae("application/json", "hello");
    expect(new TextDecoder().decode(pae)).toBe(
      "DSSEv1 16 application/json 5 hello",
    );
  });

  it("T1.3: uses byte-length not char-length for multi-byte chars", () => {
    // UTF-8 byte length of "héllo" is 6 (é is 2 bytes in UTF-8) — 5 chars
    const pae = constructPae("application/json", "héllo");
    expect(new TextDecoder().decode(pae)).toBe(
      "DSSEv1 16 application/json 6 héllo",
    );
  });

  it("T1.4: handles claude-conductor canonical payloadType", () => {
    const pae = constructPae(AUDIT_VERDICT_PAYLOAD_TYPE, "X");
    const expected = `DSSEv1 ${AUDIT_VERDICT_PAYLOAD_TYPE.length} ${AUDIT_VERDICT_PAYLOAD_TYPE} 1 X`;
    expect(new TextDecoder().decode(pae)).toBe(expected);
  });

  it("T1.5: returns Uint8Array (not string)", () => {
    const pae = constructPae("a", "b");
    expect(pae).toBeInstanceOf(Uint8Array);
  });
});

// Section 2: base64 roundtrip + malformed-input rejection
describe("base64 — Section 2: roundtrip + malformed-input handling", () => {
  it("T2.1: encodeBase64 + decodeBase64 roundtrip preserves bytes", () => {
    const original = new Uint8Array([0xff, 0x00, 0x42, 0xaa, 0x55]);
    const encoded = encodeBase64(original);
    const decoded = decodeBase64(encoded);
    expect(decoded).not.toBeNull();
    expect(Array.from(unwrap(decoded))).toEqual(Array.from(original));
  });

  it("T2.2: encodeBase64 produces canonical no-line-break output", () => {
    const bytes = new Uint8Array(100);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i;
    }
    const encoded = encodeBase64(bytes);
    expect(encoded).not.toContain("\n");
    expect(encoded).not.toContain("\r");
  });

  it("T2.3: encodeBase64 + decodeBase64 roundtrip on empty input", () => {
    const original = new Uint8Array(0);
    const encoded = encodeBase64(original);
    expect(encoded).toBe("");
    const decoded = decodeBase64(encoded);
    expect(decoded).not.toBeNull();
    expect(unwrap(decoded).length).toBe(0);
  });

  it("T2.4: decodeBase64 rejects malformed input (non-base64 chars)", () => {
    const malformed = "!!!not-valid-base64!!!";
    expect(decodeBase64(malformed)).toBeNull();
  });

  it("T2.5: decodeBase64 rejects input with missing padding", () => {
    // "hello" -> base64 = "aGVsbG8=" (canonical includes padding)
    // Missing-padding variant should fail round-trip check
    const expectedCanonical = encodeBase64(new TextEncoder().encode("hello"));
    expect(expectedCanonical).toBe("aGVsbG8=");
    const missingPadding = "aGVsbG8";
    expect(decodeBase64(missingPadding)).toBeNull();
  });
});

// Section 3: Ed25519 sign + verify roundtrip
describe("signPayload + verifyEnvelope — Section 3: Ed25519 roundtrip", () => {
  it("T3.1: sign + verify roundtrip succeeds for canonical payload", async () => {
    const keypair = await generateTestKeypair();
    const payload = encodePayload(
      JSON.stringify({ kind_version: 1, signer_role: "queue" }),
    );
    const envelope = await signPayload(payload, keypair.privateKey, "charlie");
    expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
    expect(envelope.payload).toBe(payload);
    expect(envelope.signatures).toHaveLength(1);
    expect(unwrap(envelope.signatures[0]).keyid).toBe("charlie");
    const result = await verifyEnvelope(envelope, keypair.publicKey);
    expect(result.ok).toBe(true);
  });

  it("T3.2: sign produces signature with non-empty base64 sig field", async () => {
    const keypair = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair.privateKey, "alpha");
    const firstSig = unwrap(envelope.signatures[0]);
    expect(firstSig.sig.length).toBeGreaterThan(0);
    const sigBytes = decodeBase64(firstSig.sig);
    expect(sigBytes).not.toBeNull();
    // Ed25519 signature is 64 bytes per RFC 8032 §5.1.6
    expect(unwrap(sigBytes).length).toBe(64);
  });

  it("T3.3: verify fails with wrong public key", async () => {
    const keypair1 = await generateTestKeypair();
    const keypair2 = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair1.privateKey, "charlie");
    const result = await verifyEnvelope(envelope, keypair2.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("signature-verify-failed");
    }
  });

  it("T3.4: verify handles signatureIndex out-of-bounds", async () => {
    const keypair = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair.privateKey, "charlie");
    const result = await verifyEnvelope(envelope, keypair.publicKey, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("envelope-shape-invalid");
    }
  });
});

// Section 4: tamper detection (Obs-3 HYBRID lock — signature scope covers payload)
describe("tamper detection — Section 4: HYBRID lock guarantees per slice plan §2.2", () => {
  it("T4.1: payload mutation breaks signature verify (PAE input changes)", async () => {
    const keypair = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair.privateKey, "charlie");
    const tampered = { ...envelope, payload: "BBB=" };
    const result = await verifyEnvelope(tampered, keypair.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("signature-verify-failed");
    }
  });

  it("T4.2: signature mutation breaks verify (raw sig mismatch)", async () => {
    const keypair = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair.privateKey, "charlie");
    const sigBytes = unwrap(decodeBase64(unwrap(envelope.signatures[0]).sig));
    sigBytes[0] = unwrap(sigBytes[0]) ^ 0xff; // flip bits in first byte
    const tamperedSig = encodeBase64(sigBytes);
    const tampered = {
      ...envelope,
      signatures: [{ keyid: "charlie", sig: tamperedSig }],
    };
    const result = await verifyEnvelope(tampered, keypair.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("signature-verify-failed");
    }
  });

  it("T4.3: keyid mutation does NOT break signature (DSSE keyid is outer-envelope advisory; NOT in PAE)", async () => {
    const keypair = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair.privateKey, "charlie");
    // Per OBS-A + Delta cohort-aggregate-truth catch: tampering with envelope keyid
    // does NOT break signature itself (signature is over PAE; PAE excludes envelope
    // keyid). Verifier-side line-vs-envelope cross-check catches the tamper at a
    // different layer (not at sig.verify() level).
    const tampered = {
      ...envelope,
      signatures: [
        { keyid: "MALLORY", sig: unwrap(envelope.signatures[0]).sig },
      ],
    };
    const result = await verifyEnvelope(tampered, keypair.publicKey);
    // Sig verify passes because PAE input is unchanged; the keyid swap is invisible
    // to crypto. This documents the HYBRID lock rationale empirically:
    // verifier MUST cross-check JSONL line `identity` against envelope keyid
    // separately to catch identity-tamper (per §2.2 verifier-side rule).
    expect(result.ok).toBe(true);
  });

  it("T4.4: payloadType mutation breaks signature verify (PAE input changes)", async () => {
    const keypair = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair.privateKey, "charlie");
    const tampered = { ...envelope, payloadType: "application/json" };
    const result = await verifyEnvelope(tampered, keypair.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("signature-verify-failed");
    }
  });

  it("T4.5: malformed base64 sig surfaces envelope-shape-invalid error", async () => {
    const keypair = await generateTestKeypair();
    const envelope = await signPayload("AAA=", keypair.privateKey, "charlie");
    const tampered = {
      ...envelope,
      signatures: [{ keyid: "charlie", sig: "!!!not-valid-base64!!!" }],
    };
    const result = await verifyEnvelope(tampered, keypair.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("envelope-shape-invalid");
    }
  });
});

// Section 5: DSSE envelope parse + shape validation
describe("parseDsseEnvelope — Section 5: envelope shape validation", () => {
  it("T5.1: parses canonical envelope JSON", () => {
    const envelope = parseDsseEnvelope(
      JSON.stringify({
        payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
        payload: "AAA=",
        signatures: [{ keyid: "charlie", sig: "BBB=" }],
      }),
    );
    expect(envelope).not.toBeNull();
    expect(envelope?.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
    expect(envelope?.payload).toBe("AAA=");
    expect(envelope?.signatures[0]?.keyid).toBe("charlie");
    expect(envelope?.signatures[0]?.sig).toBe("BBB=");
  });

  it("T5.2: rejects malformed JSON", () => {
    expect(parseDsseEnvelope("{not valid json")).toBeNull();
  });

  it("T5.3: rejects non-object JSON", () => {
    expect(parseDsseEnvelope('"a string"')).toBeNull();
    expect(parseDsseEnvelope("[]")).toBeNull();
    expect(parseDsseEnvelope("null")).toBeNull();
    expect(parseDsseEnvelope("42")).toBeNull();
  });

  it("T5.4: rejects missing payloadType", () => {
    expect(
      parseDsseEnvelope(
        JSON.stringify({
          payload: "AAA=",
          signatures: [{ keyid: "charlie", sig: "BBB=" }],
        }),
      ),
    ).toBeNull();
  });

  it("T5.5: rejects empty payloadType", () => {
    expect(
      parseDsseEnvelope(
        JSON.stringify({
          payloadType: "",
          payload: "AAA=",
          signatures: [{ keyid: "charlie", sig: "BBB=" }],
        }),
      ),
    ).toBeNull();
  });

  it("T5.6: rejects missing payload", () => {
    expect(
      parseDsseEnvelope(
        JSON.stringify({
          payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
          signatures: [{ keyid: "charlie", sig: "BBB=" }],
        }),
      ),
    ).toBeNull();
  });

  it("T5.7: rejects empty signatures array", () => {
    expect(
      parseDsseEnvelope(
        JSON.stringify({
          payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
          payload: "AAA=",
          signatures: [],
        }),
      ),
    ).toBeNull();
  });

  it("T5.8: rejects signature entry missing keyid", () => {
    expect(
      parseDsseEnvelope(
        JSON.stringify({
          payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
          payload: "AAA=",
          signatures: [{ sig: "BBB=" }],
        }),
      ),
    ).toBeNull();
  });

  it("T5.9: rejects signature entry with empty-post-trim keyid", () => {
    expect(
      parseDsseEnvelope(
        JSON.stringify({
          payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
          payload: "AAA=",
          signatures: [{ keyid: "   ", sig: "BBB=" }],
        }),
      ),
    ).toBeNull();
  });

  it("T5.10: parses multi-signer envelope (forward-compat for future cycles)", () => {
    const envelope = parseDsseEnvelope(
      JSON.stringify({
        payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
        payload: "AAA=",
        signatures: [
          { keyid: "charlie", sig: "BBB=" },
          { keyid: "delta", sig: "CCC=" },
        ],
      }),
    );
    expect(envelope).not.toBeNull();
    expect(envelope?.signatures).toHaveLength(2);
  });

  it("T5.11: permissive on extra fields (forward-compat per substrate-precedes-consumer discipline)", () => {
    const envelope = parseDsseEnvelope(
      JSON.stringify({
        payloadType: AUDIT_VERDICT_PAYLOAD_TYPE,
        payload: "AAA=",
        signatures: [{ keyid: "charlie", sig: "BBB=" }],
        future_field: "ignored",
      }),
    );
    expect(envelope).not.toBeNull();
  });
});

// Section 6: payload hash + chain construction
describe("computePayloadHash — Section 6: chain construction per DC-2", () => {
  it("T6.1: produces 64-char lowercase hex string", async () => {
    const hash = await computePayloadHash("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("T6.2: SHA-256 of 'test' matches known value (NIST test vector)", async () => {
    // SHA-256("test") = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
    const hash = await computePayloadHash("test");
    expect(hash).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });

  it("T6.3: empty string produces SHA-256-empty hash", async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = await computePayloadHash("");
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("T6.4: different inputs produce different hashes (chain integrity property)", async () => {
    const hashA = await computePayloadHash("payload-A");
    const hashB = await computePayloadHash("payload-B");
    expect(hashA).not.toBe(hashB);
  });

  it("T6.5: same input produces same hash (determinism)", async () => {
    const hash1 = await computePayloadHash("repeatable");
    const hash2 = await computePayloadHash("repeatable");
    expect(hash1).toBe(hash2);
  });
});

// Section 7: payload encode/decode roundtrip
describe("encodePayload + decodePayload — Section 7: payload field roundtrip", () => {
  it("T7.1: encode + decode roundtrip preserves canonical-JSON string", () => {
    const original = '{"kind_version":1,"signer_role":"queue"}';
    const encoded = encodePayload(original);
    const decoded = decodePayload(encoded);
    expect(decoded).toBe(original);
  });

  it("T7.2: encode produces base64 string suitable for DSSE envelope payload field", () => {
    const encoded = encodePayload("hello");
    // base64("hello") = "aGVsbG8="
    expect(encoded).toBe("aGVsbG8=");
  });

  it("T7.3: decodePayload returns null on malformed base64", () => {
    expect(decodePayload("!!!not-valid-base64!!!")).toBeNull();
  });

  it("T7.4: encode + decode roundtrip on multi-byte chars", () => {
    const original = '{"emoji":"\u{1F3AF}","unicode":"héllo"}';
    const encoded = encodePayload(original);
    const decoded = decodePayload(encoded);
    expect(decoded).toBe(original);
  });

  it("T7.5: encode + decode roundtrip on empty string", () => {
    const encoded = encodePayload("");
    expect(encoded).toBe("");
    const decoded = decodePayload(encoded);
    expect(decoded).toBe("");
  });
});

// Section 8: full chain construction smoke test (sign + chain + verify)
describe("end-to-end chain — Section 8: 3-entry chain sign + verify smoke", () => {
  it("T8.1: 3-entry chain sign + verify + chain-hash composition", async () => {
    const keypair = await generateTestKeypair();
    // Bootstrap entry — prev_audit_body_ref: null
    const payload1 = encodePayload(
      JSON.stringify({
        kind_version: 1,
        signed_at: "2026-05-26T13:00:00.000Z",
        prev_audit_body_ref: null,
        signer_role: "queue",
      }),
    );
    const envelope1 = await signPayload(
      payload1,
      keypair.privateKey,
      "charlie",
    );
    expect((await verifyEnvelope(envelope1, keypair.publicKey)).ok).toBe(true);

    // Second entry — prev_audit_body_ref = SHA-256(payload1)
    const hash1 = await computePayloadHash(envelope1.payload);
    const payload2 = encodePayload(
      JSON.stringify({
        kind_version: 1,
        signed_at: "2026-05-26T13:01:00.000Z",
        prev_audit_body_ref: hash1,
        signer_role: "queue",
      }),
    );
    const envelope2 = await signPayload(
      payload2,
      keypair.privateKey,
      "charlie",
    );
    expect((await verifyEnvelope(envelope2, keypair.publicKey)).ok).toBe(true);

    // Third entry — prev_audit_body_ref = SHA-256(payload2)
    const hash2 = await computePayloadHash(envelope2.payload);
    const payload3 = encodePayload(
      JSON.stringify({
        kind_version: 1,
        signed_at: "2026-05-26T13:02:00.000Z",
        prev_audit_body_ref: hash2,
        signer_role: "queue",
      }),
    );
    const envelope3 = await signPayload(
      payload3,
      keypair.privateKey,
      "charlie",
    );
    expect((await verifyEnvelope(envelope3, keypair.publicKey)).ok).toBe(true);

    // Verify chain hashes match expected values
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(hash2).toMatch(/^[a-f0-9]{64}$/);
    expect(hash1).not.toBe(hash2);
  });

  it("T8.2: chain break detection — mutate middle payload + re-hash mismatch", async () => {
    const keypair = await generateTestKeypair();
    const payload1 = encodePayload(JSON.stringify({ entry: 1 }));
    const envelope1 = await signPayload(
      payload1,
      keypair.privateKey,
      "charlie",
    );
    const hash1 = await computePayloadHash(envelope1.payload);

    // Tamper: replace envelope1's payload with different content
    const tamperedPayload1 = encodePayload(
      JSON.stringify({ entry: "TAMPERED" }),
    );
    const tamperedHash = await computePayloadHash(tamperedPayload1);

    // Chain consumer would: hash actual stored envelope.payload, compare against
    // next entry's prev_audit_body_ref. Mismatch = chain break detected.
    expect(tamperedHash).not.toBe(hash1);

    // Additionally: signature on tampered envelope (without re-signing) would fail
    const tamperedEnvelope = { ...envelope1, payload: tamperedPayload1 };
    expect((await verifyEnvelope(tamperedEnvelope, keypair.publicKey)).ok).toBe(
      false,
    );
  });
});
