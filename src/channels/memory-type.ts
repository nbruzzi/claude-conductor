// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Shared `MemoryType` vocabulary — the 4 canonical memory categories
 * from CLAUDE.md `## Types of memory` discipline.
 *
 * **Extraction history:** Originally lived inline in
 * `memory-proposal.ts` (Tier 2 Verb 2 cycle 2026-05-20) with a JSDoc
 * note predicting extraction "if Tier-3 memory primitives pull into a
 * current cohort". PR-A6 (Cycle 1 substrate-extension, the new
 * `memory-frontmatter-parser.ts`) is that trigger — extracted here per
 * the predicted plan + `feedback-substrate-precedent-as-design-rescue`
 * discipline.
 *
 * Two current consumers:
 *
 *   - `memory-proposal.ts` (channel-kind `memory-proposal` body schema;
 *     `memory_type` field validation)
 *   - `memory-frontmatter-parser.ts` (memory-file frontmatter `type:`
 *     field, accepted at top-level OR under `metadata.type:`)
 *
 * `api.ts` re-exports `MEMORY_TYPES` + `isMemoryType` via
 * `memory-proposal.ts` (transitive re-export preserves the public
 * surface unchanged across the extraction).
 */

/**
 * The 4 canonical memory types from CLAUDE.md `## Types of memory`
 * discipline. Ordered to match the original `memory-proposal.ts`
 * tuple shape (user / feedback / project / reference) to keep any
 * downstream order-sensitive callers stable across the extraction.
 */
export const MEMORY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const satisfies readonly string[];

/** A memory type as a literal-union string type. */
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Set form of `MEMORY_TYPES` for O(1) membership checks. */
const MEMORY_TYPE_SET: ReadonlySet<string> = new Set(MEMORY_TYPES);

/** Type guard: validates that `v` is one of the valid `MemoryType` literals. */
export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && MEMORY_TYPE_SET.has(v);
}
