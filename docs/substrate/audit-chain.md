# Audit-verdict signature chain

Operator + consumer documentation for the Cycle 1 substrate-core audit-verdict signature chain (Pair-B-PR-A1..PR-A8). Layer 1.5 substrate primitive enabling tamper-evident cohort audit trails via DSSE-wrapped Ed25519 signatures + in-payload `prev_audit_body_ref` chain construction.

Source plan: `~/.claude/plans/cycle-1-substrate-core-slice-plan-2026-05-26.md`. Audit-shadow body_refs cited in commit messages for each Pair-B-PR-A1..A8 squash.

## 1. Overview

The audit-verdict signature chain provides cohort-internal tamper detection for audit-verdicts posted to channel JSONL streams. Each v0.3 audit-verdict carries a DSSE-wrapped envelope containing an Ed25519 signature over the canonical-JSON-encoded body bytes; chain integrity is preserved via an in-payload `prev_audit_body_ref` field carrying SHA-256 of the prior payload.

**Three properties:**

- **Tamper-evident** — payload mutation after signing fails Ed25519 verify per RFC 8032.
- **Chain-integrity** — gaps or mutations in the audit-verdict sequence surface as `prev_audit_body_ref` mismatches at verify time.
- **Revocation-aware** — `key-revoke` kind (PR-A7) marks history entries as revoked; verifier reports revoked signatures distinctly from tamper events per the 3-class break taxonomy.

Resolves OBS-A (HMAC framing was incorrect crypto-primitive naming per Delta Phase 0 fact-base catch; cohort renamed to Ed25519 signature chain per RFC 8032 asymmetric signature semantics).

## 2. Operator workflow

### Bootstrap a cohort key (Pair-B-PR-A4)

```bash
bun run conductor audit bootstrap --identity charlie
```

Writes 3 files to `~/.claude/keys/cohort/<nato>.*` per Decision #9 OPERATOR-GLOBAL key surface:

- `<nato>.ed25519.pub` — public key (cohort-distributed via Git PR per DC-4 TOFU)
- `<nato>.ed25519.sec` — private key (mode `0600`; operator-local)
- `<nato>.history.json` — append-only key history (rotation + revocation maintenance)

`--force` overwrites existing keypair (operator-intentional rotation) + appends a new history entry marking the prior entry as `rotated`.

Identity resolution order:

1. `--identity <nato>` CLI flag (explicit)
2. `CLAUDE_CONDUCTOR_NATO` env var (test fixture)
3. `~/.claude-conductor-identity` file (operator default)

### Verify an audit-verdict chain (Pair-B-PR-A6)

```bash
bun run conductor audit verify <channel-id> [--pubkey-dir <dir>] [--output json|human] [--strict]
```

Default `--pubkey-dir = ~/.claude/keys/cohort/`. Default `--output = json` for CI; `--output human` for operator inspection.

Returns `AuditVerifyOutput` JSON shape:

```typescript
type AuditVerifyOutput = {
  ok: boolean;
  key_ids_used: string[]; // ordered first-occurrence
  total_audit_verdicts: number; // v0.3 chain-eligible count
  breaks: Array<{
    at_msg_seq: number;
    body_ref: string;
    reason: "tamper" | "revoked-key" | "key-rotation-discontinuity";
    detail: string;
    key_id?: string;
  }>;
};
```

Exit codes (DC-3 4-state):

- `0` = ok (chain verifies; vacuously ok for zero entries)
- `1` = broken (one or more `breaks[]` entries)
- `2` = partial (skipped pre-v0.3 entries; `--strict` collapses to 1)
- `3` = unsupported (unparseable bodies)

Precedence: broken > unsupported > partial > ok.

### Revoke a key (Pair-B-PR-A7)

Post a `key-revoke` channel message:

```bash
echo '{ ... }' | bun run conductor channels send <channel-id> key-revoke
```

`KeyRevokeBody` shape:

```typescript
type KeyRevokeBody = {
  kind_version: 1;
  revoked_nato: string;
  revoked_fingerprint: string; // SHA-256 hex of the public key (DER SPKI)
  revoked_at: string; // ISO-8601
  reason: "compromise" | "rotation" | "operator-departure";
  replacement_fingerprint: string | null;
  signed_by: readonly string[]; // min-1; cohort co-sign list
};
```

3-class `reason`:

- `compromise` — private key suspected leaked / exfiltrated / unauthorized signing detected
- `rotation` — operator-intentional key rotation (no compromise); `replacement_fingerprint` SHOULD be populated
- `operator-departure` — NATO identity retiring from cohort

The `revoked_at` timestamp marks the prior `KeyHistoryEntry.active_until`; entries become `status: "revoked"` from that point forward. Subsequent `audit verify` runs surface signatures by the revoked key with `breaks[].reason: "revoked-key"` distinct from tamper events.

## 3. Substrate primitives

### DSSE envelope shape (Pair-B-PR-A2 + Pair-B-PR-A5)

Per [DSSE protocol §3](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md):

```typescript
type DsseEnvelope = {
  payloadType: "application/vnd.claude-conductor.audit-verdict+json";
  payload: string; // base64-encoded canonical-JSON of AuditVerdictBody
  signatures: Array<{
    keyid: string; // NATO identifier (advisory; not signature-covered)
    sig: string; // base64-encoded Ed25519 signature
  }>;
};
```

PAE input per DSSE §2:

```
"DSSEv1" + SP + LEN(payloadType) + SP + payloadType + SP + LEN(payload) + SP + payload
```

Where `LEN(x)` is ASCII-decimal byte-length and `SP` is single space (0x20). Signature = `Ed25519.Sign(secret_key, PAE(payloadType, payload))` per RFC 8032.

### Canonical-JSON (Pair-B-PR-A5)

RFC 8785 JCS subset implementation at `src/channels/canonical-json.ts` (object-key-sort recursive + JSON.stringify default). Used at sign-side BEFORE PAE input construction to ensure semantically-identical bodies encode to identical bytes across cohort sessions.

Subset limitations documented in module JSDoc + regression-fixture tests:

- Does NOT implement RFC 8785 §3.2.2 full number canonicalization (no scientific-notation normalization for large/small floats). Sufficient for integer-only AuditVerdictBody fields; future cycles with float fields require library promotion (Cycle 2 substrate-debt; see `wiki/backlog.md` for Pair-A v0.4 cost-as-float consideration).
- Unicode normalization explicitly EXCLUDED by RFC 8785 (preserve string data "as is" per §3.2.3 string-sort prose).

### HYBRID identity + role tamper-detection (Pair B cohort cycle 2026-05-26 OQ-2)

Identity attestation via DSSE `signatures[i].keyid` (outer envelope; advisory; verifier-side cross-check against JSONL line `identity` field). Role attestation via in-payload `signer_role` field (PAE-signature-covered; mutation breaks signature verify per RFC 8032).

Per cohort cycle 4-NATO HYBRID lock: dropped redundant in-payload `signer_nato` field (was equivalent to DSSE keyid + cross-check); kept `signer_role` for orthogonal role-tamper-detection path.

## 4. Key surface (Pair-B-PR-A3)

`src/channels/key-surface.ts` provides Ed25519 keypair generation + per-NATO history file management via Bun's Web Crypto API (RFC 8032 PureEdDSA).

### Path conventions (Decision #9 OPERATOR-GLOBAL)

```
~/.claude/keys/cohort/<nato>.ed25519.pub      # public key (DER SPKI)
~/.claude/keys/cohort/<nato>.ed25519.sec      # private key (PKCS8; mode 0600)
~/.claude/keys/cohort/<nato>.history.json     # append-only history
```

`cohortKeysDir()` (`src/shared/paths.ts`) returns the canonical directory. Substrate-clean per cohort consensus pattern — extending `paths.ts` SSOT is preferred over allowlist escape-hatches when both viable (see `memories/feedback-substrate-clean-over-escape-hatch-when-cohort-leans.md`).

### KeyHistoryEntry (Pair-B-PR-A3 + Pair-B-PR-A7)

```typescript
type KeyHistoryEntry = {
  fingerprint: string; // SHA-256 hex of DER-encoded SPKI public key
  pubkey_path: string; // relative to cohort dir; per-NATO
  active_from: string; // ISO-8601
  active_until: string | null; // null if currently active; ISO-8601 on rotation/revocation
  status: "active" | "rotated" | "revoked";
};
```

### resolveKeyAtTime (Pair-B-PR-A3)

```typescript
resolveKeyAtTime(history, signedAt): { ok: true; entry } | { ok: false; error };
```

Walks history entries in order; resolves the entry whose half-open window `[active_from, active_until)` covers `signedAt`. Returns the entry on match; returns `{ ok: false; error: { kind: "key-revoked", ... } }` if the matching entry has `status: "revoked"`; returns `{ ok: false; error: { kind: "no-active-key-at-timestamp", ... } }` if no entry covers the timestamp.

## 5. 3-class break taxonomy (DC-5 + sub-Obs-6a)

Per `AuditVerifyOutput.breaks[].reason`, each variant maps to a distinct operator-facing remediation path:

| Reason                       | Trigger                                                                                                                                                                  | Operator response                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `tamper`                     | Ed25519 signature verify failed. Either payload bytes mutated post-sign OR keyid points to wrong key. Investigate channel JSONL + cross-check envelope vs line identity. | Forensic post-incident triage; cohort cross-flight audit of channel history.          |
| `revoked-key`                | History entry at `signed_at` has `status: "revoked"`. Sig is valid but the key was revoked (compromise OR explicit invalidation).                                        | Distinct from tamper for revocation-visibility; cohort decision on artifact validity. |
| `key-rotation-discontinuity` | `prev_audit_body_ref` doesn't match prior payload's SHA-256 (chain gap OR mutation), OR no history entry covers `signed_at` (gap between rotations OR clock skew).       | Sequencing analysis; rotation history audit; clock-skew investigation.                |

## 6. Consumer integration

### Pair-A-PR-A4 lineageVerify dispatch (composability gate)

Pair A `lineage verify` CLI invokes `audit verify` internally per §3.1 LOCKED contract. Composition:

```typescript
// Pair-A-PR-A4 lineageVerify CLI (post-PR-A6 merge)
const auditOutput = await runAuditVerify(channelId, { output: "json" });
const lineageOutput: LineageVerifyOutput = {
  ok: auditOutput.ok && resolvedInputsArrayValid,
  resolved_inputs: ...,
  unresolved_inputs: ...,
  sig_chain_status:
    auditOutput.total_audit_verdicts === 0 ? "skip-not-in-channel" :
    auditOutput.breaks.length > 0 ? "broken" : "intact",
  chain_start_at_msg_seq: computeChainStartFromChannel(...),
};
```

### Cross-edge surface

API exports re-exported via `claude-conductor/channels/api` and mirrored to the dotfiles shim at `~/.claude-dotfiles/src/channels/index.ts` per `memories/feedback-substrate-shim-mirror-on-plugin-export-changes.md` discipline:

- `parseAuditVerdictBody` (raw v0.1/v0.2)
- `parseAuditVerdictV0_3Wrapped` (DSSE-aware; returns `{envelope, body}`)
- `wrapAuditVerdictBody` (sign-side helper)
- `canonicalJson` (RFC 8785 JCS subset)
- `parseKeyRevokeBody` + `isKeyRevokeBody` + `isRevocationReason`

Paired-contract tests at `test/cross-edge/audit-chain-shim-mirror.test.ts` (conductor side) + `~/.claude-dotfiles/src/channels/index.test.ts` (dotfiles side; mirror section "audit-chain shim mirror paired-contract") detect drift between substrate vs shim before downstream consumer breakage.

## 7. Schema migrations

| Migration | Schema file                                         | Description                                                                                  |
| --------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 001       | (implicit v0.1 baseline)                            | Initial unsigned `AuditVerdictBody` per Tier 1 Slice 2 cycle 2026-05-19.                     |
| 002       | `docs/schema-snapshots/audit-verdict/002_v0.2.json` | Additive `signed_at` + `prev_audit_body_ref` + `signer_role` fields per HYBRID lock (PR-A1). |
| 003       | `docs/schema-snapshots/audit-verdict/003_v0.3.json` | DSSE envelope wrapping; payload = base64 of canonical-JSON of v0.2 body (PR-A5).             |
| 004       | `docs/schema-snapshots/audit-verdict/004_v0.4.json` | Pair-A `lineage?: LineageEnvelope` extension field per Pair A §7 (Pair-A-PR-A3).             |
| 001 (KR)  | `docs/schema-snapshots/key-revoke/001_v0.1.json`    | Initial `KeyRevokeBody` v0.1 schema (PR-A7).                                                 |

Reader-side parser tolerance per Sigstore parse-all-versions-simultaneously precedent: `parseAuditVerdictBody` accepts v0.1/v0.2 raw bodies; `parseAuditVerdictV0_3Wrapped` accepts v0.3 DSSE-wrapped bodies; both compose with Pair-A v0.4 `lineage?` field via inner-body parser delegation. No upconversion codec — parsers dispatch on shape.

## 8. Verification-budget contract

Per cohort `[[feedback-verification-budget-by-kind]]` discipline:

- **Parsers** (parseAuditVerdictBody / parseAuditVerdictV0_3Wrapped / parseKeyRevokeBody) trust the SHAPE returned by JSON.parse + validate field types; do NOT perform signature verification. Cryptographic checks are deferred to dedicated verifier modules (verifyEnvelope from PR-A2).
- **Verifier** (verifyChannelAuditChain) validates cryptographic correctness + 3-class break attribution + chain integrity walk; pure functions modulo filesystem read (no mutations / writes / network).
- **CLI** (`audit verify`) composes parser + verifier + key-surface module + reports `AuditVerifyOutput` JSON or human-readable text.

Verifier outputs are authoritative for cohort gate decisions; parser outputs are authoritative for shape consumers (audit-queue, dashboard audit-verdict-aggregation).

## 9. Cohort-cycle artifacts

- Cohort channel: `2026-05-25_23-30` (bernstein-review-arc Cycle 1 substrate-core impl phase)
- Slice plan body: `~/.claude/plans/cycle-1-substrate-core-slice-plan-2026-05-26.md` (4-NATO LOCKED v0.2)
- Charlie + Delta + Alpha + Bravo body_refs cited in commit messages for each PR-A1..A8 squash (audit-shadow chain integrity preserved across cohort sessions)

## 10. See also

- `[[feedback-pre-execution-empirical-verify-cryptographic-primitive-structure]]` — discipline catching OQ-2 (cohort iterated to HYBRID lock via primary-source-verify on DSSE spec §2)
- `[[feedback-substrate-shim-mirror-on-plugin-export-changes]]` — cross-edge mirror discipline applied at PR-A5 + PR-A7
- `[[feedback-cross-edge-contract-via-paired-tests]]` — paired-contract test pattern at PR-A8
- `[[feedback-substrate-clean-over-escape-hatch-when-cohort-leans]]` — paths.ts SSOT extension preferred over allowlist (PR-A3 precedent)
- `[[feedback-cohort-discipline-cycle-internal-stress-test]]` — cohort discipline-as-code maturity pattern (Bravo first-flag; 12+ instances across PR-A1..A8 cycle)
