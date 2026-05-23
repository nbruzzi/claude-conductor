// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Artifact-id and session-id syntactic validation primitive.
 *
 * Session IDs and artifact IDs are joined into filesystem paths inside
 * ~/.claude/active-sessions/, ~/.claude/channels/, and similar registries.
 * A malformed value containing `..`, `/`, or NUL would escape the registry
 * directory. Defense-in-depth: validate at every boundary, even though
 * Claude Code's raw.session_id is normally a UUID.
 *
 * Pure module — ZERO imports (purer than `src/shared/home.ts` which carries
 * a `node:os` import). Safe to consume from any context including client-
 * bundled code (e.g. SvelteKit dashboard's client-reachable URL parser via
 * `claude-conductor/shared/artifact-id`).
 *
 * Extracted from `src/active-sessions/index.ts` (cycle 2026-05-23) per
 * dashboard L4 cross-edge-cleanliness fold — importing from
 * `claude-conductor/active-sessions` pulled `node:child_process` / `crypto`
 * / `fs` / `os` / `path` into client bundles. `isValidSessionId` shares
 * this regex and stays in active-sessions/index.ts (server-only naming
 * intent for session-id-shaped values); it uses the imported regex.
 */

export const VALID_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidArtifactId(s: unknown): s is string {
  return typeof s === "string" && VALID_ID_REGEX.test(s);
}
