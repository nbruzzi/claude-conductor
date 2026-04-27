---
name: Self-monitoring failures are architectural, not housekeeping
description: When an infrastructure component's self-reported status disagrees with ground truth, treat it as an architectural concern — never file it under "Housekeeping".
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When an infrastructure component's self-reported status disagrees with observed ground truth — e.g., a Stop hook saying "sync broken" while git log shows sync commits succeeded, or a `/handoff` skill whose Step 4 is silently skipped without detection — that's an architectural concern, not a housekeeping item.

**Why:** The capturing user pushed back when the assistant initially filed two such failures (a session-log missing recent handoff entries; a sync hook reporting "broken" despite successful sync commits) under a `## Housekeeping` section of the backlog. The user's words: _"Problems for two very important architectural things. Important."_ A health signal that's wrong in either direction is worse than no signal — it trains the assistant to ignore it, so a real failure later is missed. These failures also compound: if a skill writes and verifies via the same path, the verifier fails the same way the writer does (the **monitoring-outside-context** principle: any system that monitors itself via the same mechanism it controls cannot detect failures of that mechanism — the verifier needs an out-of-band view, or it inherits whatever blind spot the writer has).

**How to apply:**

1. When the assistant spots a disagreement between a system's self-status and ground truth, file it as an architectural item with a proper section (e.g., "Self-Monitoring Infrastructure") — not under "Housekeeping" or similar catch-all.
2. Include the architectural framing in the entry: what was the signal, what was the ground truth, why the gap is dangerous, and a concrete direction for fix (external verifier, hook-based enforcement, or signal derivation from authoritative state).
3. Connect the entry to the **instructions vs enforcement** principle — skill instructions that ask the assistant to do a step are not enforcement. If a step must always happen, it needs a hook, a validator, or executable code the skill calls.
4. Never treat these as low-priority just because the observed failure was cosmetic. The blast radius is trust in the monitoring itself.
