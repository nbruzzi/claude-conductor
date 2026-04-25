<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Security

## Threat model

claude-conductor operates within the trust boundary of a single user's local environment plus their Claude Code session. The plugin's declared trust assumptions:

- **Trusted**: local filesystem, environment variables, Claude Code harness, the user's git repositories, the user's MCP servers.
- **NOT trusted**: arbitrary network sources, untrusted git remotes, arbitrary stdin content, message bodies received via channels (treat them as data, not code).

The plugin runs hooks that fire on Claude Code session events (`TeammateIdle`, `TaskCreated`, `TaskCompleted`, `PreToolUse`, etc.). These hooks execute with the user's permissions. Any Claude instance installing this plugin is authorizing it to read/write within that scope.

## Hook execution model

Phase 2's Agent Teams integration hooks (when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set) gate task completion on audit-trail presence. These hooks:

- Read the audit-trail directory at `<plugin-root>/audits/`.
- Read the decision-log directory at `<plugin-root>/decisions/`.
- Do NOT modify code outside `<plugin-root>/` or write to repositories.
- Do NOT make network calls.
- Fail-soft: any internal error (filesystem unreadable, JSON parse fail, missing config) exits 0 with stderr log; only verified policy violations block.

## Bundled memory provenance

Memories shipped under `memories/` are anonymized rewrites of cross-session feedback patterns. The anonymization process (Phase 0) blocks personally-identifying strings, repository-specific paths, and incident-specific PR numbers from the body text. The anonymization is verified by a CI grep check.

Memories declare `cadence: durable` and a fixed `updated:` timestamp at extraction time. They are NOT auto-revalidated against changing reality by this plugin; consumers should treat them as guidance, not authoritative current-state claims.

## Vulnerability disclosure

`security@<placeholder-domain>` (TBD when public-release decision is made; until then, the disclosure path is internal — coordinate with the repo owner directly).

For vulnerabilities discovered in code:

1. Open a private GitHub Security Advisory on `nbruzzi/claude-conductor`.
2. Do not file a public issue.
3. Expected response time: 48 hours acknowledgment, 14 days remediation for critical.

For vulnerabilities discovered in shipped memories or convention documentation that could mislead a Claude instance into unsafe behavior:

1. Same disclosure path.
2. Treat with the same urgency — memory rot can be load-bearing.

## Forbidden practices in code

To enforce the threat model, plugin source code is forbidden from:

- Calling `eval()`.
- Constructing functions from string sources at runtime.
- Concatenating strings into shell commands (use `Bun.spawn` argv arrays).
- Reading from `process.stdin` without an explicit type-validated parse step.
- Making outbound network calls without explicit user opt-in.

ESLint custom rules and CI grep checks enforce these where automatable.

## Secrets handling

No secrets in:

- Bundled memories.
- Audit transcripts.
- Decision logs.
- Code comments.
- Test fixtures.

A `secret-scan` CI check (gitleaks-style) blocks commits that match credential-shaped strings. The check pattern set covers API keys, tokens, passwords, bearer tokens, AWS keys, and similar.

## Dependency security

Every new runtime dependency requires an entry in `dependencies-rationale.md`. This provides an audit trail for supply-chain review at any future point.
