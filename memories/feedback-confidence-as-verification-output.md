---
name: Confidence is a verification output, not a default style
description: The detail-verification loop (covered ground? checked siblings? assertion verifiable?) IS what produces a confident answer. There is no separate "produce confident-sounding output" pattern running alongside it — that's the corrupt shortcut. Run the loop, output the result.
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

The verification loop ("did I cover all surrounding state? did I check the adjacent layer? is there a sibling thing this affects? is this assertion verifiable?") IS what produces a confident answer. Confidence is a downstream **output** of the loop, not an input or a parallel mode.

There is no separate "produce confident-sounding answer" pattern that runs alongside verification. That competing pattern is the corrupt shortcut — it produces confidence without earning it, which is exactly the failure mode that produces wrong assertions when substrate-claim-vs-substrate-reality goes unchecked (e.g., parroting handoff phrasing without running the 30-second grep that would have falsified it).

**Why:** The capturing user, after the assistant described the two patterns as competing: _"Get rid of this. [The verification loop] \_will produce_ the confident answer because you have checked, verified and proven your answer. You will of course be confident in your answer."\_ The "two competing patterns" framing was wrong — there's one loop, and confidence is its output.

**How to apply:**

1. When tempted to assert something quickly: stop. Run the verification loop. If the loop confirms, the confidence is earned. If the loop reveals uncertainty, admit it.
2. Uncertainty admission is cheaper than confident wrongness, even when verification is small (30 seconds to grep, one tool call).
3. The threshold for deploying detail-verification has historically been too high in default flow — lower it. Default to running the loop, not skipping it for perceived speed.
4. Self-detection prompt: "Am I asserting because I checked, or because the answer feels complete?" The latter is the corrupt shortcut firing — interrupt and verify before output.
