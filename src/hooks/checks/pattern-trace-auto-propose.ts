// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `pattern-trace-auto-propose` Stop hook (T4-X3 cycle 2026-05-22) —
 * composition primitive bridging T3-D pattern-trace + T2V2 memory-proposal.
 *
 * **Lane:** Tier 4 (a) Tier-3-primitive COMPOSITION. First slice that
 * integrates the meta-primitive triad (memory=WHAT / lexicon=LANGUAGE /
 * pattern-trace=WHEN).
 *
 * **Behavior:** at Stop time, reads operator-curated watch-list at
 * `~/.claude/conductor-state/pattern-trace-watch.json`, invokes
 * pattern-trace CLI per watched symbol (subprocess; OPTION B per Alpha
 * plan-tier audit S1 fold — operator-CLI precedent reused vs internal-
 * refactor), parses the memory-proposal payload from the CLI's JSON
 * output, and emits via direct-import `sendMemoryProposal` to every
 * live channel (live = newest heartbeat within 30 min).
 *
 * **Dedup gate:** sidecar at
 * `~/.claude/conductor-state/pattern-trace-emit-history.json`. Per-symbol
 * 7-day window — if last emit was ≥7d ago OR symbol never emitted, dedup
 * passes; otherwise skipped. Operator can `rm` the file to reset.
 *
 * **Scope (T4-X3 minimal — split from auto-discovery per v0.2 plan):**
 * operator-curated watch-list. T4-X3b (backlog) ships auto-discovery
 * (scan transcript / git / channel events to populate the watch-list).
 *
 * **Cross-references:**
 *   - Plan: T4-X3 v0.2 + Alpha plan-tier audit RATIFY-WITH-FOLDS 4/4 @ 15:20Z.
 *   - [[feedback-substrate-precedent-as-design-rescue]] — subprocess for
 *     detection composes via operator-CLI precedent.
 *   - [[feedback-substrate-fix-self-mirror-mid-impl]] — atomic-wiring
 *     discipline applied during this slice's own impl (definitions FIRST).
 *   - [[feedback-armed-bypass-kill-switch-visibility]] — pattern source
 *     for armed-state visibility (NOT applied here — emit-history is data,
 *     not control plane; absence of file = no dedup state, not "armed").
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sendMemoryProposal } from "../../channels/send-primitive.ts";
import { listChannels, newestHeartbeatMtime } from "../../channels/index.ts";
import { withLockAsync } from "../lock.ts";
import { pass, type HookInput, type HookResult } from "../types.ts";

const SOURCE = "pattern-trace-auto-propose";
const SCHEMA_VERSION = 1 as const;
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_WINDOW_MS = 30 * 60 * 1000;

// ─── State paths (live HOME read per `feedback-homedir-not-live-from-env`) ───

function conductorStateDir(): string {
  return join(process.env["HOME"] ?? "", ".claude", "conductor-state");
}

function watchListPath(): string {
  return join(conductorStateDir(), "pattern-trace-watch.json");
}

function emitHistoryPath(): string {
  return join(conductorStateDir(), "pattern-trace-emit-history.json");
}

function emitHistoryLockDir(): string {
  return `${emitHistoryPath()}.lock`;
}

// ─── Types ───

type WatchEntry = {
  symbol: string;
  threshold: number;
  source: "git" | "prs" | "channel" | "all";
};

type EmitHistoryEntry = {
  symbol: string;
  ts: string;
  channels: string[];
};

type EmitHistory = {
  schema_version: typeof SCHEMA_VERSION;
  emits: EmitHistoryEntry[];
};

type DetectionResult = {
  triggered: boolean;
  payload: Record<string, unknown> | null;
};

// ─── Injectable function references (INTERNAL test-overrides) ───

type RunPatternTraceFn = (
  symbol: string,
  threshold: number,
  source: string,
) => DetectionResult | null;

type SendMemoryProposalFn = (
  channelId: string,
  body: Record<string, unknown>,
) => Promise<{ ts: string; body_ref?: string } | Error>;

type ListLiveChannelsFn = () => string[];

function defaultRunPatternTrace(
  symbol: string,
  threshold: number,
  source: string,
): DetectionResult | null {
  const result = spawnSync(
    "bun",
    [
      "run",
      join(import.meta.dir, "..", "..", "pattern-trace", "cli.ts"),
      "--symbol",
      symbol,
      "--source",
      source,
      "--propagation-threshold",
      String(threshold),
      "--emit-memory-proposal",
      "--format",
      "json",
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const graph = obj["graph"];
  if (typeof graph !== "object" || graph === null || Array.isArray(graph)) {
    return null;
  }
  const triggered = Boolean(
    (graph as Record<string, unknown>)["memory_suggest_triggered"],
  );
  const payload = obj["memory_proposal_payload"];
  if (triggered && typeof payload === "object" && payload !== null) {
    return { triggered: true, payload: payload as Record<string, unknown> };
  }
  return { triggered, payload: null };
}

function defaultSendMemoryProposal(
  channelId: string,
  body: Record<string, unknown>,
): Promise<{ ts: string; body_ref?: string } | Error> {
  const sessionId = process.env["CLAUDE_SESSION_ID"] ?? "";
  return sendMemoryProposal(channelId, body, sessionId);
}

function defaultListLiveChannels(): string[] {
  const now = Date.now();
  const out: string[] = [];
  try {
    for (const summary of listChannels()) {
      const mtime = newestHeartbeatMtime(summary.id);
      if (mtime === null) continue;
      if (now - mtime < LIVE_WINDOW_MS) out.push(summary.id);
    }
  } catch {
    // Fail-open per Stop-hook convention.
    return [];
  }
  return out;
}

let runPatternTraceImpl: RunPatternTraceFn = defaultRunPatternTrace;
let sendMemoryProposalImpl: SendMemoryProposalFn = defaultSendMemoryProposal;
let listLiveChannelsImpl: ListLiveChannelsFn = defaultListLiveChannels;

export const INTERNAL = {
  SCHEMA_VERSION,
  DEDUP_WINDOW_MS,
  LIVE_WINDOW_MS,
  watchListPath,
  emitHistoryPath,
  /** Test-only: inject a mock pattern-trace runner. */
  setRunPatternTrace(fn: RunPatternTraceFn): void {
    runPatternTraceImpl = fn;
  },
  /** Test-only: restore the production runner. */
  resetRunPatternTrace(): void {
    runPatternTraceImpl = defaultRunPatternTrace;
  },
  /** Test-only: inject a mock memory-proposal sender. */
  setSendMemoryProposal(fn: SendMemoryProposalFn): void {
    sendMemoryProposalImpl = fn;
  },
  /** Test-only: restore the production sender. */
  resetSendMemoryProposal(): void {
    sendMemoryProposalImpl = defaultSendMemoryProposal;
  },
  /** Test-only: inject a mock live-channel discovery. */
  setListLiveChannels(fn: ListLiveChannelsFn): void {
    listLiveChannelsImpl = fn;
  },
  /** Test-only: restore the production discovery. */
  resetListLiveChannels(): void {
    listLiveChannelsImpl = defaultListLiveChannels;
  },
};

// ─── State readers ───

function readWatchList(): WatchEntry[] {
  const path = watchListPath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const watch = (parsed as Record<string, unknown>)["watch"];
  if (!Array.isArray(watch)) return [];
  const out: WatchEntry[] = [];
  for (const entry of watch) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const symbol = e["symbol"];
    const threshold = e["threshold"];
    const source = e["source"];
    if (typeof symbol !== "string" || symbol.length === 0) continue;
    if (typeof threshold !== "number" || !Number.isInteger(threshold)) continue;
    const src =
      typeof source === "string" &&
      (source === "git" ||
        source === "prs" ||
        source === "channel" ||
        source === "all")
        ? source
        : "all";
    out.push({ symbol, threshold, source: src });
  }
  return out;
}

function readEmitHistory(): EmitHistory {
  const path = emitHistoryPath();
  if (!existsSync(path)) {
    return { schema_version: SCHEMA_VERSION, emits: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { schema_version: SCHEMA_VERSION, emits: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { schema_version: SCHEMA_VERSION, emits: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { schema_version: SCHEMA_VERSION, emits: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const emitsRaw = obj["emits"];
  if (!Array.isArray(emitsRaw)) {
    return { schema_version: SCHEMA_VERSION, emits: [] };
  }
  const emits: EmitHistoryEntry[] = [];
  for (const entry of emitsRaw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const symbol = e["symbol"];
    const ts = e["ts"];
    const channels = e["channels"];
    if (typeof symbol !== "string") continue;
    if (typeof ts !== "string") continue;
    if (!Array.isArray(channels)) continue;
    const chStrings = channels.filter(
      (c): c is string => typeof c === "string",
    );
    emits.push({ symbol, ts, channels: chStrings });
  }
  return { schema_version: SCHEMA_VERSION, emits };
}

function writeEmitHistoryAtomic(history: EmitHistory): void {
  const path = emitHistoryPath();
  mkdirSync(conductorStateDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2));
}

function isDedupGated(
  symbol: string,
  history: EmitHistory,
  nowMs: number,
): boolean {
  const last = history.emits.find((e) => e.symbol === symbol);
  if (last === undefined) return false;
  const lastMs = Date.parse(last.ts);
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs < DEDUP_WINDOW_MS;
}

function upsertEmitEntry(
  history: EmitHistory,
  symbol: string,
  ts: string,
  channels: string[],
): EmitHistory {
  const existing = history.emits.findIndex((e) => e.symbol === symbol);
  const next: EmitHistoryEntry = { symbol, ts, channels };
  const emits =
    existing >= 0
      ? history.emits.map((e, i) => (i === existing ? next : e))
      : [...history.emits, next];
  return { schema_version: SCHEMA_VERSION, emits };
}

// ─── Main check ───

export async function check(_input: HookInput): Promise<HookResult> {
  const watchList = readWatchList();
  if (watchList.length === 0) return pass();

  const liveChannels = listLiveChannelsImpl();
  if (liveChannels.length === 0) return pass();

  await withLockAsync(
    async () => {
      const history = readEmitHistory();
      const nowMs = Date.now();
      let updated = history;
      let mutated = false;

      for (const entry of watchList) {
        if (isDedupGated(entry.symbol, updated, nowMs)) continue;

        const detection = runPatternTraceImpl(
          entry.symbol,
          entry.threshold,
          entry.source,
        );
        if (detection === null) continue;
        if (!detection.triggered || detection.payload === null) continue;

        const successfulChannels: string[] = [];
        for (const channelId of liveChannels) {
          const result = await sendMemoryProposalImpl(
            channelId,
            detection.payload,
          );
          if (!(result instanceof Error)) {
            successfulChannels.push(channelId);
          } else {
            process.stderr.write(
              `[${SOURCE}] send to ${channelId} failed: ${result.message}\n`,
            );
          }
        }

        if (successfulChannels.length > 0) {
          updated = upsertEmitEntry(
            updated,
            entry.symbol,
            new Date(nowMs).toISOString(),
            successfulChannels,
          );
          mutated = true;
        }
      }

      if (mutated) writeEmitHistoryAtomic(updated);
    },
    { lockDir: emitHistoryLockDir(), ownerTag: SOURCE },
  );

  return pass();
}
