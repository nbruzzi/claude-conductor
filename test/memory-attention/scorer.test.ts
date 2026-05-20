// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for memory-attention scorer E1 (Tier 3-E).
 *
 * Coverage per plan §9 E1 scorer test plan:
 *   - empty state → score = 0
 *   - apply_count=1 + last_apply=now → score ≈ 1.0
 *   - apply_count=1 + last_apply=7d-ago → score ≈ 0.70 (0.95^7)
 *   - violation_count=2 + apply_count=1 → score = 1 − 1 = 0
 *   - score determinism: same input → same score
 *   - sort: by score DESC, tie-break memory name ASC
 *   - edge case: days_since_last_apply > 365 clamped
 *   - parser shape-mismatch rejection
 *
 * Plan: slice-T3E-memory-attention-2026-05-20.md v0.1.
 */

import { describe, expect, it } from "bun:test";

import {
  buildAttentionOutput,
  parseMemoryAttentionState,
  scoreMemory,
  type MemoryAttentionEntry,
  type MemoryAttentionState,
} from "../../src/memory-attention/scorer.ts";

const NOW_MS = Date.parse("2026-05-20T17:00:00.000Z");
const MS_PER_DAY = 86_400_000;

function makeEntry(opts: {
  ts: string;
  count?: number;
  violations?: number;
}): MemoryAttentionEntry {
  return {
    last_apply: opts.ts,
    apply_count_recent: opts.count ?? 1,
    violation_count_recent: opts.violations ?? 0,
    apply_history: [{ ts: opts.ts }],
  };
}

describe("scoreMemory", () => {
  it("undefined entry → score 0", () => {
    expect(scoreMemory(undefined, NOW_MS)).toBe(0);
  });

  it("zero counts → score 0", () => {
    expect(
      scoreMemory(
        {
          last_apply: "2026-05-20T17:00:00.000Z",
          apply_count_recent: 0,
          violation_count_recent: 0,
          apply_history: [],
        },
        NOW_MS,
      ),
    ).toBe(0);
  });

  it("apply_count=1 + last_apply=now → score ≈ 1.0", () => {
    const e = makeEntry({ ts: "2026-05-20T17:00:00.000Z", count: 1 });
    expect(scoreMemory(e, NOW_MS)).toBeCloseTo(1.0, 3);
  });

  it("apply_count=1 + 7d-ago → score ≈ 0.6983 (0.95^7)", () => {
    const e = makeEntry({
      ts: new Date(NOW_MS - 7 * MS_PER_DAY).toISOString(),
      count: 1,
    });
    expect(scoreMemory(e, NOW_MS)).toBeCloseTo(Math.pow(0.95, 7), 3);
  });

  it("violation_count=2 + apply_count=1 → score = 1 − 1 = 0", () => {
    const e = makeEntry({
      ts: "2026-05-20T17:00:00.000Z",
      count: 1,
      violations: 2,
    });
    expect(scoreMemory(e, NOW_MS)).toBeCloseTo(0, 3);
  });

  it("score is deterministic for same input", () => {
    const e = makeEntry({ ts: "2026-05-19T10:00:00.000Z", count: 3 });
    const a = scoreMemory(e, NOW_MS);
    const b = scoreMemory(e, NOW_MS);
    expect(a).toBe(b);
  });

  it("days_since_last_apply > 365 clamped (very stale memory)", () => {
    const veryOld = new Date(NOW_MS - 500 * MS_PER_DAY).toISOString();
    const e = makeEntry({ ts: veryOld, count: 1 });
    expect(scoreMemory(e, NOW_MS)).toBeGreaterThan(0);
    expect(scoreMemory(e, NOW_MS)).toBeLessThan(0.001);
  });
});

describe("buildAttentionOutput", () => {
  it("empty memory list → empty entries", () => {
    const o = buildAttentionOutput({
      memory_names: [],
      state: null,
      now_ms: NOW_MS,
      window_days: 7,
      top: null,
    });
    expect(o.entries).toEqual([]);
    expect(o.total_memories).toBe(0);
    expect(o.scored_memories).toBe(0);
  });

  it("memory without state → score 0, still listed", () => {
    const o = buildAttentionOutput({
      memory_names: ["feedback-foo-bar-baz"],
      state: null,
      now_ms: NOW_MS,
      window_days: 7,
      top: null,
    });
    expect(o.entries).toHaveLength(1);
    expect(o.entries[0]?.score).toBe(0);
    expect(o.entries[0]?.apply_count_recent).toBe(0);
    expect(o.entries[0]?.last_apply).toBeNull();
    expect(o.scored_memories).toBe(0);
  });

  it("sorts by score DESC, tie-break memory name ASC (F1)", () => {
    const state: MemoryAttentionState = {
      schema_version: 1,
      last_updated: "2026-05-20T17:00:00.000Z",
      memories: {
        "feedback-a": makeEntry({
          ts: "2026-05-20T17:00:00.000Z",
          count: 5,
        }),
        "feedback-b": makeEntry({
          ts: "2026-05-20T17:00:00.000Z",
          count: 5,
        }),
        "feedback-c": makeEntry({
          ts: "2026-05-20T17:00:00.000Z",
          count: 10,
        }),
      },
    };
    const o = buildAttentionOutput({
      memory_names: ["feedback-c", "feedback-b", "feedback-a"],
      state,
      now_ms: NOW_MS,
      window_days: 7,
      top: null,
    });
    expect(o.entries[0]?.memory).toBe("feedback-c");
    expect(o.entries[1]?.memory).toBe("feedback-a");
    expect(o.entries[2]?.memory).toBe("feedback-b");
  });

  it("--top N caps output", () => {
    const state: MemoryAttentionState = {
      schema_version: 1,
      last_updated: "2026-05-20T17:00:00.000Z",
      memories: {
        a: makeEntry({ ts: "2026-05-20T17:00:00.000Z", count: 1 }),
        b: makeEntry({ ts: "2026-05-20T17:00:00.000Z", count: 2 }),
        c: makeEntry({ ts: "2026-05-20T17:00:00.000Z", count: 3 }),
      },
    };
    const o = buildAttentionOutput({
      memory_names: ["a", "b", "c"],
      state,
      now_ms: NOW_MS,
      window_days: 7,
      top: 2,
    });
    expect(o.entries).toHaveLength(2);
    expect(o.entries[0]?.memory).toBe("c");
    expect(o.entries[1]?.memory).toBe("b");
  });

  it("scored_memories counts only applied entries", () => {
    const state: MemoryAttentionState = {
      schema_version: 1,
      last_updated: "2026-05-20T17:00:00.000Z",
      memories: {
        applied: makeEntry({ ts: "2026-05-20T17:00:00.000Z", count: 1 }),
      },
    };
    const o = buildAttentionOutput({
      memory_names: ["applied", "never-applied"],
      state,
      now_ms: NOW_MS,
      window_days: 7,
      top: null,
    });
    expect(o.total_memories).toBe(2);
    expect(o.scored_memories).toBe(1);
  });
});

describe("parseMemoryAttentionState", () => {
  it("accepts well-formed state", () => {
    const raw = JSON.stringify({
      schema_version: 1,
      last_updated: "2026-05-20T17:00:00.000Z",
      memories: {
        foo: {
          last_apply: "2026-05-20T16:00:00.000Z",
          apply_count_recent: 3,
          violation_count_recent: 0,
          apply_history: [{ ts: "2026-05-20T16:00:00.000Z" }],
        },
      },
    });
    const parsed = parseMemoryAttentionState(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.memories["foo"]?.apply_count_recent).toBe(3);
  });

  it("rejects wrong schema_version", () => {
    const raw = JSON.stringify({
      schema_version: 2,
      last_updated: "2026-05-20T17:00:00.000Z",
      memories: {},
    });
    expect(parseMemoryAttentionState(raw)).toBeNull();
  });

  it("rejects non-JSON input", () => {
    expect(parseMemoryAttentionState("not json")).toBeNull();
  });

  it("rejects malformed memory entry", () => {
    const raw = JSON.stringify({
      schema_version: 1,
      last_updated: "2026-05-20T17:00:00.000Z",
      memories: {
        foo: { last_apply: "ts", apply_count_recent: "not-a-number" },
      },
    });
    expect(parseMemoryAttentionState(raw)).toBeNull();
  });
});
