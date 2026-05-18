<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Memories to Bundle

**Phase 0 sub-step 0.3 deliverable.** Anonymization rewrite plan for cross-session feedback memories shipped with the plugin under `<plugin-root>/memories/`. Per parent plan KS-1 + KS-2 + the audit gate.

**Audit gate:** mini-Knowledge-System audit on this document before sub-step 0.6 (file extraction) writes the actual `memories/*.md` files. Round-1 audit landed 6.5/10 with 1 critical + 3 major + 3 minor findings. **All 7 findings integrated below.** Verification round dispatched per audit-skill bounded-with-hard-cap-3 discipline.

**Status:** AUDITED — round 2 verification GREEN. Sub-step 0.6 entry unblocked. Audit envelope closed.

## Scope filter

The plugin's audience is **future-Claude + peer Claudes coordinating via Anthropic's Agent Teams**, not the original capturing user's personal setup. Memory selection criteria:

- **In-scope:** captures a cross-session pattern that generalizes to any Claude instance using the plugin. Includes audit discipline, plan-mode triggers, branching rules, autonomous-action shape, verification disciplines, audit-rounds bounded-cap, **and the multi-instance coordination disciplines that ARE the plugin's marquee feature** (merge-vs-rebase across instances, surface-merge-decisions, convergent-vs-divergent instances, self-monitoring architectural framing, detector validation as a discipline of self-aware infrastructure).
- **Drop (project-specific):** contains personally-identifying anchors as load-bearing references where the discipline doesn't survive removing them (the original user's communication preferences, the user's specific wind-down ritual, vault-specific note-taking convention).
- **Drop (substrate-specific):** about a particular workflow or substrate that doesn't generalize (vault-management trio, dotfiles-sync trio, HeatPrice domain, Sentinel jobs).

**Rule of thumb:** if removing the personally-identifying anchor leaves a generic discipline that any plugin instance would benefit from, **anonymize and bundle**. If removing the anchor leaves nothing useful (or only a communication preference), **drop**.

## Scope decisions

### Drop entirely (project-specific or substrate-specific)

These exist in the source pool but do NOT bundle into the plugin. The discipline either doesn't generalize or evaporates without the personal anchor:

- `feedback-audit-in-nicks-place.md` — explicitly references the original user by name as part of the discipline name; the discipline _is_ "stand in for the user," which is project-scoped.
- `feedback-nick-words-are-literal.md` — communication preference of the original user.
- `feedback-feed-the-wiki.md` — vault-specific knowledge-base maintenance discipline.
- `feedback-wiki-verify-before-acting.md` — vault-specific.
- `feedback-direct-and-advise.md` — communication preference.
- `feedback-self-sufficient-notes.md` — vault note-taking discipline.
- `feedback-ship-checkin.md` — communication preference with the original user.
- `feedback-response-length.md` — communication preference.
- `feedback-minimal-output.md` — communication preference.
- `feedback-commit-trailer-attribution.md` — original-user trailer convention.
- `feedback-always-push.md` — original-user-specific commit-push discipline (push-discipline depends on the user's substrate, not the plugin's).
- `ceiling-standard.md` — original ceiling memory anchored on the capturing user's verbatim quote. The same discipline (autonomous ceiling, step-away trust) is covered more sharply by `feedback-self-apply-ceiling-discipline.md` (in-scope). Bundle the latter; drop the original to avoid two-memories-same-discipline drift.
- `feedback-check-existing-before-building.md` — generic discipline but the body anchors heavily on substrate-specific examples; **reconsider in a future bundling pass** with a cleaner rewrite.
- `feedback-subagent-distance-as-default.md` — generic discipline; **reconsider in a future bundling pass** when the plugin has its own subagent flows to anchor against.
- `feedback-verify-end-to-end.md` — generic discipline; **reconsider in a future bundling pass.**
- `feedback-work-to-understand.md` — generic discipline; **reconsider in a future bundling pass.**
- All `project-*.md` files (project-vault-auto-sync, project-claude-conductor, project-memory-system-redesign, etc.) — explicitly project-scoped.

A future bundling pass (post-Phase-0) reconsiders the deferred-generic ones if they show up as load-bearing in plugin usage. Future-bundling trigger criteria are listed under "Open questions" and filed in `wiki/backlog.md`.

### In-scope (anonymize + bundle)

These bundle into `<plugin-root>/memories/` after anonymization rewrite. Total: **22 memories** (13 original + 5 multi-instance/architectural memories restored per KS-1 + 4 wind-down memories restored per `decisions/phase-5.md` Decision C).

| Source memory                                       | Anonymization required | Cross-references                                                                                 |
| --------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `feedback-confidence-as-verification-output.md`     | YES                    | references the deployment-note miss + parent-doc                                                 |
| `feedback-encode-while-context-fresh.md`            | YES                    | references audit-skill-update incident + capturing-user verbatim quote                           |
| `feedback-plan-mode-for-structural-changes.md`      | YES                    | references CLAUDE.md verbatim + audit-skill structural-change incident                           |
| `feedback-self-apply-ceiling-discipline.md`         | YES (heaviest)         | references multiple original-user interactions verbatim                                          |
| `feedback-sibling-parity-at-merge-time.md`          | YES                    | references PR #42 and the vault auto-sync arc                                                    |
| `feedback-design-vs-autonomous-runtime.md`          | YES                    | references parallel-session work + original-user verbatim                                        |
| `feedback-think-holistically-not-reactively.md`     | YES                    | references the parallel-session work + ecosystem-research pivot                                  |
| `feedback-no-known-gaps.md`                         | NO (already clean)     | minimal cross-refs; bundle as-is                                                                 |
| `feedback-phased-audit-remediation-arc.md`          | YES                    | references PR #42 phases verbatim                                                                |
| `feedback-partial-v2-anticipation-primitives.md`    | YES                    | references vault/dotfiles trio specifically                                                      |
| `multi-persona-audit-pattern.md`                    | YES                    | umbrella memory; references many specific incidents                                              |
| `feedback-prefer-single-bash-over-compound.md`      | YES                    | references vault path + dotfiles substrate                                                       |
| `feedback-memorialize-then-violate-anti-pattern.md` | YES                    | references the within-session violations specifically                                            |
| `feedback-merge-commit-across-instances.md`         | YES                    | references TimesFM PR #1 + commit SHAs + `src/todos/cli.ts`                                      |
| `feedback-validate-detector-before-behavior.md`     | YES                    | wikilink `[[Detector Validation]]` + `project-memory-system-redesign.md` + `~/.claude/` paths    |
| `feedback-self-monitoring-is-architectural.md`      | YES                    | wikilink `[[Monitoring Outside Context]]` + SESSION_LOG + dotfiles-sync hook                     |
| `feedback-surface-merge-decisions.md`               | YES                    | references PR #29 + 2026-04-18 incident                                                          |
| `feedback-convergent-instances.md`                  | YES                    | references `inter-window-coordination`, `HeatPrice.com`, channel ID, `auto-format.ts`            |
| `feedback-signoff-checklist.md`                     | YES                    | references "Nick" + bare-handoff verbatim quote                                                  |
| `feedback-wind-down-ordering.md`                    | YES                    | references rtk-ingest 2026-05-03 incident + Bravo peer name + Nick verbatim                      |
| `feedback-tiered-wind-down.md`                      | YES (light)            | references `feedback-plan-mode-for-structural-changes.md` (already bundled) + dotfiles paths     |
| `feedback-wind-down-backlog-consolidation.md`       | YES (light)            | references `wiki/backlog.md` + `feedback-self-sufficient-notes.md` (DROPPED — inline-summarized) |

The 5 newly-restored memories all encode disciplines that are load-bearing for the plugin's marquee feature: **multi-instance coordination via Agent Teams**. The auditor's verbatim observation: _"the drop reasoning ('Nick-specific multi-instance workflow') is exactly inverted: the plugin IS a multi-instance workflow."_ Restored.

The 4 wind-down memories were originally dropped at Phase 0 audit time on the rationale "original-user wind-down ritual" (project-scoped). Per `decisions/phase-5.md` Decision C, that drop decision is reversed on broader-context grounds: the discipline is demonstrably generic Claude Code workflow (tier selection, ordering, teardown gating, backlog scan all generalize); the original-user anchors are writing artifact, anonymizable without losing operational substance. Two of the four (`feedback-tiered-wind-down`, `feedback-wind-down-backlog-consolidation`) post-date the Phase 0 audit and were never triaged.

## Anonymization rules (applied uniformly)

A grep-rule script runs in CI on every commit + before bundling, blocking matches. **Expanded per KS-2 to cover all observed substrate-leak vectors:**

### Pattern blocklist

- **Personal names:** `nick`, `Nick`, `nbruzzi` (case-insensitive)
- **User-specific paths:**
  - `/Users/nbruzzi`
  - `~/.claude-dotfiles`, `claude-dotfiles`
  - `~/.claude/` (general user-config paths — replace with `<plugin-root>/` or generic phrasing)
  - `~/Documents/Obsidian Vault`, `Documents/Obsidian Vault`, `Obsidian Vault`
- **GitHub PR/issue numbers in body context:** `PR #\d+`, `#\d+ ` (in load-bearing positions; bibliographic refs in CHANGELOG/decisions are exempt)
- **Substrate-specific names:** `claude-dotfiles`, `vault auto-sync`, `dotfiles-sync`, `vault-sync`, `vault-commit`, `dotfiles-commit`, `Obsidian` (when naming a specific vault)
- **Domain-specific names:** `HeatPrice`, `HeatPrice.com`, `NewEnglandOil`, `MEMA`, `EMARI` (NE-heating-oil project domain)
- **Specific commit SHAs in body:** `[a-f0-9]{7,40}` (commit-hash literals — replace with phrasing like "a referenced commit"; exempt in CHANGELOG/decisions where SHAs are bibliographic)
- **Date-specific incident anchors as load-bearing references:** `2026-04-2[0-9]`, `2026-04-1[5-9]` followed by an incident description in the body. Allowed in `updated:` frontmatter; not in body as the load-bearing example.
- **Originating-session IDs:** `originSessionId:` frontmatter field. Strip uniformly during bundling — not relevant outside the source substrate.
- **Obsidian wikilinks:** `\[\[[A-Z][^\]]+\]\]` (Obsidian-style cross-references like `[[Detector Validation]]`, `[[Monitoring Outside Context]]`). The vault these point to does not ship with the plugin; rewrite to inline summary or omit.
- **NATO+role peer names:** `Alpha`, `Bravo`, `Charlie`, `Delta`, `Echo`, `Foxtrot`, `Golf`, `Hotel`, `India`, `Juliet`, `Kilo`, `Lima`, `Mike` when used as peer-session identifiers in body text. The convention is generic (and ships in the plugin), but specific-named-peer references are session-historic; rewrite to `Session A` / `Session B` / `peer session` etc.

### Body rewrite mappings

When the patterns above appear in body text, rewrite per these mappings:

- "Nick" / "the user" → "the capturing user" or "the operating user"
- "PR #42" / "PR #29" / specific PR refs → "a multi-phase PR" or "the in-flight PR"
- "vault auto-sync" → "an integration sync"
- "claude-dotfiles" → "the user's substrate repo" or "the host substrate"
- "Obsidian Vault" → "an external knowledge base" or omitted
- `[[Detector Validation]]`, `[[Monitoring Outside Context]]` → inline-summarize the linked concept in 1-2 sentences (the wiki those point to does not ship)
- `~/.claude/feedback-events.jsonl` → "the plugin's feedback-event log"
- `Bravo`, `Charlie` (as peer names in body) → "Session B", "Session C" or "peer session"
- Specific commit SHAs → "a referenced commit" or omit when context tolerates
- `originSessionId:` → strip from frontmatter

## Cross-reference graph audit (per ARCH-2 / KS-4)

For each in-scope memory's outbound references — including markdown links `[text](path)`, **Obsidian wikilinks `[[Concept]]`**, and **named-without-link references** (e.g., "see audit-skill", "see project-memory-system-redesign.md"):

| Source                                              | Outbound references                                                                                                                                                          | Per-link decision                                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedback-confidence-as-verification-output.md`     | (none direct; mentions deployment-note miss inline)                                                                                                                          | Inline-rewrite the deployment-note example to a generic substrate-claim-vs-substrate-reality framing.                                                                                                                                 |
| `feedback-encode-while-context-fresh.md`            | (none direct; references audit-skill update inline)                                                                                                                          | Inline-rewrite to generic same-session-encoding example.                                                                                                                                                                              |
| `feedback-plan-mode-for-structural-changes.md`      | references CLAUDE.md verbatim                                                                                                                                                | Replace external CLAUDE.md ref with plugin-internal CONTRIBUTING.md ref (the plugin's branching/plan-mode rule lives there).                                                                                                          |
| `feedback-self-apply-ceiling-discipline.md`         | references `feedback-confidence-as-verification-output.md` (bundled)                                                                                                         | Keep — both bundled.                                                                                                                                                                                                                  |
| `feedback-sibling-parity-at-merge-time.md`          | references PR #42 + Step 1.5 audit-skill section                                                                                                                             | Inline-rewrite incident to generic; preserve audit-skill Step 1.5 reference (Step 1.5 ships in plugin).                                                                                                                               |
| `feedback-design-vs-autonomous-runtime.md`          | references `feedback-confidence-as-verification-output.md` (bundled)                                                                                                         | Keep — both bundled.                                                                                                                                                                                                                  |
| `feedback-think-holistically-not-reactively.md`     | references `feedback-confidence-as-verification-output.md` + parallel-session work                                                                                           | Keep first ref; inline-rewrite second to generic.                                                                                                                                                                                     |
| `feedback-no-known-gaps.md`                         | (none)                                                                                                                                                                       | None.                                                                                                                                                                                                                                 |
| `feedback-phased-audit-remediation-arc.md`          | references multi-persona-audit-pattern (bundled) + PR #42 phases                                                                                                             | Keep first; inline-rewrite second to generic phase-arc example.                                                                                                                                                                       |
| `feedback-partial-v2-anticipation-primitives.md`    | references vault/dotfiles trio + sync-common.ts                                                                                                                              | Inline-rewrite to generic primitive-lift example; preserve concept name (sync-common-style primitives lift).                                                                                                                          |
| `multi-persona-audit-pattern.md`                    | references many bundled memories + audit-skill                                                                                                                               | Keep bundled refs; inline-rewrite specific-incident anchors to generic; preserve audit-skill ref (skill ships in plugin).                                                                                                             |
| `feedback-prefer-single-bash-over-compound.md`      | (none direct; references vault path + dotfiles inline)                                                                                                                       | Inline-rewrite vault-path example to generic spaces-in-paths-trigger-permission-prompt example.                                                                                                                                       |
| `feedback-memorialize-then-violate-anti-pattern.md` | references multiple bundled memories                                                                                                                                         | Keep refs; inline-rewrite session-specific examples to generic.                                                                                                                                                                       |
| `feedback-merge-commit-across-instances.md`         | named ref: `src/todos/cli.ts`; PR #1 + commit SHAs `d8b7911` / `b612348` / `ff2bdbd` / `ab5803b`                                                                             | Replace `src/todos/cli.ts` with generic "the plugin's todo store"; inline-rewrite SHAs to "referenced commits"; rewrite PR #1 incident to a generic example.                                                                          |
| `feedback-validate-detector-before-behavior.md`     | wikilink `[[Detector Validation]]`; named ref: `project-memory-system-redesign.md` "Pilot #8"; `~/.claude/` log path                                                         | Inline-summarize `[[Detector Validation]]` in 1-2 sentences (omit wikilink); strip the project-memory-system-redesign+Pilot-#8 ref; rewrite log path to generic.                                                                      |
| `feedback-self-monitoring-is-architectural.md`      | wikilink `[[Monitoring Outside Context]]`; named ref: SESSION_LOG, dotfiles-sync hook, "instructions vs enforcement thesis" memory                                           | Inline-summarize `[[Monitoring Outside Context]]`; rewrite SESSION_LOG + dotfiles-sync to generic "skill-step that writes and verifies via the same path"; if "instructions vs enforcement" memory ships, keep ref; otherwise inline. |
| `feedback-surface-merge-decisions.md`               | references PR #29 + 2026-04-18 incident                                                                                                                                      | Inline-rewrite PR #29 + date to a generic merge-to-main strategy decision example.                                                                                                                                                    |
| `feedback-convergent-instances.md`                  | named refs: `feedback-merge-commit-across-instances.md` (bundled), `inter-window-coordination`, `HeatPrice.com`, `auto-format.ts`, channel `2026-04-21_00-09`, "Session A/B" | Keep first ref (bundled); inline-rewrite the inter-window-coordination + HeatPrice.com + auto-format.ts incident to generic; rewrite channel ID to generic; keep "Session A/B" framing (already anonymized).                          |

**No bundled memory ships with a dangling link** post-rewrite. The validation gate (below) executes a script that resolves every remaining `[link](*.md)` in the bundle against the bundle's own file list; CI fails if any link 404s.

### Treatment of named-without-link references

Some references in the source memories are named without a markdown link (e.g., "see audit-skill" or "the multi-persona-audit-pattern memory"). The auditor's KS-4 finding flagged these as a missing dimension of the cross-ref audit. Treatment:

- **Named ref to a bundled artifact (skill, memory, agent the plugin ships):** keep the ref; optionally formalize as a markdown link if the target has a stable path inside the plugin.
- **Named ref to a non-bundled artifact (project-specific memory, vault note, external doc):** rewrite to inline summary or strip — the named ref will not resolve outside the source substrate.

The validation gate covers this: step 6's resolver checks both `[link](*.md)` and any reference that names a file by path (the rg pattern catches `\.md` literals in body text).

## Per-memory anchor list (load-bearing rewrites)

The most load-bearing rewrites — the ones where the memory's explanatory power depends on the specific anchor — are flagged here for the audit. Other anchors are mechanical regex replacements.

### `feedback-self-apply-ceiling-discipline.md`

Heaviest rewrite. The memory contains 8+ "Nick" mentions, several of them in the **Why** section as the load-bearing example. The Why section quotes the user verbatim multiple times. Rewrite challenge: preserve the discipline's force without the verbatim quote.

**Before (load-bearing example):**

> _"Nick 2026-04-25, after I told him to press Shift+Tab to enter plan mode for Item 3: 'little things like this, you need to start taking out of my hands. I need to be able to step away while knowing you are holding yourself up to the ceiling. Also, you're relying on me which just adds more unnecessariness.'"_

**Proposed after:**

> The capturing user, on the day this memory was filed: _"Take little things out of my hands. I need to be able to step away while knowing you are holding yourself up to the ceiling. Relying on me adds unnecessariness."_ The framing of "holding yourself up to the ceiling" is the load-bearing phrase — the ceiling is the assistant's to hold, not the user's.

The rewrite preserves the conceptual load (autonomous ceiling, step-away trust) while removing the personally-identifying anchor.

### `feedback-plan-mode-for-structural-changes.md`

Second-heaviest. The Why section quotes the user verbatim with a specific 2026-04-25 incident. The body cites CLAUDE.md verbatim — but the plugin doesn't ship CLAUDE.md; it ships CONTRIBUTING.md.

**Before (CLAUDE.md anchor + verbatim incident):**

> CLAUDE.md states the rule explicitly:
>
> > **Planning rules:** A complex task is anything involving more than one file...
>
> _"Nick 2026-04-25, after I committed an audit-skill structural change directly to main without prompting plan mode: 'This wasn't worth planning out? Not mad, just curious / wanting to remind if need be.'"_

**Proposed after:**

> The plugin's CONTRIBUTING.md states the rule explicitly:
>
> > **Planning rules:** A complex task is anything involving more than one file, a new feature, a bug fix, or anything that could go wrong.
>
> The capturing user, after a structural skill change was committed without entering plan mode first: _"This wasn't worth planning out?"_ — direct acknowledgment that the gate is too permissive. The same session contained a second violation of the same rule, evidence the gate isn't firing reliably by default.

The rewrite anchors the rule to the plugin's own CONTRIBUTING.md (which ships) instead of the upstream CLAUDE.md (which doesn't), and rewrites the verbatim incident to attributed paraphrase.

### `feedback-encode-while-context-fresh.md`

Light rewrite at the body level (the example references audit-skill update — that ships in the plugin), but the Why section has a verbatim user quote that needs attribution rewrite.

**Before:**

> _"Nick 2026-04-25, on the choice of doing the audit-skill sibling-parity update in the Phase 7 session vs deferring: 'I like this mentality' in response to 'Doing it now means encoding it while the receipt is in hand.'"_

**Proposed after:**

> The capturing user, on the choice of doing an audit-skill update in the same session as the lesson that motivated it (vs deferring): _"I like this mentality."_ The receipt-in-hand framing is the rule — encode while the substrate, the failure mode, and the fix are all in active context.

Preserves the discipline's force (receipt-in-hand framing as the heuristic) while removing the personally-identifying anchor and the specific Phase-7 session reference.

### `feedback-sibling-parity-at-merge-time.md`

References PR #42 and the vault auto-sync arc as the load-bearing example. Rewrite to a generic "feature PR sat open while main moved with sibling-pattern changes" framing without the PR number or substrate name. The pattern's force is the lens issue (diff-vs-base misses sibling drift), not the specific incident.

### `multi-persona-audit-pattern.md`

Umbrella memory. The body references many specific incidents. Rewrite each anchor to generic; preserve the discipline (3+ personas, scope-driven scaling, hard cap 5–6, terminal full-diff audit, Step 1.5 sibling-symmetry pre-flight, bounded verification rounds with hard cap 3).

### `feedback-merge-commit-across-instances.md`

Multi-instance memory. The Why section anchors on the TimesFM ingest (PR #1, commit `d8b7911`) and lists three other artifact-naming SHAs. Rewrite the example to a generic "PR landed via merge commit specifically because three other artifacts named SHAs on this branch" framing. Preserve the load-bearing list of SHA-reference channels (todo bodies, handoff git-state, channel messages, peer memory) — that list IS the discipline.

### `feedback-validate-detector-before-behavior.md`

Detector-validation memory. Body anchors on the 2026-04-19 `diff-prose-3-plus-lines` rule firing 33x in 7d, and the regex `/^[+-] /`. The 4-step protocol is generic; the example needs full rewrite to a generic "feedback-rule fired ≥5x but flagged behavior felt aligned with intent" framing. Wikilink `[[Detector Validation]]` inline-summarized in 1-2 sentences (the protocol expansion). Strip "Pilot #8 in `project-memory-system-redesign.md`" entirely.

### `feedback-self-monitoring-is-architectural.md`

Self-monitoring memory. The Why section quotes the user verbatim with a 2026-04-16 incident about SESSION_LOG and dotfiles-sync hooks. Rewrite the example to a generic "skill-step that writes and verifies via the same path will fail the same way in both directions" framing. Wikilink `[[Monitoring Outside Context]]` inline-summarized. The "instructions vs enforcement thesis" reference: keep if that memory ships in the plugin (review during sub-step 0.6); otherwise inline.

### `feedback-convergent-instances.md`

Convergent-instances memory. Body anchors on multiple specific incidents: 2026-04-19 `auto-format.ts` byte-identical fix between `inter-window-coordination` and `HeatPrice.com`, channel `2026-04-21_00-09` Round 1/2/3/4 reflection, and the uuidgen+CLAUDE_SESSION_ID convention. Rewrite to generic Session-A/Session-B framing throughout. The counter-case (convergent hallucination on shared faulty prior) is load-bearing — preserve the framing verbatim, anonymize the specific incident anchor.

### `feedback-signoff-checklist.md`

Wind-down checklist discipline (Phase 5 Decision C reversal of Phase 0 drop). Body anchors on the operating user's verbatim framing ("I will never simply just 'handoff' ('signoff...'). I will always work through the checklist and cover all bases / make sure everything is accounted for"). Operational core preserved: every repo / commit / sync / backlog reconciled before handoff fires. Verbatim quote rewritten as "the operating user's framing: never simply 'handoff' ('signoff...'); always work through the checklist and cover all bases" — discipline survives anonymization (per Bravo KS audit: discipline IS generic; anchors are writing artifact).

### `feedback-wind-down-ordering.md`

Three composing wind-down rules (Phase 5 Decision C reversal of Phase 0 drop). Body anchors on the rtk-ingest 2026-05-03 incident as Rule 3 evidence + the operating user's verbatim observation about premature Monitor teardown. Rule 1 + Rule 2 + Rule 3 framings + their composed sequences (DEFAULT 5-step + EXCEPTION 6-step) preserved verbatim — they ARE the operational rule. Incident anchor rewritten generically: "an instance proactively shut down peer-coordination infrastructure mid-session, losing peer events that would otherwise have arrived during the deferred-item work." Cross-reference to `feedback-efficiency-without-compromise.md` (DROPPED per Phase 0) inline-summarized as "the efficiency-without-compromise principle (optimize aggressively, but never at the cost of having to undo work)."

### Mechanical rewrites (lower load-bearing)

For the remaining 11 in-scope memories: anchors get mechanical regex replacement per the rules above. Specific verbatim quotes from the user replaced with attributed-but-anonymized phrasing ("the capturing user" + paraphrase). Date stamps in body stay (they document when the lesson was captured); date stamps as load-bearing references get rewritten. The 2 newer wind-down memories (`feedback-tiered-wind-down`, `feedback-wind-down-backlog-consolidation`) post-date Phase 0 audit and have lighter anchoring — mechanical rewrite is sufficient (no LOAD-BEARING ### block needed).

## Frontmatter rewrites

Every bundled memory file gets:

```yaml
---
name: <preserved>
description: <rewritten if it contains personally-identifying anchors>
type: feedback
cadence: stable # V2 schema vocabulary; declares stale-detection exempt
scope: global # V2 schema; applies to any Claude instance using the plugin
updated: 2026-04-25 # frozen at extraction; revalidates on plugin major version bump
origin: extracted # plugin extension to V2 schema; declares "extracted from upstream substrate, specific incident details rewritten for plugin use"
---
```

**Schema vocabulary notes (per KS-7):**

- `cadence: stable` — V2 schema's vocabulary for memories whose underlying lesson does not decay with time. Use `stable`, not `durable` (the latter is not a V2 vocabulary value).
- `origin: extracted` — plugin extension to V2 schema. The base V2 schema does not define `origin`; the plugin introduces it to declare provenance for cross-substrate-extracted memories. Documented in plugin INDEX.md so future extractions converge on the same field name.

**Strip on bundling:**

- `originSessionId:` — present in many source memories; not relevant outside the source substrate. Strip uniformly during the rewrite; the validation gate's grep catches any survivors.

## Validation gate (executable commands)

Before sub-step 0.6 writes the actual `memories/*.md` files:

1. **Mini-Knowledge-System audit on this document** — round 1 complete (6.5/10, 7 findings).
2. **Audit findings integrated** — this revision.
3. **Verification round** — bounded with hard cap 3 per audit-skill discipline; dispatched to a single Knowledge-System verifier.
4. **Sub-step 0.6 then writes the rewritten files** using this document as the rewrite spec.
5. **CI re-validates anonymization via the canonical bash+grep gate.** The plugin's actual CI gate is `scripts/check-generic-paths.sh` (wired into `.github/workflows/test.yml` via `bun run check-generic-paths`). It scans P1 (nbruzzi), P2 (/Users/<name>/), P3 (\.claude/), and P4 (7-40 char hex strings with FP-class exclusion for substring matches inside lowercase words and backtick-quoted intentional references). Run locally:

   ```bash
   bun run check-generic-paths
   ```

   Expected output: `check-generic-paths: clean (0 violations across N tracked files)`. Any compiler-style `error[P*]:` line emitted to stderr is a violation. CI fails the build with the offending file list + line numbers.

   **Allowlists** (in script body, not separate doc): top-level docs (`CHANGELOG.md`, `CONTRIBUTING.md`, `README.md`, `INDEX.md`, `SECURITY.md`, `LICENSE`), extraction working docs (`agents-to-bundle.md`, `memories-to-bundle.md`, `extraction-manifest.md`), `decisions/`, `docs/`, and `audits/` are excluded via Layer 1 pathspec. The P3 file-allowlist enumerates 12 plugin files with legitimate `\.claude/` references; new entrants either route through `paths.ts` or join the allowlist with rationale. P4 is suppressed in markdown (documentation), test fixtures, CI workflows, and `scripts/smoke-*.sh` (synthetic test SIDs).

6. **Cross-reference graph re-validates: every outbound `[link](*.md)` resolves in `<plugin-root>/memories/`.** Executable command:

   ```bash
   # Extract every [text](*.md) link from memories/, resolve target against bundle's own file list.
   rg -o --no-filename --pcre2 '\]\(([^)]+\.md)\)' -r '$1' memories/ \
     | sort -u \
     | while read -r target; do
         test -f "memories/${target}" || echo "DANGLING: ${target}"
       done
   ```

   Expected output: empty. Any "DANGLING:" line is a broken cross-link and CI fails. The check resolves links relative to `memories/` (the bundle's directory); links that escape to `../` or other paths are flagged automatically (those files won't exist relative to `memories/`).

   **Wikilink validation:** the rg pattern in step 5 catches `[[...]]` Obsidian wikilinks; if any survive, they fail step 5, not step 6. Step 6 only validates resolvable `[text](path)` markdown links.

Failure at step 5 or step 6 blocks sub-step 0.6 entry per the parent plan's audit-gate discipline.

## Open questions

- **`updated:` frozen-at-extraction interpretation:** "frozen" means the timestamp doesn't auto-revalidate when the plugin version bumps; consumers should treat it as the lesson-capture date, not a current-validity claim. Per V2 schema's `cadence: stable` declaration, no automated stale-detection on these files. If the underlying lesson genuinely becomes wrong (rare for stable disciplines), a major plugin version bump rewrites the affected memories.
- **Future bundling pass scope (KS-5):** memories listed under "Drop — generic; reconsider in a future bundling pass" (subagent-distance, verify-end-to-end, work-to-understand, check-existing-before-building) might be load-bearing in real plugin use. Sub-step at v0.5 release-candidate (Phase 5+) revisits the scope filter. **Trigger criteria:**
  - Two or more issue reports / discussion threads against the plugin reference one of these disciplines.
  - The plugin's own usage telemetry (if landed) shows recurring patterns the deferred-generic memory addresses.
  - A new feature in the plugin makes the deferred-generic memory load-bearing for that feature's discipline.
    Filed in `wiki/backlog.md` under `## Plugin V0.5+ retrospective` for tracking.
- **`origin: extracted` as V2 schema extension:** the plugin introduces this field; the base V2 schema does not define it. Two paths forward: (a) propose to upstream V2 schema; (b) document as plugin-local extension only. Decision deferred to plugin v0.5 when V2 schema may have stabilized.
- **Originating-context preservation:** the discipline of "lesson captured 2026-04-XX in context of [incident]" has provenance value. Per the rewrites, specific incidents get genericized but the lesson-capture date stays. If an auditor or future user needs to trace the original capture for verification, the upstream substrate's git history provides the provenance — not bundled with the plugin.

## Round-1 audit findings → resolution map

| Finding ID      | Severity | Resolution                                                                                                                                                                                                                   |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KS-1            | critical | 5 multi-instance/architectural memories restored to in-scope (merge-commit-across-instances, validate-detector, self-monitoring-architectural, surface-merge-decisions, convergent-instances). Scope-filter wording updated. |
| KS-2            | major    | Anonymization rules expanded with `originSessionId`, Obsidian wikilinks, NATO peer names, `~/.claude/` paths, commit SHAs.                                                                                                   |
| KS-4            | major    | Cross-reference table expanded with 5 new memories' references (wikilinks + named-without-link); explicit treatment section added for named refs.                                                                            |
| Validation gate | major    | Step 5 + step 6 specified with executable rg commands; allowlist documented.                                                                                                                                                 |
| KS-5            | minor    | Future-bundling trigger criteria added to Open Questions; backlog entry filed in `wiki/backlog.md` under "Plugin V0.5+ retrospective".                                                                                       |
| KS-6            | minor    | Per-memory anchor list expanded with explicit before/after blocks for `feedback-plan-mode-for-structural-changes.md` and `feedback-encode-while-context-fresh.md`.                                                           |
| KS-7            | minor    | Frontmatter spec uses `cadence: stable` (V2 vocabulary, not `durable`); `origin: extracted` documented as plugin-extension to V2 schema.                                                                                     |
