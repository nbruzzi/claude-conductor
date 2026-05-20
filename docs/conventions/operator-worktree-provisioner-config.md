# Worktree-provisioner operator config

This document is for **operators** configuring per-session worktree provisioning. The substrate primitive lives at `src/hooks/checks/repo-worktree-provisioner.ts` (Stream 3 Slice 2 of generic-worktree-provisioner work; shipped cycle 2026-05-19). T3-B (cycle 2026-05-20) validates the primitive against three real-world repo shapes and documents recipe examples so operators can extend coverage beyond conductor + dotfiles to their own repo set.

## What the provisioner does

When `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=1` is set, the session-start hook reads `~/.claude/worktree-provisioner.json` and provisions a per-session git worktree at `<canonical>-<sid-prefix-8>` for every repo declared with `auto: true`. The goal is to eliminate the parallel-session shared-tree branch-race failure mode (see `feedback-parallel-session-shared-tree-branch-race`): each session gets an isolated working tree so branch checkouts and untracked files don't leak across sessions.

The hook is **fail-discipline-3-case**: config absent → pass; config ok → continue; config malformed → warn with breadcrumb but never block session-start. The reaper (Slice 3) handles GC of stale per-session worktrees per the `gc` field.

## Config schema

The config is a JSON file at `~/.claude/worktree-provisioner.json` (path overridable via `CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG` env var for testability):

```json
{
  "version": 1,
  "repos": [
    {
      "name": "<display-name>",
      "canonical": "<path-to-canonical-repo>",
      "auto": true,
      "gc": true,
      "siblingCloneOf": "<another-repo-name>",
      "cleanupAfterIdleHours": 24
    }
  ]
}
```

Field reference (see `src/worktrees/repo-config.ts` `RepoConfigEntry` for source-of-truth):

- **`name`** (required) — display + breadcrumb identifier. Unique per config.
- **`canonical`** (required) — canonical repo path. `~` expansion supported. Paths containing spaces (e.g., `~/Documents/Obsidian Vault`) are supported.
- **`auto`** (optional, default `false`) — provision on session-start? Explicit opt-in required.
- **`gc`** (optional, defaults to `auto`) — reap stale worktrees on session-start? If you opt-in to provisioning, you usually opt-in to GC.
- **`siblingCloneOf`** (optional) — names another repo that MUST be opted-in for this repo's worktree to provision. The topo-order resolver fails-closed on cycle or reference to absent target.
- **`cleanupAfterIdleHours`** (optional) — aggressive GC threshold for low-traffic repos. Default behavior uses `GC_WINDOW_MS = 60min` when unset (per RFC v0.2 FOLD-ARCH-3 precedence).

## Recipes

### Recipe 1 — Standard repo (heatprice-like)

For a typical TypeScript/Node repo with `package.json` + `node_modules`, single-repo (no sibling-clone relationship):

```json
{
  "name": "heatprice",
  "canonical": "~/Repos/heatprice",
  "auto": true,
  "gc": true,
  "cleanupAfterIdleHours": 24
}
```

The provisioner will:

1. Create a worktree at `~/Repos/heatprice-<sid-prefix-8>`
2. Symlink `<worktree>/node_modules` → `<canonical>/node_modules` (avoid re-running `bun install` per session)
3. Track the worktree for reaper-side GC after 24 idle hours

### Recipe 2 — Sibling-clone repo (vault-auto-sync-like)

For repos with `file:..` cross-repo dependencies (e.g., a tool repo that depends on a sibling content repo), use `siblingCloneOf` to declare the dependency:

```json
{
  "version": 1,
  "repos": [
    {
      "name": "wiki",
      "canonical": "~/Documents/Obsidian Vault",
      "auto": true,
      "gc": false
    },
    {
      "name": "vault-auto-sync",
      "canonical": "~/Repos/vault-auto-sync",
      "auto": true,
      "siblingCloneOf": "wiki"
    }
  ]
}
```

The topo-order resolver will provision `wiki` first, then `vault-auto-sync`. If `wiki` is missing from the config (or its `auto` is `false`), the hook fails-closed on the `vault-auto-sync` entry with a breadcrumb naming the absent target.

Note: this recipe is illustrative of the `siblingCloneOf` mechanism. Operators should verify the actual cross-repo dep structure of their own repos before adopting; the example shape demonstrates the topo-order topology, not a literal claim about vault-auto-sync's real dependencies.

### Recipe 3 — Wiki / Obsidian vault (path-with-spaces, no-package.json)

For repos that are not standard Node packages — markdown vaults, content repos, documentation sites — use `gc: false` (Obsidian vault is a long-lived operator artifact; per-session worktrees should provision but not reap):

```json
{
  "name": "wiki",
  "canonical": "~/Documents/Obsidian Vault",
  "auto": true,
  "gc": false
}
```

The provisioner will:

1. Create a worktree at `~/Documents/Obsidian Vault-<sid-prefix-8>` (path-with-spaces handled correctly)
2. Skip `node_modules` symlinking (no `node_modules` at canonical — breadcrumb emitted; not an error)
3. Skip reaper (gc: false) — the per-session worktree persists across session restarts until manually cleaned

## Common pitfalls

- **Parallel-session shared-tree branch-race** (`feedback-parallel-session-shared-tree-branch-race`) — when two sessions check out different branches on the same canonical workspace, the second-mover overwrites the first's branch state silently. T3-B's provisioner config is the structural fix: each session gets its own per-session worktree at `<canonical>-<sid-prefix-8>`. Empirical referent: cycle 2026-05-20 saw the canonical dotfiles workspace leak onto a feature branch from a prior session; Alpha restored it from `charlie/conductor-slice-3-mirror @ 17e0012` back to `main @ be2cb86` at 11:13Z via 3-commit fast-forward pull. With this config in place + `auto: true` for each repo, the leak class is eliminated by construction.

- **siblingCloneOf cycle** — if A → B → A, the topo-resolver fails-closed and the hook warns; nothing provisions. Avoid by structuring `siblingCloneOf` as a strict DAG (each repo's dep points at a parent, never back-references).

- **Stale per-session worktrees after session-end** — the Slice 3 reaper handles this on subsequent session-starts. If you encounter accumulation, ensure `CLAUDE_CONDUCTOR_PER_SESSION_WORKTREES=1` is exported in your shell profile so the reaper runs on every session-start.

- **Worktree-provisioner reaps live siblings** (`feedback-worktree-provisioner-reaps-live-siblings`) — a known substrate bug class where a fresh session's reaper sweeps a parallel-active session's worktree. Mitigated by explicit-claim tracking in Slice 3 reaper; reported via memory file when it fires.

## Test surface

The provisioner primitive is exercised by `test/hooks/checks/repo-worktree-provisioner.test.ts` against real git fixtures (no mocking). T3-B adds 3 new test cases covering the characteristic shapes documented above:

- Path-with-spaces canonical (wiki-like)
- No-package.json canonical (wiki-like)
- 3-repo sibling-clone DAG (vault-auto-sync-like extended chain)

The full test file should run clean before any change to operator config; failures here indicate a substrate regression that must be fixed before the new recipe shape can ship.

## Plans + cross-references

- T3-B plan: `~/.claude/plans/slice-T3B-worktree-provisioner-phase-2-2026-05-20.md`
- Generic-worktree-provisioner RFC: `~/.claude/plans/generic-worktree-provisioner-design-2026-05-19.md` §v0.2 + §v0.3
- Convention sibling: `docs/conventions/message-kinds-and-verification.md`
- Substrate hook: `src/hooks/checks/repo-worktree-provisioner.ts`
- Config schema: `src/worktrees/repo-config.ts`
- Materialize helper: `src/worktrees/provision-repo.ts`
