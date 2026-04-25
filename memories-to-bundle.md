<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Memories to Bundle

**Phase 0 sub-step 0.3 deliverable.** Anonymization rewrite plan for cross-session feedback memories shipped with the plugin under `<plugin-root>/memories/`. Per parent plan KS-1 + KS-2 + the audit gate.

**Audit gate:** mini-Knowledge-System audit on this document before sub-step 0.6 (file extraction) writes the actual `memories/*.md` files. Findings integrated; verification round per audit-skill discipline.

**Status:** DRAFT (awaiting mini-audit).

## Scope filter

The plugin's audience is **future-Claude + peer Claudes coordinating via Anthropic's Agent Teams**, not the original capturing user's personal setup. Memory selection criteria:

- **In-scope:** captures a cross-session pattern that generalizes to any Claude instance using the plugin (audit discipline, plan-mode triggers, branching rules, autonomous-action shape, verification disciplines, audit-rounds bounded-cap, etc.).
- **Drop (project-specific):** contains personally-identifying anchors as load-bearing references (the user's name, a specific repo, a specific incident as the key example, a specific tool that's not the plugin's).
- **Drop (substrate-specific):** about a particular workflow or substrate that doesn't generalize (vault, dotfiles auto-sync trios, HeatPrice domain, Sentinel jobs).

## Scope decisions

### Drop entirely (project-specific or substrate-specific)

These exist in the source pool but do NOT bundle into the plugin:

- `feedback-audit-in-nicks-place.md` — explicitly references the original user by name as part of the discipline name.
- `feedback-nick-words-are-literal.md` — same.
- `feedback-feed-the-wiki.md` — vault-specific.
- `feedback-wiki-verify-before-acting.md` — vault-specific.
- `feedback-direct-and-advise.md` — about the original user's communication preferences specifically.
- `feedback-self-sufficient-notes.md` — vault note-taking discipline, not coordination.
- `feedback-ship-checkin.md` — communication preference with the original user.
- `feedback-response-length.md` — communication preference.
- `feedback-minimal-output.md` — communication preference.
- `feedback-signoff-checklist.md` — Nick-specific wind-down ritual.
- `feedback-wind-down-ordering.md` — same.
- `feedback-feed-the-wiki.md` (already listed).
- `feedback-validate-detector-before-behavior.md` — Nick-specific detector incident; pattern is generalizable but the memory is anchored too tightly.
- `feedback-self-monitoring-is-architectural.md` — same.
- `feedback-merge-commit-across-instances.md` — Nick-specific multi-instance workflow.
- `feedback-surface-merge-decisions.md` — same.
- `feedback-commit-trailer-attribution.md` — Nick-specific trailer convention.
- `feedback-always-push.md` — Nick-specific commit-push discipline.
- `feedback-check-existing-before-building.md` — generic but the body anchors heavily on Nick's substrate.
- `feedback-convergent-instances.md` — Nick-specific multi-instance observation.
- `feedback-subagent-distance-as-default.md` — generic; reconsider in a future bundling pass.
- `feedback-verify-end-to-end.md` — generic; reconsider in a future bundling pass.
- `feedback-work-to-understand.md` — generic; reconsider in a future bundling pass.
- All `project-*.md` files (project-vault-auto-sync, project-claude-conductor, project-memory-system-redesign, etc.) — explicitly project-scoped.

A future bundling pass (post-Phase-0) can reconsider the deferred-generic ones if they show up as load-bearing in plugin usage. For Phase 0, conservative scope.

### In-scope (anonymize + bundle)

These bundle into `<plugin-root>/memories/` after anonymization rewrite:

| Source memory                                       | Anonymization required | Cross-references                                                |
| --------------------------------------------------- | ---------------------- | --------------------------------------------------------------- |
| `feedback-confidence-as-verification-output.md`     | YES                    | references the deployment-note miss + parent-doc                |
| `feedback-encode-while-context-fresh.md`            | YES                    | references audit-skill-update incident                          |
| `feedback-plan-mode-for-structural-changes.md`      | YES                    | references audit-skill structural-change incident               |
| `feedback-self-apply-ceiling-discipline.md`         | YES (heaviest)         | references multiple Nick interactions verbatim                  |
| `feedback-sibling-parity-at-merge-time.md`          | YES                    | references PR #42 and the vault auto-sync arc                   |
| `feedback-design-vs-autonomous-runtime.md`          | YES                    | references parallel-session work + Nick verbatim                |
| `feedback-think-holistically-not-reactively.md`     | YES                    | references the parallel-session work + ecosystem-research pivot |
| `feedback-no-known-gaps.md`                         | NO (already clean)     | minimal cross-refs; bundle as-is                                |
| `feedback-phased-audit-remediation-arc.md`          | YES                    | references PR #42 phases verbatim                               |
| `feedback-partial-v2-anticipation-primitives.md`    | YES                    | references vault/dotfiles trio specifically                     |
| `multi-persona-audit-pattern.md`                    | YES                    | umbrella memory; references many specific incidents             |
| `feedback-prefer-single-bash-over-compound.md`      | YES                    | references vault path + dotfiles substrate                      |
| `feedback-memorialize-then-violate-anti-pattern.md` | YES                    | references the within-session violations specifically           |

## Anonymization rules (applied uniformly)

A grep-rule script runs in CI on every commit + before bundling, blocking matches:

- **Personal names:** `nick`, `Nick`, `nbruzzi` (case-insensitive)
- **User-specific paths:** `/Users/nbruzzi`, `~/.claude-dotfiles`, `Documents/Obsidian Vault`, `~/Documents/Obsidian Vault`
- **Specific GitHub PR/issue numbers:** `PR #\d+`, `#\d+ ` (in body context, not bibliographic refs)
- **Substrate-specific names:** `claude-dotfiles`, `vault auto-sync`, `dotfiles-sync`, `vault-sync`, `vault-commit`, `dotfiles-commit`, `Obsidian` (when naming a specific vault)
- **Domain-specific names:** `HeatPrice`, `NewEnglandOil`, `MEMA`, `EMARI` (NE-heating-oil project domain)
- **Date-specific incident anchors as load-bearing references:** `2026-04-2[0-9]` followed by an incident description in the body (allowed in `updated:` frontmatter; not in body as the load-bearing example).

Body rewrites replace these with neutral equivalents:

- "Nick" / "the user" → "the capturing user" or "the operating user"
- "PR #42" → "a multi-phase PR" or "the in-flight PR"
- "vault auto-sync" → "an integration sync"
- "claude-dotfiles" → "the user's substrate repo" or "the host substrate"
- "Obsidian Vault" → "an external knowledge base" or omitted

## Cross-reference graph audit (per ARCH-2 / KS-4)

For each in-scope memory's outbound `[link](other-memory.md)` references:

| Source                                              | Outbound links                                                                     | Per-link decision                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `feedback-confidence-as-verification-output.md`     | (none direct; mentions the deployment-note miss inline)                            | Inline-rewrite the deployment-note example to a generic substrate-claim-vs-substrate-reality framing.        |
| `feedback-encode-while-context-fresh.md`            | (none direct; references audit-skill update inline)                                | Inline-rewrite to generic same-session-encoding example.                                                     |
| `feedback-plan-mode-for-structural-changes.md`      | references CLAUDE.md branching rule (external doc)                                 | Replace external CLAUDE.md ref with plugin-internal CONTRIBUTING.md ref.                                     |
| `feedback-self-apply-ceiling-discipline.md`         | references `feedback-confidence-as-verification-output.md` (bundled)               | Keep — both bundled.                                                                                         |
| `feedback-sibling-parity-at-merge-time.md`          | references PR #42 + Step 1.5 audit-skill section                                   | Inline-rewrite incident to generic; preserve audit-skill Step 1.5 reference (Step 1.5 ships in plugin).      |
| `feedback-design-vs-autonomous-runtime.md`          | references `feedback-confidence-as-verification-output.md` (bundled)               | Keep — both bundled.                                                                                         |
| `feedback-think-holistically-not-reactively.md`     | references `feedback-confidence-as-verification-output.md` + parallel-session work | Keep first ref; inline-rewrite second to generic.                                                            |
| `feedback-no-known-gaps.md`                         | (none)                                                                             | None.                                                                                                        |
| `feedback-phased-audit-remediation-arc.md`          | references multi-persona-audit-pattern (bundled) + PR #42 phases                   | Keep first; inline-rewrite second to generic phase-arc example.                                              |
| `feedback-partial-v2-anticipation-primitives.md`    | references vault/dotfiles trio + sync-common.ts                                    | Inline-rewrite to generic primitive-lift example; preserve concept name (sync-common-style primitives lift). |
| `multi-persona-audit-pattern.md`                    | references many bundled memories + audit-skill                                     | Keep bundled refs; inline-rewrite specific-incident anchors to generic.                                      |
| `feedback-prefer-single-bash-over-compound.md`      | (none direct; references vault path + dotfiles inline)                             | Inline-rewrite vault-path example to generic spaces-in-paths-trigger-permission-prompt example.              |
| `feedback-memorialize-then-violate-anti-pattern.md` | references multiple bundled memories                                               | Keep refs; inline-rewrite session-specific examples to generic.                                              |

**No bundled memory ships with a dangling link** post-rewrite. CI grep validates outbound link targets exist in the bundle.

## Per-memory anchor list (load-bearing rewrites)

The most load-bearing rewrites — the ones where the memory's explanatory power depends on the specific anchor — are flagged here for the audit. Other anchors are mechanical regex replacements.

### `feedback-self-apply-ceiling-discipline.md`

Heaviest rewrite. The memory contains 8+ "Nick" mentions, several of them in the **Why** section as the load-bearing example. The Why section quotes the user verbatim multiple times. Rewrite challenge: preserve the discipline's force without the verbatim quote.

**Before (load-bearing example):**

> _"Nick 2026-04-25, after I told him to press Shift+Tab to enter plan mode for Item 3: 'little things like this, you need to start taking out of my hands. I need to be able to step away while knowing you are holding yourself up to the ceiling. Also, you're relying on me which just adds more unnecessariness.'"_

**Proposed after:**

> The capturing user, on the day this memory was filed: _"Take little things out of my hands. I need to be able to step away while knowing you are holding yourself up to the ceiling. Relying on me adds unnecessariness."_ The framing of "holding yourself up to the ceiling" is the load-bearing phrase — the ceiling is the assistant's to hold, not the user's.

The rewrite preserves the conceptual load (autonomous ceiling, step-away trust) while removing the personally-identifying anchor.

### `feedback-sibling-parity-at-merge-time.md`

References PR #42 and the vault auto-sync arc as the load-bearing example. Rewrite to a generic "feature PR sat open while main moved with sibling-pattern changes" framing without the PR number or substrate name. The pattern's force is the lens issue (diff-vs-base misses sibling drift), not the specific incident.

### `multi-persona-audit-pattern.md`

Umbrella memory. The body references many specific incidents. Rewrite each anchor to generic; preserve the discipline (3+ personas, scope-driven scaling, hard cap 5–6, terminal full-diff audit, Step 1.5 sibling-symmetry pre-flight, bounded verification rounds with hard cap 3).

### Mechanical rewrites (lower load-bearing)

For the other 9 in-scope memories: anchors get mechanical regex replacement per the rules above. Specific verbatim quotes from the user replaced with attributed-but-anonymized phrasing ("the capturing user" + paraphrase). Date stamps in body stay (they document when the lesson was captured); date stamps as load-bearing references get rewritten.

## Frontmatter rewrites

Every bundled memory file gets:

```yaml
---
name: <preserved>
description: <rewritten if it contains personally-identifying anchors>
type: feedback
cadence: durable # added — V2 schema; declares stale-detection exempt
scope: global # added — V2 schema; applies to any Claude instance using the plugin
updated: 2026-04-25 # frozen at extraction; revalidates on plugin version bump
origin: extracted from upstream substrate; specific incident details rewritten for plugin use
---
```

Removes any `originSessionId:` field if present (not relevant outside the source substrate).

## Validation gate

Before sub-step 0.6 writes the actual `memories/*.md` files:

1. Mini-Knowledge-System audit on this document.
2. Audit findings integrated.
3. Verification round (bounded 1 round; up to 3 if substantively changed surface).
4. Sub-step 0.6 then writes the rewritten files using this document as the rewrite spec.
5. CI grep on the written files re-validates: zero matches for `nick|nbruzzi|/Users/|claude-dotfiles|Obsidian|HeatPrice` outside CONTRIBUTING/CHANGELOG/decisions/audits.
6. Cross-reference graph re-validates: every outbound `[link]` resolves in `<plugin-root>/memories/`.

Failure at any step blocks sub-step 0.6 entry per the parent plan's audit-gate discipline.

## Open questions

- **`updated:` frozen-at-extraction interpretation:** "frozen" means the timestamp doesn't auto-revalidate when the plugin version bumps; consumers should treat it as the lesson-capture date, not a current-validity claim. Per V2 schema's `cadence: durable` declaration, no automated stale-detection on these files. If the underlying lesson genuinely becomes wrong (rare for durable disciplines), a major plugin version bump rewrites the affected memories.
- **Future bundling pass scope:** memories listed under "Drop — generic; reconsider in a future bundling pass" (subagent-distance, verify-end-to-end, work-to-understand) might be load-bearing in real plugin use. Sub-step at v0.5 release-candidate (Phase 5+) revisits the scope filter.
- **Originating-context preservation:** the discipline of "lesson captured 2026-04-XX in context of [incident]" has provenance value. Per the rewrites, specific incidents get genericized but the lesson-capture date stays. If an auditor or future user needs to trace the original capture for verification, the upstream substrate's git history provides the provenance — not bundled with the plugin.
