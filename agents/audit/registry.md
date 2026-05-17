# Audit Board Registry

The audit board is a catalog of 21 expert auditors — 13 cold (pure domain expertise, no project context), 4 familiar (project-aware, get memory context injected at commission time), and **5 posture (LENS-class — mode-2 axes, stage-gated rather than keyword-triggered)** with 1 template (`familiar/_template.md`, unregistered). The `/audit` skill reads this registry to match auditors to plans.

## Selection Heuristics — 2-pool model

The board is organized as two independent pools per the audit-posture framework (see `memories/feedback-audit-upstream-vs-downstream-posture.md`). Pool selection happens in parallel; final commissioned set = Pool A ∪ Pool B (independent caps).

### Pool A — Domain (cold + familiar)

Selected per existing keyword-trigger heuristics. Fires at **all** stages.

1. **Word-boundary matching** for trigger keywords, case-insensitive. Use `\bTERM\b` regex — not substring — so `as` doesn't match "class" or "was". Multi-word triggers ("app router", "use client") match as a phrase.
2. **Per-trigger cap:** count each trigger's hits up to a cap of 50 to prevent any single saturated keyword from dominating the ranking.
3. **Rank by total match count** across all triggers.
4. Plans under 800 words → 2 auditors. Over 800 → 3. Over 8,000 words → 4.
5. At least one cold auditor (prevents familiarity blind spots).
6. At least one familiar when plan touches project internals (hooks, agents, skills, memory, decisions log, established conventions).
7. Maximum lens diversity — skip any auditor whose trigger set overlaps >50% with an already-selected one.
8. **Stage-mode-mix sensitivity (Pool A fallback path):** at stages where mode-2 is in scope (pre-plan / plan-v1), Architecture auditor gets **+3** and at least one auditor whose triggers include `workflow` or `coordination` is forced in. Remains active when Pool B selects 0 (e.g., domain-heavy plans). Per the audit-posture framework, this is the legacy workaround before the posture pool existed; preserved as fallback for cycles where pool-B yields nothing.

### Pool B — Posture (LENS-class)

Selected per **stage from Step 0 of the `/audit` skill**, NOT by keyword-trigger. Triggers field in the TSV is empty for posture auditors — selection happens by stage only.

| Stage                    | Pool B selection                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-plan-write           | **all 5 posture auditors** (mode-2 dominant)                                                                                                                      |
| plan-v1 cross-audit      | **3-5 posture auditors** (mode-2 + mode-1 mix; pick by plan-content heuristic: PREMISE always; SCOPE always; REFRAME + DEFAULT + SEQUENCE if plan has those axes) |
| plan-v2 / locked         | **0-1 posture auditors** (mode-2 only if BLOCKER suspected; default 0)                                                                                            |
| per-PR audit             | **0 posture auditors** (mode-1 only)                                                                                                                              |
| pre-merge Lane D         | **0 posture auditors** (mode-1 only)                                                                                                                              |
| post-merge retrospective | **1-2 posture auditors** (SCOPE + SEQUENCE for cycle-learning; results file as next-cycle backlog)                                                                |

**Why posture is a separate pool:** posture-auditors probe abstract framing axes (PREMISE / SCOPE / REFRAME / DEFAULT / SEQUENCE) that don't appear as plan-text keywords. The Pool A keyword-trigger model structurally can't select them. Stage-gating is the correct selection mechanism — at stages where mode-2 is cheap, posture-auditors fire; at stages where reframe-cost is catastrophic, they don't.

**Total commissioned auditors per cycle:** Pool A (3-4 typical) + Pool B (0-5 stage-dependent) = 3-9 typical range. Per-audit overhead scales with Pool B selection.

## Cold Auditors

No project context. Pure domain expertise with a fresh, external lens.

| File                               | Prefix | Name                     | Domain        | Adversarial Lens                                                                                                                                           |
| ---------------------------------- | ------ | ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cold/security-engineer.md`        | SE     | Security Engineer        | security      | What attack vectors does this plan expose, and what security assumptions are implicit but unverified?                                                      |
| `cold/performance-engineer.md`     | PE     | Performance Engineer     | performance   | Where will this plan hit performance walls, and what's the cost model the plan doesn't account for?                                                        |
| `cold/reliability-engineer.md`     | RE     | Reliability Engineer     | reliability   | What happens when this fails, and does the plan account for every failure mode?                                                                            |
| `cold/accessibility-specialist.md` | A11Y   | Accessibility Specialist | accessibility | Can every user, regardless of ability, accomplish every task this plan enables?                                                                            |
| `cold/database-architect.md`       | DBA    | Database Architect       | database      | Will the data model hold as scale and requirements change, or are there structural weaknesses hiding under current assumptions?                            |
| `cold/api-designer.md`             | API    | API Designer             | api           | Would a developer consuming this API for the first time understand it without asking questions?                                                            |
| `cold/test-architect.md`           | TA     | Test Architect           | testing       | How would you prove this actually works, and what failure scenarios have no test?                                                                          |
| `cold/typescript-expert.md`        | TS     | TypeScript Expert        | typescript    | Do the types encode the actual invariants, or are they papering over ambiguity?                                                                            |
| `cold/nextjs-architect.md`         | NXT    | Next.js Architect        | nextjs        | Is the rendering strategy correct for each page's actual data requirements, or is the plan using patterns that fight the framework?                        |
| `cold/cli-dx-engineer.md`          | CLI    | CLI DX Engineer          | dx            | Would a developer using this for the first time understand what to do, what went wrong, and how to fix it — without reading source code?                   |
| `cold/seo-geo-strategist.md`       | SEO    | SEO/Geo Strategist       | seo           | Will search engines treat this content as genuinely useful for the target query, or will it be classified as thin/duplicate/manipulative?                  |
| `cold/marketplace-operator.md`     | MKT    | Marketplace Operator     | marketplace   | Does this marketplace design create sustainable trust between both sides, or does it contain structural incentives that will erode participant confidence? |
| `cold/ux-flow-engineer.md`         | UX     | UX Flow Engineer         | ux            | Would a first-time user complete the primary task without instructions, and would a returning user still find it pleasant after 1000 repetitions?          |

## Familiar Auditors

Project-aware. Get memory context injected at commission time. Catch drift from established standards and internal inconsistency.

| File                                   | Prefix | Name                     | Domain       | Adversarial Lens                                                                                                                                         |
| -------------------------------------- | ------ | ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `familiar/code-standards.md`           | CS     | Code Standards Auditor   | typescript   | Does this plan's code approach match our established TypeScript conventions, or does it introduce patterns we've explicitly rejected?                    |
| `familiar/workflow-process.md`         | WP     | Workflow Auditor         | workflow     | Does this plan follow our established workflow, or does it skip steps that exist for good reasons?                                                       |
| `familiar/architecture-integration.md` | ARCH   | Architecture Auditor     | architecture | Does this plan integrate correctly with our existing systems, or does it create parallel infrastructure that should use what already exists?             |
| `familiar/knowledge-system.md`         | KS     | Knowledge System Auditor | knowledge    | Does this plan's knowledge management approach follow our memory + decisions-log conventions, or does it create information that belongs somewhere else? |

> **Adding a domain-specific familiar auditor for your project?** Clone `familiar/_template.md` and customize the frontmatter (expertise, triggers, context_sources, adversarial_lens) for your domain thesis. Then follow the registration steps under "Adding a New Auditor" below to add the table row + TSV row + bumped header counts.

## Posture Auditors

LENS-class — probe abstract framing axes (PREMISE / SCOPE / REFRAME / DEFAULT / SEQUENCE), not domain-specific concerns. Stage-gated selection from Step 0 of the `/audit` skill, NOT keyword-trigger. Get audit-posture framework memory context injected at commission time.

| File                        | Prefix   | Name                   | Axis           | Adversarial Lens                                                                                                                                                      |
| --------------------------- | -------- | ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `posture/premise.md`        | PREMISE  | Premise Auditor        | premise        | What assumptions are baked into this plan that, if false, invalidate the bundle entirely?                                                                             |
| `posture/scope.md`          | SCOPE    | Scope Auditor          | scope          | What's just outside the bundle that's more valuable than the lowest item in the bundle? What got silently inherited from prior framing?                               |
| `posture/reframe.md`        | REFRAME  | Reframe Auditor        | reframe        | What design shape are we silently committing to? What does the inversion or alternative shape reveal?                                                                 |
| `posture/default-action.md` | DEFAULT  | Default-Action Auditor | default-action | For every "default" in the plan, is it the conservative default or the right default? Conservative defaults preserve sunk-state at the cost of user-intent alignment. |
| `posture/sequence.md`       | SEQUENCE | Sequence Auditor       | sequence       | What ordering is implicit? What if we reordered? What dependencies are silently inherited from filing order rather than load-bearing flow?                            |

## Machine-readable index

The `/audit` skill parses this block to avoid reading each auditor file just for trigger lists. Format: tab-separated `file \t prefix \t name \t triggers-pipe-separated`. Keep in sync with the frontmatter of each auditor file — the `Adding a New Auditor` checklist below enforces this.

```tsv
cold/accessibility-specialist.md	A11Y	Accessibility Specialist	accessibility|a11y|wcag|aria|screen reader|keyboard|focus|contrast|semantic|form|modal|dialog|tab|navigation|disabled
cold/api-designer.md	API	API Designer	api|endpoint|route|rest|graphql|request|response|status code|versioning|rate limit|pagination|webhook|contract|openapi|swagger
cold/cli-dx-engineer.md	CLI	CLI DX Engineer	cli|command line|terminal|flag|argument|option|config|dotfile|plugin|hook|exit code|help|error message|dx|developer experience
cold/database-architect.md	DBA	Database Architect	database|schema|migration|index|query|table|column|foreign key|transaction|sql|orm|prisma|drizzle|supabase|postgres
cold/marketplace-operator.md	MKT	Marketplace Operator	marketplace|two-sided|supply|demand|pricing|take rate|commission|unit economics|growth|network effect|cold start|liquidity|supplier|buyer|seller
cold/nextjs-architect.md	NXT	Next.js Architect	next|nextjs|app router|server component|client component|use client|use server|ssr|ssg|isr|middleware|route handler|layout|page|loading
cold/performance-engineer.md	PE	Performance Engineer	performance|bundle|cache|query|index|lazy|render|memory|latency|throughput|pagination|batch|prefetch|optimize|slow
cold/reliability-engineer.md	RE	Reliability Engineer	error|retry|timeout|fallback|graceful|degradation|recovery|rollback|logging|monitoring|alert|health check|circuit breaker|idempotent|resilience
cold/security-engineer.md	SE	Security Engineer	auth|login|password|token|jwt|session|cookie|api key|secret|encrypt|hash|input|sanitize|validation|dependency
cold/seo-geo-strategist.md	SEO	SEO/GEO Strategist	seo|search|google|crawl|sitemap|robots|structured data|schema markup|meta|canonical|indexing|content|llm|geo|aeo
cold/test-architect.md	TA	Test Architect	test|spec|coverage|mock|stub|fixture|assert|expect|edge case|integration|unit test|e2e|snapshot|regression
cold/typescript-expert.md	TS	TypeScript Expert	typescript|type|generic|interface|any|unknown|as|cast|infer|narrowing|union|intersection|strict|zod|schema
cold/ux-flow-engineer.md	UX	UX Flow Engineer	ux|user experience|onboarding|friction|flow|form|feedback|progressive|defer|optional|minimal|default|affordance|wizard|empty state|first-run
familiar/architecture-integration.md	ARCH	Architecture Auditor	hook|dispatcher|sync|registry|agent|skill|handler|check|settings|infrastructure|plugin|memory-surface|audit-registry
familiar/code-standards.md	CS	Code Standards Auditor	typescript|type|any|enum|interface|error|catch|lint|format|strict|explicit
familiar/knowledge-system.md	KS	Knowledge System Auditor	memory|backlog|knowledge|index|convention|changelog|decisions-log|audit-archive|memory-index|cross-reference
familiar/workflow-process.md	WP	Workflow Auditor	pipeline|branch|commit|plan|verify|test|workflow|typecheck|lint|format|pre-commit|hook
posture/premise.md	PREMISE	Premise Auditor
posture/scope.md	SCOPE	Scope Auditor
posture/reframe.md	REFRAME	Reframe Auditor
posture/default-action.md	DEFAULT	Default-Action Auditor
posture/sequence.md	SEQUENCE	Sequence Auditor
```

**Posture-pool TSV note:** triggers column is empty (4th tab-separated field absent) for posture rows by design. The `/audit` skill's Step 2 selection skips keyword-trigger matching for rows where category=posture; it dispatches based on Step 0 stage instead.

## Adding a New Auditor

1. Create a `.md` file in the appropriate directory (`cold/` or `familiar/`). For familiars, clone `familiar/_template.md` as the starting point.
2. Follow the frontmatter schema: `name`, `description`, `model`, `category`, `domain`, `expertise`, `triggers`, `adversarial_lens`. Familiars also include `context_sources`, `origin`, and `updated`.
3. Choose a unique 2-4 letter finding prefix and use it consistently in the auditor's output format (`[PREFIX-N]`). Verify no existing auditor uses the same prefix.
4. For familiar auditors, add `context_sources` with paths into the plugin's bundled artifacts. Use the `plugin:` key for plugin-rooted paths (`INDEX.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `memories/<name>.md`); the `memory:` key for user-memory paths; and the `wiki:` key for genuine vault paths. Verify each file exists — if any are missing at commission time, the skill fails loud.
5. Add the auditor's table row (with prefix column) AND its machine-readable row to this registry. Bump the header counts at the top of this file. Keep all three in sync with the auditor's frontmatter.
6. Verify the triggers don't overlap >50% with an existing auditor in the same category.

## Known-tension pairs

Observed and predicted lens tensions that trigger Step 5b' reconciliation rounds in the `/audit` skill. Surfaced informationally in Step 3 when both auditors in a row appear in the selected set. Seed set reflects recurring patterns in the domain — extended as real audits surface new pairs.

| Pair A                   | Pair B                 | Typical tension surface                                                                |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------- |
| Security Engineer        | CLI DX Engineer        | user-input surfaces (validation vs flow)                                               |
| Security Engineer        | UX Flow Engineer       | form validation friction vs input safety                                               |
| Security Engineer        | Performance Engineer   | validation cost vs throughput                                                          |
| Performance Engineer     | Reliability Engineer   | aggressive caching vs failure modes                                                    |
| Performance Engineer     | UX Flow Engineer       | loading-state transparency vs perceived latency                                        |
| API Designer             | CLI DX Engineer        | explicit/verbose vs terse/implicit                                                     |
| Accessibility Specialist | Performance Engineer   | semantic markup vs page weight                                                         |
| Accessibility Specialist | UX Flow Engineer       | explicit labels/confirmations vs minimal flow                                          |
| Test Architect           | CLI DX Engineer        | coverage thoroughness vs feedback speed                                                |
| Next.js Architect        | Performance Engineer   | server-first vs client interactivity                                                   |
| Premise Auditor          | Scope Auditor          | premise-of-an-item vs bundle-edge composition (both can fire on the same plan section) |
| Reframe Auditor          | Default-Action Auditor | shape-change vs behavior-tweak on the same surface                                     |
| Scope Auditor            | Sequence Auditor       | which-items-in vs in-what-order — both can argue against the same proposed bundle      |

**How to use:** the `/audit` skill's Step 3 reads this table. When both auditors in a row are in the selected set, surface the tension zone to the user so they can anticipate reconciliation rounds in Step 5b' — or swap an auditor before commissioning.

**How to extend:** after any audit where a new tension pair surfaces (escalated or reconciled), append a row. Format: `| <Auditor A name> | <Auditor B name> | <tension surface description> |`. Keep auditor names matching the `Name` column in the Cold Auditors and Familiar Auditors tables above.
