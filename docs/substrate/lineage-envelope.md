# Lineage envelope

Operator + consumer documentation for the Cycle 1 substrate-extension lineage envelope (Pair-A-PR-A1..PR-A9). Layer 2 per-artefact provenance primitive applied to 4 surfaces: audit-verdict bodies, channel-message structured bodies, memory entry frontmatter, and handoff frontmatter.

Source plan: `~/.claude/plans/cycle-1-substrate-extension-slice-plan-2026-05-26.md`. Substrate SSOT: `src/channels/lineage-envelope.ts` (type + parser + constructor + `lineageVerify` stub per PR-A1). Consumer code: PR-A7 (`~/.claude-dotfiles/src/hooks/checks/memory-integrity.ts` + `scripts/memory-archive.ts`); PR-A8 (`commands/session/handoff.md` + `commands/session/handoff-resume.md`); cross-edge tests: `test/cross-edge/lineage-shim-mirror.test.ts` + `test/integration/lineage-frontmatter-roundtrip.test.ts` per PR-A9.

## 1. Overview

The lineage envelope records the **provenance** of an artefact: which session produced it, when, which inputs informed it (other body_refs + other handoffs), optional cost + model attribution. Composition-symmetric across 4 surfaces means the same `LineageEnvelope` shape and SSOT parser flow through each consumer surface, so audit tools (PR-A1..A4 verify CLI) and consumer tools (memory-integrity walker, archive-script skip, resume briefing display) can share validation + display logic.

**Three properties:**

- **Composition-symmetric** — single substrate type + parser used across audit-verdict body, channel-message structured body, memory frontmatter, handoff frontmatter. No per-surface schema drift.
- **Back-compat tolerant** — read-side parsers tolerate envelope absence (`undefined`); strict shape-validation only triggers when the field is present. Legacy artefacts ship unchanged.
- **Forward-compat versioned** — `kind_version: 1` is locked for Cycle 1; mismatched versions return `null` from `parseLineageEnvelope` (skip semantics; sibling to `parseLiveUpdateBody` / `parseDigestBody` / `parseAuditVerdictBody` precedent).

Resolves Bravo PR-A1 Conditions 1+2+3: SSOT parser + canonical-JSON composition with DSSE PAE (audit-verdict surface) + `parseHandoffFrontmatter` strict dispatch (handoff surface).

## 2. Field reference

```typescript
export type LineageEnvelope = {
  kind_version: 1;
  producer_session_id: string;
  produced_at?: string | null;
  input_body_refs: readonly string[];
  input_handoffs?: readonly string[] | null;
  prompt_sha?: string | null;
  model?: string | null;
  cost?: TokenCost | null;
};

export type TokenCost = {
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
};
```

Substrate type lives at `src/channels/lineage-envelope.ts:78-87`. Re-exported via `src/channels/api.ts` for direct consumers; mirrored in dotfiles shim `~/.claude-dotfiles/src/channels/index.ts` for cross-edge consumers (PR #151 handoff parser + PR #152 memory parser shim mirrors).

### Required fields

- **`kind_version`** — fixed at `1`. Required for forward-compat parsing. Mismatched values cause `parseLineageEnvelope` to return `null` (skip semantics).
- **`producer_session_id`** — non-empty string identifying the session that produced the artefact. By cohort convention this is a UUID-shape session id (per `effectiveHome()` + `paths.ts`), but the substrate accepts any non-empty string.
- **`input_body_refs`** — array of `body_ref` UUIDs referencing channel messages that informed this artefact. Empty array `[]` is valid when no specific refs are load-bearing. Each entry must be a non-empty string.

### Optional fields

- **`produced_at`** — ISO-8601 timestamp. Optional per substrate (`?: string | null`); required as a cross-surface convention on handoffs (handoffs always carry `ended_at`). Tolerates explicit `null` or omission.
- **`input_handoffs`** — array of handoff filenames or paths referencing predecessor handoffs in the supersedes chain. Tolerates `null` or omission. Each entry must be a non-empty string. Resolution rules per consumer:
  - Bare filename: `HANDOFF_2026-05-27_01-29_bravo.md`
  - Bare id: `2026-05-27_01-29_bravo` (consumer appends `.md`)
  - Absolute path: `/Users/.../HANDOFF_*.md`
  - The PR-A7 `memory-integrity` hook + PR-A8 handoff-resume parser tolerate all three forms; PR-A8 emitter defaults to bare-filename per template.
- **`prompt_sha`** — reserved for Cycle 2 prompt-hash convention; leave omitted in Cycle 1.
- **`model`** — active model id (e.g., `claude-opus-4-7`). Optional attribution.
- **`cost`** — `TokenCost` record. **Cycle 1 opt-in only** per PUNT-OBS-CL-1: `cost_usd` is a float; `canonical-json.ts` ships an RFC 8785 SUBSET without §3.2.2 full number canonicalization, so cost-populated envelopes may cause sign-verify divergence cross-runtime. Cycle 2 substrate-debt promotes `canonical-json.ts` to full RFC 8785 OR amends `cost_usd` to integer micros (Stripe/PayPal precedent: 1200 micros = $0.0012). Until Cycle 2 closes this, prefer omitting `cost` on signed envelopes.

## 3. Operator workflow

### Construct an envelope

```typescript
import { createLineageEnvelope } from "claude-conductor/channels/api";

const env = createLineageEnvelope({
  producer_session_id: process.env["CLAUDE_SESSION_ID"]!,
  produced_at: new Date().toISOString(),
  input_body_refs: ["audit-body-ref-1"],
  input_handoffs: ["HANDOFF_2026-05-26_20-50.md"],
  model: "claude-opus-4-7",
});
```

`producer_session_id` defaults from `CLAUDE_SESSION_ID` env var when omitted from opts; throws if both omitted-arg AND env-absent.

### Emit on a handoff (PR-A8)

Per `commands/session/handoff.md` Step 3.5: assemble the envelope alongside the existing telemetry fields and emit as a block-style YAML sub-object in the handoff frontmatter. The Step 4 template fixes the field-ordering convention to match the substrate type order so write-side, read-side, and template emission stay in lockstep:

```yaml
---
session_id: <id>
started_at: <iso-8601>
ended_at: <iso-8601>
entries_touched: []
lineage:
  kind_version: 1
  producer_session_id: <id>
  produced_at: <iso-8601>
  input_body_refs: []
  input_handoffs:
    - HANDOFF_<prior>.md
---
```

**Fail-silent contract:** if any required field can't be resolved (e.g., telemetry absent → no `session_id`), OMIT the entire `lineage:` field. A missing envelope is back-compat valid (the optional read-side tolerates absence); a malformed one is not — the strict-parser will reject the whole frontmatter wholesale.

### Emit on a memory file

Memory frontmatter emit is operator-driven (memory files are written by hand or by future memorialization tooling). The shape mirrors handoff emit but lives in memory frontmatter:

```yaml
---
name: my-memory
description: ...
type: feedback
lineage:
  kind_version: 1
  producer_session_id: <id>
  input_body_refs:
    - <body-ref>
  input_handoffs:
    - HANDOFF_<source>.md
---
```

### Emit on an audit-verdict body (PR-A2)

`AuditVerdictBody.lineage?: LineageEnvelope | null` field; populated at audit-verdict construction time before DSSE wrap. Lineage gets canonical-JSON-encoded into the payload bytes per `canonicalJson()` and is signature-covered automatically via DSSE PAE. See `test/channels/audit-verdict.test.ts` Section 15 for shape + DSSE roundtrip coverage.

## 4. Consumer workflow

### Parse an envelope from arbitrary input

```typescript
import { parseLineageEnvelope } from "claude-conductor/channels/api";

const parsed = parseLineageEnvelope(maybeEnvelope);
if (parsed === null) {
  // Shape-invalid or kind_version mismatch — skip or back-compat fall-through
}
```

`parseLineageEnvelope` tolerates string input (JSON-parse first) OR object input (skip parse). Returns `null` on shape violation.

### Parse from a memory file (PR-A6)

```typescript
import { parseMemoryFrontmatterFromFile } from "claude-conductor/channels/api";

const memory = parseMemoryFrontmatterFromFile(path);
if (memory?.lineage !== undefined) {
  // memory.lineage is a valid LineageEnvelope (substrate dispatched through parseLineageEnvelope)
  for (const handoff of memory.lineage.input_handoffs ?? []) {
    // walk handoff refs
  }
}
```

### Parse from a handoff file (PR-A5)

```typescript
import { parseHandoffFrontmatterFromFile } from "claude-conductor/channels/api";

const handoff = parseHandoffFrontmatterFromFile(path);
if (handoff?.lineage !== undefined) {
  // Render in the resume briefing per PR-A8 Step 3 format
}
```

### Walk dangling refs (PR-A7 memory-integrity hook)

The dotfiles `memory-integrity` Stop hook surfaces a 6th signal (`lineage-dangling handoff refs`) when a memory's `lineage.input_handoffs` entries don't resolve to existing handoff files. See `~/.claude-dotfiles/src/hooks/checks/memory-integrity.ts:177` for the walker; env override `MEMORY_INTEGRITY_HANDOFFS_DIR` for testing.

### Skip from archival (PR-A7 memory-archive script)

The dotfiles `memory-archive.ts` script skips memories with a `lineage:` frontmatter marker from the default 30d archival path; lineage presence signals explicit provenance metadata (audit trail). Precedence order:

1. `archive: never` operator marker → full silent skip
2. `violation_count_recent > 0` (sidecar) → still flagged for REVIEW (operator wants violation visibility regardless of provenance)
3. `apply_count_recent >= 1` → silent skip (not stale)
4. **lineage marker → silent skip (NEW PR-A7)**
5. `mtime > thresholdDays` → flagged as `sidecar-empty-30d` candidate

See `~/.claude-dotfiles/scripts/memory-archive.ts:148` for `hasLineageMarker` + line 205 for the skip.

## 5. Cross-edge consumers

5 documented touchpoints (per `test/cross-edge/lineage-shim-mirror.test.ts` Section 3):

| Consumer                | Surface                              | Behavior                                                            |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `dotfiles-shim`         | re-exports via `index.ts`            | PR #151 + #152 mirror; identical shape contract                     |
| `memory-integrity-hook` | `memory-integrity.ts`                | 6th signal: walks `input_handoffs`, surfaces dangling refs          |
| `memory-archive-script` | `memory-archive.ts`                  | `hasLineageMarker` skip from default 30d archival                   |
| `handoff-write-skill`   | `commands/session/handoff.md`        | Step 3.5 assembles envelope; Step 4 emits in frontmatter            |
| `handoff-resume-skill`  | `commands/session/handoff-resume.md` | Step 1 parses via PR-A5 dispatch; Step 3 renders `**Lineage:**` row |

Drift detection: any change to the substrate type or parser surface MUST update the shim mirror at the same time (per `[[feedback-substrate-shim-mirror-on-plugin-export-changes]]`). The paired-contract test at `test/cross-edge/lineage-shim-mirror.test.ts` catches surface drift; the file-I/O roundtrip at `test/integration/lineage-frontmatter-roundtrip.test.ts` catches encoding drift.

## 6. Composition with `lineage verify` CLI (PR-A4)

```bash
bun run conductor lineage verify <body-ref> [--pubkey-dir <dir>] [--strict]
```

Library entry point: `lineageVerify(target, opts)` returns `LineageVerifyOutput` per `src/channels/lineage-envelope.ts:100`. Cycle 1 ships the library stub (returns `sig_chain_status: "skip-not-in-channel"`); PR-A4 wires actual channel-message lookup + delegates to Pair B's `audit verify` CLI for sig-chain status.

Exit code matrix per §3.1 LOCKED contract:

- `0` = ok (`ok: true`)
- `1` = broken (signature chain mismatch OR `--strict` partial promotion)
- `2` = partial (unresolved inputs OR skip semantics)
- `3` = unsupported (envelope unparseable)

## 7. Forward-compat notes

**Cycle 2 substrate-debt items** referenced from this envelope:

1. **`canonical-json.ts` RFC 8785 §3.2.2 full number canonicalization** — required to make `cost.cost_usd` (float) reproducible cross-runtime; currently PUNT-OBS-CL-1.
2. **`cost.cost_usd` → integer micros** — alternative to (1); precedent at Stripe / PayPal. Pair B Cycle 2 lane to decide.
3. **`prompt_sha` canonical convention** — no canonical prompt-hash convention yet; field reserved for Cycle 2+.

`kind_version: 1` is locked. Any field-set change requires `kind_version: 2` + parallel parser support per Sigstore "parse-all-versions-simultaneously" precedent.

## 8. References

- Substrate SSOT: `src/channels/lineage-envelope.ts` (PR-A1)
- API re-export: `src/channels/api.ts:249-289` (PR-A2/A5/A6 chained re-exports)
- Audit-verdict integration: `src/channels/audit-verdict.ts` `AuditVerdictBody.lineage` field (PR-A2)
- Handoff parser: `src/channels/handoff-body-parser.ts` (PR-A5)
- Memory parser: `src/channels/memory-frontmatter-parser.ts` (PR-A6)
- Dotfiles consumers: `~/.claude-dotfiles/src/hooks/checks/memory-integrity.ts` + `~/.claude-dotfiles/scripts/memory-archive.ts` (PR-A7; claude-dotfiles #153)
- Skill emit + display: `commands/session/handoff.md` + `commands/session/handoff-resume.md` (PR-A8; conductor #140)
- Cross-edge tests: `test/cross-edge/lineage-shim-mirror.test.ts` + `test/integration/lineage-frontmatter-roundtrip.test.ts` (PR-A9; conductor #141)
- Discipline pattern: `[[feedback-substrate-precedent-as-design-rescue]]`, `[[feedback-cross-edge-contract-via-paired-tests]]`, `[[feedback-substrate-shim-mirror-on-plugin-export-changes]]`
