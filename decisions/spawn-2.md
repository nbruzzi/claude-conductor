# SPAWN-2 — Worktree-path session-UUID discovery tier (2026-06-08)

**Slice:** SPAWN-2, a substrate follow-up to the L137 spawn-template workstream — let a spawned cohort session's channel `join` resolve its own session UUID without a manual `export CLAUDE_SESSION_ID`. Conductor PR #218.
**Cycle:** 2026-06-08
**Outcome:** Shipped — a worktree-path discovery tier in `resolveSessionId` (`src/shared/session-id-discovery.ts`), wired through `cli.ts:sid()`.

This logs the load-bearing build-time call. The architectural frame (CLI-context session-id discovery: env → ppid → mtime, fail-loud) is upstream in the module's own header; this entry records the one new tier and its deliberate trust trade-off.

---

## 2026-06-08 — Decision A: worktree-path tier trusts uniqueness + SE-1, NOT an SE-2 `<pid>.json` sanity check

```yaml
---
ts: 2026-06-08T12:30:00Z
kind: architectural
severity: major
phase: spawn-2
files:
  - src/shared/session-id-discovery.ts
  - src/channels/cli.ts
---
```

**Context:** A spawned cohort session has `CLAUDE_SESSION_ID` unset and a broken ppid-tree (the worktree shell does not link bun → … → the CC binary pid), so `resolveSessionId`'s `mtime` tier sees multiple fresh sibling `~/.claude/sessions/<uuid>.json` files and returns `{kind:"ambiguous"}` → `sid()` throws → the operator must read the 8-char worktree-path suffix and `export` by hand. The per-session worktree dir name (`~/.claude-dotfiles-<sid8>`) uniquely identifies the session and can disambiguate.

**Chosen:** A new `worktree` tier inserted **after ppid (authoritative), before mtime (ambiguous in a cohort)**. `extractSid8FromPath` parses the worktree dir's final segment (anchored `^\.claude-dotfiles-([0-9a-f]{8})$`); `resolveViaWorktreePath` resolves the full uuid by matching that 8-hex prefix against the **unique** uuid-stemmed telemetry file (gated by `isStrictUUID(stem)` + `stem.startsWith(prefix)` + the `session_id === stem` SE-1 invariant; 0 or >1 matches → `null` → fall through to mtime). Path source is an injectable `ResolveOptions.startDir` (test seam) defaulting to a try-each ladder `CLAUDE_DOTFILES_ROOT_RESOLVED → PWD → cwd`. New `worktree` `DiscoveryResult` variant (both `assertNever` switches + the `cli.ts:sid()` success if-chain updated). **Deliberately NO SE-2 `<pid>.json` sanity check** (unlike the mtime tier).

**Reason:** Requiring a live `<pid>.json` would re-break the exact cohort case this fixes — the broken pid-tree is _why_ ppid failed, so a pidfile-presence gate would reject the legitimate self-session. The trust basis substituting for SE-2 is the **uniqueness gate + the `session_id === stem` (SE-1) invariant**: a single telemetry file whose embedded id matches its filename and uniquely shares the worktree's 8-hex prefix is a strong identity signal. Correctness is enforced by the match, not by trusting any one path source, so the `startDir` ladder is safe (the spawn bootstrap `cd`s to canonical when env is unset, making bare `cwd` suffix-less; `PWD` recovers the worktree).

**Known boundary (tracked):** a solo (non-cohort) session with env unset + broken ppid whose cwd is a **foreign/dead** `.claude-dotfiles-<hexB>` worktree could resolve B's id if B's telemetry is prefix-unique — a silent misresolution the dropped SE-2 liveness check would have caught. The cohort target case is unaffected (each session runs in its **own** worktree → self → correct). Documented in `resolveViaWorktreePath`'s JSDoc; a follow-up to add liveness corroboration (matching `<pid>.json` OR a freshness gate, verified against real spawned-session pidfile semantics) is backlogged. Surfaced by the inline code-review audit (rated SHOULD-FIX, non-blocking).

**Audit cadence:** Alpha build (PR #218); inline Nick-lens code-review audit pre-PR (verdict SHIP, one documented boundary).

**Supersedes / superseded_by:** Additive — a new tier between ppid and mtime; the env/ppid/mtime branches and `resolveSessionId`'s exported signature are unchanged.
