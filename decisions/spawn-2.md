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

**Supersedes / superseded_by:** Additive at ship time — a new tier between ppid and mtime; the env/ppid/mtime branches and `resolveSessionId`'s exported signature are unchanged. **Reasoning superseded by Decision B (P6)** — the "requiring a live `<pid>.json` would re-break the cohort case" premise was empirically false (see B).

---

## 2026-06-08 — Decision B: switch the worktree-tier match source to the EAGER live `<pid>.json` (P6 — supersedes A's reasoning; closes the boundary AND the cold-spawn coverage gap)

```yaml
---
ts: 2026-06-08T21:00:00Z
kind: architectural
severity: major
phase: spawn-2-p6
files:
  - src/shared/session-id-discovery.ts
  - test/shared/session-id-discovery.test.ts
---
```

**Context — two empirical findings (verified live this cohort, not reasoned):** Decision A matched the worktree prefix against the `<uuid>.json` **telemetry** file and deliberately dropped the SE-2 `<pid>.json` sanity check. The empirical pidfile pass that gated this follow-up resolved the open question behind that drop:

1. **The `<pid>.json` is EAGER; the `<uuid>.json` telemetry is LAZY.** The CC binary writes `~/.claude/sessions/<pid>.json` at session start (present for every live cohort session). The `<uuid>.json` telemetry is written by a PostToolUse hook (dotfiles `session-telemetry-tracker.ts`) ONLY on a memory-dir file op or a `^bun run test|typecheck|lint|…` match — NOT at session start, and `join` matches no pattern. Proven: a live session was alive + joined for 12 min with telemetry **absent**, appearing only after a memory Read. (Bravo independently confirmed the same split on its own session.)
2. **`sanityCheckHasCCFile` SCANS the dir; it does NOT walk the ppid tree.** So "ppid-tree unreachable" (real — why the ppid TIER failed) does NOT imply "pidfile absent": the scan finds the eager pidfile regardless of the broken walk.

**Chosen:** Switch `resolveViaWorktreePath`'s match source from the lazy `<uuid>.json` telemetry to the eager `<pid>.json` (CC-binary, embedded `sessionId`), and require the matched pid to be **ALIVE** (`process.kill(pid, 0)`; only the unambiguous `ESRCH` rejects — biased toward alive so a live self is never falsely rejected). The uniqueness gate dedupes by `sessionId` (0 or >1 distinct live matches → `null` → fall through to mtime). New INTERNAL `isPidAlive`. The `startDir` ladder, the `worktree` `DiscoveryResult` variant, and the tier position (after ppid, before mtime) are unchanged.

**Reason (supersedes A's "would re-break the cohort case"):** That premise conflated **"ppid-tree unreachable"** with **"pidfile absent"** (this is Bravo's #218 audit finding F1, now resolved). The scan finds the eager self-pidfile even when the ppid walk is broken, so a pidfile check does NOT re-break the cohort case. Matching the `<pid>.json` is **strictly better on three axes at once**: (1) it FIRES for a true cold spawn — A's telemetry-keyed tier could not, because the telemetry is absent at join, so SPAWN-2 shipped CORRECT but INERT for its headline ("join resolves UUID without a manual export"); (2) the pid is a liveness signal; (3) that liveness CLOSES the foreign/dead-worktree boundary. One mechanism, three wins.

**Boundary CLOSED + residual:** A solo session whose cwd is a foreign/DEAD `.claude-dotfiles-<hexB>` worktree no longer resolves B's id — a dead B has no LIVE pidfile (clean exit → the CC binary removes it, verified; crash → a stale pidfile with a dead pid → the alive-check rejects it). **Residual (narrow, NOT closed):** pid RECYCLING — if a crashed B's pid is reassigned to an unrelated live process, the alive-check passes. Defending it needs a recorded-`procStart`-vs-live-process comparison, which NO resolver in this module does; left consistent with the module convention and documented in the JSDoc.

**Out of scope (backlogged → SPAWN-3):** the telemetry trigger patterns are `^`-anchored, so a compound `cd … && bun test` never fires them — the lazy telemetry may also weaken OTHER consumers (the mtime fallback; active-sessions liveness). Flagged, not addressed here. The dotfiles spawn-prompt SSOT templates' "auto-resolve, no export needed" caveat becomes TRUE on this merge (cold-spawn now auto-resolves); the template text fix is a sibling dotfiles change (a PR cannot span repos).

**Audit cadence:** Charlie build (P6 PR) — TDD: foreign/dead-worktree → rejected; cold-spawn own-telemetry-absent → resolves (the precondition the original suite never set up); + Bravo's 2 NITs folded (startDir env-ladder branch, ppid-precedence). Bravo decision-assess (#218 F1) + re-lens on this delta; Alpha captain ruling = land A+B unified.

**Supersedes / superseded_by:** Supersedes Decision A's **reasoning** (the SE-2-drop justification); A's tier-placement and `worktree`-variant decisions stand. Additive to the env/ppid/mtime branches.

---

## 2026-06-08 — Decision C: the worktree tier shares the ppid cold-start retry budget (explicit grace; SPAWN-3 follow-up to B)

```yaml
---
ts: 2026-06-08T23:30:00Z
kind: architectural
severity: minor
phase: spawn-2-p6-followup
files:
  - src/shared/session-id-discovery.ts
  - test/shared/session-id-discovery.test.ts
---
```

**Context:** Decision B switched the worktree tier to match the EAGER `<pid>.json`, but the tier read it ONCE (no retry). It inherited cold-start grace only INCIDENTALLY — it runs after `ppidWalkWithRetry` burns ~`retryCount×retryDelayMs` of wall-clock, by which time the eager pidfile has landed. Bravo's #220 re-lens NIT: that grace is IMPLICIT cross-tier coupling — reduce `retryCount` to 0 (or reorder/remove the ppid tier) and the worktree tier silently loses its startup grace, re-inerting the headline for a true first-action cold spawn that runs before the CC binary writes the pidfile. The original suite never reproduced that not-yet-written-at-join window (tests planted the pidfile present) — the same fixture-confidence class P6 exists to kill.

**Chosen:** Replace `ppidWalkWithRetry` with `resolveViaPpidOrWorktree`, which tries ppid (authoritative) THEN the worktree tier each attempt, retrying BOTH on ONE SHARED budget (`retryCount` attempts × `retryDelayMs`). The worktree tier's cold-start grace is now EXPLICIT (it retries on its own, independent of ppid's elapsed time). New `ResolveOptions.onColdStartRetry` (observability + deterministic test seam; must-not-throw) fires before each inter-attempt sleep.

**Reason:** Sharing ONE loop (vs giving the worktree tier its own retry loop after ppid's) is Bravo's preferred fix: it makes the grace explicit WITHOUT doubling the genuine-missing wall-clock (the sleep budget — the dominant cost — stays `retryCount` sleeps, not `2×`). ppid precedence is preserved (ppid before worktree within each attempt; a ppid hit returns before the worktree tier runs). The institutionalized adversarial-subagent execution-trace (today's C1 lesson) confirmed: no precedence inversion, no off-by-one in the attempt/sleep counts, retry never fabricates a match (exhaust → null → mtime fallback), no C1-class short-circuit, no silent-failure abort of the loop.

**Tests:** the not-yet-written-window test (pidfile absent on attempt 0, written via `onColdStartRetry` before attempt 1, resolves `worktree`) + a negative budget-exhaustion test (no pidfile ever → retries `[0,1]` → `missing`, never fabricates). The pre-existing ppid-precedence + cohort tests pass unchanged (behavior-preserving refactor).

**Residual / out of scope:** the `^`-anchored-telemetry-weakens-other-consumers thread (Decision B's "out of scope") remains the separate SPAWN-3 investigate-first item.

**Supersedes / superseded_by:** Additive to Decision B — hardens the same worktree tier; `resolveSessionId`'s exported signature is unchanged (a new optional `ResolveOptions` field).
