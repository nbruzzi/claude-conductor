// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared types + path helpers for config-protection approval markers.
 *
 * Both the hook (config-protection.ts) and the CLI (config-protection-cli.ts)
 * import from here so the marker-path mangling logic lives in one place.
 *
 * Markers live at <approvals-root>/<hash>.json where:
 *   - approvals-root = $HOME/.claude/config-protection-approvals (HOME env
 *     respected so test isolation works; falls back to os.homedir() if HOME
 *     is unset, which should not happen in normal operation but is defensive)
 *   - hash = first 16 hex chars of SHA-256(canonical absolute path)
 *
 * Path canonicalization: callers MUST pass the result of canonicalizePath()
 * before computing the marker path or comparing marker.path. The canonical
 * form resolves symlinks and ".."/"." segments so /tmp/X and /private/tmp/X
 * both hash to the same marker (macOS) and approvals match regardless of how
 * the editing tool spelled the path.
 */

import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, normalize } from "node:path";

import { effectiveHome } from "../../shared/home.ts";

// Re-exported for back-compat with dotfiles shims that import effectiveHome
// from this module's old location. Canonical source is `src/shared/home.ts`;
// new consumers should import from there. Cleanup tracked in vault backlog.
export { effectiveHome };

const APPROVALS_DIR_NAME = "config-protection-approvals";
const HASH_PREFIX_LENGTH = 16;
const MAX_REASON_LENGTH = 200;

export type ApprovalMarker = {
  readonly version: 1;
  readonly path: string;
  readonly approved_at: string;
  readonly expires_at: string;
  readonly reason: string;
};

/** ISO-8601-ish date string check — rejects empty, garbage, and NaN-producing inputs. */
function isIsoString(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

/**
 * Type predicate for unmarshalled `ApprovalMarker` JSON. Validates shape +
 * runtime invariants downstream code already assumes:
 *   - `version === 1` literal (rejects future-version markers a current
 *     consumer cannot interpret)
 *   - `path` is a non-empty string (path canonicalization downstream)
 *   - `approved_at` and `expires_at` parse as finite-ms timestamps
 *   - `reason` is a string (sanitized downstream)
 *
 * Sub-step 0.10 TS-1 — replaces the `as ApprovalMarker` cast that accepted
 * any JSON object shape. Adversarial-audit TS-A1 spec.
 */
export function isApprovalMarker(v: unknown): v is ApprovalMarker {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o["version"] === 1 &&
    typeof o["path"] === "string" &&
    o["path"].length > 0 &&
    isIsoString(o["approved_at"]) &&
    isIsoString(o["expires_at"]) &&
    typeof o["reason"] === "string"
  );
}

export function approvalsDir(): string {
  return join(effectiveHome(), ".claude", APPROVALS_DIR_NAME);
}

/**
 * Canonical form for marker-path identity. Resolves symlinks + ".." segments
 * so two spellings of the same on-disk file map to the same marker.
 *
 * Falls back to normalize(path) when realpath fails (e.g., the file does not
 * yet exist — common for `Write` to a brand-new config). normalize() still
 * collapses ".." but does not resolve symlinks; this is acceptable because
 * the marker comparison happens twice (write-side and read-side use the same
 * canonicalizePath, so identity holds even when realpath is unavailable).
 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return normalize(path);
  }
}

export function markerPath(absolutePath: string): string {
  const canonical = canonicalizePath(absolutePath);
  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, HASH_PREFIX_LENGTH);
  return join(approvalsDir(), `${hash}.json`);
}

// Characters stripped from --reason: ASCII control chars (0x00-0x1F except tab),
// DEL (0x7F), and Unicode line/paragraph separators (U+2028/U+2029). Built from
// char codes via String.fromCharCode to avoid literal control chars in source.
const REASON_STRIP_RE = (() => {
  const codes: number[] = [];
  for (let c = 0x00; c <= 0x08; c++) codes.push(c); // skip 0x09 (tab)
  for (let c = 0x0a; c <= 0x1f; c++) codes.push(c);
  codes.push(0x7f, 0x2028, 0x2029);
  const escaped = codes
    .map((c) => `\\u${c.toString(16).padStart(4, "0")}`)
    .join("");
  return new RegExp(`[${escaped}]`, "g");
})();

/**
 * Sanitize a user-supplied reason string for storage. Truncates to a max
 * length and strips control characters that would break grep/cat/audit-log
 * formatting downstream.
 */
export function sanitizeReason(reason: string): string {
  const stripped = reason.replace(REASON_STRIP_RE, "");
  if (stripped.length <= MAX_REASON_LENGTH) return stripped;
  return stripped.slice(0, MAX_REASON_LENGTH - 3) + "...";
}
