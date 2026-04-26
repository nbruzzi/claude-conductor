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

import { homedir } from "node:os";
import { join } from "node:path";

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

/**
 * Resolve the home directory honoring $HOME first, then os.homedir(). Tests
 * mutate $HOME for isolation; os.homedir() is cached at process start and
 * does NOT pick up later mutations on macOS/Linux. Same shape as
 * config-protection-store.ts.
 */
export function effectiveHome(): string {
  const env = process.env["HOME"];
  if (env !== undefined && env.length > 0) return env;
  return homedir();
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
