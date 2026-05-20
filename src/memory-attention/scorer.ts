// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Memory-attention scorer (Tier 3-E E1) — pure logic layer.
 *
 * Computes Bravo's algorithm:
 *   score = apply_count_recent × 0.95^days_since_last_apply
 *           − 0.5 × violation_count_recent
 *
 * Sidecar state lives at conductor-state dir — NOT in memory file
 * frontmatter, per `feedback-memory-authoring-surface-dont-auto-file`
 * (substrate must not auto-modify operator-owned memory files).
 *
 * Pure functions; no fs / no spawn. CLI driver (cli.ts) loads state +
 * memory list, calls into this module, emits output. Stop-hook updater
 * (memory-attention-updater.ts, E2 Bravo) writes state.
 *
 * Plan: slice-T3E-memory-attention-2026-05-20.md v0.1.
 */

export const SCHEMA_VERSION = 1 as const;

/**
 * Per-memory tracked state. Updated by E2 Stop-hook on each turn-end.
 */
export type MemoryAttentionEntry = {
  /** ISO-8601 of most recent apply event in the apply_history ring. */
  last_apply: string;
  /** Count of apply events within the recent window (caller defines window). */
  apply_count_recent: number;
  /** Count of operator-acted-against events (v2 wires real source; v0.1 always 0). */
  violation_count_recent: number;
  /** Ring-buffer of recent apply events, bounded to last 50 (F4 cap). */
  apply_history: readonly { ts: string; transcript_ref?: string }[];
};

/**
 * Top-level sidecar shape persisted to `<conductor-state>/memory-attention.json`.
 * schema_version=1 (F2 fold); future v2 migrations bump.
 */
export type MemoryAttentionState = {
  schema_version: typeof SCHEMA_VERSION;
  /** ISO-8601 of last hook run; reader can compare against now() for staleness. */
  last_updated: string;
  /** Keyed by memory file basename without `.md` (e.g., `feedback-foo-bar-baz`). */
  memories: Readonly<Record<string, MemoryAttentionEntry>>;
};

export type ScoredEntry = {
  memory: string;
  score: number;
  apply_count_recent: number;
  last_apply: string | null;
  days_since_last_apply: number | null;
  violation_count_recent: number;
};

export type AttentionOutput = {
  generated_at: string;
  window_days: number;
  total_memories: number;
  scored_memories: number;
  entries: readonly ScoredEntry[];
};

const DAYS_CLAMP = 365;
const MS_PER_DAY = 86_400_000;

/**
 * Score a single memory entry per Bravo's algorithm. Pure function;
 * pass `now_ms` explicitly for determinism.
 *
 * Edge cases:
 *  - entry undefined / never referenced → score 0
 *  - days_since_last_apply > 365 → clamped at 365 (prevents underflow)
 *  - violation_count_recent * 0.5 may exceed apply_count → score can be
 *    negative (operator signal: high-violation memories rank lowest)
 */
export function scoreMemory(
  entry: MemoryAttentionEntry | undefined,
  now_ms: number,
): number {
  if (entry === undefined) return 0;
  if (entry.apply_count_recent === 0 && entry.violation_count_recent === 0) {
    return 0;
  }
  const lastApplyMs = Date.parse(entry.last_apply);
  if (!Number.isFinite(lastApplyMs)) return 0;
  const daysSinceRaw = (now_ms - lastApplyMs) / MS_PER_DAY;
  const daysSince = Math.min(Math.max(daysSinceRaw, 0), DAYS_CLAMP);
  const decay = Math.pow(0.95, daysSince);
  return entry.apply_count_recent * decay - 0.5 * entry.violation_count_recent;
}

/**
 * Build a sorted AttentionOutput from a set of memory names + the sidecar
 * state. Entries WITHOUT state get default zeros; surfaced in output for
 * operator visibility ("never referenced this window").
 *
 * F1 deterministic sort: score DESC, tie-break memory name ASC.
 */
export function buildAttentionOutput(args: {
  memory_names: readonly string[];
  state: MemoryAttentionState | null;
  now_ms: number;
  window_days: number;
  top: number | null;
}): AttentionOutput {
  const { memory_names, state, now_ms, window_days, top } = args;
  const memories = state?.memories ?? {};
  const entries: ScoredEntry[] = memory_names.map((name) => {
    const entry = memories[name];
    const score = scoreMemory(entry, now_ms);
    const last_apply = entry?.last_apply ?? null;
    const days_since_last_apply =
      last_apply === null
        ? null
        : Math.min(
            Math.max((now_ms - Date.parse(last_apply)) / MS_PER_DAY, 0),
            DAYS_CLAMP,
          );
    return {
      memory: name,
      score,
      apply_count_recent: entry?.apply_count_recent ?? 0,
      last_apply,
      days_since_last_apply,
      violation_count_recent: entry?.violation_count_recent ?? 0,
    };
  });

  entries.sort((a, b) => {
    if (a.score > b.score) return -1;
    if (a.score < b.score) return 1;
    if (a.memory < b.memory) return -1;
    if (a.memory > b.memory) return 1;
    return 0;
  });

  const capped = top === null ? entries : entries.slice(0, top);
  const scored = entries.filter((e) => e.apply_count_recent > 0).length;

  return {
    generated_at: new Date(now_ms).toISOString(),
    window_days,
    total_memories: memory_names.length,
    scored_memories: scored,
    entries: capped,
  };
}

/**
 * Parse a sidecar state JSON string. Returns null on shape mismatch
 * (mirror Slice 2 audit-verdict parser discipline; F2 fold).
 */
export function parseMemoryAttentionState(
  raw: string,
): MemoryAttentionState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== SCHEMA_VERSION) return null;
  if (typeof obj["last_updated"] !== "string") return null;
  const memoriesRaw = obj["memories"];
  if (
    typeof memoriesRaw !== "object" ||
    memoriesRaw === null ||
    Array.isArray(memoriesRaw)
  ) {
    return null;
  }
  const memories: Record<string, MemoryAttentionEntry> = {};
  for (const [name, entryRaw] of Object.entries(memoriesRaw)) {
    if (
      typeof entryRaw !== "object" ||
      entryRaw === null ||
      Array.isArray(entryRaw)
    ) {
      return null;
    }
    const e = entryRaw as Record<string, unknown>;
    if (typeof e["last_apply"] !== "string") return null;
    if (
      typeof e["apply_count_recent"] !== "number" ||
      !Number.isFinite(e["apply_count_recent"])
    ) {
      return null;
    }
    if (
      typeof e["violation_count_recent"] !== "number" ||
      !Number.isFinite(e["violation_count_recent"])
    ) {
      return null;
    }
    if (!Array.isArray(e["apply_history"])) return null;
    memories[name] = {
      last_apply: e["last_apply"],
      apply_count_recent: e["apply_count_recent"],
      violation_count_recent: e["violation_count_recent"],
      apply_history: e["apply_history"] as readonly {
        ts: string;
        transcript_ref?: string;
      }[],
    };
  }
  return {
    schema_version: SCHEMA_VERSION,
    last_updated: obj["last_updated"],
    memories,
  };
}
