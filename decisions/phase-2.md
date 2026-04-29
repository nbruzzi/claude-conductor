<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Decision Log — Phase 2

Per-entry schema (same as `phase-0.md` + `phase-1.md`):

```yaml
---
ts: <ISO-8601>
kind: sequencing | architectural | api-shape | scope | tooling
severity: critical | major | minor
phase: 2
affects: [list of components]
---
```

Followed by:

- **Context:** what was being decided
- **Options considered:** list with brief pros/cons
- **Chosen:** the decision
- **Reason:** why this option won
- **Supersedes / superseded_by:** cross-link if relevant

---

## Phase 2 entry point

**Phase 2 starts from tag `v0.1.0-phase-1`** (Lane B HEAD `44cfff4` at tag time). Phase 1 v0.1.0 closed 2026-04-29 via Slice 8 Wave 2 audit + Bravo verification round (VERDICT: SHIP).

## Phase 2 scope (private-closed arc per `project-claude-conductor.md`)

Phase 2 = **Agent Teams integration hooks**. The NATO identity + role + cross-edge plugin/dotfiles boundary established in Phase 1 is the foundation. Phase 2 layers Anthropic Agent Teams integration on top:

- TaskCreated / TeammateIdle hooks consume `metadata.identities` + `role` to coordinate agent assignment.
- System-reminder injection on `claimIdentity` so a session that just claimed a NATO letter knows what its peers see.
- `--since` integration with the last-seen substrate so agents can replay deltas without re-reading the full channel.

Phase 3 (handoff system surviving `/resume`) follows; Phases 4-6 deferred to public-launch.

## Phase 2 carry-over backlog (from Phase 1 Wave 2 audit)

Listed in priority order. Each line summarizes findings, links the file/line evidence, and the audit transcript.

### Critical / Major (close in Phase 2 mid-cycle audit)

- **RE-W2-1** — `appendMessage` reads `metadata.identities` outside `withMetadataLock` for identity-auto-attach (Decision G). Concurrent `set-role` / `close-peer` can attach stale identity+role to in-flight messages. **Fix sketch:** wrap the read+attach+append cycle in `withMetadataLock` (cascades async; cost is per-message metadata-read+lock+write triple). **Evidence:** `src/channels/index.ts:725-757` (auto-attach loop). **Test gap:** N senders × interleaved set-role flips not covered by Slice 7 race tests.
- **RE-W2-2** — `close-peer` audit-trail `status` message append happens outside `withMetadataLock`. Concurrent operators can produce `status: peer-closed` lines with mismatched ts ordering vs metadata mutation. **Fix sketch:** move the append inside the lock OR document log-time-vs-lock-time caveat in the function header. **Evidence:** `src/channels/cli.ts:716-743`.
- **RE-W2-3** — `outputJson` is module-level mutable state in `src/channels/cli.ts:143`. Programmatic in-process consumers (Phase 2 hooks invoking `runChannelsCli` directly per Decision Q4 of api.ts) leak `--json` mode across invocations if they don't reset. **Fix sketch:** thread `outputJson` through `die` as a parameter, OR `try/finally` around `runChannelsCli` body. **Test gap:** in-process consecutive `runChannelsCli` calls with different `--json` values not covered.

### Important (close opportunistically)

- **RE-W2-4** — `close-peer` sentinel-unlink failure path is invisible to JSON output. `unlinkIdentitySentinelOrLogOrphan` swallows non-ENOENT into `appendPresenceFailure`; the JSON `{kind: "released"}` payload doesn't surface orphan-sentinel state. **Fix sketch:** `unlinkIdentitySentinelOrLogOrphan` returns a status that the CLI surfaces in the JSON payload (`{kind: "released", orphan_sentinel: true, sentinel_error: "EACCES"}`).
- **ARCH-W2-7** — `validateChannelMetadata` legacy `?? {}` masks schema drift on partial-write recovery. Phase 2 GC reaper is the natural place for a metadata-vs-sentinel-directory reconciliation pass that distinguishes "channel never had identities" from "channel has identities but the metadata write got truncated."
- **CLI-W2-4** — Slash commands in dotfiles still use `bun run src/channels/cli.ts <verb>` instead of the canonical `claude-conductor channels <verb>`. Bun does NOT auto-symlink bin from a `file:..` dependency, so the binary isn't on PATH from dotfiles working directory after `bun install`. **Three resolution paths:** (a) absolute path via `$CLAUDE_DOTFILES_ROOT/node_modules/claude-conductor/bin/claude-conductor` (ugly), (b) global install (defeats per-user-config model), (c) dotfiles setup-time symlink into a known-on-PATH location. **Decision deferred to Phase 2 hooks layer review** (slash-command surface gets a wider rethink anyway).

### Minor (Phase 3+ as needed)

- Plugin v0.1.0 publication strategy (when/how does plugin get its own PR-and-tag flow) — deferred per `project-claude-conductor.md` to Phase 2 boundary.
- Channel-CLI ppid+mtime fallback for non-UUID `CLAUDE_SESSION_ID` consumers — port plugin's UUID-strict resolver as opt-in if any surface (`feedback-channel-cli-uuid-only-env.md`).

## Slice 8.5 status (parallel CLI-DX consistency closure)

Slice 8.5 (`phase-1-slice-8-5-cli-dx-consistency` @ `4903a18` — verified by Bravo SHIP at 17:17 UTC) closes 7 of 8 Wave 2 polish items not in v0.1.0-phase-1 tag:

- **CLI-W2-1** ✓ `--json` position-insensitivity full fix (3 positions verified)
- **CLI-W2-3** ✓ `todos/cli.ts` parity (parseFlags + per-verb help + import.meta.main + runTodosCli export)
- **CLI-W2-5** ✓ `--version` / `-V` flag
- **CLI-W2-6** ✓ `--help` Global flags section
- **ARCH-W2-4** ✓ dispatcher 'presence' deferral hint
- **RE-W2-5** ✓ acquireLock holder pid in lockfile + failure error
- **RE-W2-6** ✓ DieAlreadyHandled sentinel + catch-all guard for mocked-exit forward compat

Slice 8.5 ships separately (likely as `v0.1.0-phase-1.5` or rolls into the first Phase 2 milestone). CLI-W2-4 (slash command migration) is the only Wave 2 item that escapes Slice 8.5 and lives in this Phase 2 backlog.

## Pending decisions (Phase 2 audit cycle)

(Populate as Phase 2 work begins.)
