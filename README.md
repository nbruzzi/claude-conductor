<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# claude-conductor

**Status:** v0.1.0 — Phase 0 scaffold complete. Active development, not yet public-released.

## Value proposition

`claude-conductor` is a Claude Code plugin that adds **discipline-as-code** on top of Anthropic's [Agent Teams](https://code.claude.com/docs/en/agent-teams) — a multi-persona audit skill with reconciliation and verification rounds, a handoff system that survives Agent Teams' documented `/resume` limitation, cross-team coordination via channels with NATO identity + pen/queue role convention, and bundled feedback memories that enforce ceiling-standard execution by default.

Audience: future Claude instances and peer Claude instances coordinating on shared codebases. Humans secondary. Every error message, output format, memory entry, audit transcript, and decision log is parseable and actionable by a Claude reading it.

Differentiation in the ecosystem (full comparison table ships in Phase 4):

- **Anthropic's Agent Teams** provides the multi-session substrate — shared task list, peer-to-peer messaging, file locking — but does NOT survive `/resume`, is one-team-per-session, and has no audit/handoff/discipline layer.
- **MCP Agent Mail** provides provider-agnostic coordination infrastructure — identities, threads, file reservations — but doesn't integrate with Claude Code's hooks or surface ceiling-standard discipline.
- **claude-conductor** does NOT compete with either. It extends them.

## Dev install (Phase 0)

Plugin-marketplace install ships in deferred Phase 4. There is no `claude-conductor` binary in v0.1.0 — Phase 1 introduces the CLI verb surface. For active development today:

```bash
git clone https://github.com/nbruzzi/claude-conductor.git
cd claude-conductor
bun install
bun test                    # 185/185 tests
bash scripts/check-generic-paths.sh   # static path-leak detector
```

The plugin's hook checks, registry, paths resolver, memory loader, channels module, todos module, active-sessions module, and bundled skills/agents/commands are all consumable today via the `package.json` `exports` map (see `INDEX.md` for the catalog). Cross-repo consumers link via `file:../claude-conductor`.

> **Slash commands and CLI verbs:** the session slash commands `/handoff`, `/handoff-resume`, `/channel`, `/presence` live in the user's dotfiles repo (substrate-refactor 2026-05-27 — user-workflow skills belong to user identity; conductor is primitive-only). They consume conductor primitives (channels CLI + parsers + hook framework + audit-verdict types + lineage envelope SSOT) via the `package.json` `exports` map cross-edge. A standalone `claude-conductor` CLI bin with stable verb contracts (`whoami`, `set-role`, `join`, `send`, `read`) ships in **Phase 1**, not v0.1.0.

## CLI verbs (deferred to Phase 1)

The CLI verb surface below is the **Phase 1 design target**, not the v0.1.0 contract. None of these verbs exist as a standalone binary in v0.1.0 — coordination today happens via the bundled slash commands inside Claude Code, which delegate to `src/channels/cli.ts` (consumed via cross-repo `file:..` link from dotfiles).

| Verb                           | Purpose (Phase 1)                                         |
| ------------------------------ | --------------------------------------------------------- |
| `whoami <channel-id>`          | Print this session's identity + role in the channel.      |
| `set-role <channel-id> <role>` | Flip role posture: `pen` / `queue` / `out`.               |
| `join <channel-id>`            | Join channel; auto-assigns NATO identity (BRAVO, etc.).   |
| `send <channel-id> <kind>`     | Send a message (identity + role attached automatically).  |
| `read <channel-id>`            | Read messages, rendered as `<identity> (<role>): <body>`. |

Full per-verb contracts will live in `docs/api/cli-contracts.md` (Phase 1 deliverable). Error codes catalogued in `docs/api/error-codes.md`.

## Decision-log convention

Phase decisions are filed at `decisions/phase-<N>.md` per the parent plan's discipline. See `INDEX.md` for the catalog and `docs/conventions/decision-log-schema.md` for the per-entry frontmatter format.

## Deferred until public-release decision

These phases of work are NOT yet executing. They activate when (and if) a public-release decision is made:

- **Phase 4** — Plugin manifest (Claude Code plugin format), full README polish, comparison docs vs Agent Teams + MCP Agent Mail + vanilla Claude Code, install flow documentation.
- **Phase 6** — PR to Anthropic with the NATO identity + pen/queue role convention as a proposed Agent Teams extension.

## Status line

| Field             | Value                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| Version           | v0.1.0                                                                |
| Last phase merged | Phase 0 (sub-steps 0.1–0.10 — initial scaffold + audit-remediation)   |
| Next phase queued | Phase 1 — CLI verb surface (`whoami`, `set-role`, `join`, `send`, …)  |
| License           | Apache-2.0                                                            |
| Distribution      | Private/closed for now                                                |
| Audit gate state  | Sub-step 0.10 4-persona terminal audit + remediation arc (2026-04-28) |

## License

Apache-2.0. See `LICENSE` for full text and `SECURITY.md` for the threat model and vulnerability disclosure path.
