<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Agents to Bundle

**Phase 0 sub-step 0.3b deliverable.** Anonymization rewrite plan for agents shipped with the plugin under `<plugin-root>/agents/`. Per parent plan KS-1 + manifest audit's ARCH-4 finding (agent `context_sources` anonymization carved out as a separate deliverable from memory body anonymization).

**Audit gate:** mini-Architecture audit on this document landed 7.5/10 (ship-with-conditions) with 2 critical + 3 major + 2 minor findings. **All 7 findings integrated below.** Verification round dispatched per audit-skill bounded-with-hard-cap-3 discipline.

**Status:** AUDITED — round 2 verification GREEN. Sub-step 0.6 entry unblocked. Audit envelope closed.

## Scope filter

The plugin ships an auditor registry + 13 cold auditors + 4 familiar auditors + 1 familiar template + 2 generic agents (code-simplifier, verify-app). Agents are different from memories in two ways:

- **Cold auditors are domain-pure** (TypeScript expertise, security expertise, performance expertise, etc.). They have no `context_sources` field, no substrate references in body. They bundle as-is — no rewrite needed.
- **Familiar auditors carry `context_sources` + substrate-anchored expertise + substrate-anchored Audit Protocols** in their frontmatter AND in the operational checks. They commission against the project's own context (wiki + memory files). For the plugin, "the project" is the plugin itself, not the upstream substrate. Familiars need frontmatter rewrite + body rewrite + **Audit Protocol numbered-check rewrite** to anchor against `<plugin-root>` surfaces (memories/, decisions/, INDEX.md, CHANGELOG.md).

**Rule of thumb:** if the agent's adversarial lens generalizes to any plugin user's project but the current frontmatter and Audit Protocol anchor against the upstream substrate, **rewrite and bundle**. If the lens itself is substrate-thesis-specific (e.g., a domain-specific business thesis), **drop and ship a structural template** so the registry's extensibility story is demonstrable.

## Scope decisions

### Drop entirely

- **`familiar/domain-business.md`** — entire agent is anchored on the HeatPrice two-stack thesis, dealer neutrality, NEO/FuelSnap/competitors, programmatic SEO for zip pages. The adversarial lens IS the business thesis; removing the thesis leaves no agent. The plugin's audience won't have this thesis. **Drop the file outright.** A structural replacement (`familiar/_template.md`, see below) ships in Phase 0 so the registry's extensibility story is demonstrable.

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

The 4 remaining familiar auditors + the registry get rewrite passes. **Per ARCH-1, the rewrite scope explicitly includes the Audit Protocol numbered-check list** for any agent whose checks reference substrate-specific operational concerns (install.sh, sync allowlist, sentinel, wiki conventions, hot cache, backlog hygiene).

| Agent file                             | Rewrite scope | Surfaces to rewrite                                                                                                                                                                                                                            |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `familiar/architecture-integration.md` | HEAVY         | Frontmatter (`expertise`, `triggers`, `context_sources`); body "Your Expertise" paragraph; **Audit Protocol steps 7, 9, 10, 11** (install.sh / sync allowlist / PostToolUse / sentinel references).                                            |
| `familiar/code-standards.md`           | LIGHT         | Frontmatter `context_sources` only.                                                                                                                                                                                                            |
| `familiar/knowledge-system.md`         | HEAVY         | Frontmatter (`expertise`, `triggers`, `context_sources`); body; **Audit Protocol steps 6, 7, 8, 9, 10, 11** (knowledge placement layers / wiki convention / three-layer architecture / hot.md / backlog hygiene / information lifecycle refs). |
| `familiar/workflow-process.md`         | LIGHT         | Frontmatter `context_sources`; body single CLAUDE.md → CONTRIBUTING.md ref.                                                                                                                                                                    |
| `audit/registry.md`                    | LIGHT         | See "Registry rewrite (full scope)" section below.                                                                                                                                                                                             |

### New: ship `familiar/_template.md` (per ARCH-7)

Phase 0 ships a minimal stub demonstrating the structural shape of a familiar auditor without any domain-specific thesis. Catalogued in `<plugin-root>/INDEX.md` but **not registered** in `audit/registry.md` (no triggers list = the audit skill never picks it).

**Frontmatter:**

```yaml
---
name: <Your Domain> Auditor
description: <Catches what?>
model: opus
category: familiar
domain: <your-domain-slug>
expertise:
  - TBD — list 6-8 areas of project-specific expertise
triggers:
  - TBD # list keyword triggers; word-boundary regex applies (case-insensitive)
adversarial_lens: "TBD — your adversarial lens framed as a question."
context_sources:
  wiki:
    - INDEX.md # or other plugin-bundled surfaces
  memory:
    - TBD # list bundled memories that anchor the discipline
origin: template
---
```

**Body:** generic instruction to clone, customize for the host project's domain thesis, register in `audit/registry.md` (table row + TSV row + bumped header counts), verify trigger overlap < 50% with existing familiars, then commission via the audit skill. Demonstrates the registry's extensibility story.

## Anonymization rules (applied uniformly)

A grep-rule script runs in CI on every commit + before bundling, blocking matches.

### Pattern blocklist (reuses memories-to-bundle.md rules + agent-specific additions)

Inherited from `memories-to-bundle.md`:

- Personal names, user-specific paths, GitHub PR/issue numbers (load-bearing), substrate-specific names, domain-specific names, commit SHAs, date-specific incident anchors, `originSessionId:`, Obsidian wikilinks, NATO peer names.

Agent-specific additions (per ARCH-1):

- **`context_sources:` paths that point outside `<plugin-root>/`:** the plugin's familiars commission against the plugin's own context surfaces. Any path under `wiki/`, `domains/`, `meta/`, `~/Documents/Obsidian Vault/` is a substrate-leak.
- **`expertise:` items naming substrate-specific concepts:** "Dotfiles repo structure", "GitHub Actions sentinel", "Obsidian vault structure", "HeatPrice two-stack thesis", "Settings.json copy-not-symlink" (which is a dotfiles-substrate detail), "wiki/", `hot.md`, `graphify pipeline`, `.raw/`, `_shelved/`.
- **`triggers:` keywords that are substrate-specific:** `obsidian`, `vault`, `dotfiles`, `sentinel`, `allowlist`, `install`, `NEO`, `HeatPrice`, `FuelSnap` (last two covered by domain-business drop).
- **`adversarial_lens:` containing substrate-specific thesis:** the domain-business lens IS the HeatPrice thesis (drop). Other lenses generalize after frontmatter cleanup.
- **Audit Protocol numbered-check phrases:** `install\.sh`, `PostToolUse`, `SessionStart catch-up`, `sync allowlist`, `sentinel`, `GitHub Actions sentinel`, `dispatcher/handler convention`, `hot cache pattern`, `three-layer architecture`, `feed-the-wiki`, `graphify`, `\.raw/`, `_shelved/`. Including these in step-5 rg pattern catches substrate leaks the frontmatter+narrative rewrites alone don't see.

### Body rewrite mappings (agent-specific)

- "nbruzzi/claude-dotfiles" → "the host project" or "the plugin consumer's project"
- "Obsidian vault" / "the wiki" → "the plugin's knowledge surfaces" or "the host project's documentation"
- "MEMORY.md index" → "the plugin's memory index (`<plugin-root>/memories/INDEX.md` or analogous)"
- "GitHub Actions sentinel" → "any CI verification job the host project runs"
- "Settings.json (copy not symlink)" → omit (dotfiles-specific implementation detail)
- "graphify pipeline" → omit (vault-specific)
- ".raw/ ingestion" / "\_shelved/" → omit (vault-specific)
- "hot cache pattern" → "the project's hot-context surface (e.g., `INDEX.md` or analogous)"
- "Sunday agent" / "sentinel cron" → omit (dotfiles-substrate-specific)
- "three-layer architecture (hot cache, index, domain pages)" → "the plugin's two-layer architecture (`INDEX.md` catalog + `memories/` + `decisions/` + `docs/audits/`)"
- "feed-the-wiki" → "feed the plugin's knowledge surfaces" (CHANGELOG.md, decisions log)
- "install.sh's DIRS and FILES arrays" → "the plugin's bundled-artifact catalog (INDEX.md)"
- "PostToolUse hooks copy managed files and stage them" → "the plugin's hook handlers register through the registry pattern"

## Per-agent rewrite plan (load-bearing)

### `familiar/architecture-integration.md`

Heaviest familiar rewrite. Adversarial lens is generic and load-bearing — preserved verbatim. Three rewrite surfaces.

**Frontmatter rewrites (literal resulting YAML, per ARCH-5):**

```yaml
expertise:
  - The plugin's hook/dispatcher system and handler conventions
  - Agent and skill definitions — how the plugin extends Anthropic's Agent Teams
  - The auditor registry pattern — cold and familiar auditors, commissioning protocol
  - Cross-component integration within the plugin and between plugin and host project
  - The plugin's memory surface — `<plugin-root>/memories/` directory layout, INDEX.md
  - The plugin's decisions log — `<plugin-root>/decisions/` per-phase entries
  - CI verification patterns — typecheck/format/lint/test gates and their ordering

triggers:
  - hook
  - dispatcher
  - sync
  - registry
  - agent
  - skill
  - handler
  - check
  - settings
  - infrastructure
  - plugin
  - memory-surface
  - audit-registry

adversarial_lens: "Does this plan integrate correctly with our existing systems, or does it create parallel infrastructure that should use what already exists?" # unchanged

context_sources:
  wiki:
    - INDEX.md
    - CHANGELOG.md
  memory:
    - feedback-merge-commit-across-instances.md
    - feedback-self-monitoring-is-architectural.md
    - multi-persona-audit-pattern.md
```

**Resulting registry TSV row (per ARCH-5, must match frontmatter byte-for-byte):**

```tsv
familiar/architecture-integration.md	ARCH	Architecture Auditor	hook|dispatcher|sync|registry|agent|skill|handler|check|settings|infrastructure|plugin|memory-surface|audit-registry
```

**Body "Your Expertise" rewrite:**

> You know how the plugin's pieces fit together: the plugin (`<plugin-root>/`) bundles a hook/dispatcher system, an auditor registry, a discipline-as-code memory surface, and skills that extend Anthropic's Agent Teams. The plugin's components — hooks, agents, skills, memories, decisions log — interact through documented contracts: the registry pattern for hook check registration, the commission protocol for familiar auditors, the audit-skill discipline for plan reviews. Drift looks like: building a one-off mechanism when the registry pattern already handles it, creating a parallel decisions-log surface when `decisions/<phase>.md` is the convention, forgetting to update INDEX.md when adding a new bundled artifact, or adding a new agent/skill that bypasses the audit registry's commissioning protocol.

**Audit Protocol rewrite (per ARCH-1) — steps 7, 9, 10, 11 of the source:**

- **Step 7 (source):** "Check for integration completeness — if the plan adds a new file/config, does it update the sync allowlist? If it adds a new hook, does it follow the dispatcher/handler convention?"
  → **Rewrite:** "Check for integration completeness — if the plan adds a new bundled artifact (memory, agent, skill, decision-log entry), is it catalogued in `<plugin-root>/INDEX.md`? If it adds a new hook check, does it register through `Registry.register()` per the registry pattern? If it adds a new agent, is the registry table row + TSV row both updated?"
- **Step 9 (source):** "Check for `install.sh` alignment — if new directories or files are added, are they reflected in install.sh's DIRS and FILES arrays? Would `install.sh` correctly restore them on a fresh machine?"
  → **Rewrite:** "Check for INDEX.md alignment — if new bundled artifacts are added, are they catalogued? Would a fresh plugin install correctly surface the new artifacts (memories loaded by the memory-loader, agents commissionable through the audit skill, skills discoverable)?"
- **Step 10 (source):** "Check for sync pipeline awareness — does the plan account for the auto-sync hooks? Will PostToolUse correctly detect and sync the new files? Are the file patterns on the allowlist?"
  → **Rewrite:** "Check for cross-component edge handling — if the plan adds an import edge between plugin components, does the dependency graph stay acyclic? Are extract-with-shim re-exports preserved when needed for host-project consumers?"
- **Step 11 (source):** "Check for sentinel compatibility — will the GitHub Actions sentinel validate the new files correctly? Are there new patterns that the sentinel needs to know about?"
  → **Rewrite:** "Check for CI gate compatibility — does the plan's new files pass typecheck, format, lint, and test gates without modification? Are new patterns covered by existing tests, or do they need new test scaffolding?"

### `familiar/code-standards.md`

Light rewrite. The TypeScript conventions (`no-any`, `no-enum`, `prefer-type-over-interface`, strict-mode, error-handling-explicitness, Bun runtime, prettier+eslint) are generic and ship verbatim. Single rewrite is `context_sources`:

```yaml
context_sources:
  wiki:
    - INDEX.md
  memory:
    - feedback-self-apply-ceiling-discipline.md # bundled (generic ceiling discipline)
    - feedback-confidence-as-verification-output.md # bundled
```

**Resulting registry TSV row (unchanged from source — triggers list is generic):**

```tsv
familiar/code-standards.md	CS	Code Standards Auditor	typescript|type|any|enum|interface|error|catch|lint|format|strict|explicit
```

No body rewrite needed — the "code conventions" expertise is plugin-agnostic. Audit Protocol steps are domain-pure (type strictness, error handling, format/lint compliance) — no rewrite needed.

### `familiar/knowledge-system.md`

Heavy rewrite. Discipline ("knowledge-architecture-drift", "wiki convention violations", "misplaced knowledge") is generic and preserved as the adversarial lens. Three rewrite surfaces.

**Frontmatter rewrites (literal resulting YAML):**

```yaml
expertise:
  - The plugin's memory schema (V2 cadence/scope/updated/origin)
  - Memory vs decisions-log placement — when a learning belongs in `<plugin-root>/memories/` vs `<plugin-root>/decisions/<phase>.md`
  - The plugin's INDEX.md as the master catalog of bundled artifacts
  - CHANGELOG.md as the load-bearing version-history surface
  - Information lifecycle — when knowledge is born (in-session), where it lives (memory/decision/CHANGELOG/CONTRIBUTING), when it moves, when it dies
  - Cross-reference graph health — outbound links from bundled memories must resolve within `<plugin-root>/memories/`
  - The audit-skill's documentation surface and how findings get archived to `<plugin-root>/docs/audits/`

triggers:
  - memory
  - backlog
  - knowledge
  - index
  - convention
  - changelog
  - decisions-log
  - audit-archive
  - memory-index
  - cross-reference

adversarial_lens: "Does this plan's knowledge management approach follow our memory + decisions-log conventions, or does it create information that belongs somewhere else?"

context_sources:
  wiki:
    - INDEX.md
    - CHANGELOG.md
  memory:
    - feedback-self-monitoring-is-architectural.md # bundled
    - feedback-encode-while-context-fresh.md # bundled
    - feedback-no-known-gaps.md # bundled
```

**Resulting registry TSV row:**

```tsv
familiar/knowledge-system.md	KS	Knowledge System Auditor	memory|backlog|knowledge|index|convention|changelog|decisions-log|audit-archive|memory-index|cross-reference
```

**Body rewrite:** the agent body references "Obsidian", "the wiki", "the memory system", "MEMORY.md", "\_shelved/", "graphify". All substrate-specific. Rewrite to anchor against the plugin's surfaces (memories/, decisions/, INDEX.md, CHANGELOG.md, docs/audits/).

**Audit Protocol rewrite (per ARCH-1) — steps 6, 7, 8, 9, 10, 11 of the source:**

- **Step 6 (source):** "Check for knowledge placement — does new information end up in the right layer? Durable knowledge in the wiki, session preferences in memory, action items in backlog?"
  → **Rewrite:** "Check for knowledge placement — does new information end up in the right layer? Durable cross-session learnings in `memories/`, per-phase decisions in `decisions/<phase>.md`, version-history in CHANGELOG.md, audit findings in `docs/audits/`?"
- **Step 7 (source):** "Check for wiki convention compliance — do any new or modified wiki pages include proper frontmatter, use wikilinks for cross-references, and follow the established status values? Is the three-layer architecture (hot cache, index, domain pages) maintained?"
  → **Rewrite:** "Check for memory schema compliance — do new bundled memories include proper V2 frontmatter (`cadence: stable`, `scope: global`, `updated:`, `origin: extracted`), and do their cross-references resolve within `memories/`? Is INDEX.md updated for the new artifact?"
- **Step 8 (source):** "Check for information connectivity — does the plan create isolated knowledge, or does it connect new information to the existing graph through links, index updates, and hot cache entries?"
  → **Rewrite:** "Check for information connectivity — does the plan create isolated knowledge, or does it connect new information to the existing artifacts through cross-references and INDEX.md updates?"
- **Step 9 (source):** "Check for hot cache relevance — if the plan creates important new knowledge, should hot.md be updated? Or does it add something to hot.md that doesn't belong there?"
  → **Rewrite:** "Check for INDEX.md surfacing — if the plan creates important new knowledge, is it catalogued in INDEX.md with a one-line summary? Or is it added in a way that buries it from discovery?"
- **Step 10 (source):** "Check for backlog hygiene — does the plan reference backlog items that should be checked off?"
  → **Rewrite:** "Check for follow-up tracking — does the plan reference deferred items that should land in `<plugin-root>/decisions/<phase>.md` open-questions sections, or in the host project's own backlog?"
- **Step 11 (source):** "Check for information lifecycle — is the plan creating knowledge that will rot?"
  → **Unchanged** — this step is generic. The discipline ("create maintenance mechanism for knowledge that can become stale") is plugin-agnostic.

### `familiar/workflow-process.md`

Light rewrite. The pipeline + branching + commit-gate disciplines are universal. Two rewrite surfaces.

**Frontmatter rewrites (literal resulting YAML):**

```yaml
context_sources:
  wiki:
    - CONTRIBUTING.md # plugin's branching/plan-mode rule lives here
  memory:
    - feedback-plan-mode-for-structural-changes.md # bundled
    - feedback-phased-audit-remediation-arc.md # bundled
    - multi-persona-audit-pattern.md # bundled
```

**Resulting registry TSV row (unchanged from source):**

```tsv
familiar/workflow-process.md	WP	Workflow Auditor	pipeline|branch|commit|plan|verify|test|workflow|typecheck|lint|format|pre-commit|hook
```

**Body:** single CLAUDE.md → CONTRIBUTING.md ref rewrite. Audit Protocol steps are domain-pure (pipeline sequencing, branching rules, commit gate ordering) — no rewrite needed.

### `audit/registry.md` — Registry rewrite (full scope, per ARCH-3)

The mini-Architecture audit's ARCH-3 finding flagged that the original "two line edits" framing under-scoped the work. Full scope:

1. **Line 1 (header counts):** "catalog of 17 expert auditors — 12 cold (...) and 5 familiar" → "catalog of 16 expert auditors — 13 cold (...) and 4 familiar with 1 template (`familiar/_template.md`, unregistered)."
   _Note the corrected cold count: 13, not the source's 12 — the source registry header drift is corrected here. Verified by counting the cold table (lines 21–33): 13 entries._
2. **Line 12 (selection heuristic 6):** "At least one familiar when plan touches project internals (dotfiles, hooks, wiki, memory, established conventions)" → "At least one familiar when plan touches project internals (hooks, agents, skills, memory, decisions log, established conventions)."
3. **Line 44 (familiar table row):** drop the `familiar/domain-business.md | BIZ | Business Auditor | business | <thesis lens>` row entirely.
4. **Line 67 (TSV row):** drop the `familiar/domain-business.md ... business|strategy|competitor` TSV row entirely.
5. **Line 65 (architecture-integration TSV triggers):** rewrite per the agent's own resulting trigger list above (drop `dotfiles|install|allowlist`; add `plugin|memory-surface|audit-registry`).
6. **Line 68 (knowledge-system TSV triggers):** rewrite per the agent's own resulting trigger list above (drop `wiki|obsidian|frontmatter|wikilink|vault|hot cache`; add `changelog|decisions-log|audit-archive|memory-index|cross-reference`).
7. **Optional registration of `familiar/_template.md`:** NOT registered in the table or TSV. The "Adding a New Auditor" instructions (lines 72–79) implicitly cover the template's customization path. Optionally add a one-line note under "Familiar Auditors" pointing to the template: _"To create a new familiar auditor for your project's domain, clone `familiar/_template.md` and follow the registration steps below."_

**Cross-reference verification (per ARCH-3 last sub-finding):** the audit-skill's commission code path must handle the now-missing `familiar/domain-business.md` gracefully. Sub-step 0.6 verifies via test: commission a plan that would have triggered BIZ in the source registry; assert the audit-skill either (a) does not pick BIZ (because it's not registered) or (b) fails loud with a clear "agent not found in plugin" error. Either is acceptable; silent-no-op is not.

## Frontmatter rewrites (universal, per KS-7 schema)

Cold auditors and the 2 generic agents ship without frontmatter changes (no `origin` or `updated` fields needed since they are not extracted-with-rewrite).

**Familiars get added:**

```yaml
---
# ...existing fields...
origin: extracted # plugin extension to V2 schema; declares "extracted from upstream substrate, frontmatter rewritten for plugin use"
updated: 2026-04-25 # frozen at extraction
---
```

**Template gets:**

```yaml
origin: template # plugin extension to V2 schema; declares "structural template — customize for your project"
```

**Strip from all bundled agents (cold + familiar + generic + template):**

- Any `originSessionId:` field if present (none observed in current pass; defensive grep catches).

## `model:` field decision (per ARCH-6)

**Decision:** keep `model: opus` on all bundled agents. Document override pattern in `<plugin-root>/INDEX.md`:

> All bundled agents specify `model: opus` because the audit and verification disciplines require deep reasoning. To override (e.g., for cost reasons or model availability), edit the agent's frontmatter post-install, OR set `CLAUDE_AGENT_MODEL_OVERRIDE=<model-id>` in the plugin's settings.json — the plugin's audit skill respects the override at commission time.

The override pattern is a Phase 1+ implementation (the plugin's audit skill needs the override-respecting commission code). For Phase 0, document the intent in INDEX.md so consumers see the model pin is intentional, not accidental.

## Validation gate (executable commands)

Before sub-step 0.6 writes the actual `agents/*.md` files:

1. **Mini-Architecture audit on this document** — round 1 complete (7.5/10, 7 findings).
2. **Audit findings integrated** — this revision.
3. **Verification round** — bounded with hard cap 3 per audit-skill discipline.
4. **Sub-step 0.6 then writes the rewritten agents** using this document as the rewrite spec.
5. **CI grep on the written agents re-validates anonymization.** Executable command (run from `<plugin-root>/`):

   ```bash
   rg -l --pcre2 \
     'nick|nbruzzi|/Users/nbruzzi|claude-dotfiles|Obsidian|HeatPrice|NEO|FuelSnap|NewEnglandOil|MEMA|EMARI|originSessionId|MEMORY\.md|graphify|_shelved|\.raw/|sentinel agent|GitHub Actions sentinel|install\.sh|sync allowlist|PostToolUse|SessionStart catch-up|three-layer architecture|hot cache pattern|feed-the-wiki|wiki/(hot|index|domains|meta|sources|entities|concepts|comparisons|questions)\.md|2026-04-(1[5-9]|2[0-9])|\[\[[A-Z][^\]]+\]\]' \
     agents/
   ```

   Expected output: empty. Any path emitted is a violation. CI fails the build with the offending file list.

   **Allowlist:** none for `agents/`. The narrow scope is intentional — agent files are operational instruction surfaces; substrate leaks corrupt the auditor's behavior at commission time.

6. **Cross-reference graph re-validates: every `context_sources.memory` entry resolves to a file in `<plugin-root>/memories/`, and every `context_sources.wiki` entry resolves to a file in `<plugin-root>/`.** Executable command (per ARCH-2 fix — replaces broken awk+heuristic with YAML-aware extraction):

   ```bash
   # Use Bun to parse YAML frontmatter and walk context_sources.{wiki,memory} explicitly.
   for agent in agents/audit/familiar/*.md; do
     bun -e '
       import { readFileSync } from "fs";
       import { join } from "path";
       const file = process.argv[2];
       const text = readFileSync(file, "utf8");
       const fm = text.match(/^---\n([\s\S]*?)\n---/);
       if (!fm) process.exit(0);
       // Crude YAML parse — frontmatter is flat enough that we walk it line-by-line.
       const lines = fm[1].split("\n");
       let inWiki = false, inMemory = false;
       for (const line of lines) {
         if (/^wiki:\s*$/.test(line) || /^\s+wiki:\s*$/.test(line)) { inWiki = true; inMemory = false; continue; }
         if (/^memory:\s*$/.test(line) || /^\s+memory:\s*$/.test(line)) { inWiki = false; inMemory = true; continue; }
         if (/^\w/.test(line) && !/^(wiki|memory):\s*$/.test(line)) { inWiki = false; inMemory = false; continue; }
         const m = line.match(/^\s+-\s+(\S.+)$/);
         if (!m) continue;
         const entry = m[1].trim();
         if (inWiki) {
           if (!require("fs").existsSync(entry)) console.log(`DANGLING wiki: ${file} -> ${entry}`);
         } else if (inMemory) {
           const target = join("memories", entry);
           if (!require("fs").existsSync(target)) console.log(`DANGLING memory: ${file} -> ${entry}`);
         }
       }
     ' "$agent"
   done
   ```

   Expected output: empty. Any "DANGLING" line is a broken reference and CI fails.

   **Why Bun-based:** the original awk+heuristic (per ARCH-2) had two defects — (a) the range-pattern terminated at the first lowercase line, killing the memory: block; (b) the slash-presence heuristic misclassifies plain filenames. The Bun script walks the YAML explicitly, tracking `inWiki` / `inMemory` state, and resolves each entry against its correct root.

7. **Cross-deliverable consistency check (per ARCH-4 cross-cutting concern):** every memory referenced in `agents-to-bundle.md`'s `context_sources.memory` blocks must appear in `memories-to-bundle.md`'s in-scope set. Executable command:

   ```bash
   # Extract memory refs from agents-to-bundle.md, verify each appears in memories-to-bundle.md.
   rg --pcre2 -o '^\s+-\s+(feedback-[a-z-]+\.md|multi-persona-audit-pattern\.md)' agents-to-bundle.md \
     | sed -E 's/.*-\s+//' \
     | sort -u \
     | while read -r mem; do
         grep -qF "\`${mem}\`" memories-to-bundle.md || echo "MISSING in-scope: ${mem}"
       done
   ```

   Expected output: empty. Any "MISSING" line means a context_sources ref points to a memory not declared in-scope by the companion deliverable.

8. **Meta-gate dry-run (per ARCH-2 cross-cutting concern):** before sub-step 0.6 writes any agent files, run steps 5/6/7 against a positive-control file (a deliberate violation file like `agents/test-violation.md` containing `nbruzzi` and a dangling memory ref) AND a clean control. Confirm step 5 fires on the substrate leak; step 6 fires on the dangling ref; step 7 fires on a missing-in-scope ref. Then delete the test fixtures. Confirms the gate scripts function correctly before they're trusted.

Failure at step 5, 6, 7, or 8 blocks sub-step 0.6 entry per the parent plan's audit-gate discipline.

## Open questions

- **Cold-auditor `model: opus` portability:** RESOLVED per ARCH-6 above — keep `opus`, document override pattern in INDEX.md, implement override-respecting commission in Phase 1+.
- **Familiar template registration:** RESOLVED per ARCH-7 above — ship `familiar/_template.md` in Phase 0, NOT registered in registry.md. Customization path documented in body and "Adding a New Auditor" registry section.
- **Familiar auditor commissioning protocol portability:** the `(This section will be replaced at commission time with injected wiki/memory content)` placeholder presupposes a commissioning step that injects context. The plugin's audit skill must implement this injection. Sub-step that wires up the commissioning protocol (likely Phase 1 or 2) is not in Phase 0 scope.
- **Drop-then-re-add pattern beyond `domain-business`:** if future plugin users propose other thesis-specific familiars (e.g., a marketplace-thesis auditor for marketplace-pivoting projects), the same drop-and-template pattern applies. Filed for v0.5+ retrospective backlog.

## Round-1 audit findings → resolution map

| Finding ID | Severity | Resolution                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARCH-1     | critical | Audit Protocol numbered-check rewrite scope added explicitly. Per-agent rewrite plan now lists Audit Protocol step rewrites for architecture-integration (steps 7, 9, 10, 11) and knowledge-system (steps 6, 7, 8, 9, 10, 11). Step-5 rg pattern extended with `install\.sh`, `PostToolUse`, `SessionStart catch-up`, `sync allowlist`, `sentinel`, `three-layer architecture`, `hot cache pattern`, `feed-the-wiki`. |
| ARCH-2     | critical | Step 6 YAML resolver rewritten as a Bun-based YAML-aware extractor. Tracks `inWiki` / `inMemory` state explicitly, resolves wiki entries against `<plugin-root>/` and memory entries against `<plugin-root>/memories/`. Slash-presence heuristic dropped.                                                                                                                                                             |
| ARCH-3     | major    | Registry rewrite scope expanded to: header counts (line 1), heuristic 6 (line 12), familiar table BIZ row drop (line 44), TSV BIZ row drop (line 67), architecture-integration TSV triggers (line 65), knowledge-system TSV triggers (line 68), missing-agent commission test scaffolding.                                                                                                                            |
| ARCH-4     | major    | Cross-deliverable inconsistency on `ceiling-standard.md` reconciled. Memories-to-bundle.md to be updated in same commit to add `ceiling-standard.md` to drop list with rationale (anchored on capturing-user verbatim quote; same discipline covered by `feedback-self-apply-ceiling-discipline.md`). New step 7 in validation gate checks cross-deliverable consistency programmatically.                            |
| ARCH-5     | major    | All trigger-list rewrites converted from prose-comments to literal resulting YAML lists AND literal resulting TSV trigger strings. Sub-step 0.6 now mechanically copies; no derivation needed.                                                                                                                                                                                                                        |
| ARCH-6     | minor    | `model: opus` decision resolved in this deliverable: keep opus, document override pattern in INDEX.md. Override-respecting commission deferred to Phase 1+.                                                                                                                                                                                                                                                           |
| ARCH-7     | minor    | `familiar/_template.md` ships in Phase 0 (added to bundle list). NOT registered in registry; customization path documented. Demonstrates registry's extensibility story.                                                                                                                                                                                                                                              |
