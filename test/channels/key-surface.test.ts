// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for Ed25519 key surface (Cycle 1 substrate-core PR-A3; Pair B
 * Charlie-pen per slice plan
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §6.1 test plan).
 *
 * Coverage:
 *   - Section 1: keyPaths derives canonical 3-file shape
 *   - Section 2: generateKeypair + Web Crypto Ed25519 properties
 *   - Section 3: exportKeypairToPaths writes .pub + .sec with correct mode
 *   - Section 4: importPublicKey + importPrivateKey roundtrip
 *   - Section 5: end-to-end sign + verify (compose with audit-signature-chain.ts)
 *   - Section 6: readKeyHistory + writeKeyHistory shape validation
 *   - Section 7: resolveKeyAtTime lookup semantics
 *   - Section 8: appendKeyEntry rotation flow
 *   - Section 9: computeFingerprint determinism
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendKeyEntry,
  computeFingerprint,
  exportKeypairToPaths,
  generateKeypair,
  importPrivateKey,
  importPublicKey,
  keyPaths,
  readKeyHistory,
  resolveKeyAtTime,
  writeKeyHistory,
  type KeyHistory,
  type KeyHistoryEntry,
} from "../../src/channels/key-surface.ts";
import {
  encodePayload,
  signPayload,
  verifyEnvelope,
} from "../../src/channels/audit-signature-chain.ts";

function unwrap<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`unwrap: expected non-null/non-undefined ${label}`);
  }
  return value;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "key-surface-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Section 1: keyPaths derives canonical 3-file shape
describe("keyPaths — Section 1: canonical file shape per DC-1 ssh-convention", () => {
  it("T1.1: derives all 3 paths from nato + cohortDir", () => {
    const paths = keyPaths("charlie", "/tmp/cohort");
    expect(paths.publicKeyPath).toBe("/tmp/cohort/charlie.ed25519.pub");
    expect(paths.secretKeyPath).toBe("/tmp/cohort/charlie.ed25519.sec");
    expect(paths.historyPath).toBe("/tmp/cohort/charlie.history.json");
  });

  it("T1.2: NATO-prefixed naming per slice plan body §2.1", () => {
    const paths = keyPaths("delta", "/tmp/cohort");
    expect(paths.publicKeyPath).toContain("delta.ed25519.pub");
    expect(paths.secretKeyPath).toContain("delta.ed25519.sec");
    expect(paths.historyPath).toContain("delta.history.json");
  });

  it("T1.3: uses default cohortDir when not specified", () => {
    const paths = keyPaths("alpha");
    expect(paths.publicKeyPath).toContain(".claude/keys/cohort/");
    expect(paths.publicKeyPath).toContain("alpha.ed25519.pub");
  });
});

// Section 2: generateKeypair + Web Crypto Ed25519 properties
describe("generateKeypair — Section 2: Ed25519 keypair properties per RFC 8032", () => {
  it("T2.1: generates extractable Ed25519 keypair", async () => {
    const keypair = await generateKeypair();
    expect(keypair.privateKey.algorithm.name).toBe("Ed25519");
    expect(keypair.publicKey.algorithm.name).toBe("Ed25519");
    expect(keypair.privateKey.extractable).toBe(true);
    expect(keypair.publicKey.extractable).toBe(true);
  });

  it("T2.2: private key has sign usage; public key has verify usage", async () => {
    const keypair = await generateKeypair();
    expect(keypair.privateKey.usages).toContain("sign");
    expect(keypair.publicKey.usages).toContain("verify");
  });

  it("T2.3: subsequent generations produce different keypairs", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const fp1 = await computeFingerprint(kp1.publicKey);
    const fp2 = await computeFingerprint(kp2.publicKey);
    expect(fp1).not.toBe(fp2);
  });
});

// Section 3: exportKeypairToPaths writes .pub + .sec with correct mode
describe("exportKeypairToPaths — Section 3: filesystem write per DC-1 ssh-convention", () => {
  it("T3.1: writes .pub + .sec files at expected paths", async () => {
    const keypair = await generateKeypair();
    const result = await exportKeypairToPaths(keypair, "charlie", {
      cohortDir: tmpDir,
    });
    expect(result.publicKeyPath).toBe(path.join(tmpDir, "charlie.ed25519.pub"));
    expect(result.secretKeyPath).toBe(path.join(tmpDir, "charlie.ed25519.sec"));
    const pubStat = await fs.stat(result.publicKeyPath);
    const secStat = await fs.stat(result.secretKeyPath);
    expect(pubStat.isFile()).toBe(true);
    expect(secStat.isFile()).toBe(true);
  });

  it("T3.2: secret key file has 0600 mode (operator-only readable)", async () => {
    const keypair = await generateKeypair();
    const result = await exportKeypairToPaths(keypair, "charlie", {
      cohortDir: tmpDir,
    });
    const secStat = await fs.stat(result.secretKeyPath);
    const mode = secStat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("T3.3: refuses to overwrite existing files without force", async () => {
    const kp1 = await generateKeypair();
    await exportKeypairToPaths(kp1, "charlie", { cohortDir: tmpDir });
    const kp2 = await generateKeypair();
    await expect(
      exportKeypairToPaths(kp2, "charlie", { cohortDir: tmpDir }),
    ).rejects.toThrow(/file exists/);
  });

  it("T3.4: overwrites existing files with force: true (operator rotation)", async () => {
    const kp1 = await generateKeypair();
    await exportKeypairToPaths(kp1, "charlie", { cohortDir: tmpDir });
    const fp1 = await computeFingerprint(kp1.publicKey);
    const kp2 = await generateKeypair();
    await exportKeypairToPaths(kp2, "charlie", {
      cohortDir: tmpDir,
      force: true,
    });
    const importedKp2Pub = unwrap(
      await importPublicKey(path.join(tmpDir, "charlie.ed25519.pub")),
    );
    const fp2Read = await computeFingerprint(importedKp2Pub);
    expect(fp2Read).not.toBe(fp1);
  });

  it("T3.5: creates parent directory recursively if missing", async () => {
    const nestedDir = path.join(tmpDir, "nested", "subdir");
    const keypair = await generateKeypair();
    await exportKeypairToPaths(keypair, "charlie", { cohortDir: nestedDir });
    const stat = await fs.stat(nestedDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

// Section 4: importPublicKey + importPrivateKey roundtrip
describe("importPublicKey + importPrivateKey — Section 4: filesystem read roundtrip", () => {
  it("T4.1: export + import public key roundtrip preserves identity (same fingerprint)", async () => {
    const original = await generateKeypair();
    await exportKeypairToPaths(original, "charlie", { cohortDir: tmpDir });
    const originalFp = await computeFingerprint(original.publicKey);
    const imported = unwrap(
      await importPublicKey(path.join(tmpDir, "charlie.ed25519.pub")),
    );
    const importedFp = await computeFingerprint(imported);
    expect(importedFp).toBe(originalFp);
  });

  it("T4.2: importPublicKey returns null on file-not-found", async () => {
    const result = await importPublicKey(
      path.join(tmpDir, "nonexistent.ed25519.pub"),
    );
    expect(result).toBeNull();
  });

  it("T4.3: importPrivateKey returns null on file-not-found", async () => {
    const result = await importPrivateKey(
      path.join(tmpDir, "nonexistent.ed25519.sec"),
    );
    expect(result).toBeNull();
  });

  it("T4.4: imported private key has sign usage", async () => {
    const original = await generateKeypair();
    await exportKeypairToPaths(original, "charlie", { cohortDir: tmpDir });
    const imported = unwrap(
      await importPrivateKey(path.join(tmpDir, "charlie.ed25519.sec")),
    );
    expect(imported.usages).toContain("sign");
  });

  it("T4.5: imported public key has verify usage", async () => {
    const original = await generateKeypair();
    await exportKeypairToPaths(original, "charlie", { cohortDir: tmpDir });
    const imported = unwrap(
      await importPublicKey(path.join(tmpDir, "charlie.ed25519.pub")),
    );
    expect(imported.usages).toContain("verify");
  });
});

// Section 5: end-to-end sign + verify (compose with audit-signature-chain.ts)
describe("end-to-end key+sign+verify — Section 5: PR-A2 + PR-A3 composition", () => {
  it("T5.1: export + import + sign + verify roundtrip succeeds", async () => {
    const original = await generateKeypair();
    await exportKeypairToPaths(original, "charlie", { cohortDir: tmpDir });
    const importedPriv = unwrap(
      await importPrivateKey(path.join(tmpDir, "charlie.ed25519.sec")),
    );
    const importedPub = unwrap(
      await importPublicKey(path.join(tmpDir, "charlie.ed25519.pub")),
    );
    const payload = encodePayload(
      JSON.stringify({ kind_version: 1, signer_role: "queue" }),
    );
    const envelope = await signPayload(payload, importedPriv, "charlie");
    const result = await verifyEnvelope(envelope, importedPub);
    expect(result.ok).toBe(true);
  });

  it("T5.2: cross-NATO signature attestation fails (sign Charlie / verify Delta pubkey)", async () => {
    const charlieKp = await generateKeypair();
    const deltaKp = await generateKeypair();
    await exportKeypairToPaths(charlieKp, "charlie", { cohortDir: tmpDir });
    await exportKeypairToPaths(deltaKp, "delta", { cohortDir: tmpDir });
    const charliePriv = unwrap(
      await importPrivateKey(path.join(tmpDir, "charlie.ed25519.sec")),
    );
    const deltaPub = unwrap(
      await importPublicKey(path.join(tmpDir, "delta.ed25519.pub")),
    );
    const payload = encodePayload(JSON.stringify({ from: "charlie" }));
    const envelope = await signPayload(payload, charliePriv, "charlie");
    const result = await verifyEnvelope(envelope, deltaPub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("signature-verify-failed");
    }
  });
});

// Section 6: readKeyHistory + writeKeyHistory shape validation
describe("readKeyHistory + writeKeyHistory — Section 6: history file shape per DC-5", () => {
  it("T6.1: write + read roundtrip preserves history", async () => {
    const historyPath = path.join(tmpDir, "charlie.history.json");
    const history: KeyHistory = {
      kind_version: 1,
      nato: "charlie",
      entries: [
        {
          fingerprint: "a".repeat(64),
          pubkey_path: "charlie.ed25519.pub",
          active_from: "2026-05-26T00:00:00.000Z",
          active_until: null,
          status: "active",
        },
      ],
    };
    await writeKeyHistory(historyPath, history);
    const read = await readKeyHistory(historyPath);
    expect(read).toEqual(history);
  });

  it("T6.2: readKeyHistory returns null on file-not-found (pre-bootstrap state)", async () => {
    const result = await readKeyHistory(
      path.join(tmpDir, "nonexistent.history.json"),
    );
    expect(result).toBeNull();
  });

  it("T6.3: readKeyHistory returns null on malformed JSON", async () => {
    const historyPath = path.join(tmpDir, "bad.history.json");
    await fs.writeFile(historyPath, "{not valid json", "utf-8");
    expect(await readKeyHistory(historyPath)).toBeNull();
  });

  it("T6.4: readKeyHistory rejects wrong kind_version", async () => {
    const historyPath = path.join(tmpDir, "bad.history.json");
    await fs.writeFile(
      historyPath,
      JSON.stringify({ kind_version: 2, nato: "charlie", entries: [] }),
      "utf-8",
    );
    expect(await readKeyHistory(historyPath)).toBeNull();
  });

  it("T6.5: readKeyHistory rejects empty nato", async () => {
    const historyPath = path.join(tmpDir, "bad.history.json");
    await fs.writeFile(
      historyPath,
      JSON.stringify({ kind_version: 1, nato: "", entries: [] }),
      "utf-8",
    );
    expect(await readKeyHistory(historyPath)).toBeNull();
  });

  it("T6.6: readKeyHistory rejects entry with invalid status", async () => {
    const historyPath = path.join(tmpDir, "bad.history.json");
    await fs.writeFile(
      historyPath,
      JSON.stringify({
        kind_version: 1,
        nato: "charlie",
        entries: [
          {
            fingerprint: "a".repeat(64),
            pubkey_path: "charlie.ed25519.pub",
            active_from: "2026-05-26T00:00:00.000Z",
            active_until: null,
            status: "INVALID-STATUS",
          },
        ],
      }),
      "utf-8",
    );
    expect(await readKeyHistory(historyPath)).toBeNull();
  });

  it("T6.7: readKeyHistory rejects entry with unparseable active_from", async () => {
    const historyPath = path.join(tmpDir, "bad.history.json");
    await fs.writeFile(
      historyPath,
      JSON.stringify({
        kind_version: 1,
        nato: "charlie",
        entries: [
          {
            fingerprint: "a".repeat(64),
            pubkey_path: "charlie.ed25519.pub",
            active_from: "not-a-date",
            active_until: null,
            status: "active",
          },
        ],
      }),
      "utf-8",
    );
    expect(await readKeyHistory(historyPath)).toBeNull();
  });

  it("T6.8: readKeyHistory accepts empty entries array (pre-bootstrap state)", async () => {
    const historyPath = path.join(tmpDir, "empty.history.json");
    await fs.writeFile(
      historyPath,
      JSON.stringify({ kind_version: 1, nato: "charlie", entries: [] }),
      "utf-8",
    );
    const read = unwrap(await readKeyHistory(historyPath));
    expect(read.entries).toEqual([]);
  });
});

// Section 7: resolveKeyAtTime lookup semantics
describe("resolveKeyAtTime — Section 7: lookup-by-signed_at per DC-5", () => {
  const baseHistory: KeyHistory = {
    kind_version: 1,
    nato: "charlie",
    entries: [
      {
        fingerprint: "key1",
        pubkey_path: "charlie.ed25519.pub.v1",
        active_from: "2026-01-01T00:00:00.000Z",
        active_until: "2026-03-01T00:00:00.000Z",
        status: "rotated",
      },
      {
        fingerprint: "key2",
        pubkey_path: "charlie.ed25519.pub.v2",
        active_from: "2026-03-01T00:00:00.000Z",
        active_until: null,
        status: "active",
      },
    ],
  };

  it("T7.1: resolves currently-active key for present-day signed_at", () => {
    const result = resolveKeyAtTime(baseHistory, "2026-05-26T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fingerprint).toBe("key2");
    }
  });

  it("T7.2: resolves historical (rotated) key for past signed_at within rotated window", () => {
    const result = resolveKeyAtTime(baseHistory, "2026-02-15T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fingerprint).toBe("key1");
    }
  });

  it("T7.3: half-open boundary — signed_at at active_until uses NEXT key", () => {
    const result = resolveKeyAtTime(baseHistory, "2026-03-01T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.fingerprint).toBe("key2");
    }
  });

  it("T7.4: returns no-active-key-at-timestamp for pre-history signed_at", () => {
    const result = resolveKeyAtTime(baseHistory, "2025-12-31T00:00:00.000Z");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no-active-key-at-timestamp");
    }
  });

  it("T7.5: returns key-revoked for revoked entry (currently-active)", () => {
    const revokedHistory: KeyHistory = {
      kind_version: 1,
      nato: "charlie",
      entries: [
        {
          fingerprint: "revoked-key",
          pubkey_path: "charlie.ed25519.pub.v1",
          active_from: "2026-01-01T00:00:00.000Z",
          active_until: null,
          status: "revoked",
        },
      ],
    };
    const result = resolveKeyAtTime(revokedHistory, "2026-05-26T00:00:00.000Z");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("key-revoked");
      if (result.error.kind === "key-revoked") {
        expect(result.error.fingerprint).toBe("revoked-key");
      }
    }
  });

  it("T7.6: returns key-revoked for revoked entry (historical window)", () => {
    const revokedHistory: KeyHistory = {
      kind_version: 1,
      nato: "charlie",
      entries: [
        {
          fingerprint: "revoked-key",
          pubkey_path: "charlie.ed25519.pub.v1",
          active_from: "2026-01-01T00:00:00.000Z",
          active_until: "2026-03-01T00:00:00.000Z",
          status: "revoked",
        },
      ],
    };
    const result = resolveKeyAtTime(revokedHistory, "2026-02-15T00:00:00.000Z");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("key-revoked");
    }
  });

  it("T7.7: returns no-active-key-at-timestamp for unparseable signed_at", () => {
    const result = resolveKeyAtTime(baseHistory, "not-a-timestamp");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no-active-key-at-timestamp");
    }
  });

  it("T7.8: returns no-active-key-at-timestamp for empty history", () => {
    const emptyHistory: KeyHistory = {
      kind_version: 1,
      nato: "charlie",
      entries: [],
    };
    const result = resolveKeyAtTime(emptyHistory, "2026-05-26T00:00:00.000Z");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no-active-key-at-timestamp");
    }
  });
});

// Section 8: appendKeyEntry rotation flow
describe("appendKeyEntry — Section 8: rotation/revocation discipline per DC-5", () => {
  it("T8.1: appending new active entry rotates prior active entry", () => {
    const bootstrap: KeyHistory = {
      kind_version: 1,
      nato: "charlie",
      entries: [
        {
          fingerprint: "key1",
          pubkey_path: "charlie.ed25519.pub",
          active_from: "2026-01-01T00:00:00.000Z",
          active_until: null,
          status: "active",
        },
      ],
    };
    const rotation: KeyHistoryEntry = {
      fingerprint: "key2",
      pubkey_path: "charlie.ed25519.pub",
      active_from: "2026-05-26T00:00:00.000Z",
      active_until: null,
      status: "active",
    };
    const rotated = appendKeyEntry(bootstrap, rotation);
    expect(rotated.entries).toHaveLength(2);
    expect(unwrap(rotated.entries[0]).status).toBe("rotated");
    expect(unwrap(rotated.entries[0]).active_until).toBe(
      "2026-05-26T00:00:00.000Z",
    );
    expect(unwrap(rotated.entries[1]).status).toBe("active");
    expect(unwrap(rotated.entries[1]).active_until).toBeNull();
  });

  it("T8.2: appending bootstrap entry to empty history", () => {
    const empty: KeyHistory = {
      kind_version: 1,
      nato: "charlie",
      entries: [],
    };
    const bootstrap: KeyHistoryEntry = {
      fingerprint: "key1",
      pubkey_path: "charlie.ed25519.pub",
      active_from: "2026-01-01T00:00:00.000Z",
      active_until: null,
      status: "active",
    };
    const result = appendKeyEntry(empty, bootstrap);
    expect(result.entries).toHaveLength(1);
    expect(unwrap(result.entries[0])).toEqual(bootstrap);
  });

  it("T8.3: preserves nato + kind_version", () => {
    const history: KeyHistory = {
      kind_version: 1,
      nato: "charlie",
      entries: [],
    };
    const entry: KeyHistoryEntry = {
      fingerprint: "key1",
      pubkey_path: "charlie.ed25519.pub",
      active_from: "2026-01-01T00:00:00.000Z",
      active_until: null,
      status: "active",
    };
    const result = appendKeyEntry(history, entry);
    expect(result.kind_version).toBe(1);
    expect(result.nato).toBe("charlie");
  });
});

// Section 9: computeFingerprint determinism
describe("computeFingerprint — Section 9: stable cross-cohort identifier", () => {
  it("T9.1: returns 64-char lowercase hex string", async () => {
    const keypair = await generateKeypair();
    const fp = await computeFingerprint(keypair.publicKey);
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("T9.2: same key produces same fingerprint (determinism)", async () => {
    const keypair = await generateKeypair();
    const fp1 = await computeFingerprint(keypair.publicKey);
    const fp2 = await computeFingerprint(keypair.publicKey);
    expect(fp1).toBe(fp2);
  });

  it("T9.3: imported pubkey produces same fingerprint as original", async () => {
    const original = await generateKeypair();
    const originalFp = await computeFingerprint(original.publicKey);
    await exportKeypairToPaths(original, "charlie", { cohortDir: tmpDir });
    const imported = unwrap(
      await importPublicKey(path.join(tmpDir, "charlie.ed25519.pub")),
    );
    const importedFp = await computeFingerprint(imported);
    expect(importedFp).toBe(originalFp);
  });
});
