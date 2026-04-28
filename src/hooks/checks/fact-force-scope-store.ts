// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared types + path helpers for fact-force scope-approval markers.
 *
 * A scope marker pre-authorizes "next N file operations under reason X" so a
 * planned batch of file creations/edits doesn't require per-file conversational
 * fact-statements. The marker is consumed incrementally — each gated edit/write
 * decrements the remaining budget; when the budget reaches zero OR the TTL
 * expires, the marker auto-deletes and the gate reverts to per-file fact prompts.
 *
 * Markers live at <approvals-root>/<sessionId>.json where:
 *   - approvals-root = $HOME/.claude/fact-force-scopes (HOME env respected
 *     via effectiveHome() so test isolation works; falls back to os.homedir()
 *     if HOME is unset, defensively)
 *   - sessionId = the hook input's session_id (validated by isValidSessionId)
 *
 * Per-session isolation: scopes do NOT cross sessions. Two parallel Claude
 * sessions in the same project each have their own scope marker (or none).
 * This matches fact-force's own per-session sharding.
 */

import { join } from "node:path";

import { effectiveHome } from "../../shared/home.ts";

// Re-exported for back-compat with dotfiles shims that import effectiveHome
// from this module's old location. Canonical source is `src/shared/home.ts`;
// new consumers should import from there. Cleanup tracked in vault backlog.
export { effectiveHome };

const SCOPES_DIR_NAME = "fact-force-scopes";
const MAX_REASON_LENGTH = 200;

export type ScopeMarker = {
  readonly version: 1;
  readonly sessionId: string;
  readonly reason: string;
  readonly approved_at: string;
  readonly expires_at: string;
  /** Maximum file operations covered by this scope. */
  readonly max_files: number;
  /** Files consumed so far. Updated by store helpers via writeScopeMarker. */
  readonly files_consumed: number;
};

/** ISO-8601-ish date string check — rejects empty, garbage, and NaN-producing inputs. */
function isIsoString(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

/**
 * Type predicate for unmarshalled `ScopeMarker` JSON. Validates shape +
 * runtime invariants `tryConsumeScope` assumes:
 *   - `version === 1` literal (future-version safety)
 *   - `sessionId` and `reason` are strings
 *   - `approved_at` and `expires_at` parse as finite-ms timestamps
 *   - `max_files` and `files_consumed` are non-negative integers (NaN /
 *     Infinity / negative values would break the budget-exhaustion comparison
 *     `files_consumed >= max_files` — `NaN >= NaN` is false, looping forever)
 *   - `files_consumed <= max_files` (already-exhausted markers fail-closed)
 *
 * Sub-step 0.10 TS-1 — replaces the `as ScopeMarker` cast at fact-force.ts:302
 * that accepted any JSON object shape. Closes the NaN-loop risk in
 * `tryConsumeScope` per adversarial-audit TS-A1.
 */
export function isScopeMarker(v: unknown): v is ScopeMarker {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o["version"] !== 1) return false;
  if (typeof o["sessionId"] !== "string") return false;
  if (typeof o["reason"] !== "string") return false;
  if (!isIsoString(o["approved_at"])) return false;
  if (!isIsoString(o["expires_at"])) return false;
  const max = o["max_files"];
  const consumed = o["files_consumed"];
  if (typeof max !== "number" || !Number.isInteger(max) || max < 0)
    return false;
  if (
    typeof consumed !== "number" ||
    !Number.isInteger(consumed) ||
    consumed < 0
  ) {
    return false;
  }
  if (consumed > max) return false;
  return true;
}

export function scopesDir(): string {
  return join(effectiveHome(), ".claude", SCOPES_DIR_NAME);
}

export function scopeMarkerPath(sessionId: string): string {
  return join(scopesDir(), `${sessionId}.json`);
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
