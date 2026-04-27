---
name: Never ship known gaps
description: Never write code with known limitations and move on — fix them during build, not after the user discovers them
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

Never ship code with known gaps. If I know something is broken, incomplete, or faking functionality while writing it, I fix it in that same step — not later, not "Phase 3", not when asked.

**Why:** The capturing user explicitly sets a ceiling standard. Shipping a fake verification function (comparing artifact against itself), including formats in detection knowing the API rejects them, or writing sequential processing when concurrent is straightforward — these aren't limitations discovered later. They're shortcuts taken during build. That violates the pipeline (verify step) and the ceiling expectation.

**How to apply:** Before moving to the next file or step during implementation, ask: "Does this actually work as advertised?" If the answer involves "sort of" or "not really but it's fine for now" — stop and fix it. No fake implementations. No known-broken paths. No deferring obvious functionality. If something genuinely can't be done, say so explicitly during the build — don't quietly ship it and wait to be asked.
