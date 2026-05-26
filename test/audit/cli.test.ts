// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for audit CLI (Cycle 1 substrate-core PR-A4; Pair B Charlie-pen
 * per slice plan `cycle-1-substrate-core-slice-plan-2026-05-26.md`
 * §6.1 test plan).
 *
 * Coverage:
 *   - Section 1: bootstrap creates 3 files (.pub + .sec + .history.json)
 *   - Section 2: identity resolution order (CLI flag > env var > file)
 *   - Section 3: bootstrap with --force overwrites + appends rotated entry
 *   - Section 4: bootstrap appends to existing history correctly
 *   - Section 5: end-to-end key roundtrip via PR-A2 + PR-A3 composition
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBootstrap, resolveIdentity } from "../../src/audit/cli.ts";
import {
  importPrivateKey,
  importPublicKey,
  keyPaths,
  readKeyHistory,
} from "../../src/channels/key-surface.ts";
import {
  encodePayload,
  signPayload,
  verifyEnvelope,
} from "../../src/channels/audit-signature-chain.ts";
import {
  parseAuditVerdictV0_3Wrapped,
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";

function unwrap<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`unwrap: expected non-null/non-undefined ${label}`);
  }
  return value;
}

let tmpDir: string;
let originalNatoEnv: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-cli-test-"));
  originalNatoEnv = process.env["CLAUDE_CONDUCTOR_NATO"];
  delete process.env["CLAUDE_CONDUCTOR_NATO"];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (originalNatoEnv !== undefined) {
    process.env["CLAUDE_CONDUCTOR_NATO"] = originalNatoEnv;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_NATO"];
  }
});

// Section 1: bootstrap creates 3 files
describe("runBootstrap — Section 1: bootstrap creates 3 files per DC-1 + DC-5", () => {
  it("T1.1: bootstrap writes .pub + .sec + .history.json", async () => {
    const result = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: tmpDir,
    });
    expect(result.nato).toBe("charlie");
    expect(result.was_rotation).toBe(false);
    const pubStat = await fs.stat(result.publicKeyPath);
    const secStat = await fs.stat(result.secretKeyPath);
    const historyStat = await fs.stat(result.historyPath);
    expect(pubStat.isFile()).toBe(true);
    expect(secStat.isFile()).toBe(true);
    expect(historyStat.isFile()).toBe(true);
  });

  it("T1.2: bootstrap returns 64-char hex fingerprint", async () => {
    const result = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: tmpDir,
    });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("T1.3: bootstrap writes valid history with 1 active entry", async () => {
    const result = await runBootstrap({
      identity: "delta",
      force: false,
      cohortDir: tmpDir,
    });
    const history = unwrap(await readKeyHistory(result.historyPath));
    expect(history.kind_version).toBe(1);
    expect(history.nato).toBe("delta");
    expect(history.entries).toHaveLength(1);
    const firstEntry = unwrap(history.entries[0]);
    expect(firstEntry.status).toBe("active");
    expect(firstEntry.active_until).toBeNull();
    expect(firstEntry.fingerprint).toBe(result.fingerprint);
  });

  it("T1.4: history entry pubkey_path uses ssh-convention NATO-prefixed naming", async () => {
    const result = await runBootstrap({
      identity: "alpha",
      force: false,
      cohortDir: tmpDir,
    });
    const history = unwrap(await readKeyHistory(result.historyPath));
    const firstEntry = unwrap(history.entries[0]);
    // Algorithm tag is canonical "ed25519" at runtime per DC-1
    expect(firstEntry.pubkey_path).toBe("alpha.ed25519.pub");
  });
});

// Section 2: identity resolution order
describe("resolveIdentity — Section 2: identity resolution priority", () => {
  it("T2.1: CLI flag takes priority over env var", async () => {
    process.env["CLAUDE_CONDUCTOR_NATO"] = "from-env";
    const result = await resolveIdentity("from-flag");
    expect(result).toBe("from-flag");
  });

  it("T2.2: env var used when CLI flag is null", async () => {
    process.env["CLAUDE_CONDUCTOR_NATO"] = "from-env";
    const result = await resolveIdentity(null);
    expect(result).toBe("from-env");
  });

  it("T2.3: empty-string CLI flag falls through to next source", async () => {
    process.env["CLAUDE_CONDUCTOR_NATO"] = "from-env";
    const result = await resolveIdentity("   ");
    expect(result).toBe("from-env");
  });

  it("T2.4: empty env var falls through (treats empty as absent)", async () => {
    process.env["CLAUDE_CONDUCTOR_NATO"] = "";
    const result = await resolveIdentity("from-flag");
    expect(result).toBe("from-flag");
  });
});

// Section 3: bootstrap rotation flow
describe("runBootstrap — Section 3: rotation with --force overwrites + marks prior rotated", () => {
  it("T3.1: bootstrap with existing history sets was_rotation=true", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: tmpDir,
    });
    const result2 = await runBootstrap({
      identity: "charlie",
      force: true,
      cohortDir: tmpDir,
    });
    expect(result2.was_rotation).toBe(true);
  });

  it("T3.2: rotation appends new active entry + marks prior as rotated", async () => {
    const first = await runBootstrap({
      identity: "delta",
      force: false,
      cohortDir: tmpDir,
    });
    const second = await runBootstrap({
      identity: "delta",
      force: true,
      cohortDir: tmpDir,
    });
    const history = unwrap(await readKeyHistory(second.historyPath));
    expect(history.entries).toHaveLength(2);
    const firstEntry = unwrap(history.entries[0]);
    const secondEntry = unwrap(history.entries[1]);
    expect(firstEntry.status).toBe("rotated");
    expect(firstEntry.active_until).not.toBeNull();
    expect(secondEntry.status).toBe("active");
    expect(secondEntry.active_until).toBeNull();
    expect(firstEntry.fingerprint).toBe(first.fingerprint);
    expect(secondEntry.fingerprint).toBe(second.fingerprint);
    expect(firstEntry.fingerprint).not.toBe(secondEntry.fingerprint);
  });

  it("T3.3: rotation without --force throws (defensive against accidental overwrite)", async () => {
    await runBootstrap({ identity: "alpha", force: false, cohortDir: tmpDir });
    await expect(
      runBootstrap({ identity: "alpha", force: false, cohortDir: tmpDir }),
    ).rejects.toThrow(/file exists/);
  });
});

// Section 4: keyPaths consistency
describe("runBootstrap — Section 4: keyPaths + cohortDir override", () => {
  it("T4.1: keyPaths derives consistent paths across invocations", () => {
    const p1 = keyPaths("charlie", tmpDir);
    const p2 = keyPaths("charlie", tmpDir);
    expect(p1).toEqual(p2);
  });

  it("T4.2: bootstrap preserves cohortDir override", async () => {
    const result = await runBootstrap({
      identity: "bravo",
      force: false,
      cohortDir: tmpDir,
    });
    expect(result.publicKeyPath).toContain(tmpDir);
    expect(result.secretKeyPath).toContain(tmpDir);
    expect(result.historyPath).toContain(tmpDir);
  });
});

// Section 5: end-to-end sign + verify via PR-A2 + PR-A3 composition
describe("runBootstrap end-to-end — Section 5: full bootstrap → sign → verify cycle", () => {
  it("T5.1: bootstrap → import keys → sign + verify roundtrip succeeds", async () => {
    const result = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: tmpDir,
    });
    const privKey = unwrap(await importPrivateKey(result.secretKeyPath));
    const pubKey = unwrap(await importPublicKey(result.publicKeyPath));
    const payload = encodePayload(
      JSON.stringify({ kind_version: 1, signer_role: "queue" }),
    );
    const envelope = await signPayload(payload, privKey, "charlie");
    const verifyResult = await verifyEnvelope(envelope, pubKey);
    expect(verifyResult.ok).toBe(true);
  });

  it("T5.2: rotation produces distinct keypair (old signatures don't verify with new pubkey)", async () => {
    const first = await runBootstrap({
      identity: "delta",
      force: false,
      cohortDir: tmpDir,
    });
    const firstPriv = unwrap(await importPrivateKey(first.secretKeyPath));
    const payload = encodePayload(JSON.stringify({ test: "old-key" }));
    const oldEnvelope = await signPayload(payload, firstPriv, "delta");

    await runBootstrap({ identity: "delta", force: true, cohortDir: tmpDir });
    // After rotation, .pub now contains the NEW pubkey
    const newPub = unwrap(await importPublicKey(first.publicKeyPath));
    // Verifying old signature with new pubkey fails (different keypair)
    const verifyResult = await verifyEnvelope(oldEnvelope, newPub);
    expect(verifyResult.ok).toBe(false);
  });

  /**
   * T5.3 (PR-A5 extension): end-to-end v0.3 DSSE-wrapped audit-verdict
   * roundtrip composing the full PR-A1..PR-A5 substrate-primitives stack:
   *
   *   - PR-A4 bootstrap → produces keypair + history
   *   - PR-A3 import → loads CryptoKey objects from .pub/.sec files
   *   - PR-A5 wrap → canonical-JSON-RFC-8785 + base64 + DSSE envelope
   *   - PR-A2 verify → Ed25519 signature verify against PAE input
   *   - PR-A5 parse → DSSE envelope shape + decode payload + inner v0.2 body
   *   - PR-A1 v0.2 fields → all extension fields preserved through roundtrip
   *
   * Empirically proves the v0.3 wrapper composes cleanly on top of the
   * substrate-primitives layer (PR-A1 schema + PR-A2 sig-chain + PR-A3
   * key-surface + PR-A4 bootstrap). Satisfies §6.1 + §4.2 cross-pair
   * consumer-contract for Pair A v0.4 Layer 2 lineage envelope.
   */
  it("T5.3: full bootstrap → wrap → verify → parse roundtrip composes PR-A1..PR-A5", async () => {
    const result = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: tmpDir,
    });
    const privKey = unwrap(await importPrivateKey(result.secretKeyPath));
    const pubKey = unwrap(await importPublicKey(result.publicKeyPath));

    const inputBody: AuditVerdictBody = {
      kind_version: 1,
      target_pr: { repo: "conductor", number: 127 },
      target_peer: "Delta",
      lens_set_applied: ["RE", "Architecture"],
      audit_class: "inside-pair",
      audit_axes: ["surface", "depth"],
      verdict: "SHIP-CLEAN",
      counts: { blocker: 0, fold: 0, nit: 0 },
      three_option_ask: {
        a_ratify: "PR cleared post-distance-lens.",
        b_fold_if_applicable: null,
        c_reframe_if_applicable: null,
      },
      findings: [],
      cross_edge_consumers_verified: [
        "dotfiles-shim",
        "lineage-verifier",
        "drift-verifier",
      ],
      signed_at: "2026-05-26T17:00:00.000Z",
      prev_audit_body_ref: null,
      signer_role: "queue",
    };

    // PR-A5 wrap (composes PR-A2 sign + canonical-JSON + base64)
    const envelopeJson = await wrapAuditVerdictBody(
      inputBody,
      privKey,
      "charlie",
    );

    // PR-A5 parse (extracts envelope + inner body via PR-A1 parseAuditVerdictBody)
    const wrapped = parseAuditVerdictV0_3Wrapped(envelopeJson);
    expect(wrapped).not.toBeNull();
    expect(wrapped?.envelope.signatures[0]?.keyid).toBe("charlie");

    // PR-A2 verify (signature against PAE input using PR-A3-imported pubkey)
    const verifyResult = unwrap(wrapped);
    const verify = await verifyEnvelope(verifyResult.envelope, pubKey);
    expect(verify.ok).toBe(true);

    // PR-A1 v0.2 field preservation through roundtrip
    expect(wrapped?.body.kind_version).toBe(1);
    expect(wrapped?.body.target_pr).toEqual({ repo: "conductor", number: 127 });
    expect(wrapped?.body.target_peer).toBe("Delta");
    expect(wrapped?.body.verdict).toBe("SHIP-CLEAN");
    expect(wrapped?.body.cross_edge_consumers_verified).toEqual([
      "dotfiles-shim",
      "lineage-verifier",
      "drift-verifier",
    ]);
    expect(wrapped?.body.signed_at).toBe("2026-05-26T17:00:00.000Z");
    expect(wrapped?.body.prev_audit_body_ref).toBeNull();
    expect(wrapped?.body.signer_role).toBe("queue");
  });
});
