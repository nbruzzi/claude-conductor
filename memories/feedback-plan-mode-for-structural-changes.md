---
name: Plan mode + branching trigger thresholds are intentionally low — apply them by default for structural changes
description: Plan mode fires for "anything involving more than one file, a new feature, a bug fix, or anything that could go wrong" and branching fires when work touches >3 files. These thresholds are intentionally low; the failure mode is treating them as advisory and skipping with a verbal "plan" sketch in response prose. Default to plan mode + branch when work is structural — skills, agents, system config, hooks, behavior-affecting infrastructure — regardless of file count.
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

The plugin's CONTRIBUTING.md states the rule explicitly:

> **Planning rules:** A complex task is anything involving more than one file, a new feature, a bug fix, or anything that could go wrong.
>
> **Branching rules:** Create a feature branch before starting work if EITHER (a) plan mode is entered, OR (b) the work will touch more than 3 files.

These thresholds are deliberately moderate, but they are **hard thresholds, not advisory**. The rule is not "use plan mode when it feels right" — it requires an explicit trigger check before touching any file.

The failure mode: produce a verbal "plan" sketch in response prose, then proceed to execute. The verbal sketch _looks_ like planning, but:

- It is not plan mode (no formal scope-lock, no plan file, no opportunity for the user to audit the plan before execution).
- It bypasses the `multi-persona-audit-pattern.md` memory (which mandates a multi-persona audit + verification loop on substantial plans before `ExitPlanMode`).
- It often goes straight to commit-on-main, violating the branching rule too.

This is the same architectural shape as the verification-loop failure documented in `feedback-confidence-as-verification-output.md`: the trigger to deploy the procedural check doesn't fire by default. The discipline exists; the gate is too permissive.

**Why:** The capturing user, after a structural skill change was committed without entering plan mode first: _"This wasn't worth planning out?"_ — direct acknowledgment that the gate is too permissive. The same session contained a second violation of the same rule (a 5-file structural change to a parallel-trio sibling, also committed without plan mode) — evidence the gate isn't firing reliably by default.

**How to apply:**

1. **Before touching any file**, run the trigger check explicitly:
   - Does this work involve more than one file? → plan mode candidate.
   - Is this a new feature, bug fix, or behavior-affecting change? → plan mode candidate.
   - Will the change touch more than 3 files? → branch first.
   - Is this a change to bundled skills, agents, settings, hooks, or anything that affects future-session behavior? → plan mode + branch by default, regardless of file count. These categories are structural even when the diff looks small.
2. **Verbal sketches in response prose are not plan mode.** If the work crosses a threshold, prompt the user: _"This is a [structural / >1-file / behavior-affecting] change. Want me to switch to plan mode (Shift+Tab twice) and produce a plan first?"_ Wait for their answer.
3. **Don't commit directly to main on a structural change.** Even when the repo doesn't enforce branch protection, the rule does. Default: branch first, commit on branch, open PR or merge per user direction.
4. **The threshold is intentionally low — apply it, don't ramp it up.** The cost of an unnecessary plan-mode prompt is one extra round-trip; the cost of a missed plan-mode prompt is a structural change that escaped audit, branching, and user pre-approval. Default to prompting when in doubt.
5. **Self-detection prompt:** "Am I about to write to a file because I have a verified scope the user pre-approved, or because the immediate task feels small and I'm flowing through it?" The latter is the corrupt shortcut firing — interrupt and run the trigger check.
