// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Integration test for lineage frontmatter end-to-end roundtrip across the
 * two consumer surfaces added in Cycle 1 substrate-extension:
 *
 *   - **Memory frontmatter** (PR-A6 parser; PR-A7 walker is the production
 *     consumer): write a memory file with a `lineage:` block, parse via
 *     `parseMemoryFrontmatterFromFile`, confirm the envelope roundtrips
 *     with all fields preserved.
 *   - **Handoff frontmatter** (PR-A5 parser; PR-A8 skill is the production
 *     emitter): write a handoff file per the PR-A8 Step 4 YAML template
 *     (kind_version + producer_session_id + produced_at + input_body_refs
 *     + input_handoffs), parse via `parseHandoffFrontmatterFromFile`,
 *     confirm the envelope roundtrips.
 *
 * Delta cross-pair-shadow `e50f7950` on PR-A8 noted a load-bearing caveat:
 * PR-A7 + PR-A8 do NOT directly close a single emit→walk→detect loop
 * because PR-A7 walks memory-frontmatter and PR-A8 emits handoff-
 * frontmatter — they're parallel surfaces, not a single chain. This test
 * file covers BOTH parser surfaces via parallel integration paths.
 *
 * Per `[[feedback-cross-edge-contract-via-paired-tests]]` — file I/O
 * roundtrip vs in-memory shape roundtrip catches encoding/decoding
 * regressions that a pure in-memory test cannot (block-style YAML
 * vs inline flow, escape semantics, line-ending tolerance).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLineageEnvelope,
  parseHandoffFrontmatterFromFile,
  parseMemoryFrontmatterFromFile,
  type LineageEnvelope,
} from "../../src/channels/api.ts";

const TEST_SID = "11111111-1111-4111-8111-111111111111";
const PRODUCED_AT = "2026-05-27T12:00:00.000Z";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "lineage-roundtrip-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Serialize a LineageEnvelope as a YAML block sub-object matching the
 * PR-A8 Step 4 template field-ordering convention (substrate type order).
 */
function emitLineageYaml(env: LineageEnvelope): string {
  const lines: string[] = [
    "lineage:",
    `  kind_version: ${env.kind_version}`,
    `  producer_session_id: ${env.producer_session_id}`,
  ];
  if (env.produced_at !== undefined && env.produced_at !== null) {
    lines.push(`  produced_at: ${env.produced_at}`);
  }
  if (env.input_body_refs.length === 0) {
    lines.push(`  input_body_refs: []`);
  } else {
    lines.push(`  input_body_refs:`);
    for (const ref of env.input_body_refs) lines.push(`    - ${ref}`);
  }
  if (Array.isArray(env.input_handoffs) && env.input_handoffs.length > 0) {
    lines.push(`  input_handoffs:`);
    for (const h of env.input_handoffs) lines.push(`    - ${h}`);
  }
  if (env.model !== undefined && env.model !== null) {
    lines.push(`  model: ${env.model}`);
  }
  return lines.join("\n");
}

describe("lineage frontmatter roundtrip — memory surface (PR-A6 parser + PR-A7 walker)", () => {
  it("memory file with full lineage frontmatter roundtrips via parseMemoryFrontmatterFromFile", () => {
    const env = createLineageEnvelope({
      producer_session_id: TEST_SID,
      produced_at: PRODUCED_AT,
      input_body_refs: ["body-ref-a", "body-ref-b"],
      input_handoffs: [
        "HANDOFF_2026-05-26_20-50.md",
        "HANDOFF_2026-05-27_01-29_bravo.md",
      ],
    });
    const content = `---
name: test-memory-with-lineage
description: integration roundtrip test
type: feedback
${emitLineageYaml(env)}
---
body content
`;
    const path = join(sandbox, "test-memory.md");
    writeFileSync(path, content, "utf-8");

    const parsed = parseMemoryFrontmatterFromFile(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("test-memory-with-lineage");
    expect(parsed?.lineage).toBeDefined();
    expect(parsed?.lineage?.kind_version).toBe(1);
    expect(parsed?.lineage?.producer_session_id).toBe(TEST_SID);
    expect(parsed?.lineage?.produced_at).toBe(PRODUCED_AT);
    expect(parsed?.lineage?.input_body_refs).toEqual([
      "body-ref-a",
      "body-ref-b",
    ]);
    expect(parsed?.lineage?.input_handoffs).toEqual([
      "HANDOFF_2026-05-26_20-50.md",
      "HANDOFF_2026-05-27_01-29_bravo.md",
    ]);
  });

  it("memory file with minimal lineage frontmatter (required fields only) roundtrips", () => {
    const env = createLineageEnvelope({
      producer_session_id: TEST_SID,
      input_body_refs: [],
    });
    const content = `---
name: minimal-lineage
description: minimal
type: feedback
${emitLineageYaml(env)}
---
body
`;
    const path = join(sandbox, "minimal-memory.md");
    writeFileSync(path, content, "utf-8");

    const parsed = parseMemoryFrontmatterFromFile(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage?.kind_version).toBe(1);
    expect(parsed?.lineage?.producer_session_id).toBe(TEST_SID);
    expect(parsed?.lineage?.input_body_refs).toEqual([]);
    expect(parsed?.lineage?.input_handoffs).toBeUndefined();
  });

  it("memory file without lineage frontmatter still parses (back-compat)", () => {
    const content = `---
name: legacy-memory
description: pre-lineage memory
type: feedback
---
body
`;
    const path = join(sandbox, "legacy-memory.md");
    writeFileSync(path, content, "utf-8");

    const parsed = parseMemoryFrontmatterFromFile(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage).toBeUndefined();
  });
});

describe("lineage frontmatter roundtrip — handoff surface (PR-A5 parser + PR-A8 emitter)", () => {
  it("handoff file per PR-A8 Step 4 template roundtrips via parseHandoffFrontmatterFromFile", () => {
    const env = createLineageEnvelope({
      producer_session_id: TEST_SID,
      produced_at: PRODUCED_AT,
      input_body_refs: ["audit-body-ref-1"],
      input_handoffs: ["HANDOFF_2026-05-26_20-50.md"],
      model: "claude-opus-4-7",
    });
    const content = `---
session_id: ${TEST_SID}
started_at: 2026-05-27T10:00:00Z
ended_at: ${PRODUCED_AT}
entries_touched: []
${emitLineageYaml(env)}
---

# Handoff: Test Roundtrip
**Date:** 2026-05-27 12:00 UTC
**Working directory:** /tmp/sandbox
**Branch:** main

## Summary

Integration roundtrip test fixture per PR-A8 Step 4 emit template.
`;
    const path = join(sandbox, "HANDOFF_2026-05-27_12-00.md");
    writeFileSync(path, content, "utf-8");

    const parsed = parseHandoffFrontmatterFromFile(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.session_id).toBe(TEST_SID);
    expect(parsed?.lineage).toBeDefined();
    expect(parsed?.lineage?.kind_version).toBe(1);
    expect(parsed?.lineage?.producer_session_id).toBe(TEST_SID);
    expect(parsed?.lineage?.produced_at).toBe(PRODUCED_AT);
    expect(parsed?.lineage?.input_body_refs).toEqual(["audit-body-ref-1"]);
    expect(parsed?.lineage?.input_handoffs).toEqual([
      "HANDOFF_2026-05-26_20-50.md",
    ]);
    expect(parsed?.lineage?.model).toBe("claude-opus-4-7");
  });

  it("handoff file with minimal lineage frontmatter (required fields only) roundtrips", () => {
    const env = createLineageEnvelope({
      producer_session_id: TEST_SID,
      input_body_refs: [],
    });
    const content = `---
session_id: ${TEST_SID}
started_at: 2026-05-27T10:00:00Z
ended_at: ${PRODUCED_AT}
entries_touched: []
${emitLineageYaml(env)}
---

# Handoff: Minimal
`;
    const path = join(sandbox, "HANDOFF_minimal.md");
    writeFileSync(path, content, "utf-8");

    const parsed = parseHandoffFrontmatterFromFile(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage?.kind_version).toBe(1);
    expect(parsed?.lineage?.input_body_refs).toEqual([]);
    expect(parsed?.lineage?.input_handoffs).toBeUndefined();
    expect(parsed?.lineage?.produced_at).toBeUndefined();
  });

  it("handoff file without lineage frontmatter still parses (back-compat)", () => {
    const content = `---
session_id: ${TEST_SID}
started_at: 2026-05-27T10:00:00Z
ended_at: ${PRODUCED_AT}
entries_touched: []
---

# Handoff: Legacy
`;
    const path = join(sandbox, "HANDOFF_legacy.md");
    writeFileSync(path, content, "utf-8");

    const parsed = parseHandoffFrontmatterFromFile(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.lineage).toBeUndefined();
  });
});

describe("lineage frontmatter roundtrip — cross-surface parallel-coverage assertion", () => {
  it("identical LineageEnvelope content roundtrips equivalently across memory + handoff surfaces", () => {
    const env = createLineageEnvelope({
      producer_session_id: TEST_SID,
      produced_at: PRODUCED_AT,
      input_body_refs: ["shared-body-ref"],
      input_handoffs: ["HANDOFF_shared.md"],
    });
    const yaml = emitLineageYaml(env);

    const memSource = `---
name: parallel-mem
description: parallel
type: feedback
${yaml}
---
body
`;
    const memPath = join(sandbox, "parallel-mem.md");
    writeFileSync(memPath, memSource, "utf-8");

    const handoffSource = `---
session_id: ${TEST_SID}
started_at: 2026-05-27T10:00:00Z
ended_at: ${PRODUCED_AT}
entries_touched: []
${yaml}
---

# Handoff: Parallel
`;
    const handoffPath = join(sandbox, "HANDOFF_parallel.md");
    writeFileSync(handoffPath, handoffSource, "utf-8");

    const memParsed = parseMemoryFrontmatterFromFile(memPath);
    const handoffParsed = parseHandoffFrontmatterFromFile(handoffPath);

    expect(memParsed?.lineage).toEqual(handoffParsed?.lineage);
  });
});
