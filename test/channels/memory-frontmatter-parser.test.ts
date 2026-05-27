// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * PR-A6 unit tests for `parseMemoryFrontmatter` + `parseMemoryFrontmatterFromFile`.
 *
 * Coverage axes:
 *
 *   - Required-field validation (name + description + type — where
 *     `type` may live at top-level OR under `metadata.type`)
 *   - Optional field handling (originSessionId from flat OR metadata;
 *     archive marker; cadence; scope; node_type)
 *   - Both authoring vintages (flat-fields style; nested-metadata style)
 *   - PR-A6 extension: lineage block-style + inline-JSON-flow + malformed
 *   - File-reading wrapper happy path + ENOENT throw
 *   - Roundtrip on real memory-file shapes observed in
 *     `~/.claude/projects/<encoded-cwd>/memory/feedback-*.md`
 *
 * Mirrors the test-style precedent set by `handoff-body-parser.test.ts`
 * PR-A5 cases (FM-1..FM-29).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseMemoryFrontmatter,
  parseMemoryFrontmatterFromFile,
  type MemoryFrontmatter,
} from "../../src/channels/memory-frontmatter-parser.ts";
import type { LineageEnvelope } from "../../src/channels/lineage-envelope.ts";

const VALID_LINEAGE: LineageEnvelope = {
  kind_version: 1,
  producer_session_id: "session-uuid-1",
  input_body_refs: ["ref-a", "ref-b"],
};

const MIN_FLAT_FM = `---
name: foo-memo
description: minimal feedback memo
type: feedback
---

memo body content
`;

const MIN_NESTED_FM = `---
name: bar-memo
description: minimal feedback memo (nested metadata vintage)
metadata:
  type: feedback
---

memo body content
`;

describe("parseMemoryFrontmatter — required fields", () => {
  it("MF-1: parses minimal flat-style frontmatter (3 required fields)", () => {
    const fm = parseMemoryFrontmatter(MIN_FLAT_FM);
    expect(fm).not.toBeNull();
    expect(fm).toEqual({
      name: "foo-memo",
      description: "minimal feedback memo",
      type: "feedback",
    });
  });

  it("MF-2: parses minimal nested-metadata style (type lives under metadata.type)", () => {
    const fm = parseMemoryFrontmatter(MIN_NESTED_FM);
    expect(fm).not.toBeNull();
    expect(fm?.type).toBe("feedback");
    expect(fm?.name).toBe("bar-memo");
  });

  it("MF-3: returns null when source has no frontmatter block", () => {
    expect(parseMemoryFrontmatter("just a body, no frontmatter")).toBeNull();
  });

  it("MF-4: returns null when frontmatter opens but never closes", () => {
    expect(
      parseMemoryFrontmatter(
        "---\nname: foo\ndescription: x\ntype: feedback\n",
      ),
    ).toBeNull();
  });

  it("MF-5: returns null when name is missing", () => {
    const fm = `---
description: feedback memo
type: feedback
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });

  it("MF-6: returns null when name is empty", () => {
    const fm = `---
name:
description: feedback memo
type: feedback
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });

  it("MF-7: returns null when description is missing", () => {
    const fm = `---
name: foo
type: feedback
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });

  it("MF-8: returns null when type is missing from both flat AND metadata", () => {
    const fm = `---
name: foo
description: feedback memo
metadata:
  originSessionId: abc
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });

  it("MF-9: returns null when type is not a valid MemoryType", () => {
    const fm = `---
name: foo
description: feedback memo
type: not-a-real-type
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });
});

describe("parseMemoryFrontmatter — type vocabulary", () => {
  it.each(["feedback", "user", "project", "reference"] as const)(
    "MF-10: accepts valid MemoryType '%s' at top level",
    (type) => {
      const fm = `---
name: foo
description: memo
type: ${type}
---
`;
      const result = parseMemoryFrontmatter(fm);
      expect(result?.type).toBe(type);
    },
  );

  it.each(["feedback", "user", "project", "reference"] as const)(
    "MF-11: accepts valid MemoryType '%s' under metadata.type",
    (type) => {
      const fm = `---
name: foo
description: memo
metadata:
  type: ${type}
---
`;
      const result = parseMemoryFrontmatter(fm);
      expect(result?.type).toBe(type);
    },
  );
});

describe("parseMemoryFrontmatter — optional fields", () => {
  it("MF-12: parses flat-style originSessionId", () => {
    const fm = `---
name: foo
description: memo
type: feedback
originSessionId: session-uuid-flat
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.originSessionId).toBe("session-uuid-flat");
  });

  it("MF-13: parses nested-style originSessionId (from metadata)", () => {
    const fm = `---
name: foo
description: memo
metadata:
  type: feedback
  originSessionId: session-uuid-nested
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.originSessionId).toBe("session-uuid-nested");
  });

  it("MF-14: parses archive: never marker", () => {
    const fm = `---
name: foo
description: memo
type: feedback
archive: never
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.archive).toBe("never");
  });

  it("MF-15: rejects archive value other than 'never'", () => {
    const fm = `---
name: foo
description: memo
type: feedback
archive: sometimes
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });

  it("MF-16: parses cadence + scope discipline tags", () => {
    const fm = `---
name: foo
description: memo
type: feedback
cadence: stable
scope: global
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.cadence).toBe("stable");
    expect(result?.scope).toBe("global");
  });

  it("MF-17: parses node_type only from metadata (no flat fallback)", () => {
    const fm = `---
name: foo
description: memo
metadata:
  type: feedback
  node_type: memory
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.node_type).toBe("memory");
  });

  it("MF-18: rejects optional field with empty value (no silent-tolerance)", () => {
    const fm = `---
name: foo
description: memo
type: feedback
cadence:
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });
});

describe("parseMemoryFrontmatter — lineage extension", () => {
  it("MF-19: parser tolerates absent lineage (back-compat)", () => {
    const result = parseMemoryFrontmatter(MIN_FLAT_FM);
    expect(result?.lineage).toBeUndefined();
  });

  it("MF-20: parses block-style lineage envelope", () => {
    const fm = `---
name: foo
description: memo
type: feedback
lineage:
  kind_version: 1
  producer_session_id: session-uuid-1
  input_body_refs:
    - ref-a
    - ref-b
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.lineage).toEqual(VALID_LINEAGE);
  });

  it("MF-21: parses block-style lineage with all optional fields", () => {
    const fm = `---
name: foo
description: memo
type: feedback
lineage:
  kind_version: 1
  producer_session_id: producer-uuid
  input_body_refs:
    - ref-a
  produced_at: 2026-05-26T17:00:00Z
  model: claude-opus-4-7
  prompt_sha: deadbeef
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.lineage).toEqual({
      kind_version: 1,
      producer_session_id: "producer-uuid",
      input_body_refs: ["ref-a"],
      produced_at: "2026-05-26T17:00:00Z",
      model: "claude-opus-4-7",
      prompt_sha: "deadbeef",
    });
  });

  it("MF-22: parses inline JSON-flow lineage", () => {
    const fm = `---
name: foo
description: memo
type: feedback
lineage: {"kind_version":1,"producer_session_id":"producer-uuid","input_body_refs":["ref-a"]}
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.lineage).toEqual({
      kind_version: 1,
      producer_session_id: "producer-uuid",
      input_body_refs: ["ref-a"],
    });
  });

  it("MF-23: returns null on lineage wrong kind_version (delegates to parseLineageEnvelope)", () => {
    const fm = `---
name: foo
description: memo
type: feedback
lineage:
  kind_version: 2
  producer_session_id: producer-uuid
  input_body_refs:
    - ref-a
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });

  it("MF-24: returns null on lineage missing required producer_session_id", () => {
    const fm = `---
name: foo
description: memo
type: feedback
lineage:
  kind_version: 1
  input_body_refs:
    - ref-a
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });

  it("MF-25: returns null on malformed inline-JSON lineage", () => {
    const fm = `---
name: foo
description: memo
type: feedback
lineage: {not valid json}
---
`;
    expect(parseMemoryFrontmatter(fm)).toBeNull();
  });
});

describe("parseMemoryFrontmatter — quoted scalars", () => {
  it("MF-26: handles double-quoted description (newer-vintage form)", () => {
    const fm = `---
name: foo
description: "Audit cycle catching layers conventionally count 4 (local-pipeline / CI / subagent-lens / cross-audit-on-diff)."
type: feedback
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.description).toBe(
      "Audit cycle catching layers conventionally count 4 (local-pipeline / CI / subagent-lens / cross-audit-on-diff).",
    );
  });

  it("MF-27: handles single-quoted scalar", () => {
    const fm = `---
name: foo
description: 'wrapped in single quotes'
type: feedback
---
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result?.description).toBe("wrapped in single quotes");
  });
});

describe("parseMemoryFrontmatter — real-shape roundtrip", () => {
  it("MF-28: parses real ceiling-standard.md shape (flat + cadence + scope)", () => {
    const fm = `---
name: Shoot for the ceiling, never settle
description: User expects tier-1 ceiling-quality work in plans and recommendations
type: feedback
originSessionId: cbdc1066-3b4b-41ff-9794-3999bce3ea51
cadence: stable
scope: global
---

body
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Shoot for the ceiling, never settle");
    expect(result?.type).toBe("feedback");
    expect(result?.originSessionId).toBe(
      "cbdc1066-3b4b-41ff-9794-3999bce3ea51",
    );
    expect(result?.cadence).toBe("stable");
    expect(result?.scope).toBe("global");
  });

  it("MF-29: parses real nested-metadata vintage with quoted description", () => {
    const fm = `---
name: pre-execution-empirical-verify-as-5th-catching-layer
description: "Audit cycle catching layers conventionally count 4."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 50562c36-9297-4d61-9fa2-2995b7919542
---

body
`;
    const result = parseMemoryFrontmatter(fm);
    expect(result).not.toBeNull();
    expect(result?.name).toBe(
      "pre-execution-empirical-verify-as-5th-catching-layer",
    );
    expect(result?.type).toBe("feedback");
    expect(result?.originSessionId).toBe(
      "50562c36-9297-4d61-9fa2-2995b7919542",
    );
    expect(result?.node_type).toBe("memory");
  });
});

describe("parseMemoryFrontmatterFromFile — file wrapper", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-frontmatter-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("MF-30: reads + parses a memory file", () => {
    const path = join(tmpDir, "feedback-foo.md");
    writeFileSync(path, MIN_FLAT_FM);
    const result = parseMemoryFrontmatterFromFile(path);
    expect(result?.name).toBe("foo-memo");
  });

  it("MF-31: throws ENOENT on missing file", () => {
    const missing = join(tmpDir, "does-not-exist.md");
    expect(() => parseMemoryFrontmatterFromFile(missing)).toThrow();
  });

  it("MF-32: returns null when file has no frontmatter", () => {
    const path = join(tmpDir, "no-fm.md");
    writeFileSync(path, "# Just a body\n\nNo frontmatter here.\n");
    expect(parseMemoryFrontmatterFromFile(path)).toBeNull();
  });
});

describe("parseMemoryFrontmatter — type narrowing surface", () => {
  it("MF-33: returned value is structurally MemoryFrontmatter (compile-time)", () => {
    const result = parseMemoryFrontmatter(MIN_FLAT_FM);
    if (result !== null) {
      const narrowed: MemoryFrontmatter = result;
      expect(narrowed.name).toBe("foo-memo");
    }
  });
});
