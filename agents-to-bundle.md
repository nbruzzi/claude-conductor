<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Agents to Bundle

**Phase 0 sub-step 0.3b deliverable.** Anonymization rewrite plan for agents shipped with the plugin under `<plugin-root>/agents/`. Per parent plan KS-1 + manifest audit's ARCH-4 finding (agent `context_sources` anonymization carved out as a separate deliverable from memory body anonymization).

**Audit gate:** mini-Architecture audit on this document before sub-step 0.6 (file extraction) writes the actual `agents/*.md` files. Verification round per audit-skill bounded-with-hard-cap-3 discipline.

**Status:** DRAFT (awaiting mini-Architecture audit).

## Scope filter

The plugin ships an auditor registry + 13 cold auditors + 4 familiar auditors + 2 generic agents (code-simplifier, verify-app). Agents are different from memories in two ways:

- **Cold auditors are domain-pure** (TypeScript expertise, security expertise, performance expertise, etc.). They have no `context_sources` field, no substrate references in body. They bundle as-is — no rewrite needed.
- **Familiar auditors carry `context_sources` + substrate-anchored expertise** in their frontmatter. They commission against the project's own context (wiki + memory files). For the plugin, "the project" is the plugin itself, not the upstream substrate. Familiars need frontmatter rewrite + body rewrite to anchor against `<plugin-root>` surfaces (memories/, decisions/, INDEX.md, CHANGELOG.md).

**Rule of thumb:** if the agent's adversarial lens generalizes to any plugin user's project but the current frontmatter anchors against the upstream substrate, **rewrite and bundle**. If the lens itself is substrate-thesis-specific (e.g., a domain-specific business thesis), **drop**.

## Scope decisions

### Drop entirely

- **`familiar/domain-business.md`** — entire agent is anchored on the HeatPrice two-stack thesis, dealer neutrality, NEO/FuelSnap/competitors, programmatic SEO for zip pages. The adversarial lens IS the business thesis; removing the thesis leaves no agent. The plugin's audience won't have this thesis. **Drop the file outright.** Plugin users with their own business-thesis can compose their own familiar agent (the auditor registry pattern supports this).

### Bundle as-is (no rewrite)

The 13 cold auditors are domain-pure and ship without modification:

| Agent file (under `agents/audit/cold/`) | Rationale                                                |
| --------------------------------------- | -------------------------------------------------------- |
| `accessibility-specialist.md`           | Pure accessibility expertise; no substrate refs.         |
| `api-designer.md`                       | Pure API contract expertise; no substrate refs.          |
| `cli-dx-engineer.md`                    | Pure CLI UX expertise; no substrate refs.                |
| `database-architect.md`                 | Pure database expertise; no substrate refs.              |
| `marketplace-operator.md`               | Pure marketplace-economics expertise; no substrate refs. |
| `nextjs-architect.md`                   | Pure Next.js expertise; no substrate refs.               |
| `performance-engineer.md`               | Pure performance expertise; no substrate refs.           |
| `reliability-engineer.md`               | Pure reliability expertise; no substrate refs.           |
| `security-engineer.md`                  | Pure security expertise; no substrate refs.              |
| `seo-geo-strategist.md`                 | Pure SEO/GEO expertise; no substrate refs.               |
| `test-architect.md`                     | Pure testing expertise; no substrate refs.               |
| `typescript-expert.md`                  | Pure TypeScript expertise; no substrate refs.            |
| `ux-flow-engineer.md`                   | Pure UX expertise; no substrate refs.                    |

The 2 generic agents also ship as-is:

| Agent file           | Rationale                                                     |
| -------------------- | ------------------------------------------------------------- |
| `code-simplifier.md` | Generic post-implementation cleanup agent; no substrate refs. |
| `verify-app.md`      | Generic end-to-end verification agent; no substrate refs.     |

### Bundle with anonymization rewrite

The 4 remaining familiar auditors + the registry get rewrite passes:

| Agent file                             | Rewrite scope | Notes                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `familiar/architecture-integration.md` | HEAVY         | `expertise` heavily anchored on dotfiles repo, sync pipeline, sentinel agent. Body references "nbruzzi/claude-dotfiles" verbatim. Adversarial lens is generic ("integration mismatches, parallel infrastructure") — preserved.                |
| `familiar/code-standards.md`           | LIGHT         | `expertise` is mostly generic TypeScript/Bun conventions. Single substrate ref via `context_sources.memory.ceiling-standard.md`.                                                                                                              |
| `familiar/knowledge-system.md`         | HEAVY         | `expertise` heavily anchored on Obsidian vault concepts (vault structure, .raw/, \_shelved/, graphify pipeline, MEMORY.md index). The discipline (knowledge-architecture-drift) is generic — preserved with plugin's own surfaces as anchors. |
| `familiar/workflow-process.md`         | LIGHT         | `expertise` is mostly generic pipeline + branching + commit-gate disciplines. Two substrate refs via `context_sources.memory.branching-rules.md` and `hooks-thesis.md`.                                                                       |
| `audit/registry.md`                    | LIGHT         | Two substrate refs: line 12 ("dotfiles, hooks, wiki, memory") and line 65 (architecture-integration trigger keywords include "dotfiles", "install", "allowlist"). Mechanical rewrite.                                                         |

## Anonymization rules (applied uniformly)

A grep-rule script runs in CI on every commit + before bundling, blocking matches.

### Pattern blocklist (reuses memories-to-bundle.md rules + agent-specific additions)

Inherited from `memories-to-bundle.md`:

- Personal names, user-specific paths, GitHub PR/issue numbers (load-bearing), substrate-specific names, domain-specific names, commit SHAs, date-specific incident anchors, `originSessionId:`, Obsidian wikilinks, NATO peer names.

Agent-specific additions:

- **`context_sources:` paths that point outside `<plugin-root>/`:** the plugin's familiars commission against the plugin's own context surfaces. Any path under `wiki/`, `domains/`, `meta/`, `~/Documents/Obsidian Vault/` is a substrate-leak.
- **`expertise:` items naming substrate-specific concepts:** "Dotfiles repo structure", "GitHub Actions sentinel", "Obsidian vault structure", "HeatPrice two-stack thesis", "Settings.json copy-not-symlink" (which is a dotfiles-substrate detail), "wiki/", `hot.md`, `graphify pipeline`, `.raw/`, `_shelved/`.
- **`triggers:` keywords that are substrate-specific:** `obsidian`, `vault`, `dotfiles`, `sentinel`, `allowlist`, `install`, `NEO`, `HeatPrice`, `FuelSnap` (the last two are already covered by domain-business drop).
- **`adversarial_lens:` containing substrate-specific thesis:** the domain-business lens IS the HeatPrice thesis (drop). Other lenses generalize after frontmatter cleanup.

### Body rewrite mappings (agent-specific)

- "nbruzzi/claude-dotfiles" → "the host project" or "the plugin consumer's project"
- "Obsidian vault" / "the wiki" → "the plugin's knowledge surfaces" or "the host project's documentation"
- "MEMORY.md index" → "the plugin's memory index (`<plugin-root>/memories/INDEX.md` or analogous)"
- "GitHub Actions sentinel" → "any CI verification job the host project runs"
- "Settings.json (copy not symlink)" → omit (dotfiles-specific implementation detail)
- "graphify pipeline" → omit (vault-specific)
- ".raw/ ingestion" / "\_shelved/" → omit (vault-specific)
- "hot cache pattern" → "the project's hot-context surface (e.g., `hot.md`, `INDEX.md`, or analogous)"
- "Sunday agent" / "sentinel cron" → omit (dotfiles-substrate-specific)

## Per-agent rewrite plan (load-bearing)

### `familiar/architecture-integration.md`

Heaviest familiar rewrite. The agent's adversarial lens — "Does this plan integrate correctly with our existing systems, or does it create parallel infrastructure that should use what already exists?" — is GENERIC and load-bearing. Preserved verbatim. The frontmatter `expertise` items, body paragraphs, and `context_sources` need rewrite.

**Frontmatter rewrites:**

```yaml
expertise:
  # Before:
  # - Dotfiles repo structure — sync pipeline, allowlist, install script, sentinel agent
  # - Cross-repo integration — dotfiles, HeatPrice, wiki, how they connect
  # - Auto-sync pipeline — PostToolUse copies + stages, SessionStart catch-up, Stop commits
  # - Settings.json management — security-critical, copy not symlink
  # - GitHub Actions sentinel — CI verification of dotfiles integrity
  # - Memory system architecture — project-scoped directories, MEMORY.md index
  # After:
  - The plugin's hook/dispatcher system and handler conventions
  - Agent and skill definitions — how the plugin extends Anthropic's Agent Teams
  - The auditor registry pattern — cold and familiar auditors, commissioning protocol
  - Cross-component integration within the plugin and between plugin and host project
  - The plugin's memory surface — `<plugin-root>/memories/` directory layout, INDEX.md
  - The plugin's decisions log — `<plugin-root>/decisions/` per-phase entries
  - CI verification patterns — typecheck/format/lint/test gates and their ordering

triggers:
  # Drop: dotfiles, install, allowlist, sentinel.
  # Keep: hook, dispatcher, sync, registry, agent, skill, handler, check, settings, infrastructure.
  # Add: plugin, memory-surface, audit-registry.

adversarial_lens: # unchanged — generic discipline.

context_sources:
  wiki:
    # Before: hot.md, index.md (vault paths)
    # After: <plugin-root>/INDEX.md (plugin's master catalog), <plugin-root>/CHANGELOG.md
    - INDEX.md
    - CHANGELOG.md
  memory:
    # Before: dotfiles-repo.md, hooks-self-governance.md, handoff-system.md
    # After: bundled plugin memories that anchor the discipline.
    - feedback-merge-commit-across-instances.md
    - feedback-self-monitoring-is-architectural.md
    - multi-persona-audit-pattern.md
```

**Body rewrites:** the "Project Context" placeholder section already says "(This section will be replaced at commission time with injected wiki/memory content)" — the commission protocol works the same way for the plugin. The "Your Expertise" paragraph references `nbruzzi/claude-dotfiles`, "auto-sync lifecycle", "PostToolUse hooks copy managed files and stage them", "allowlist in dotfiles-sync.ts", "Settings.json is copied (not symlinked)", "install.sh script". All substrate-specific. Rewrite to:

> You know how the plugin's pieces fit together: the plugin (`<plugin-root>/`) bundles a hook/dispatcher system, an auditor registry, a discipline-as-code memory surface, and skills that extend Anthropic's Agent Teams. The plugin's components — hooks, agents, skills, memories, decisions log — interact through documented contracts: the registry pattern for hook check registration, the commission protocol for familiar auditors, the audit-skill discipline for plan reviews. Drift looks like: building a one-off mechanism when the registry pattern already handles it, creating a parallel decisions-log surface when `decisions/<phase>.md` is the convention, forgetting to update INDEX.md when adding a new bundled artifact, or adding a new agent/skill that bypasses the audit registry's commissioning protocol.

The "Drift looks like" examples preserve the discipline's force (parallel-infrastructure, integration-completeness) without the dotfiles-substrate examples.

### `familiar/code-standards.md`

Light rewrite. The TypeScript conventions (`no-any`, `no-enum`, `prefer-type-over-interface`, strict-mode, error-handling-explicitness, Bun runtime, prettier+eslint) are generic and ship verbatim. The single substrate ref is `context_sources.memory.ceiling-standard.md` — already not bundled (ceiling-standard is generic but anchored on Nick's verbatim quote, hence dropped from memories per Phase 0 scope). Replace with bundled equivalents:

```yaml
context_sources:
  wiki:
    - INDEX.md
  memory:
    - feedback-self-apply-ceiling-discipline.md # bundled, generic ceiling discipline
    - feedback-confidence-as-verification-output.md # bundled
```

No body rewrite needed — the "code conventions" expertise is plugin-agnostic.

### `familiar/knowledge-system.md`

Heavy rewrite. The discipline ("knowledge-architecture-drift", "wiki convention violations", "misplaced knowledge") is generic and preserved as the adversarial lens. The frontmatter `expertise` items, however, are heavily anchored on the Obsidian vault.

**Frontmatter rewrites:**

```yaml
expertise:
  # Before:
  # - Wiki conventions — frontmatter schema, wikilinks, status values, three-layer architecture
  # - Memory patterns — entry types, when to save vs wiki, MEMORY.md index maintenance
  # - Backlog system — persistent action items, nudge behavior, staleness detection
  # - Cross-project referencing via CLAUDE.md and the hot cache pattern
  # - Obsidian vault structure — wiki root, domains/, meta/, _shelved/
  # - Feed-the-wiki discipline — actively evaluating everything shared for wiki value
  # - Information lifecycle — when knowledge is born, where it lives, when it moves, when it dies
  # - Graphify and ingestion pipeline — .raw/ conversion, wikilink connectivity
  # After:
  - The plugin's memory schema (V2 cadence/scope/updated/origin)
  - Memory vs decisions-log placement — when a learning belongs in `<plugin-root>/memories/` vs `<plugin-root>/decisions/<phase>.md`
  - The plugin's INDEX.md as the master catalog of bundled artifacts
  - CHANGELOG.md as the load-bearing version-history surface
  - Information lifecycle — when knowledge is born (in-session), where it lives (memory/decision/CHANGELOG/CONTRIBUTING), when it moves, when it dies
  - Cross-reference graph health — outbound links from bundled memories must resolve within `<plugin-root>/memories/`
  - The audit-skill's documentation surface and how findings get archived to `<plugin-root>/docs/audits/`

triggers:
  # Drop: wiki, obsidian, vault, hot cache, ingest, frontmatter, wikilink (last is plugin-irrelevant since the plugin doesn't ship Obsidian wikilinks)
  # Keep: memory, backlog, knowledge, index, convention.
  # Add: changelog, decisions-log, audit-archive, memory-index, cross-reference.

adversarial_lens: # unchanged — generic discipline.

context_sources:
  wiki:
    # Before: hot.md, meta/conventions.md, meta/toolbox.md
    - INDEX.md
    - CHANGELOG.md
  memory:
    # Before: wiki-system.md, backlog-system.md, feedback-feed-the-wiki.md (none bundled)
    - feedback-self-monitoring-is-architectural.md # bundled
    - feedback-encode-while-context-fresh.md # bundled
    - feedback-no-known-gaps.md # bundled
```

**Body rewrites:** the agent body references "Obsidian", "the wiki", "the memory system", "MEMORY.md", "\_shelved/", "graphify". All substrate-specific. Rewrite to anchor against the plugin's surfaces (memories/, decisions/, INDEX.md, CHANGELOG.md, docs/audits/).

### `familiar/workflow-process.md`

Light rewrite. The pipeline + branching + commit-gate disciplines are universal. The two substrate refs in `context_sources.memory` are `branching-rules.md` and `hooks-thesis.md` — neither bundled. Replace with bundled equivalents:

```yaml
context_sources:
  wiki:
    - CONTRIBUTING.md # plugin's branching/plan-mode rule lives here
  memory:
    - feedback-plan-mode-for-structural-changes.md # bundled
    - feedback-phased-audit-remediation-arc.md # bundled
    - multi-persona-audit-pattern.md # bundled
```

No body rewrite needed beyond replacing "CLAUDE.md" with "the plugin's CONTRIBUTING.md" in any explicit reference.

### `audit/registry.md`

Light mechanical rewrite. Two substrate refs:

- **Line 12** — "At least one familiar when plan touches project internals (dotfiles, hooks, wiki, memory, established conventions)." → "At least one familiar when plan touches project internals (hooks, agents, skills, memory, decisions log, established conventions)."
- **Line 65** — `architecture-integration` triggers list includes substrate-specific keywords. Drop `dotfiles`, `install`, `allowlist`; add `plugin`, `memory-surface`, `audit-registry` per the architecture-integration agent's own rewrite.

## Frontmatter rewrites

Cold auditors and the 2 generic agents ship without frontmatter changes. Familiars get the rewrites above.

**Add to all bundled familiars:**

```yaml
---
# ...existing fields...
origin: extracted # plugin extension to V2 schema; declares "extracted from upstream substrate, frontmatter rewritten for plugin use"
updated: 2026-04-25 # frozen at extraction
---
```

**Strip from all bundled agents (cold + familiar + generic):**

- Any `originSessionId:` field if present (none observed in current pass; defensive grep catches).

## Validation gate (executable commands)

Before sub-step 0.6 writes the actual `agents/*.md` files:

1. **Mini-Architecture audit on this document.**
2. **Audit findings integrated.**
3. **Verification round** — bounded with hard cap 3 per audit-skill discipline.
4. **Sub-step 0.6 then writes the rewritten agents** using this document as the rewrite spec.
5. **CI grep on the written agents re-validates anonymization.** Executable command (run from `<plugin-root>/`):

   ```bash
   rg -l --pcre2 \
     'nick|nbruzzi|/Users/nbruzzi|claude-dotfiles|Obsidian|HeatPrice|NEO|FuelSnap|NewEnglandOil|MEMA|EMARI|originSessionId|MEMORY\.md|graphify|_shelved|\.raw/|sentinel agent|GitHub Actions sentinel|wiki/(hot|index|domains|meta|sources|entities|concepts|comparisons|questions)\.md|2026-04-(1[5-9]|2[0-9])|\[\[[A-Z][^\]]+\]\]' \
     agents/
   ```

   Expected output: empty. Any path emitted is a violation. CI fails the build with the offending file list.

6. **Cross-reference graph re-validates: every `context_sources.memory` entry resolves to a file in `<plugin-root>/memories/`, and every `context_sources.wiki` entry resolves to a file in `<plugin-root>/`.** Executable command:

   ```bash
   # Extract context_sources entries from agent frontmatter, resolve each.
   for agent in agents/audit/familiar/*.md; do
     # YAML-parse the frontmatter context_sources block, emit one path per line.
     awk '/^context_sources:$/,/^[a-z]/' "$agent" \
       | grep -E '^\s+-\s+' \
       | sed -E 's/^\s+-\s+//' \
       | while read -r entry; do
           # Wiki entries resolve against <plugin-root>/; memory entries against <plugin-root>/memories/.
           # Heuristic: if entry contains a slash, it's a wiki path; otherwise it's a memory file.
           if [[ "$entry" == *.md ]] && [[ "$entry" != */* ]]; then
             test -f "memories/${entry}" || echo "DANGLING memory: $agent -> $entry"
           else
             test -f "${entry}" || echo "DANGLING wiki: $agent -> $entry"
           fi
         done
   done
   ```

   Expected output: empty. Any "DANGLING" line is a broken reference and CI fails.

Failure at step 5 or step 6 blocks sub-step 0.6 entry per the parent plan's audit-gate discipline.

## Open questions

- **Cold-auditor `model:` field portability:** all 13 cold auditors specify `model: opus`. Whether this is a hard requirement vs a default depends on the host's billing/availability. The plugin should document `model:` field semantics in `<plugin-root>/INDEX.md` so consumers can override. Decision deferred to sub-step 0.6 (extraction-time decision; the bundled agents preserve `model: opus` unless a strong reason to change emerges).
- **Familiar auditor commissioning protocol portability:** the `(This section will be replaced at commission time with injected wiki/memory content)` placeholder presupposes a commissioning step that injects context. The plugin's audit skill must implement this injection. Sub-step that wires up the commissioning protocol (likely Phase 1 or 2) is not in Phase 0 scope.
- **Drop-then-re-add pattern for domain-business:** the plugin can ship a "familiar template" (a stub agent with the structural shape of a familiar auditor but no domain-specific thesis) so users can clone it for their own business-thesis familiar. Filed for v0.5+ retrospective backlog.

## Round-1 audit findings → resolution map

(Will populate after the mini-Architecture audit dispatches.)
