// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Conductor-side paired-contract test for the lineage envelope shim mirror
 * (Cycle 1 Pair-A-PR-A9; cross-edge surface for PR-A1/A2/A5/A6 chain).
 *
 * Paired-contract pattern per `[[feedback-cross-edge-contract-via-paired-tests]]`:
 *
 * Conductor side (this file) asserts the substrate-canonical `api.ts`
 * surface for the lineage envelope (PR-A1) + the two strict-frontmatter
 * parsers that consume it: HandoffFrontmatter (PR-A5) + MemoryFrontmatter
 * (PR-A6). The dotfiles shim mirror (PR #151 for handoff parser; PR #152
 * for memory parser) re-exports these symbols; the dotfiles-side test in
 * `~/.claude-dotfiles/src/channels/index.test.ts` asserts the shim
 * re-exports the same symbols with identical behavior.
 *
 * Cross-edge contract: any consumer importing
 * `claude-conductor/channels/api` (via `api.ts` directly OR via dotfiles
 * shim re-export) gets the same surface for these symbols:
 *
 *   types: LineageEnvelope, TokenCost, CreateLineageEnvelopeOpts,
 *          HandoffFrontmatter, MemoryFrontmatter
 *   values: parseLineageEnvelope, isLineageEnvelope, createLineageEnvelope,
 *           parseHandoffFrontmatter, parseHandoffFrontmatterFromFile,
 *           parseMemoryFrontmatter, parseMemoryFrontmatterFromFile
 *
 * Drift between substrate and shim is detected here BEFORE downstream
 * consumer breakage (PR-A7 memory-integrity hook + memory-archive script +
 * PR-A8 handoff write/resume skills).
 */

import { describe, expect, it } from "bun:test";

import {
  createLineageEnvelope,
  isLineageEnvelope,
  parseHandoffFrontmatter,
  parseLineageEnvelope,
  parseMemoryFrontmatter,
  type CreateLineageEnvelopeOpts,
  type HandoffFrontmatter,
  type LineageEnvelope,
  type MemoryFrontmatter,
  type TokenCost,
} from "../../src/channels/api.ts";

const TEST_SID = "11111111-1111-4111-8111-111111111111";

const MINIMAL_OPTS: CreateLineageEnvelopeOpts = {
  producer_session_id: TEST_SID,
  input_body_refs: [],
};

const FULL_OPTS: CreateLineageEnvelopeOpts = {
  producer_session_id: TEST_SID,
  produced_at: "2026-05-27T12:00:00.000Z",
  input_body_refs: ["body-ref-1", "body-ref-2"],
  input_handoffs: ["HANDOFF_2026-05-26_20-50.md"],
  model: "claude-opus-4-7",
};

describe("lineage shim mirror — Section 1: api.ts surface contract", () => {
  it("T1.1: parseLineageEnvelope is exported as a function via api.ts", () => {
    expect(typeof parseLineageEnvelope).toBe("function");
  });

  it("T1.2: isLineageEnvelope is exported as a function via api.ts", () => {
    expect(typeof isLineageEnvelope).toBe("function");
  });

  it("T1.3: createLineageEnvelope is exported as a function via api.ts", () => {
    expect(typeof createLineageEnvelope).toBe("function");
  });

  it("T1.4: parseMemoryFrontmatter is exported as a function via api.ts", () => {
    expect(typeof parseMemoryFrontmatter).toBe("function");
  });

  it("T1.5: parseHandoffFrontmatter is exported as a function via api.ts", () => {
    expect(typeof parseHandoffFrontmatter).toBe("function");
  });

  it("T1.6: LineageEnvelope + TokenCost + CreateLineageEnvelopeOpts types are structurally usable", () => {
    const env: LineageEnvelope = {
      kind_version: 1,
      producer_session_id: TEST_SID,
      input_body_refs: [],
    };
    const cost: TokenCost = { input_tokens: 0, output_tokens: 0 };
    const opts: CreateLineageEnvelopeOpts = {
      producer_session_id: TEST_SID,
      input_body_refs: [],
    };
    expect(env.kind_version).toBe(1);
    expect(cost.input_tokens).toBe(0);
    expect(opts.input_body_refs).toEqual([]);
  });

  it("T1.7: HandoffFrontmatter + MemoryFrontmatter types are structurally usable", () => {
    const hf: HandoffFrontmatter = {
      session_id: TEST_SID,
      started_at: "2026-05-27T10:00:00Z",
      ended_at: "2026-05-27T12:00:00Z",
      entries_touched: [],
    };
    const mf: MemoryFrontmatter = {
      name: "x",
      description: "x",
      type: "feedback",
    };
    expect(hf.session_id).toBe(TEST_SID);
    expect(mf.type).toBe("feedback");
  });
});

describe("lineage shim mirror — Section 2: behavioral roundtrip via api.ts", () => {
  it("T2.1: createLineageEnvelope produces a parseable envelope (minimal opts)", () => {
    const env = createLineageEnvelope(MINIMAL_OPTS);
    expect(env.kind_version).toBe(1);
    expect(env.producer_session_id).toBe(TEST_SID);
    expect(env.input_body_refs).toEqual([]);
  });

  it("T2.2: createLineageEnvelope -> parseLineageEnvelope roundtrip preserves all fields", () => {
    const env = createLineageEnvelope(FULL_OPTS);
    const parsed = parseLineageEnvelope(env);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind_version).toBe(1);
    expect(parsed?.producer_session_id).toBe(TEST_SID);
    expect(parsed?.produced_at).toBe("2026-05-27T12:00:00.000Z");
    expect(parsed?.input_body_refs).toEqual(["body-ref-1", "body-ref-2"]);
    expect(parsed?.input_handoffs).toEqual(["HANDOFF_2026-05-26_20-50.md"]);
    expect(parsed?.model).toBe("claude-opus-4-7");
  });

  it("T2.3: isLineageEnvelope returns true for a constructed envelope", () => {
    const env = createLineageEnvelope(FULL_OPTS);
    expect(isLineageEnvelope(env)).toBe(true);
  });

  it("T2.4: parseLineageEnvelope returns null for kind_version mismatch (forward-compat skip)", () => {
    const bad = {
      kind_version: 2,
      producer_session_id: TEST_SID,
      input_body_refs: [],
    };
    expect(parseLineageEnvelope(bad)).toBeNull();
  });

  it("T2.5: parseLineageEnvelope returns null for missing producer_session_id", () => {
    const bad = { kind_version: 1, input_body_refs: [] };
    expect(parseLineageEnvelope(bad)).toBeNull();
  });

  it("T2.6: parseLineageEnvelope rejects empty-string entry in input_handoffs", () => {
    const bad = {
      kind_version: 1,
      producer_session_id: TEST_SID,
      input_body_refs: [],
      input_handoffs: [""],
    };
    expect(parseLineageEnvelope(bad)).toBeNull();
  });

  it("T2.7: parseMemoryFrontmatter dispatches lineage sub-object through parseLineageEnvelope", () => {
    const source = `---
name: test-memory
description: test
type: feedback
lineage:
  kind_version: 1
  producer_session_id: ${TEST_SID}
  input_body_refs: []
  input_handoffs:
    - HANDOFF_test.md
---
body
`;
    const parsed = parseMemoryFrontmatter(source);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage?.kind_version).toBe(1);
    expect(parsed?.lineage?.producer_session_id).toBe(TEST_SID);
    expect(parsed?.lineage?.input_handoffs).toEqual(["HANDOFF_test.md"]);
  });

  it("T2.8: parseMemoryFrontmatter back-compat: lineage absent is undefined", () => {
    const source = `---
name: legacy
description: legacy
type: feedback
---
body
`;
    const parsed = parseMemoryFrontmatter(source);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage).toBeUndefined();
  });

  it("T2.9: parseHandoffFrontmatter dispatches lineage sub-object through parseLineageEnvelope", () => {
    const source = `---
session_id: ${TEST_SID}
started_at: 2026-05-27T10:00:00Z
ended_at: 2026-05-27T12:00:00Z
entries_touched: []
lineage:
  kind_version: 1
  producer_session_id: ${TEST_SID}
  input_body_refs:
    - audit-1
  input_handoffs:
    - HANDOFF_prior.md
---

# Handoff: x
`;
    const parsed = parseHandoffFrontmatter(source);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage?.kind_version).toBe(1);
    expect(parsed?.lineage?.input_body_refs).toEqual(["audit-1"]);
    expect(parsed?.lineage?.input_handoffs).toEqual(["HANDOFF_prior.md"]);
  });

  it("T2.10: parseHandoffFrontmatter back-compat: lineage absent is undefined", () => {
    const source = `---
session_id: ${TEST_SID}
started_at: 2026-05-27T10:00:00Z
ended_at: 2026-05-27T12:00:00Z
entries_touched: []
---

# Handoff: legacy
`;
    const parsed = parseHandoffFrontmatter(source);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage).toBeUndefined();
  });
});

describe("lineage shim mirror — Section 3: paired-contract documentation", () => {
  it("T3.1: cross-edge consumers documented (substrate-canonical contract list)", () => {
    const CROSS_EDGE_CONSUMERS = [
      "dotfiles-shim",
      "memory-integrity-hook",
      "memory-archive-script",
      "handoff-write-skill",
      "handoff-resume-skill",
    ] as const;
    expect(CROSS_EDGE_CONSUMERS.length).toBe(5);
    expect(CROSS_EDGE_CONSUMERS).toContain("dotfiles-shim");
    expect(CROSS_EDGE_CONSUMERS).toContain("memory-integrity-hook");
    expect(CROSS_EDGE_CONSUMERS).toContain("memory-archive-script");
    expect(CROSS_EDGE_CONSUMERS).toContain("handoff-write-skill");
    expect(CROSS_EDGE_CONSUMERS).toContain("handoff-resume-skill");
  });
});
