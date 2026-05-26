// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { effectiveHome } from "./home.ts";

type ComponentName =
  | "channels"
  | "identity"
  | "todos"
  | "handoffs"
  | "active-sessions"
  | "decision-logs"
  | "audits"
  | "memories"
  | "keys";

type ComponentSpec = {
  readonly defaultSuffix: string;
  readonly envVar: string;
  // Optional legacy env-var name accepted as a deprecated alias for envVar.
  // Used during cross-edge migrations where consumers (e.g., dotfiles forks
  // not yet shimmed) still set the legacy name. Resolution precedence:
  // envVar > legacyEnvVar > root > fallback. Only declared on components
  // with active legacy consumers; absent on plugin-native components.
  readonly legacyEnvVar?: string;
};

const COMPONENT_SPECS: { readonly [K in ComponentName]: ComponentSpec } = {
  channels: {
    defaultSuffix: "channels",
    envVar: "CLAUDE_CONDUCTOR_CHANNELS_DIR",
  },
  identity: {
    defaultSuffix: "identity",
    envVar: "CLAUDE_CONDUCTOR_IDENTITY_DIR",
  },
  todos: { defaultSuffix: "todos", envVar: "CLAUDE_CONDUCTOR_TODOS_DIR" },
  handoffs: {
    defaultSuffix: "handoffs",
    envVar: "CLAUDE_CONDUCTOR_HANDOFFS_DIR",
  },
  "active-sessions": {
    defaultSuffix: "active-sessions",
    envVar: "CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR",
    // Legacy alias — dotfiles fork at src/active-sessions/index.ts (and its
    // 5 test files) reads CLAUDE_ACTIVE_SESSIONS_DIR. Accepted here as a
    // deprecated fallback so post-shim test isolation continues to work
    // before the dotfiles-side env-var fan-out. Per fork-inventory at
    // ~/.claude/notes/dotfiles-fork-inventory-2026-05-06.md (TS-1 fold from
    // Item #1 audit) + memory feedback-cross-edge-via-shim-env-var-trap.md.
    legacyEnvVar: "CLAUDE_ACTIVE_SESSIONS_DIR",
  },
  // Plugin-internal artifacts (no dotfiles canonical) — keep conductor namespace
  // in the layer-3 fallback to avoid colliding with shared ~/.claude/ state.
  // Per Decision N (post-mortem on Decision J — namespace revert for v0.1.0).
  "decision-logs": {
    defaultSuffix: "conductor/decisions",
    envVar: "CLAUDE_CONDUCTOR_DECISION_LOGS_DIR",
  },
  audits: {
    defaultSuffix: "conductor/audits",
    envVar: "CLAUDE_CONDUCTOR_AUDITS_DIR",
  },
  memories: {
    // DEPRECATED for memoriesDir() resolution — bypassed by the project-
    // namespaced resolver added in cycle-2026-05-22 T4-Y1. Retained in
    // COMPONENT_SPECS for type-system stability + the legacy fallback path
    // (memoriesDir() returns join(fallbackRoot(), "memories") when
    // CLAUDE_CODE_SESSION_ID-based discovery fails, e.g. in CLI/test
    // environments without Claude Code's session env var). Future cleanup
    // slice may remove if no other code-paths reference.
    defaultSuffix: "memories",
    envVar: "CLAUDE_CONDUCTOR_MEMORIES_DIR",
  },
  keys: {
    // Cycle 1 substrate-core PR-A3 (2026-05-26) — Pair B Charlie-pen
    // Ed25519 key surface per Decision #9 4-NATO ratify-clean
    // (OPERATOR-GLOBAL `~/.claude/keys/`); cohort sub-directory layered
    // via cohortKeysDir() below. Consumer-routing avoids `.claude/`
    // literals in src/channels/key-surface.ts per CGP-003 discipline.
    defaultSuffix: "keys",
    envVar: "CLAUDE_CONDUCTOR_KEYS_DIR",
  },
};

const ROOT_ENV_VAR = "CLAUDE_CONDUCTOR_ROOT";
// Layer-3 fallback root — defaults to ~/.claude/ matching dotfiles canonical
// for the 6 components that have a dotfiles counterpart (channels, todos,
// identity, active-sessions, handoffs, memories). The 2 plugin-internal
// components (audits, decision-logs) embed `conductor/` in their defaultSuffix
// so they remain isolated even at this layer. Per Decision N.
const FALLBACK_ROOT_SUFFIX = ".claude";

function fallbackRoot(): string {
  return join(effectiveHome(), FALLBACK_ROOT_SUFFIX);
}

function resolveComponent(component: ComponentName): string {
  const spec = COMPONENT_SPECS[component];
  const componentEnv = process.env[spec.envVar];
  if (componentEnv && componentEnv.length > 0) {
    return componentEnv;
  }
  // Legacy env-var fallback — only fires when component declares a legacyEnvVar
  // AND the current envVar is unset/empty. Documented in ComponentSpec doc-comment.
  if (spec.legacyEnvVar !== undefined) {
    const legacyEnv = process.env[spec.legacyEnvVar];
    if (legacyEnv && legacyEnv.length > 0) {
      return legacyEnv;
    }
  }
  const rootEnv = process.env[ROOT_ENV_VAR];
  if (rootEnv && rootEnv.length > 0) {
    return join(rootEnv, spec.defaultSuffix);
  }
  return join(fallbackRoot(), spec.defaultSuffix);
}

export function channelsDir(): string {
  return resolveComponent("channels");
}

export function identityDir(): string {
  return resolveComponent("identity");
}

export function todosDir(): string {
  return resolveComponent("todos");
}

export function handoffsDir(): string {
  return resolveComponent("handoffs");
}

export function activeSessionsDir(): string {
  return resolveComponent("active-sessions");
}

export function decisionLogsDir(): string {
  return resolveComponent("decision-logs");
}

export function auditsDir(): string {
  return resolveComponent("audits");
}

/**
 * Root of the operator-global key surface (`~/.claude/keys/` per Decision
 * #9 4-NATO ratify-clean). Per-cohort layering is provided by
 * {@link cohortKeysDir}.
 */
export function keysDir(): string {
  return resolveComponent("keys");
}

/**
 * Cohort sub-directory under the operator-global key surface (i.e.,
 * `~/.claude/keys/cohort/`). Sibling to channelsDir/todosDir/etc. for
 * Cycle 1 substrate-core key-surface.ts consumer routing per
 * `[[feedback-substrate-precedes-consumer-via-prop]]` discipline.
 *
 * Per slice plan `cycle-1-substrate-core-slice-plan-2026-05-26.md`
 * §2.1: canonical files live at
 * `~/.claude/keys/cohort/<nato>.ed25519.{pub,sec,history.json}`.
 */
export function cohortKeysDir(): string {
  return join(keysDir(), "cohort");
}

// ============================================================================
// T4-Y1 cycle 2026-05-22 — project-namespaced memory directory helpers.
//
// Claude Code's memory storage convention: ~/.claude/projects/<slug>/memory/
// where <slug> is the project root path with forward-slashes replaced by
// hyphens (e.g. /Users/nbruzzi → -Users-nbruzzi, /Users/nbruzzi/.claude-dotfiles
// → -Users-nbruzzi-.claude-dotfiles). This is a Claude Code harness convention;
// deviation breaks operator memory-loading + memory-attention-updater hook
// detection. See cycle-2026-05-22 T3-E L2 substrate gap memorialization
// (feedback-memoriesdir-project-namespaced-resolution, candidate).
//
// `memoriesDir()` returns the per-project memory path. `memoriesDirForSlug(slug)`
// is for callers that already have a slug (e.g. Stop hook extracted from
// `input.transcriptPath`). `projectSlugFromTranscriptPath(p)` parses the slug
// from a transcript path. `discoverProjectSlug()` resolves the current
// session's slug by scanning `~/.claude/projects/` for the session-id's
// transcript file (S2-A per Charlie plan-tier fold; more reliable than
// cwd-derivation under per-session worktrees).
//
// NOTE: memory is the ONLY component dir that is project-namespaced. Other
// resolvers (channelsDir, identityDir, todosDir, handoffsDir,
// activeSessionsDir, decisionLogsDir, auditsDir) are user-scoped.
// ============================================================================

const SESSION_ID_ENV_VAR = "CLAUDE_CODE_SESSION_ID";
let cachedProjectSlug: string | undefined = undefined;
let cacheInitialized = false;

/**
 * Discover the project slug for the current Claude Code session by scanning
 * `~/.claude/projects/<slug>/<session-id>.jsonl` for ownership. Module-level
 * cache (initialized on first call → O(1) on subsequent calls within the
 * process lifetime). Cache reset for tests via
 * `INTERNAL.resetProjectSlugCache()`.
 *
 * Returns undefined when CLAUDE_CODE_SESSION_ID is unset, the projects/
 * directory is unreadable, or no project contains a transcript file matching
 * the session-id (e.g. CLI invocations from outside a Claude Code session).
 */
export function discoverProjectSlug(): string | undefined {
  if (cacheInitialized) return cachedProjectSlug;
  cacheInitialized = true;

  const sid = process.env[SESSION_ID_ENV_VAR];
  if (sid === undefined || sid.length === 0) return undefined;

  const projectsRoot = join(effectiveHome(), ".claude", "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsRoot);
  } catch {
    return undefined;
  }

  for (const slug of entries) {
    const transcriptPath = join(projectsRoot, slug, `${sid}.jsonl`);
    if (existsSync(transcriptPath)) {
      cachedProjectSlug = slug;
      return cachedProjectSlug;
    }
  }
  return undefined;
}

/**
 * Extract the project slug from a Claude Code transcript path. Path shape:
 * `<home>/.claude/projects/<slug>/<session-id>.jsonl`. Returns undefined on
 * shape mismatch. More reliable than `discoverProjectSlug()` when the caller
 * has direct transcriptPath context (Stop hook `input.transcriptPath`);
 * avoids the filesystem scan.
 */
export function projectSlugFromTranscriptPath(
  transcriptPath: string,
): string | undefined {
  const match = transcriptPath.match(
    /\/\.claude\/projects\/([^/]+)\/[^/]+\.jsonl$/,
  );
  return match?.[1];
}

/**
 * Build the project-namespaced memory directory for a caller-supplied slug.
 * Honors the same layered env-var precedence as `memoriesDir()`:
 *   Layer 1: `CLAUDE_CONDUCTOR_MEMORIES_DIR` (operator-supplied absolute path)
 *   Layer 2: `CLAUDE_CONDUCTOR_ROOT` prefix + `projects/<slug>/memory`
 *   Layer 3: `~/.claude/projects/<slug>/memory` (Claude Code convention)
 */
export function memoriesDirForSlug(slug: string): string {
  const env = process.env["CLAUDE_CONDUCTOR_MEMORIES_DIR"];
  if (env !== undefined && env.length > 0) return env;

  const root = process.env[ROOT_ENV_VAR];
  if (root !== undefined && root.length > 0) {
    return join(root, "projects", slug, "memory");
  }

  return join(effectiveHome(), ".claude", "projects", slug, "memory");
}

/**
 * Memory storage directory for the current Claude Code session.
 *
 * Resolution order:
 *   Layer 1: `CLAUDE_CONDUCTOR_MEMORIES_DIR` (operator-supplied absolute path)
 *   Layer 2 (project-namespaced, when slug discoverable):
 *     `discoverProjectSlug()` succeeds → `memoriesDirForSlug(slug)`
 *   Layer 3 (legacy fallback, when slug discovery fails):
 *     `CLAUDE_CONDUCTOR_ROOT` + `memories` OR `~/.claude/memories`
 *
 * The legacy fallback (Layer 3) preserves backward-compat for environments
 * without `CLAUDE_CODE_SESSION_ID` (CLI invocations from outside a Claude
 * Code session, test environments). Within a Claude Code session, Layer 2
 * resolves to the per-project memory storage.
 */
export function memoriesDir(): string {
  const env = process.env["CLAUDE_CONDUCTOR_MEMORIES_DIR"];
  if (env !== undefined && env.length > 0) return env;

  const slug = discoverProjectSlug();
  if (slug !== undefined) return memoriesDirForSlug(slug);

  const root = process.env[ROOT_ENV_VAR];
  if (root !== undefined && root.length > 0) return join(root, "memories");
  return join(fallbackRoot(), "memories");
}

export const INTERNAL = {
  /**
   * Test-only: reset the `discoverProjectSlug()` module-level cache so each
   * test starts with a fresh resolution. Matches sibling INTERNAL patterns
   * in `identity.ts` / `registry-assertion.ts`.
   */
  resetProjectSlugCache(): void {
    cachedProjectSlug = undefined;
    cacheInitialized = false;
  },
};
