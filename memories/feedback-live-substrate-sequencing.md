---
name: Live substrate sequencing — backwards-compatible shape changes first
description: When refactoring TS substrate the live Claude Code hook dispatcher depends on, never break the running system mid-flight; sequence changes so the live caller never sees a broken intermediate state
type: feedback
cadence: stable
scope: global
updated: 2026-05-12
origin: extracted
---

When modifying substrate that the live Claude Code hook dispatcher loads (`src/hooks/handlers/*.ts`, `src/hooks/dispatcher.ts`, `src/hooks/registry.ts`, anything imported transitively), sequence changes in two phases:

1. **Backwards-compatible shape changes first** — handlers accept new params as optional (`_registry?: SealedRegistry`), HANDLERS map widens to 2-arity but legacy 1-arity bodies still work. Existing callers keep working.
2. **Behavior changes second** — once all callers are upgraded to pass the new arg, convert handler bodies to USE the new contract.

**Never** test failure modes by overwriting a LIVE substrate file in place. The live `PreToolUse` / `Stop` hooks invoke that file on the next tool call; if it errors, every subsequent Edit/Write/Bash is blocked — including the one needed to recover. Use a temp path + a CLI flag or env var to redirect the dispatcher at the temp module.

**Why:** During the dispatcher refactor (sub-step 0.6 batch 3b, dotfiles commit `fec3849`, 2026-04-26) two self-traps occurred. (1) Wrote a 2-arity handler before the dispatcher could pass the second arg → live `PreToolUse` crashed with `registry.checksFor` on `undefined` → all fix-tools blocked → operator had to `git checkout` from a terminal. (2) Wrote a deliberately-broken register module to verify the boot-failure assertion exits 2 → same crash → operator had to `cp` the backup from `/tmp/`. Both incidents were caused by the live system running on the same code path being refactored; the fail-CLOSED dispatcher does its job too well to allow self-recovery.

**How to apply:** Before the first Edit/Write to a substrate file the live dispatcher loads, ask: "Does this change break the contract the running dispatcher expects?" If yes, split into a backwards-compatible step first (widen types, add optional params, keep legacy bodies) and verify the live system still works before behavior changes. For failure-injection tests on substrate, copy the file to `/tmp/`, write the broken version there, invoke the dispatcher with an override flag — build the flag if it doesn't exist; never overwrite the canonical path. Recovery from a self-trap requires the operator; budget for that in autonomous work, or skip the test if the operator isn't reachable.

**Substrate-rename application (Phase 3 Step G; ARCH-W2-4):** the dual-read protocol used to rename 5 per-channel subdirectories (`heartbeat/` → `heartbeats/`, `last-seen/` → `last-seen-cursors/`, `gc-reap/` → `reap-cursors/`, `identity-emit/` → `identity-emit-cursors/`, `idle-emit/` → `idle-emit-cursors/`) is a direct expression of this discipline. Writers write to NEW name only; readers try NEW first, fall back to LEGACY on ENOENT; clear/unlink walks BOTH; enumerate unions BOTH; rate-gate takes MAX(newMtime, legacyMtime). Pre-Step-G peers running on the OLD writer code still produce cursors at the LEGACY path, and the dual-read makes those visible to post-Step-G peers — neither side sees a broken intermediate state. The legacy-removal commit lands 30+ days later, only after the empirical-absence-of-pre-Step-G-writes is verified.
