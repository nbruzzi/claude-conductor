# Statusline NATO-identity recipe

Show the session's current NATO identity (Alpha / Bravo / …) in a Claude Code
statusline using the `whoami-active` channels verb.

## Why a verb (not inline jq)

Discovering "which NATO identity does this session hold, on which channel"
requires iterating `~/.claude/channels/*/metadata.json` and matching
`.identities[<letter>].session_id` against the session id. That is
plugin-owned schema knowledge — it should not be reimplemented in user-side
bash, where it drifts when the channel metadata shape changes. `whoami-active`
encapsulates the scan (and its tiebreaker) behind a stable CLI surface.

## The verb

```
claude-conductor channels whoami-active [--session-id <uuid>] [--json]
```

- **No channel-id argument** — the verb auto-discovers the channel for you.
- `--session-id <uuid>` — the session to look up. Falls back to
  `CLAUDE_SESSION_ID` when the flag is absent. If neither resolves, the verb
  prints `null` (`--json`) / empty (bare) and **exits 0** — a statusline must
  never see an error.
- `--json` — prints `{ identity, channel_id, role, joined_at }` (or `null`).
  Without it, prints just the identity string (e.g. `Bravo`) or empty.
- **Multiple claims** — when the session holds an identity on more than one
  channel, the verb returns the **most-recent by `lastMessageTs`** (falling
  back to `joined_at` when a channel has no messages yet, then breaking exact
  ties on `channel_id`). The ordering is deterministic — it never depends on
  filesystem enumeration order.
- **Always exits 0.** "No identity" is a successful read of "no identity",
  not an error.

## Statusline snippet

In your `statusline-command.sh`, after extracting `session_id` from the
Claude Code JSON input:

```bash
identity=""
if [ -n "$session_id" ]; then
  identity=$(claude-conductor channels whoami-active --session-id "$session_id" 2>/dev/null)
fi
# …then render "$identity" as the first segment of your statusline when set.
```

A single subprocess invocation per statusline tick is typically ~10–50 ms for
the usual handful of active channels. If profiling ever shows it is slow on a
host with many channels, cache the result at
`~/.claude/.cache/statusline-identity-<session-id>` with a short TTL and
invalidate on channel-metadata mtime change.

## See also

- `channels whoami <channel-id>` — the single-channel sibling (you already
  know the channel).
- `docs/conventions/message-kinds-and-verification.md` — channel message kinds.
