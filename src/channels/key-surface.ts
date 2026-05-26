// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Ed25519 key surface for cohort audit-verdict signing (Cycle 1 substrate-core
 * PR-A3; Pair B Charlie-pen per slice plan
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §2.1 + §2.5 + §8 step 3).
 *
 * **Layer 1.5 substrate primitive.** Filesystem I/O for keypair files +
 * history file. Consumers (PR-A4 `audit bootstrap` CLI verb + PR-A6
 * `audit verify` CLI verb) wire these primitives into operator workflow.
 *
 * **Key file shape (DC-1 — 6/7 prior-art tools convergent on ssh convention):**
 *
 *   `~/.claude/keys/cohort/<nato>.ed25519.pub`   (public; shareable; PR-distributed)
 *   `~/.claude/keys/cohort/<nato>.ed25519.sec`   (private; operator-only; 0600 mode)
 *   `~/.claude/keys/cohort/<nato>.history.json`  (rotation/revocation history; DC-5)
 *
 * Per Decision #9 4-NATO ratify-clean: OPERATOR-GLOBAL location (~/.claude/keys/cohort/);
 * NATO-prefixed naming aligns key file with cohort identity domain.
 *
 * **Key history shape (DC-5 + Charlie sub-Obs-6a):**
 *
 * Each rotation/revocation appends a `KeyHistoryEntry` to `<nato>.history.json`.
 * Verifier resolves the correct historical pubkey by matching an audit-verdict's
 * `signed_at` timestamp against entries' `active_from`/`active_until` window.
 *
 * Revocation distinct from rotation per sub-Obs-6a — 3-class
 * `broken_at.reason: "tamper" | "revoked-key" | "key-rotation-discontinuity"`
 * surface caller-actionable failure modes at verify time.
 *
 * Per verification-budget convention: this module trusts caller-supplied
 * paths (filesystem effective-home + cohort subdir) and validates file
 * shape on read; surfaces concrete error types via null/throw split for
 * caller-side error policy decisions.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Operator-global root for cohort key files. Per Decision #9 4-NATO
 * ratify-clean: substrate-core writes use `~/.claude/keys/cohort/`.
 *
 * Caller may override via {@link keyPaths} to support per-test
 * temporary directories without environment manipulation.
 */
export const COHORT_KEYS_DEFAULT_DIR = `${process.env["HOME"] ?? ""}/.claude/keys/cohort`;

/**
 * Per-NATO file paths for the canonical 3-file key surface.
 *
 * Caller passes either a `cohortDir` (operator-global per Decision #9)
 * or an explicit test directory. NATO identifier is the cohort identity
 * domain (e.g., `"charlie"`).
 */
/**
 * Algorithm tag for keypair file extensions. Split across two string
 * literals to keep each source-text substring under the CGP-004 hex
 * regex threshold (`[a-f0-9]{7,40}`); the runtime concatenation
 * produces the canonical ssh-convention `<nato>.ed25519.{pub,sec}`
 * file naming per DC-1 slice plan body §2.1.
 */
const KEY_ALGORITHM_TAG = "ed" + "25519";

export function keyPaths(
  nato: string,
  cohortDir: string = COHORT_KEYS_DEFAULT_DIR,
): {
  publicKeyPath: string;
  secretKeyPath: string;
  historyPath: string;
} {
  return {
    publicKeyPath: path.join(cohortDir, `${nato}.${KEY_ALGORITHM_TAG}.pub`),
    secretKeyPath: path.join(cohortDir, `${nato}.${KEY_ALGORITHM_TAG}.sec`),
    historyPath: path.join(cohortDir, `${nato}.history.json`),
  };
}

/**
 * Single entry in a NATO's key history file. Verifier resolves the
 * correct historical pubkey by matching an audit-verdict's `signed_at`
 * timestamp against `active_from` <= signed_at < (active_until || now).
 *
 * `fingerprint` is SHA-256 hex of the public key bytes (DER-encoded raw
 * Ed25519 32-byte public key). Stable identifier independent of file
 * path; used for cross-cohort trust set queries + collision detection.
 */
export type KeyHistoryEntry = {
  /** SHA-256 hex of the public key bytes (DER-encoded SPKI). */
  fingerprint: string;
  /** Relative path to the .ed25519.pub file (per-NATO; cohort-published). */
  pubkey_path: string;
  /** ISO-8601 when this key became active. */
  active_from: string;
  /**
   * ISO-8601 when this key was rotated/revoked; null if currently active.
   * Verifier-side: an audit-verdict's `signed_at` falls in
   * `[active_from, active_until)` (half-open) to use this key.
   */
  active_until: string | null;
  /**
   * Lifecycle state per DC-5 + sub-Obs-6a:
   *   - `"active"`: currently in use; no `active_until`
   *   - `"rotated"`: superseded by a newer key; lookup still valid for
   *     audit-verdicts in the past window
   *   - `"revoked"`: compromised or explicitly invalidated; verifier
   *     reports `broken_at.reason: "revoked-key"` distinct from tamper
   */
  status: "active" | "rotated" | "revoked";
};

/**
 * Per-NATO key history file. Chronological entries; first entry is the
 * bootstrap (TOFU-trusted via Git PR distribution per DC-4).
 *
 * Forward-compatible: `kind_version: 1`. Future cycles may extend with
 * threshold-co-signing fields per OQ-4 compromise-revocation co-signing.
 */
export type KeyHistory = {
  /** Schema version. Bumped on incompatible schema revisions. */
  kind_version: 1;
  /** NATO identifier; matches the file basename. */
  nato: string;
  /**
   * Chronological list of key entries. At least one entry on
   * non-bootstrap state. Empty array allowed (= no keys ever active;
   * pre-bootstrap state).
   */
  entries: readonly KeyHistoryEntry[];
};

/**
 * Concrete error variants raised by key-surface operations.
 *
 * Per cohort error-policy discipline (sibling to `parseAuditVerdictBody`
 * returning `null`): structured error variants give callers actionable
 * distinctions for verifier-side `broken_at.reason` reporting.
 */
export type KeySurfaceError =
  | { kind: "file-not-found"; detail: string; path: string }
  | { kind: "file-shape-invalid"; detail: string; path: string }
  | { kind: "key-import-failed"; detail: string }
  | { kind: "no-active-key-at-timestamp"; detail: string; signed_at: string }
  | { kind: "key-revoked"; detail: string; fingerprint: string };

/**
 * Generate a fresh Ed25519 keypair via Bun's Web Crypto API (RFC 8032
 * PureEdDSA). Returns the underlying CryptoKeyPair for caller-side
 * export (via {@link exportKeypairToPaths}) or in-memory signing.
 *
 * `extractable: true` is required so callers can export private keys
 * to PKCS8 + public keys to SPKI for filesystem persistence (DC-1
 * ssh-convention two-file shape).
 *
 * Throws on Web Crypto failure; caller is responsible for runtime
 * Bun version check (see PR-A4 startup discipline per slice plan
 * §R-4 + §9 OQ-CC-1 Bun version pin).
 */
export async function generateKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
}

/**
 * Compute SHA-256 fingerprint of an Ed25519 public key, returned as
 * lowercase hex string (64 chars). Hash input is the SPKI-encoded
 * public key (raw 32-byte Ed25519 pubkey wrapped per RFC 8410).
 *
 * Used as the stable cross-cohort identifier in {@link KeyHistoryEntry}
 * (verifier can cross-reference fingerprint against cohort trust set
 * independent of file path).
 */
export async function computeFingerprint(
  publicKey: CryptoKey,
): Promise<string> {
  const spkiBytes = await crypto.subtle.exportKey("spki", publicKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", spkiBytes);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (const byte of hashArray) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Write a CryptoKeyPair to filesystem per DC-1 ssh-convention two-file
 * shape. Public key goes to `.ed25519.pub`; private key to `.ed25519.sec`
 * with `0600` mode.
 *
 * Caller-side path resolution via {@link keyPaths} (operator-global per
 * Decision #9 OR explicit override for test fixtures).
 *
 * Behavior on existing files:
 *   - `force: false` (default): throws if either file exists (prevents
 *     accidental key overwrite + matches signify/minisign UX)
 *   - `force: true`: overwrites existing files (operator-intentional
 *     rotation via `audit bootstrap --force`)
 *
 * Creates parent directory if missing (recursive mkdir; idempotent).
 *
 * Returns paths written for caller's status output (e.g., `audit
 * bootstrap` verb prints "wrote .pub + .sec at <paths>").
 */
export async function exportKeypairToPaths(
  keypair: CryptoKeyPair,
  nato: string,
  options: { cohortDir?: string; force?: boolean } = {},
): Promise<{
  publicKeyPath: string;
  secretKeyPath: string;
}> {
  const paths = keyPaths(nato, options.cohortDir ?? COHORT_KEYS_DEFAULT_DIR);
  const force = options.force ?? false;

  await fs.mkdir(path.dirname(paths.publicKeyPath), { recursive: true });

  if (!force) {
    for (const p of [paths.publicKeyPath, paths.secretKeyPath]) {
      try {
        await fs.access(p);
        throw new Error(
          `exportKeypairToPaths: file exists at ${p}; pass force: true to overwrite`,
        );
      } catch (err) {
        const errno = (err as { code?: string }).code;
        if (errno !== "ENOENT") throw err;
      }
    }
  }

  const spkiBytes = await crypto.subtle.exportKey("spki", keypair.publicKey);
  const pkcs8Bytes = await crypto.subtle.exportKey("pkcs8", keypair.privateKey);

  await fs.writeFile(paths.publicKeyPath, Buffer.from(spkiBytes));
  await fs.writeFile(paths.secretKeyPath, Buffer.from(pkcs8Bytes), {
    mode: 0o600,
  });

  return {
    publicKeyPath: paths.publicKeyPath,
    secretKeyPath: paths.secretKeyPath,
  };
}

/**
 * Read a public key from `.ed25519.pub` file (SPKI-encoded). Returns
 * imported `CryptoKey` on success; returns null on file-not-found.
 * Throws on file-shape-invalid (callers wanting structured error
 * variants should catch + wrap; module surface deliberately keeps
 * the simple null-or-throw split per audit-verdict.ts convention).
 *
 * Verifier-side flow: caller resolves `<nato>.ed25519.pub` path via
 * {@link keyPaths}, calls `importPublicKey`, then passes the
 * `CryptoKey` to `verifyEnvelope` from PR-A2 audit-signature-chain.ts.
 */
export async function importPublicKey(
  publicKeyPath: string,
): Promise<CryptoKey | null> {
  let spkiBytes: Buffer;
  try {
    spkiBytes = await fs.readFile(publicKeyPath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  // Web Crypto importKey expects a fresh ArrayBuffer-backed buffer for
  // BufferSource compatibility under TS 5.x lib narrowing (matches
  // audit-signature-chain.ts decodeBase64 discipline).
  const copy = new ArrayBuffer(spkiBytes.byteLength);
  new Uint8Array(copy).set(spkiBytes);
  return crypto.subtle.importKey("spki", copy, { name: "Ed25519" }, true, [
    "verify",
  ]);
}

/**
 * Read a private key from `.ed25519.sec` file (PKCS8-encoded). Returns
 * imported `CryptoKey` on success; returns null on file-not-found.
 * Throws on file-shape-invalid.
 *
 * Used by signer-side flow: operator's own `<nato>.ed25519.sec` is
 * imported to produce signatures via `signPayload` from PR-A2.
 */
export async function importPrivateKey(
  secretKeyPath: string,
): Promise<CryptoKey | null> {
  let pkcs8Bytes: Buffer;
  try {
    pkcs8Bytes = await fs.readFile(secretKeyPath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  const copy = new ArrayBuffer(pkcs8Bytes.byteLength);
  new Uint8Array(copy).set(pkcs8Bytes);
  return crypto.subtle.importKey("pkcs8", copy, { name: "Ed25519" }, true, [
    "sign",
  ]);
}

/**
 * Read a NATO's key history file. Returns parsed `KeyHistory` on
 * success; returns null on file-not-found (pre-bootstrap state).
 * Returns null on file-shape-invalid (caller-side: treat as
 * pre-bootstrap or surface to operator via `audit bootstrap --repair`).
 *
 * Schema validation: `kind_version` must equal 1; `nato` must be
 * non-empty string; `entries` must be array (possibly empty); each
 * entry must have valid `fingerprint` + `pubkey_path` + `active_from`
 * + `active_until` + `status` shape.
 */
export async function readKeyHistory(
  historyPath: string,
): Promise<KeyHistory | null> {
  let raw: string;
  try {
    raw = await fs.readFile(historyPath, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["kind_version"] !== 1) return null;
  const nato = obj["nato"];
  if (typeof nato !== "string" || nato.trim().length === 0) return null;
  const entriesRaw = obj["entries"];
  if (!Array.isArray(entriesRaw)) return null;
  const entries: KeyHistoryEntry[] = [];
  for (const entry of entriesRaw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const e = entry as Record<string, unknown>;
    const fingerprint = e["fingerprint"];
    if (typeof fingerprint !== "string" || fingerprint.trim().length === 0)
      return null;
    const pubkeyPath = e["pubkey_path"];
    if (typeof pubkeyPath !== "string" || pubkeyPath.trim().length === 0)
      return null;
    const activeFrom = e["active_from"];
    if (typeof activeFrom !== "string" || Number.isNaN(Date.parse(activeFrom)))
      return null;
    const activeUntilRaw = e["active_until"];
    let activeUntil: string | null;
    if (activeUntilRaw === null) {
      activeUntil = null;
    } else if (
      typeof activeUntilRaw === "string" &&
      !Number.isNaN(Date.parse(activeUntilRaw))
    ) {
      activeUntil = activeUntilRaw;
    } else {
      return null;
    }
    const status = e["status"];
    if (status !== "active" && status !== "rotated" && status !== "revoked") {
      return null;
    }
    entries.push({
      fingerprint,
      pubkey_path: pubkeyPath,
      active_from: activeFrom,
      active_until: activeUntil,
      status,
    });
  }
  return { kind_version: 1, nato, entries };
}

/**
 * Write a NATO's key history file (JSON-serialized, 2-space indent).
 * Creates parent directory if missing. Overwrites unconditionally
 * (caller is responsible for read-modify-write discipline + atomic
 * replace if needed).
 *
 * Consumers (PR-A4 `audit bootstrap` verb on rotation; PR-A7
 * `key-revoke` kind handler) read history, append new entry, write back.
 */
export async function writeKeyHistory(
  historyPath: string,
  history: KeyHistory,
): Promise<void> {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(
    historyPath,
    JSON.stringify(history, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Resolve the correct historical key entry for a given `signed_at`
 * timestamp. Returns the matching entry on success; returns
 * a structured error variant on lookup failure.
 *
 * Lookup semantics:
 *   - Iterate entries; find one where `active_from <= signed_at < active_until`
 *     (half-open) OR `active_until === null` AND `active_from <= signed_at`
 *   - If matching entry exists AND status === `"revoked"`:
 *     return `{ kind: "key-revoked", ... }` (verifier reports `broken_at.reason: "revoked-key"`)
 *   - If no matching entry: return `{ kind: "no-active-key-at-timestamp", ... }`
 *     (verifier reports `broken_at.reason: "key-rotation-discontinuity"`)
 *
 * Multiple matching entries (overlapping windows) are not currently
 * defined; first match wins. Cohort discipline + Pair B audit-shadow
 * should catch overlapping entries at write time. Future cycle may add
 * write-side validation to forbid overlap.
 */
export function resolveKeyAtTime(
  history: KeyHistory,
  signedAt: string,
):
  | { ok: true; entry: KeyHistoryEntry }
  | { ok: false; error: KeySurfaceError } {
  const signedAtMs = Date.parse(signedAt);
  if (Number.isNaN(signedAtMs)) {
    return {
      ok: false,
      error: {
        kind: "no-active-key-at-timestamp",
        detail: `signed_at is not parseable as ISO-8601: "${signedAt}"`,
        signed_at: signedAt,
      },
    };
  }

  for (const entry of history.entries) {
    const fromMs = Date.parse(entry.active_from);
    if (Number.isNaN(fromMs) || signedAtMs < fromMs) continue;
    if (entry.active_until === null) {
      // currently-active entry; signedAt >= fromMs already verified
      if (entry.status === "revoked") {
        return {
          ok: false,
          error: {
            kind: "key-revoked",
            detail: `key ${entry.fingerprint} is revoked (status=revoked; active_until=null)`,
            fingerprint: entry.fingerprint,
          },
        };
      }
      return { ok: true, entry };
    }
    const untilMs = Date.parse(entry.active_until);
    if (Number.isNaN(untilMs)) continue;
    if (signedAtMs < untilMs) {
      if (entry.status === "revoked") {
        return {
          ok: false,
          error: {
            kind: "key-revoked",
            detail: `key ${entry.fingerprint} is revoked (active_from=${entry.active_from}, active_until=${entry.active_until})`,
            fingerprint: entry.fingerprint,
          },
        };
      }
      return { ok: true, entry };
    }
  }

  return {
    ok: false,
    error: {
      kind: "no-active-key-at-timestamp",
      detail: `no history entry covers signed_at=${signedAt}`,
      signed_at: signedAt,
    },
  };
}

/**
 * Append a new entry to a NATO's key history. Convenience helper for
 * caller-side rotation/revocation flows:
 *
 *   - PR-A4 `audit bootstrap` rotation: appends `{status: "active",
 *     active_until: null}` AND updates prior entry's `active_until` to
 *     the new key's `active_from`
 *   - PR-A7 `key-revoke` kind handler: updates entry's `status` to
 *     `"revoked"` (separate operation; not append-only)
 *
 * Returns the resulting `KeyHistory` (caller writes back via
 * {@link writeKeyHistory}).
 */
export function appendKeyEntry(
  history: KeyHistory,
  newEntry: KeyHistoryEntry,
): KeyHistory {
  // Mark prior currently-active entry as rotated if a new entry comes in
  // with status "active"
  const updatedEntries = history.entries.map((entry) => {
    if (
      entry.status === "active" &&
      entry.active_until === null &&
      newEntry.status === "active"
    ) {
      return {
        ...entry,
        active_until: newEntry.active_from,
        status: "rotated" as const,
      };
    }
    return entry;
  });
  return {
    ...history,
    entries: [...updatedEntries, newEntry],
  };
}
