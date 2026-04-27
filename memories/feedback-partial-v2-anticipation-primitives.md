---
name: Partial V2 anticipation via primitives-only lift
description: When a second caller of a pattern appears, lift the shared primitives into a cross-caller module NOW, but do NOT lift the structural choices — V2 registry consolidation stays deferred
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When a second caller of an existing pattern appears, the shipping shape is **Shape B (parallel siblings) + a cross-caller primitives module**. Lift the reusable primitives (rotation, diagnostics, whitespace normalization, shared constants) into `<domain>-common.ts`. Do NOT lift the structural choices (copy-vs-in-place, narrow-vs-bulk, policy differences). The primitive lift is the partial V2 anticipation; the registry consolidation is the full V2 and stays deferred.

**Why (load-bearing example, generic shape):** On a multi-phase feature PR, a parallel sibling trio shipped as a parallel sibling to an existing trio (Shape B, chosen over Shape A "parameterized registry"). After shipping the sibling trio's hardening phase, the original trio was still holding pre-hardening byte-for-byte copies of `oneLine`, `appendLogWithRotation`, `diagnosePushFailure`, etc. — a drift-in-waiting. Lifting them into a `<domain>-common.ts` cross-caller module removed the drift vector without committing to the registry abstraction (Shape A). The two trios still make their own structural choices (one pushes only on a specific branch; the other auto-pushes; one stages narrowly; the other uses bulk staging). Those differences are real and straight-line code is the right encoding — a registry flag for each would be more complex than the parallel trios.

The pattern is: **primitives yes, structure no.** Shared constants and pure functions cross into the common module. Control flow stays per-sibling.

**How to apply:**

- **Trigger:** A second caller of a pattern appears AND there are byte-for-byte (or near-byte-for-byte) copies of helpers. The second caller alone isn't enough; the copy-drift is the decisive signal.
- **Scope of lift:** pure functions (`oneLine`, `diagnosePushFailure`), constants (e.g., size limits, timeouts), and simple wrappers (`appendLogWithRotation`). Nothing with conditional branches on caller-specific state.
- **What stays per-sibling:** push policy, staging strategy, commit-message format, sentinel semantics, lock discipline. Each sibling decides these; differences are features, not drift.
- **Naming:** `<shared-domain>-common.ts` (e.g., `sync-common.ts` for a sync-loop pair). Not `shared.ts`, not `utils.ts` — the name encodes the domain scope so the next caller knows whether they qualify.
- **Document the distinction in the module header.** The common module opens with: "Anything <sibling-A>-specific belongs in `<sibling-A>-common.ts`. Anything <sibling-B>-specific belongs in `<sibling-B>-common.ts`. This module exists so primitives that both loops need live in exactly one place." The distinction is load-bearing; a future contributor unclear on scope will bloat the common module and reintroduce drift the other direction.
- **Decision record gets a living-status line.** The Shape B decision record should note in a **Status** section that the partial V2 primitive lift happened (and when), so future readers see both the original Shape A/B/C tradeoff AND the partial-anticipation refinement. Without the status pin, the decision record rots into "decided in <month>; still true?" ambiguity.
- **Registry consolidation stays deferred to V2.** The partial primitive lift doesn't obviate Shape A — it just removes the drift-in-waiting that would make Shape A harder to reach later. Note in V2 output: "primitive layer is fixed; registry layer is additive."
- **Counter-signal — when NOT to partial-lift:** If the second caller has a materially different policy for what looks like the same primitive (e.g., one caller needs rotation with multi-slot history, the other with single-slot), don't fuse. Either parameterize honestly (and pay the registry cost) or leave them separate. Fake-fusing with a flag is the worst outcome.

**Track record:** On a real instance, the primitive lift survived the final terminal full-diff audit without being criticized as premature abstraction. The structural differences (preserved as parallel code) were specifically called out in the architecture documentation as "intentionally not encoded as registry flags." This is the target state.
