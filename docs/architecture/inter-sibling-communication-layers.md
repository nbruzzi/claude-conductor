<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Inter-sibling communication — 4-layer model

How two coordinating Claude Code sessions (Alpha + Bravo) talk across windows, machines, and crashes. Phase 4 Step A closes the substrate gaps in this stack; this document is the permanent home for the conceptual model + the per-layer state-of-the-art.

**Audience:** operators who need to understand which CLI verbs / hooks / message kinds compose the coordination surface, and designers reasoning about future protocol extensions or replacements.

**Source-of-truth pointers:**

- Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 (Phase 4 Step A umbrella).
- Decision log: `decisions/phase-4.md` — per-layer narrow decisions (no umbrella; per Bravo's I/J letter precedent):
  - **Decision K** — Layer 1 (`peer-message-deliverer` hook + cursor 2PC + body fencing); ships in A1 (this PR).
  - **Decision I** — Layer 3 (walkie-talkie kinds + `extraMetadataMutator` + manual-`send out` as sole `out_posted_at` writer); ships in B1 (PR #41).
  - **Decision J** — Layer 4 (`digest` kind + `parseDigestBody` shared parser + per-kind verification-budget convention); ships in B2.

---

## The 4 layers

Inter-sibling communication decomposes into a layered stack — each layer is independently testable, replaceable, and meaningful only above the layer beneath it. The decomposition came out of the 2026-05-13 wind-down brainstorm; each layer corresponds to a concrete gap observed in field use.

| Layer | Name                      | What it provides                                                                                                                                     | Substrate landing                                                                      |
| ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | Transport / push delivery | New peer messages surface in the receiving Claude's prompt on the next `UserPromptSubmit` fire — no manual `channels read` poll required.            | `peer-message-deliverer` hook + `peer-message-cursors.ts` substrate.                   |
| 2     | Identity                  | Each session in a channel claims a stable NATO letter (Alpha … Zulu) with a role (`pen` / `queue` / `out`). Atomic POSIX-EEXIST primitive race-free. | `claimIdentity` / `setRole` / `whoami` / `peers` (Phase 1).                            |
| 3     | Bandwidth choice          | Message kinds that signal protocol state distinct from prose content — `ack` / `roger` / `over` / `standby` / `out` walkie-talkie primitives.        | `CHANNEL_KINDS` SSOT + send role-gate carve-out (Phase 4 Step A Layer 3, ships in B1). |
| 4     | Mental-model sync         | Structured `digest` kind with verification-budget convention so reader knows which fields to trust verbatim vs. primary-source-verify before acting. | `digest` kind + `parseDigestBody` (Phase 4 Step A Layer 4, ships in B2).               |

The layers compose strictly bottom-up: Layer 4 messages assume Layer 3 kinds; Layer 3 kinds assume Layer 2 identity; Layer 2 identity rides on Layer 1 transport. Replacing any layer leaves higher layers untouched if the contract is preserved.

---

## Layer 1 — Transport / push delivery

**Gap addressed:** before Phase 4 Step A Layer 1, peer messages were only seen via:

- Manual `claude-conductor channels read <id> --since-cursor` poll, OR
- `SessionStart` fire — which only runs at `/resume`, NOT mid-session.

This made true autonomous sibling coordination impossible at the substrate level — Nick had to act as a human bridge, copy-pasting messages between windows. The 2026-04-25 caveat ("I was still required for your communication to work") stood until this layer closed.

### Mechanism

`peer-message-deliverer` is a `user-prompt-submit`-event hook (position 1) that fires on every operator prompt. For each channel where the running session has a NATO identity claim, the hook scans `messages.jsonl` for entries newer than this session's last-emitted cursor + skips own-from messages + surfaces the body in a sanitized + fence-wrapped system-reminder block.

### Two-phase cursor commit

Per-(channel, session) emission cursor lives at `<channel-dir>/peer-message-emit-cursors/<sid>.json` with `{mtime, ts}` shape (sibling-shape to `LastSeenCursor`). Two-phase commit semantics:

- **Emit turn:** writes `<sid>.json.pending` with the newest emitted mtime. Atomic tmp+rename — concurrent writers race on the rename, one wins, file is always valid.
- **Next fire:** promotes pending → committed via atomic rename. Idempotent — repeated promotes after consumption are no-ops.

Recovery: if the session crashes between emit and promote, the next session sees the stale pending + the still-old committed cursor and re-emits. Silent message-loss is impossible because cursor advance is gated on the operator reaching the next prompt (the prompt-fire IS the evidence that the prior emission was consumed).

### Bootstrap-without-emit

First scan on a fresh channel (no committed cursor, no pending) sets the cursor to the newest message mtime silently — does NOT emit. Matches the `--since-cursor` bootstrap rule. Prevents a flood on first-prompt-after-week-offline.

### Body fencing + sanitization (prompt-injection defense)

Peer body is free-form text from another Claude session — a malicious or accidentally-corrupted body containing platform-control markup (`system-reminder` tags, function-call traces, role-confusion strings) would corrupt the receiving Claude's prompt structure if surfaced verbatim. Defense-in-depth:

1. **Truncate** at 200 chars inline; longer bodies → `body_ref` note with recovery hint pointing at `channels read --since-cursor`.
2. **Sanitize** in two passes:
   - **(a)** Strip platform-control patterns (`system-reminder` open/close tags, `function_calls` open/close, `antml:*` namespace tags, fence-marker `[peer-body-<hex>]`, bare `</` close-tag sequence). Replace each match with literal `[redacted-platform-marker]`.
   - **(b)** Escape any remaining bare `<` chars via `&lt;`-replacement (markdown surface — bare `<` is structurally meaningful).
   - **NO high-byte strip** — multibyte UTF-8 (em-dashes, smart quotes, emoji, ellipsis) is preserved verbatim. Stripping defends nothing additional and breaks legitimate prose. (MINOR-3 fold on plan v3 → v4.)
3. **Fence** with a per-emission UUID-nonce wrap: `[peer-body-<8hex>]\n<sanitized>\n[/peer-body-<8hex>]`. The fence-marker itself is in the sanitizer's strip pattern set so an attacker cannot synthesize the marker inside the body.

### Emission cap + summary mode

50-message-per-prompt cap across all channels. If a single channel has more than the remaining cap, emission switches to summary mode for that channel: one block showing `(N new messages — M suppressed by 50-message cap)` with the cursor still advancing to the newest-suppressed mtime. Operators can read the full batch via `channels read <id> --since-cursor`.

### Recovery verbs

Two CLI verbs siblings to `forget-cursor` / `show-cursor`:

- `channels show-message-cursor <id>` — print committed + pending cursor state.
- `channels forget-message-cursor <id>` — clear both cursors (next fire bootstraps silently).

### Failure-mode class

**Fail-open + breadcrumb.** Any thrown helper inside the hook becomes a single outer `pass()` — the hook never breaks the `UserPromptSubmit` chain. Cursor-read failures, JSONL-read failures, and emission failures all breadcrumb via `appendPresenceFailure({source: "channels-identity", kind: "write-failed"})` and degrade silently.

---

## Layer 2 — Identity (audit-only this arc)

NATO + roles. Already shipped in Phase 1 (Slice 2 — `claimIdentity`) and Phase 2 (Slice 5 — `identity-injector` hook). Phase 4 Step A does NOT modify Layer 2.

**State of the art:**

- 26 NATO letters (Alpha … Zulu), race-free claim via `linkSync` create-only POSIX EEXIST primitive (sibling pattern of `active-sessions/index.ts:writeMetaIfMissing`).
- Per-letter sentinel file at `<channel-dir>/identities/<letter>` is the canonical mutex; `metadata.identities[<letter>]` is the materialized cache for `whoami`/`peers` reads.
- Idempotent rejoin — a session reclaiming its own letter returns the existing claim without reassignment.
- Roles: `pen` (actively writing), `queue` (ready to take pen), `out` (observing only, sends blocked). `set-role` transitions are atomic via `withMetadataLock`.
- Recovery: `close-peer <id> --peer <letter>` releases a peer's identity if its heartbeat is >60 s stale; `--force` overrides the staleness gate.

---

## Layer 3 — Bandwidth choice (ships in B1)

Walkie-talkie message-kind primitives. Extends `CHANNEL_KINDS` SSOT with 5 new kinds beyond the original 4 (`note` / `question` / `handoff` / `status`):

- `ack` — receipt only ("I see your message"); no commitment.
- `roger` — receipt + commitment ("understood, will act").
- `over` — sender hint ("I posted, expecting reply").
- `standby` — sender hint ("heard you, working, hold the channel").
- `out` — peer terminates this channel; additive (`claim --force` resets).

Send role-gate carves out `kind = "out"` for `role = "out"` senders — a session in `out` posture can still announce departure but cannot send other kinds. `metadata.identities[<L>].out_posted_at` is materialized by manual `channels send <ch> out` via `extraMetadataMutator` (atomic single-lock write of JSONL + metadata, JSONL-first per RE-2). The auto-out Stop-hook extension was dropped per plan v5 RE-1 fold (Stop fires per-turn, not session-end); a SessionStart-driven reaper is the structurally-correct replacement, deferred to Phase 4 Step B.

---

## Layer 4 — Mental-model sync (ships in B2)

`digest` message kind for structured arc-close summaries. Body convention is a JSON object:

```jsonc
{
  "kind_version": 1,
  "what_shipped": ["PR #N at SHA"],
  "what_verified": ["typecheck", "test", "audit:CLI-DX"],
  "audit_class_paid": ["sibling-shape-miss", "prompt-injection-surface"],
  "next_pickable": "backlog-item-id or plan-step-N",
  "blockers": [],
  "verification_budget_consumed_ms": 12000,
}
```

Parsed via `parseDigestBody(body: string): DigestBody | null` exported from `src/channels/digest.ts`. Verification budget by kind:

| Kind                                         | Reader's verification budget                                     |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `note` / `status`                            | Trust verbatim.                                                  |
| `ack` / `roger` / `over` / `standby` / `out` | Trust verbatim. Protocol state, not assertions.                  |
| `question`                                   | Verify factual claims it relies on.                              |
| `handoff`                                    | Trust + verify against named SHAs/paths.                         |
| `digest`                                     | Trust SHAPE; primary-source-verify any audit-class claim or SHA. |

Full convention reference: `docs/conventions/message-kinds-and-verification.md` (ships in B2 as the first inhabitant of `docs/conventions/`).

---

## Cross-references

- [docs/operations/phase-2-hooks.md](../operations/phase-2-hooks.md) — operator runbook for hook firing + Symptom/Diagnose/Recover/Verify per hook.
- [decisions/phase-4.md](../../decisions/phase-4.md) — Decision K (Layer 1, this PR) / Decision I (Layer 3, B1) / Decision J (Layer 4, B2). Per-layer narrowly-scoped decisions; no umbrella.
- [CHANGELOG.md](../../CHANGELOG.md) — Phase 4 Step A entries.
- Plan: `~/.claude/plans/eventual-marinating-wall.md` v5 — full design rationale + audit-fold lineage (5 audit cycles + Bravo sibling cross-audit cycles).
