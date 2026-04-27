---
name: Convergent problem-solving across instances is a signal, not a coincidence
description: Convergent instances replicate the principle (gap recognition, generalized approach) — rarely byte-identical artifacts. Treat convergence as a validation signal; design for collision detection. Counter-case — convergence on a shared faulty prior is diagnostic, not validating.
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

Two independent deterministic agents (same model, same codebase, similar recent context) will frequently converge when exposed to the same problem. **This has two implications:** (a) convergent diagnoses/fixes are a strong validation signal that the framing is correct, and (b) the system must detect and reconcile concurrent work rather than hoping it doesn't happen.

**Load-bearing example (generic shape):** While working on a coordination feature in one branch, another session working independently in a different branch discovered and fixed the same hot-path bug. Both fixes were byte-identical; PRs landed within minutes of each other. The other session spontaneously wrote a degenerate file-based "cross-session note" to describe the collision — unknowingly demonstrating the exact need the coordination feature exists to solve.

**Substrate replicates principle, not artifacts:** the byte-identical fix above was a lucky coincidence at the artifact level — small bug, small diff, similar framing context. The general case is convergence on PRINCIPLE (gap recognition, "this needs coordination," "this primitive is missing") with different surface implementations. Real instance: Session A framed a capture problem as "filing cadence"; Session B framed it as "observation-vs-capture split." Same principle (work is generating insights faster than they're being filed), different phrasings, distinct artifacts. Reading convergence as "we'll produce byte-identical fixes" over-reads the rare case; reading it as "we'll identify the same gap" is the load-bearing signal.

**Counter-case: convergent hallucination on a shared faulty prior.** Convergence is only a validation signal when it isn't explained by a shared faulty prior. In a real cross-session reflection cycle, two peer sessions spent rounds operating on a hallucinated three-role model generated from two-entity ground truth, because both sessions inherited the same upstream convention from the handoff flow. One session cycled through fresh-generated IDs per CLI invocation; the other read identity churn as role proliferation; both independently constructed the same wrong ontology. The convergence wasn't validation — it was diagnostic of a shared flawed upstream assumption.

The framing (preserved verbatim from the peer-session capture): _"Convergent hallucination on an over-specified model is diagnostic of a shared faulty prior, not validation of the model."_ Before trusting convergence as signal: check whether the converged-on model is over-specified relative to ground truth, and whether both sessions inherited the same upstream convention that could mislead them the same way. If yes, convergence is confirming the bad prior, not the conclusion.

**How to apply:**

- When the assistant discovers a bug or a gap and a PR/item for the same thing already exists, don't treat it as wasted work — treat it as confirmation that the diagnosis is sound.
- Expect principle-level convergence; don't expect byte-identical artifacts. If two sessions disagree on implementation while agreeing on the gap, that's healthy — pick the stronger implementation and file the reasoning.
- For merging concurrent work in a multi-instance environment: prefer merge-commits over rebase (see `feedback-merge-commit-across-instances.md`). Rebase-and-drop-duplicates is safe only when the duplicates are strictly local and not externally referenced.
- Defense-in-depth candidate: a PreToolUse lockfile hook that signals to the other instance before a write, complementing reactive channel-based coordination.
- Cross-instance coordination is not hypothetical — it already happens, and will happen more as parallel sessions become routine.
- Detect convergent hallucination explicitly: before treating peer-session agreement as validation, ask "did both sessions inherit the same upstream convention that could mislead them the same way?" If yes, the agreement is over-determined; don't read it as independent confirmation.
