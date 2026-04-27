---
name: Prefer single Bash calls over compound chains for paths with special characters
description: Compound bash commands chained with `&&` / `||` / `;` that contain backslash-escaped paths trigger Claude Code's permission-prompt heuristic even when each individual segment is auto-allowed. The fix is operational — issue separate Bash calls instead of chaining them — until Claude Code's permission engine decomposes compound commands.
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When issuing Bash calls that touch paths containing special characters (spaces requiring backslash-escape, quotes, etc.), **prefer multiple single-command Bash calls over one compound chain** when the chain is just for grouping (not necessary for shell semantics like piping output).

The failure mode (observed pervasively in a session that touched a path with backslash-escaped whitespace): compound commands like `find /path/with\ spaces -name X && cd /path/with\ spaces && git branch --list` trigger Claude Code's permission-prompt heuristic with the message _"Contains backslash-escaped whitespace. Do you want to proceed?"_ — **even though each individual segment (`find`, `cd`, `git branch`) is auto-allowed.** The heuristic doesn't decompose `&&` chains into segments; it treats the whole chain as one unit needing approval.

**Why:** The capturing user, with a screenshot of the prompt: _"This is the majority of when you get stopped. I understand the ramifications of what can happen and why I need to approve, but I think we have a TON of things implemented to make sure nothing causes any issues."_ A fewer-permission-prompts skill scan confirmed: most allowlist entries already cover the patterns; the friction is structural in the permission-engine's compound-command handling, not an allowlist gap. Allowlist patterns can't safely cover compound chains because `Bash(<pattern>*)` would auto-allow arbitrary post-`&&` commands.

**How to apply:**

1. **When the chain is just for output grouping** (e.g., printing a header before each section, multiple independent reads): issue separate Bash calls in a single message. Each call auto-allows; no prompt fires.
2. **When the chain is semantic** (output piped to next command, exit code propagation matters, working directory changes affect subsequent commands): keep the chain. The prompt cost is sometimes the right cost.
3. **Specifically for paths with spaces**: since these contain backslash-escaped whitespace and trigger the heuristic, decompose proactively. `find spaced-path` + `cd spaced-path` + `git ...` as three separate Bash calls in one message executes faster and doesn't prompt.
4. **Don't try to allowlist around it.** A pattern like `Bash(find /path/with spaces*)` looks like it would help, but the `*` wildcard matches end-of-string including any `&&` suffix, which would auto-allow compound chains containing arbitrary post-`&&` commands. Unsafe.
5. **The structural fix is upstream** — Claude Code's permission engine should decompose chains and check each segment against auto-allow independently. File this as feedback to the framework vendor if it surfaces as a recurring friction point. For now, the operational workaround is sufficient.
6. **Trade-off acknowledgment**: separate Bash calls means more tool-call round-trips than one compound. For very-long output-grouping chains (10+ segments) the round-trip cost may exceed the prompt-acceptance cost; in those cases, accept the prompt rather than fan out.
