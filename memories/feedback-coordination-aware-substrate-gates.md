---
name: Coordination-aware substrate gates via shared read-only primitives
description: Substrate gates that false-fire on legitimate channel-coordinated sibling work should consult coordination state via shared read-only primitives, not be bypassed via operator workarounds.
type: feedback
cadence: stable
scope: global
updated: 2026-05-15
origin: extracted
---

When a substrate-gate's input model is incomplete — it fires on legitimate work because it lacks visibility into channel-coordination state — the fix belongs in the substrate (sharpen the input model via a shared read-only primitive), not at the operator layer (instruct users to dismiss the false-fires) or in each gate individually (duplicate the read-shape).

**Why:** Lived 2026-05-15 evidence — `session-collision-gate` (PreToolUse Edit/Write) fired 2+ times on a sibling's vault edits during a channel-coordinated triage cycle, each engaging a 30-min cooldown that the operator had to override. `teammate-idle-reminder` (UserPromptSubmit) fired on a `role=queue` standby peer at the 5-min mark, then again at 13-min, then again at 8+ min. Each fire consumed operator attention to evaluate-and-dismiss. Both gates' input model was wrong on the work they were observing — they didn't see the open channel that made the peer state legitimate. Per `feedback-self-monitoring-is-architectural.md`: a gate whose health signal is wrong in either direction trains the operator to ignore it; the real fire later is missed. Operator-bypass is also exactly the prior state that produced the lived evidence — bypass works for one fire, multiplies as a tax across cycles.

**How to apply:**

1. **Recognize the shape.** A substrate gate that BLOCKs / WARNs / surfaces a reminder on a peer's heartbeat, mtime, or message-stream state — when the gate has no signal of channel coordination — has an incomplete input model. The first false-fire is the signal; the second is the operational tax compounding.
2. **Locate the substrate read.** The state the gate needs is already in the substrate — channel metadata (`identities[]`, `participants[]`, `messages.jsonl`). The gate needs a read-only function to consult it, not its own copy of the read-shape.
3. **Co-locate primitives by domain.** Extending an existing module is preferred over a new omnibus. `isPeerCoordinatedWithSelf` extends `channels/identity-context.ts` because it wraps the same domain (participant-set scan). `getMostRecentPeerKind` got its own new module `channels/peer-recent-message.ts` because tail-reading `messages.jsonl` is a genuinely new domain (no precedent). Multi-helper omnibuses across domains are an anti-pattern.
4. **Read-only contract.** Substrate primitives consumed by gates must be read-only: zero fs writes, zero lock acquisitions. Otherwise they can't be called inside the gate's existing lock context without re-entrancy hazards or deadlock potential.
5. **Skip-on-error.** Helper throw must be caught internally + breadcrumb'd via `appendPresenceFailure`. The consumer gate falls back to its pre-coordination behavior (conservative default — BLOCK on collision, fire on idle), so the new behavior is purely additive. Failure modes never escape the helper.
6. **Bound the tail-read.** When tail-reading message-streams, use an absolute byte-cap AND absolute line-cap (whichever hits first). Drop partial first lines (byte-cap mid-record) + trailing lines without `\n` (mid-append). Re-use the canonical validator. 256 KB / 500 lines is the verified-against-real-channel bound for messages.jsonl as of plan v2 RE-2.
7. **Forensic breadcrumb at suppression.** When a gate suppresses its primary behavior based on a coordination signal, emit a `<lifecycle>-suppressed` `PresenceFailureKind` breadcrumb at the suppression point. If the suppression mis-engages (peer genuinely crashed after posting a standby kind), the breadcrumb is the only forensic record — without it, operators can't distinguish "correctly suppressed" from "mistakenly suppressed."
8. **Preserve mixed-state behavior.** When N peers can be in mixed coordination state (some coordinated, some uncoordinated), the gate must NOT take the downgrade path on any single coordinated peer. `peers.every(coordinated)` is the load-bearing predicate; mixed-peer collisions retain the existing BLOCK behavior with per-peer annotation in the formatted message body so the operator can distinguish which peer is which.

**Cross-references:**

- `feedback-self-monitoring-is-architectural.md` — the parent principle (input-model-wrong-on-legitimate-work is architectural).
- `feedback-live-substrate-sequencing.md` — substrate evolution discipline; this pattern is additive (new exports + new modules) so no dual-read protocol is needed.
- `feedback-no-known-gaps.md` — don't ship operator-bypass as the fix; the substrate-level fix is the load-bearing one.
- `decisions/phase-5.md` Decision G — the architectural choice ratified for this pattern.

**Pairs with:**

- Plan: `~/.claude/plans/sibling-coord-gate-awareness.md` v2 (the load-bearing plan that operationalized the pattern across L161 + L146).
- Implementations: `src/channels/identity-context.ts` (`isPeerCoordinatedWithSelf`), `src/channels/peer-recent-message.ts` (`getMostRecentPeerKind`), `src/hooks/checks/teammate-idle-reminder.ts` (consumer), dotfiles `src/hooks/checks/session-collision-gate.ts` (consumer; parallel-by-design per INVERSIONS B5 ARCH-3 deferral).
