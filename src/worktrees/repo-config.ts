// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Per-repo worktree-provisioner config — schema + reader + topo-order
 * resolver for the `siblingCloneOf` dependency DAG.
 *
 * Config lives at `~/.claude/worktree-provisioner.json` (3-case
 * fail-discipline per RFC v0.2 FOLD-RE-1):
 *
 *   Case 1: absent       → `{ kind: "absent" }` → caller returns pass()
 *   Case 2: empty repos  → `{ kind: "ok", repos: [] }` → caller returns pass()
 *   Case 3: malformed    → `{ kind: "malformed", reason, path }` → caller
 *                          emits warn() with breadcrumb naming the parse
 *                          error + file path. DO NOT fail session-start.
 *
 * Sub-case 3a (siblingCloneOf reference to absent repo): topoSort detects
 * + returns an error. The hook handles this by skipping the dependent repo
 * with a breadcrumb (per RFC v0.2 §2).
 *
 * Plan: ~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md
 * §v0.2 + §v0.3 Slice 2.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_FILENAME = "worktree-provisioner.json";

/** Default path resolves `~/.claude/worktree-provisioner.json`.
 *  Override via env var for testability + operator override. */
const configPath = (): string => {
  const override = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".claude", CONFIG_FILENAME);
};

/** Single repo entry in the config. */
export type RepoConfigEntry = {
  /** Display + breadcrumb identifier. Required. Unique per config. */
  readonly name: string;
  /** Canonical repo path. Required. `~` expansion supported. */
  readonly canonical: string;
  /** Session worktree pattern with `<sid>` placeholder. Optional;
   *  defaults to `<canonical>-<sid-prefix-8>` via worktreePathForSession.
   *  Kept in v0.2 for future use; Slice 2 + this v0.3 don't substitute
   *  the pattern — the existing worktreePathForSession primitive is
   *  the path-source-of-truth. Field preserved for forward-compat. */
  readonly sessionWorktreePattern?: string;
  /** Provision on session-start? Default `false` (opt-in per repo
   *  preserves current manual-discipline; explicit operator opt-in
   *  required). */
  readonly auto?: boolean;
  /** Reap stale worktrees on session-start? Default matches `auto`
   *  (if you opt-in to provision, you opt-in to GC). Slice 3 ships
   *  the GC reaper that consumes this field. */
  readonly gc?: boolean;
  /** Cross-repo file:.. co-location dependency. Names another repo
   *  in the config that MUST be opted-in for this repo's worktree
   *  to provision. The topo-order resolver fails-closed on cycle. */
  readonly siblingCloneOf?: string;
  /** Aggressive GC threshold for low-traffic repos. Default behavior
   *  uses dotfiles-style GC_WINDOW_MS=60min when unset (per RFC v0.2
   *  FOLD-ARCH-3 precedence). Slice 3 consumes this field. */
  readonly cleanupAfterIdleHours?: number;
};

/** Result of reading + parsing the config file. */
export type RepoConfigReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly repos: readonly RepoConfigEntry[] }
  | {
      readonly kind: "malformed";
      readonly path: string;
      readonly reason: string;
    };

/** Result of topo-sorting `siblingCloneOf` dependencies. */
export type TopoResult =
  | { readonly kind: "ok"; readonly ordered: readonly RepoConfigEntry[] }
  | { readonly kind: "error"; readonly reason: string };

/** Type guard for a record-like value with a string-keyed property. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a single repo entry's shape. Returns RepoConfigEntry on
 *  success or { error } on shape failure. Uses bracket-access because
 *  tsconfig has `noPropertyAccessFromIndexSignature: true`. */
function parseEntry(v: unknown): RepoConfigEntry | { error: string } {
  if (!isObject(v)) {
    return { error: "entry is not an object" };
  }
  const name = v["name"];
  const canonical = v["canonical"];
  const sessionWorktreePattern = v["sessionWorktreePattern"];
  const auto = v["auto"];
  const gc = v["gc"];
  const siblingCloneOf = v["siblingCloneOf"];
  const cleanupAfterIdleHours = v["cleanupAfterIdleHours"];

  if (typeof name !== "string" || name.length === 0) {
    return { error: "entry.name must be a non-empty string" };
  }
  if (typeof canonical !== "string" || canonical.length === 0) {
    return {
      error: `entry.name="${name}": canonical must be a non-empty string`,
    };
  }
  const entry: RepoConfigEntry = {
    name,
    canonical: expandHome(canonical),
    ...(typeof sessionWorktreePattern === "string"
      ? { sessionWorktreePattern }
      : {}),
    ...(typeof auto === "boolean" ? { auto } : {}),
    ...(typeof gc === "boolean" ? { gc } : {}),
    ...(typeof siblingCloneOf === "string" && siblingCloneOf.length > 0
      ? { siblingCloneOf }
      : {}),
    ...(typeof cleanupAfterIdleHours === "number" && cleanupAfterIdleHours > 0
      ? { cleanupAfterIdleHours }
      : {}),
  };
  return entry;
}

/** Expand `~` to the home directory. Pure path-string manipulation. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Read + parse the worktree-provisioner config. Caller handles each
 * `kind` per the 3-case fail-discipline (per RFC v0.2 FOLD-RE-1).
 *
 * Path resolution: honors `CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG`
 * env var override (for tests + explicit operator). Default
 * `~/.claude/worktree-provisioner.json`.
 */
export function readRepoConfig(): RepoConfigReadResult {
  const path = configPath();
  if (!existsSync(path)) return { kind: "absent" };

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    return {
      kind: "malformed",
      path,
      reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    return {
      kind: "malformed",
      path,
      reason: `JSON.parse: ${err instanceof Error ? err.message : "syntax error"}`,
    };
  }

  if (!isObject(parsed)) {
    return {
      kind: "malformed",
      path,
      reason: "top-level value must be a JSON object",
    };
  }

  // version field validation — currently only version 1 is recognized
  const version = parsed["version"];
  if (version !== undefined && version !== 1) {
    return {
      kind: "malformed",
      path,
      reason: `unrecognized version ${JSON.stringify(version)}; only version 1 is supported`,
    };
  }

  const reposRaw = parsed["repos"];
  if (reposRaw === undefined) {
    // Missing `repos` key: treat as empty config. Operator may have a
    // skeleton file with version only.
    return { kind: "ok", repos: [] };
  }
  if (!Array.isArray(reposRaw)) {
    return {
      kind: "malformed",
      path,
      reason: "`repos` must be an array",
    };
  }

  const repos: RepoConfigEntry[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < reposRaw.length; i += 1) {
    const result = parseEntry(reposRaw[i]);
    if ("error" in result) {
      return {
        kind: "malformed",
        path,
        reason: `repos[${String(i)}]: ${result.error}`,
      };
    }
    if (seenNames.has(result.name)) {
      return {
        kind: "malformed",
        path,
        reason: `duplicate repo name "${result.name}" at repos[${String(i)}]`,
      };
    }
    seenNames.add(result.name);
    repos.push(result);
  }

  return { kind: "ok", repos };
}

/**
 * Topologically sort repos by `siblingCloneOf` dependency DAG. Returns
 * the order such that each repo's `siblingCloneOf` target precedes it.
 * Fails-closed on:
 *   - reference to absent repo (siblingCloneOf names a repo not in config)
 *   - cycle in the DAG
 *
 * Per RFC v0.2 NIT-RE-1: 2-pass topo-order makes siblingCloneOf
 * provisioning deterministic regardless of config-file declaration order.
 *
 * Implementation: Kahn's algorithm (BFS over in-degree zero nodes).
 * Stable per insertion order when multiple in-degree-zero candidates exist.
 */
export function topoSortRepos(repos: readonly RepoConfigEntry[]): TopoResult {
  if (repos.length === 0) return { kind: "ok", ordered: [] };

  const byName = new Map<string, RepoConfigEntry>();
  for (const r of repos) byName.set(r.name, r);

  // Validate all siblingCloneOf references first.
  for (const r of repos) {
    if (r.siblingCloneOf !== undefined && !byName.has(r.siblingCloneOf)) {
      return {
        kind: "error",
        reason: `repo "${r.name}" siblingCloneOf "${r.siblingCloneOf}" — referenced repo not present in config`,
      };
    }
  }

  // Build in-degree map (count of incoming dependency edges per node).
  const inDegree = new Map<string, number>();
  for (const r of repos) inDegree.set(r.name, 0);
  for (const r of repos) {
    if (r.siblingCloneOf !== undefined) {
      // Edge: siblingCloneOf → r. So r has an incoming edge from sibling.
      const prior = inDegree.get(r.name) ?? 0;
      inDegree.set(r.name, prior + 1);
    }
  }

  // Kahn's: collect in-degree-zero nodes in insertion order.
  const queue: RepoConfigEntry[] = [];
  for (const r of repos) {
    if ((inDegree.get(r.name) ?? 0) === 0) queue.push(r);
  }

  const ordered: RepoConfigEntry[] = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    ordered.push(next);
    // Decrement in-degree of all dependents of `next`.
    for (const r of repos) {
      if (r.siblingCloneOf === next.name) {
        const current = inDegree.get(r.name) ?? 0;
        inDegree.set(r.name, current - 1);
        if (current - 1 === 0) queue.push(r);
      }
    }
  }

  if (ordered.length !== repos.length) {
    // Some nodes still have non-zero in-degree → cycle.
    const cycleMembers: string[] = [];
    for (const [name, deg] of inDegree.entries()) {
      if (deg > 0) cycleMembers.push(name);
    }
    return {
      kind: "error",
      reason: `siblingCloneOf cycle detected involving: ${cycleMembers.join(", ")}`,
    };
  }

  return { kind: "ok", ordered };
}
