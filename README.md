<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# claude-conductor

**Status:** v0.0.0 — Active development, not yet public-released. Phase 0 (extraction at ceiling standard) in progress.

## Value proposition

`claude-conductor` is a Claude Code plugin that adds **discipline-as-code** on top of Anthropic's [Agent Teams](https://code.claude.com/docs/en/agent-teams) — a multi-persona audit skill with reconciliation and verification rounds, a handoff system that survives Agent Teams' documented `/resume` limitation, cross-team coordination via channels with NATO identity + pen/queue role convention, and bundled feedback memories that enforce ceiling-standard execution by default.

Audience: future Claude instances and peer Claude instances coordinating on shared codebases. Humans secondary. Every error message, output format, memory entry, audit transcript, and decision log is parseable and actionable by a Claude reading it.

Differentiation in the ecosystem (full comparison table ships in Phase 4):

- **Anthropic's Agent Teams** provides the multi-session substrate — shared task list, peer-to-peer messaging, file locking — but does NOT survive `/resume`, is one-team-per-session, and has no audit/handoff/discipline layer.
- **MCP Agent Mail** provides provider-agnostic coordination infrastructure — identities, threads, file reservations — but doesn't integrate with Claude Code's hooks or surface ceiling-standard discipline.
- **claude-conductor** does NOT compete with either. It extends them.

## Dev install (in-scope phases)

Plugin-marketplace install ships in deferred Phase 4. For active development:

```bash
git clone https://github.com/nbruzzi/claude-conductor.git
cd claude-conductor
bun install
./scripts/dev-link.sh   # symlinks bin/claude-conductor into ~/.claude/conductor/bin/
claude-conductor --help
```

## CLI verbs preview (Phase 1)

| Verb                           | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `whoami <channel-id>`          | Print this session's identity + role in the channel.      |
| `set-role <channel-id> <role>` | Flip role posture: `pen` / `queue` / `out`.               |
| `join <channel-id>`            | Join channel; auto-assigns NATO identity (BRAVO, etc.).   |
| `send <channel-id> <kind>`     | Send a message (identity + role attached automatically).  |
| `read <channel-id>`            | Read messages, rendered as `<identity> (<role>): <body>`. |

Full per-verb contracts live in `docs/api/cli-contracts.md` (Phase 1 deliverable). Error codes catalogued in `docs/api/error-codes.md`.

## Decision-log convention

Phase decisions are filed at `decisions/phase-<N>.md` per the parent plan's discipline. See `INDEX.md` for the catalog and `docs/conventions/decision-log-schema.md` for the per-entry frontmatter format.

## Deferred until public-release decision

These phases of work are NOT yet executing. They activate when (and if) a public-release decision is made:

- **Phase 4** — Plugin manifest (Claude Code plugin format), full README polish, comparison docs vs Agent Teams + MCP Agent Mail + vanilla Claude Code, install flow documentation.
- **Phase 6** — PR to Anthropic with the NATO identity + pen/queue role convention as a proposed Agent Teams extension.

## Status line

| Field             | Value                                           |
| ----------------- | ----------------------------------------------- |
| Version           | v0.0.0                                          |
| Last phase merged | (none yet — Phase 0 in progress)                |
| Next phase queued | Phase 0 — extraction + scaffold + test pipeline |
| License           | Apache-2.0                                      |
| Distribution      | Private/closed for now                          |
| Audit gate state  | Plan audited 2026-04-25; Phase 0 entry-ready    |

## License

Apache-2.0. See `LICENSE` for full text and `SECURITY.md` for the threat model and vulnerability disclosure path.
