---
name: Phased audit remediation arc with final full-diff audit
description: For multi-phase infrastructure work, run per-phase inline audits AND a terminal full-branch-diff audit — the final audit catches accumulation hazards that slice-level audits structurally cannot see
type: feedback
cadence: stable
scope: global
updated: 2026-04-25
origin: extracted
---

When shipping substantial infrastructure across multiple phases, run inline audits at the end of each phase AND a separate multi-persona audit on the **full cumulative branch diff** as the terminal phase before merge. The per-phase audits catch slice-local hazards; the final full-diff audit catches accumulation hazards that only become visible once the pieces are assembled.

**Why (load-bearing example, generic shape):** On a six-phase feature PR, phases 1–5 each ran inline audits and shipped clean. Phase 6 was a distinct "final audit on full diff" pass. Two real production hazards surfaced in Phase 6 that all five prior audits had missed:

- A non-atomic sentinel-file write via `writeFileSync`. Invisible in per-phase audits because each phase only examined its own additions; the write pattern had been there since Phase 1 but the hazard only became loud once the full read-modify-write flow (sync → commit → clear) was visible in one frame.
- A push-failure-diagnostic priority order ranking wall-clock heuristic above stderr content. An earlier phase shipped the diagnostic standalone; it took the full-branch view in Phase 6 to see how a slow auth failure would be misreported as a timeout — a composition bug, not a slice bug.

Both were caught, both were fixed in-branch before merge. The pattern held: final full-diff audit is not redundant polish — it is structurally necessary for accumulation hazards.

**How to apply:**

- **Per-phase inline audit (phases 1..N-1):** matched-lens personas scoped to that phase's blast radius. Fast, cheap, catches slice-local hazards. Ship each phase clean.
- **Terminal full-diff audit (phase N):** separate phase explicitly commissioned to read the entire branch diff cold. Same multi-persona discipline as planning audits — 2-3 matched lenses (Architecture + Reliability + Test Architect is the default triplet for infrastructure work). Adversarial stance, not a victory lap.
- **Prompt framing matters.** Tell each persona explicitly: "You are auditing the full branch diff end-to-end, not individual slices. Look for hazards that only exist in the composition." Otherwise the persona defaults to per-slice review and the terminal-phase value evaporates.
- **Run the verification round on the terminal audit** the same way the planning audit does — each persona re-checks their own findings after integration. Bounded, with hard cap of 3 rounds. Both hazards in the real instance passed verification cleanly.
- **File remaining deferrals to the project's backlog with fix sketch + firing trigger.** The terminal audit on the real instance surfaced 13 additional items that didn't meet the pre-merge bar. Each went to the project backlog with enough context that a future session can act on them without re-auditing.
- **Budget:** terminal audit is 10-15% of total phase budget on top of the per-phase audits. Worth every minute — the pre-merge fix cost of the two real hazards was hours; the post-merge recovery cost if they had shipped would have been days of data-loss debugging.
- **Anti-pattern to avoid:** collapsing the terminal audit into the final phase's inline audit. Inline audits are scoped to the phase's changes. The terminal audit must be explicitly re-scoped to the full branch. Different frame, different findings.
