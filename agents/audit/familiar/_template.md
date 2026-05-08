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
  plugin:
    - INDEX.md # or CHANGELOG.md, CONTRIBUTING.md, etc.
  memory:
    - TBD # list bundled memories that anchor the discipline
origin: template
---

# Familiar Auditor Template

This is the structural shape of a project-specific familiar auditor. It is intentionally **not registered** in `audit/registry.md` (no triggers list = the audit skill never picks it). Use it as the starting point for adding a domain-specific auditor that captures your project's thesis.

## How to customize

1. **Replace the frontmatter placeholders.** Pick a `name` (e.g., "Marketplace Trust Auditor", "Localization Auditor", "Legacy-Migration Auditor"), a `description` (one-line summary of what gets caught), a `domain` slug (used for selection heuristics), an `expertise` list (6-8 specific areas the auditor knows), a `triggers` list (keyword regex; word-boundary matched), an `adversarial_lens` (one-question framing of the audit lens), and a `context_sources` block (memories that anchor the discipline — must resolve within `<plugin-root>/memories/`).
2. **Write the body.** Two sections matter: "Your Expertise" (a paragraph or two anchoring what the auditor knows about the project's specific thesis) and "Audit Protocol" (a numbered list of checks the auditor runs against any plan).
3. **Register the auditor.** Add the row to `audit/registry.md`'s Familiar Auditors table AND to the Machine-readable index TSV. Bump the header counts at the top of the registry file. Pick a unique 2-4 letter prefix for findings.
4. **Verify trigger overlap.** Run a quick check that the new auditor's triggers don't overlap >50% with any existing familiar — the registry's lens-diversity rule needs to hold.
5. **Test the wiring.** Commission an audit on a tiny test plan that should trigger the new auditor; confirm it gets selected and produces structured output.

## Why this template ships unregistered

The plugin's audit board is intentionally domain-agnostic — the four registered familiars (ARCH, CS, KS, WP) cover plugin-internal disciplines (architecture integration, code standards, knowledge system, workflow process). For project-specific theses (e.g., a marketplace's two-sided economic discipline, a CMS's content-modeling discipline, a heavily-localized app's i18n discipline), the project author should clone this template and customize. Shipping the template registered would commit the plugin to a domain it doesn't have context for; shipping it unregistered demonstrates the registry's extensibility story without overcommitting.

## Example structures (illustrative; not exhaustive)

The "Audit Protocol" should follow the cold-auditor shape — 10-12 numbered checks, scoring guidance, output format. Look at any of `cold/*.md` for the structural template; copy the pattern and substitute your domain's specific checks.

The "Your Expertise" paragraph should establish the auditor's frame: what does it know about the project that an outside expert wouldn't? What drift looks like in this domain? What does the auditor flag as load-bearing vs cosmetic? The Architecture Auditor's body section is a good reference for the expected depth.

## Output Format

The auditor's output structure follows the registry's standard:

```
## <Auditor Name> Audit

**Score:** X.X/10
**Lens:** <adversarial_lens verbatim>

### Critical Findings

1. [<PREFIX>-1] [critical/major/minor] — description
   **Risk:** what goes wrong if ignored
   **Fix:** specific, actionable change

### Strengths

- (brief)

### Cross-cutting Concerns

- (domain-specific systemic concerns)

### Verdict

Ship / don't ship / ship with conditions (one paragraph)
```

Replace `<Auditor Name>` and `<PREFIX>` with the values from your customized frontmatter.
