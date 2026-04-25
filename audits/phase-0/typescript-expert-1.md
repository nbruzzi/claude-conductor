<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Phase 0 Audit — TypeScript Expert (sub-step 0.4)

**Subject:** `src/memory-loader/index.ts` + `src/shared/paths.ts` (sub-step 0.4 + 0.5 implementation)
**Date:** 2026-04-26
**Persona:** TypeScript Expert (single-persona inline review, code-substrate)
**Score:** 8.5/10
**Verdict:** Ship-with-X-fix (TS-1, TS-2, TS-3 fixed before commit)

## Scope dispatched

Type-design integrity review on the new memory-loader + path-resolver code. Audited for: type-level lies, unchecked casts, type-design gaps, error-handling explicitness, V2 schema vocabulary completeness, test coverage of design invariants.

## Findings

| ID   | Severity | Summary                                                                                                                                                                                                                                                                                                                    |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS-1 | major    | `validateFrontmatter` return type `MemoryFrontmatter \| string` is not idiomatic. Forces `typeof === "string"` discriminator at call site. Should be discriminated union `{ ok: true; value } \| { ok: false; reason }`.                                                                                                   |
| TS-2 | major    | `as Cadence` / `as Scope` / `as Origin` casts at lines 147–148 + 127 are redundant given immediate prior validation, but the locals were re-fetched after validation and have widened back to `string \| undefined`. Should use user-defined type predicates (`isCadence`, `isScope`, `isOrigin`) to narrow without casts. |
| TS-3 | major    | `MemoryFrontmatter.type: string` is weakly typed. The frontmatter clearly expects an enumeration but the loader treats it as free text. Should narrow to `MemoryType = "feedback" \| "user" \| "project" \| "reference"` (V2 vocabulary).                                                                                  |
| TS-4 | minor    | `parseFrontmatter` defensive null checks for regex captures are dead code. Lowest priority.                                                                                                                                                                                                                                |
| TS-5 | minor    | Test coverage gap: no fixture covering malformed-key case (typo as missing-required-field).                                                                                                                                                                                                                                |
| TS-6 | minor    | `paths.ts` overly defensive `&& length > 0` checks. Style nit, not a bug.                                                                                                                                                                                                                                                  |
| TS-7 | minor    | `NAMESPACE_PREFIX_VALUE` is a duplicate re-export of `NAMESPACE_PREFIX`. Two names invite drift.                                                                                                                                                                                                                           |

## Resolution

Integrated in commit `d79cbad` on branch `phase-0-initial-scaffold`:

- TS-1 — discriminated union shipped (`ValidateResult` type, `validated.ok` discriminator at call site).
- TS-2 — user-defined type predicates (`isMemoryType`, `isCadence`, `isScope`, `isOrigin`) shipped; casts removed.
- TS-3 — `MemoryType` string-literal union shipped (`feedback | user | project | reference`).
- TS-5 — `feedback-typoed-key.md` fixture + corresponding test added (asserts typo-as-missing behavior is intentional).
- TS-7 — `NAMESPACE_PREFIX_VALUE` removed; `NAMESPACE_PREFIX` is canonical.

Skipped:

- TS-4 — switched to destructuring per auditor's secondary suggestion (`const [, block, body] = match`); same defensive shape, cleaner.
- TS-6 — kept explicit `&& length > 0` checks; the explicit length guard defends against `process.env["X"] = ""` edge cases.

## Verification

No round 2 dispatched — this was a sub-step inline audit, not a phase-terminal audit. Code passes typecheck/lint/format/test gates. The Phase 0 terminal audit (sub-step 0.10, 4-persona) re-evaluates the full code surface.

## Strengths noted

- `readonly` modifiers throughout `MemoryEntry` / `MemoryLoadResult`.
- Conditional spread for `origin` respects `exactOptionalPropertyTypes`.
- Explicit error-handling everywhere — no silent swallowing.
- `paths.ts` `COMPONENT_SPECS: { readonly [K in ComponentName]: ComponentSpec }` enforces exhaustiveness.
- 32 tests covering happy/error paths + filtering + formatting.

## Decision-log entry

`decisions/phase-0.md` § "2026-04-26 — Sub-step 0.4: memory-loader shipped with TS Expert audit findings integrated".
