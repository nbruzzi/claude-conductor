---
name: Memorialize-then-violate is a recurring failure mode — apply the memory to the very next action
description: Writing a memory about a failure mode does NOT internalize the discipline. The repeated pattern observed: write memory entry about avoiding pattern X, then violate pattern X within the next 5–10 tool calls. The fix is verifying the LAST memory written against the NEXT action about to be taken — explicit self-detection, not hopeful internalization.
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When a memory entry is written about a discipline (e.g., "prefer single Bash calls over compound chains for paths with special characters" or "branch first when work touches >3 files"), the act of writing the memory does NOT actually internalize the discipline. The repeated observed pattern is: **write memory entry → next 5–10 tool calls violate the exact pattern just memorialized**. The memory is performative; behavior change requires a separate explicit step.

Concrete observations (single-session pair):

- Wrote `feedback-prefer-single-bash-over-compound.md` saying "prefer single Bash calls over compound chains for paths with special characters." Within 4 tool calls, issued a 6-segment compound chain with backslash-escaped paths — triggering exactly the prompt-friction the memory warned against.
- Wrote `feedback-plan-mode-for-structural-changes.md` saying "branch first when work touches >3 files." Within 1 tool call after creating a new repo, started parallel-writing 16+ files to `main` of the new repo without cutting a feature branch. The branch-enforcement hook fired correctly at file 4.

Both violations were on a brand-new repo, immediately after writing memories whose entire point was to prevent these specific failures.

The corrupt shortcut: **memorialize → feel like the discipline is now active → proceed without verifying**. The memory writing produces a felt-sense of "I've handled it" that displaces actual discipline.

**Why:** The capturing user, with two consecutive screenshots showing the prompts: _"Do you see 1) my problem? You stopped for me. 2) The irony..."_ The irony is that the assistant wrote memories explicitly about these failure modes and immediately violated both. The user has been catching this pattern repeatedly across sessions. The system-reminder mechanism + hook enforcement is what's actually saving the work; the memory entries themselves aren't load-bearing yet.

**How to apply:**

1. **Last-memory-vs-next-action self-check.** Before EVERY tool call: "Is the discipline I most recently wrote about applicable to this action? Am I about to do exactly what that memory said to avoid?" This is a 1-second check that catches the failure mode at the exact point it would otherwise happen.
2. **Memorialize-then-verify, not memorialize-then-proceed.** After writing a feedback memory, the very next action gets explicit checking against that memory's guidance. If they conflict, the memory wins; the action gets restructured.
3. **The hook system is doing memory's job.** When discipline-as-code hooks fire (`branch-enforcement`, `config-protection`, `destructive-cmd`, `fact-force`) — those are the substrate compensating for failed internalization. Treat each hook stop as evidence that a recent memory wasn't actually internalized, not just as friction to work around. The fix isn't disabling hooks; it's catching the same conditions before the hook has to.
4. **Stop writing more memories until existing ones are reliably followed.** The memory pile keeps growing while the application rate stays flat. Adding entries is easier than internalizing, so the easy action displaces the load-bearing one. Density itself becomes a signal of failed internalization. (Same shape as the ecosystem-prior-art point in `feedback-think-holistically-not-reactively.md`.)
5. **Self-detection prompt:** _"What did the last memory I wrote say to avoid? Am I about to do that?"_ — applied before every Bash, Edit, Write, or other action with discipline-relevant scope. The discipline is the check, not the memory.

This memory is itself an anti-pattern instance (writing a memory about failed memory-internalization). The remediation is to verify on the NEXT tool call after this is saved that the assistant is not about to violate any recently-memorialized discipline. Explicit verification at the action boundary is the only fix.
