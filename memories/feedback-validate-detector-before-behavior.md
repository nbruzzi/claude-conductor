---
name: Validate the detector before changing behavior
description: When a feedback telemetry rule fires high-frequency but the flagged behavior feels aligned with the user's intent, suspect the detector — not the behavior. Sample 5-10 raw matches before adjusting course.
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When a detector/reminder fires ≥5x in a rolling window and the flagged behavior feels correct, **suspect the detector first**. Do not "try harder" to avoid the behavior on the assumption that the telemetry is ground truth.

**Why (load-bearing example, generic shape):** A feedback-event rule fired ≥30x in a 7-day window over a single rolling sample. All matches were syntactic siblings of the intended violation class, not the violation class itself — for example, a regex meant to match diff-prose hunks (`/^[+-] /`) accidentally matching markdown bullet lists in the user's preferred handoff format. The detector could not distinguish the two; the intervention was inverting the feedback loop, nudging away from the format the user wanted and away from nothing real. **A false positive that inverts intervention is worse than a false negative**; a missed violation leaves the user to surface it, but an inverting FP actively corrupts self-correction.

**Detector Validation principle (concept summary):** before letting telemetry change behavior, sample raw matches and confirm they are the intended violation class. A detector that mis-fires on syntactic siblings is worse than no detector — its output corrupts the same self-correction loop it is meant to support. The validation check costs ~30 seconds; the cost of acting on a corrupt signal compounds across every subsequent intervention.

**How to apply:** When a feedback-rule-reminder cites a non-zero count that feels wrong:

1. Grab the raw matches: `jq -c '.matches[0].snippet_preview' <feedback-event-log> | tail -10`.
2. Eyeball 5-10. Are they the intended violation class, or a syntactic sibling?
3. If sibling → detector is under-specified. Add a discriminator, add a true-negative test, archive the stale log, truncate the live log, start re-measurement fresh.
4. If genuine → take the behavior seriously. The detector is telling the truth.

The 4-step protocol is generic and applies to any detector-validation pattern (telemetry, alerts, automated linters, audit triggers). The discriminator-vs-sibling distinction is the load-bearing concept.
