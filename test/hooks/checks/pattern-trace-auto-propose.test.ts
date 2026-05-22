// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `pattern-trace-auto-propose` Stop hook (T4-X3 cycle 2026-05-22).
 *
 * Composition primitive: reads operator-curated watch-list, invokes
 * pattern-trace CLI per watched symbol (subprocess; OPTION B per Alpha
 * plan-tier audit RATIFY @ ~15:20Z), and emits kind=memory-proposal to
 * every live channel via direct-import sendMemoryProposal (per S1 fold).
 * Dedup-gates via emit-history sidecar (~7-day window per OQ3).
 *
 * Test design (per [[feedback-validate-detector-on-broken-state-prerequisite]]):
 * this file is WRITTEN BEFORE FILE 1 implementation (V2 → V2.5 discipline).
 * Initial run expected to FAIL with import errors — that's the detector
 * validation. After FILE 1 + FILE 2a + FILE 2b land, all cases pass.
 *
 * Cross-references:
 *   - [[feedback-substrate-fix-self-mirror-mid-impl]] — author-side
 *     wedge-avoidance through atomic-wiring discipline during impl.
 *   - [[feedback-cross-pair-shadow-empirical-validation]] — methodology
 *     for the 3-lens plan-tier convergence T4-X3 went through.
 *   - [[feedback-substrate-precedent-as-design-rescue]] — subprocess-for-
 *     detection composes via operator-CLI precedent; send-side is direct-
 *     import per Alpha S1 fold.
 *
 * Test isolation: 3 INTERNAL test-override surfaces (runPatternTrace,
 * sendMemoryProposal, listLiveChannels) + tmpHome via mkdtempSync +
 * process.env["HOME"] mutation for live-read state-path resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  check,
  INTERNAL,
} from "../../../src/hooks/checks/pattern-trace-auto-propose.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "11111111-2222-3333-4444-555555555555";

type SendCall = {
  channelId: string;
  body: Record<string, unknown>;
};

let tmpHome: string;
let watchPath: string;
let emitHistoryPath: string;
let originalHome: string | undefined;

let runPatternTraceCalls: Array<{
  symbol: string;
  threshold: number;
  source: string;
}>;
let sendCalls: SendCall[];
let listLiveChannelsCalls: number;

let mockRunPatternTraceReturn: {
  triggered: boolean;
  payload: Record<string, unknown> | null;
} | null;
let mockSendReturn: { ts: string; body_ref?: string } | Error;
let mockLiveChannels: string[];

function makeInput(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: tmpHome,
    transcriptPath: undefined,
    raw: { session_id: SID },
    dispatch: DEFAULT_DISPATCH,
  };
}

function writeWatchList(
  entries: ReadonlyArray<{
    symbol: string;
    threshold: number;
    source?: string;
  }>,
): void {
  mkdirSync(join(tmpHome, ".claude", "conductor-state"), { recursive: true });
  writeFileSync(
    watchPath,
    JSON.stringify(
      {
        schema_version: 1,
        watch: entries.map((e) => ({ source: "all", ...e })),
      },
      null,
      2,
    ),
  );
}

function writeEmitHistory(
  emits: ReadonlyArray<{
    symbol: string;
    ts: string;
    channels: string[];
  }>,
): void {
  mkdirSync(join(tmpHome, ".claude", "conductor-state"), { recursive: true });
  writeFileSync(
    emitHistoryPath,
    JSON.stringify({ schema_version: 1, emits }, null, 2),
  );
}

function readEmitHistory(): {
  schema_version: number;
  emits: Array<{ symbol: string; ts: string; channels: string[] }>;
} {
  const raw = readFileSync(emitHistoryPath, "utf-8");
  return JSON.parse(raw) as ReturnType<typeof readEmitHistory>;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "pattern-trace-auto-propose-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  watchPath = join(
    tmpHome,
    ".claude",
    "conductor-state",
    "pattern-trace-watch.json",
  );
  emitHistoryPath = join(
    tmpHome,
    ".claude",
    "conductor-state",
    "pattern-trace-emit-history.json",
  );

  runPatternTraceCalls = [];
  sendCalls = [];
  listLiveChannelsCalls = 0;
  mockRunPatternTraceReturn = null;
  mockSendReturn = { ts: "2026-05-22T15:00:00Z", body_ref: "mock-ref" };
  mockLiveChannels = ["2026-05-22_11-00", "2026-05-22_pair-cd"];

  INTERNAL.setRunPatternTrace((symbol, threshold, source) => {
    runPatternTraceCalls.push({ symbol, threshold, source });
    return mockRunPatternTraceReturn;
  });
  INTERNAL.setSendMemoryProposal((channelId, body) => {
    sendCalls.push({ channelId, body });
    return Promise.resolve(mockSendReturn);
  });
  INTERNAL.setListLiveChannels(() => {
    listLiveChannelsCalls += 1;
    return mockLiveChannels;
  });
});

afterEach(() => {
  INTERNAL.resetRunPatternTrace();
  INTERNAL.resetSendMemoryProposal();
  INTERNAL.resetListLiveChannels();
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("pattern-trace-auto-propose — watch-list discovery", () => {
  it("no watch-list file → pass + no detection + no send", async () => {
    const r = await check(makeInput());
    expect(r.stdout).toBe("");
    expect(runPatternTraceCalls).toEqual([]);
    expect(sendCalls).toEqual([]);
  });

  it("empty watch-list → pass + no detection + no send", async () => {
    writeWatchList([]);
    const r = await check(makeInput());
    expect(r.stdout).toBe("");
    expect(runPatternTraceCalls).toEqual([]);
    expect(sendCalls).toEqual([]);
  });

  it("malformed watch-list JSON → pass (fail-open) + no detection + no send", async () => {
    mkdirSync(join(tmpHome, ".claude", "conductor-state"), { recursive: true });
    writeFileSync(watchPath, "{not valid json");
    const r = await check(makeInput());
    expect(r.stdout).toBe("");
    expect(runPatternTraceCalls).toEqual([]);
    expect(sendCalls).toEqual([]);
  });
});

describe("pattern-trace-auto-propose — detection-then-emit", () => {
  it("watch-list with 1 symbol, threshold met → invokes runPatternTrace, sends to all live channels, writes emit-history", async () => {
    writeWatchList([{ symbol: "fooBar", threshold: 3 }]);
    mockRunPatternTraceReturn = {
      triggered: true,
      payload: {
        kind_version: 1,
        candidate_name: "pattern-trace-foobar",
        memory_type: "feedback",
        description: "Pattern 'fooBar' adopted by 3 peers",
        reason: "auto-suggest threshold met",
        proposed_body: "body",
        amends_existing: null,
      },
    };

    await check(makeInput());

    expect(runPatternTraceCalls).toEqual([
      { symbol: "fooBar", threshold: 3, source: "all" },
    ]);
    expect(sendCalls.length).toBe(2);
    expect(sendCalls.map((c) => c.channelId).sort()).toEqual([
      "2026-05-22_11-00",
      "2026-05-22_pair-cd",
    ]);
    expect(sendCalls[0]?.body["candidate_name"]).toBe("pattern-trace-foobar");

    const history = readEmitHistory();
    expect(history.emits.length).toBe(1);
    expect(history.emits[0]?.symbol).toBe("fooBar");
    expect(history.emits[0]?.channels.sort()).toEqual([
      "2026-05-22_11-00",
      "2026-05-22_pair-cd",
    ]);
  });

  it("watch-list with 1 symbol, threshold NOT met → invokes runPatternTrace, no send, no history write", async () => {
    writeWatchList([{ symbol: "fooBar", threshold: 3 }]);
    mockRunPatternTraceReturn = { triggered: false, payload: null };

    await check(makeInput());

    expect(runPatternTraceCalls).toEqual([
      { symbol: "fooBar", threshold: 3, source: "all" },
    ]);
    expect(sendCalls).toEqual([]);
    expect(existsSync(emitHistoryPath)).toBe(false);
  });
});

describe("pattern-trace-auto-propose — dedup gate (7-day window)", () => {
  it("threshold met BUT dedup-window ACTIVE (last emit < 7 days) → no send, no history change", async () => {
    writeWatchList([{ symbol: "fooBar", threshold: 3 }]);
    const recentTs = new Date(Date.now() - 1 * 86_400_000).toISOString();
    writeEmitHistory([
      { symbol: "fooBar", ts: recentTs, channels: ["2026-05-22_11-00"] },
    ]);
    mockRunPatternTraceReturn = {
      triggered: true,
      payload: { kind_version: 1, candidate_name: "x" },
    };

    await check(makeInput());

    expect(sendCalls).toEqual([]);
    const history = readEmitHistory();
    expect(history.emits.length).toBe(1);
    expect(history.emits[0]?.ts).toBe(recentTs);
  });

  it("threshold met + dedup-window EXPIRED (last emit > 7 days) → send + history update", async () => {
    writeWatchList([{ symbol: "fooBar", threshold: 3 }]);
    const staleTs = new Date(Date.now() - 8 * 86_400_000).toISOString();
    writeEmitHistory([
      { symbol: "fooBar", ts: staleTs, channels: ["2026-05-22_11-00"] },
    ]);
    mockRunPatternTraceReturn = {
      triggered: true,
      payload: { kind_version: 1, candidate_name: "x" },
    };

    await check(makeInput());

    expect(sendCalls.length).toBe(2);
    const history = readEmitHistory();
    expect(history.emits.length).toBe(1);
    expect(history.emits[0]?.symbol).toBe("fooBar");
    expect(history.emits[0]?.ts).not.toBe(staleTs);
    expect(Date.parse(history.emits[0]?.ts ?? "")).toBeGreaterThan(
      Date.parse(staleTs),
    );
  });
});

describe("pattern-trace-auto-propose — multi-symbol independence", () => {
  it("multi-symbol watch-list → independent detection per symbol; independent dedup decisions", async () => {
    writeWatchList([
      { symbol: "symbolA", threshold: 3 },
      { symbol: "symbolB", threshold: 5 },
    ]);
    const yesterdayTs = new Date(Date.now() - 86_400_000).toISOString();
    writeEmitHistory([
      { symbol: "symbolA", ts: yesterdayTs, channels: ["2026-05-22_11-00"] },
    ]);

    let callCount = 0;
    INTERNAL.setRunPatternTrace((symbol, threshold, source) => {
      runPatternTraceCalls.push({ symbol, threshold, source });
      callCount += 1;
      return {
        triggered: true,
        payload: { kind_version: 1, candidate_name: `pattern-${symbol}` },
      };
    });

    await check(makeInput());

    // symbolA is dedup-gated (yesterdayTs < 7d window) so impl skips its
    // detection invocation entirely (no point computing a result we'd
    // throw away). symbolB has no prior emit → detection runs + sends.
    expect(callCount).toBe(1);
    expect(runPatternTraceCalls.map((c) => c.symbol)).toEqual(["symbolB"]);
    expect(sendCalls.length).toBe(2);
    expect(
      sendCalls.every((c) => c.body["candidate_name"] === "pattern-symbolB"),
    ).toBe(true);

    const history = readEmitHistory();
    expect(history.emits.length).toBe(2);
    const bEntry = history.emits.find((e) => e.symbol === "symbolB");
    expect(bEntry).toBeDefined();
    // symbolA entry preserved unchanged (dedup-gate)
    const aEntry = history.emits.find((e) => e.symbol === "symbolA");
    expect(aEntry?.ts).toBe(yesterdayTs);
  });
});

describe("pattern-trace-auto-propose — fail-open isolation", () => {
  it("runPatternTrace returns null (subprocess fail) → pass, no send, no history", async () => {
    writeWatchList([{ symbol: "fooBar", threshold: 3 }]);
    mockRunPatternTraceReturn = null;

    const r = await check(makeInput());
    expect(r.stdout).toBe("");
    expect(sendCalls).toEqual([]);
    expect(existsSync(emitHistoryPath)).toBe(false);
  });

  it("sendMemoryProposal returns Error → fail-open, history NOT updated for failed channels", async () => {
    writeWatchList([{ symbol: "fooBar", threshold: 3 }]);
    mockRunPatternTraceReturn = {
      triggered: true,
      payload: { kind_version: 1, candidate_name: "x" },
    };
    let attempt = 0;
    INTERNAL.setSendMemoryProposal((channelId, body) => {
      sendCalls.push({ channelId, body });
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? { ts: "2026-05-22T15:00:00Z" }
          : new Error("network down"),
      );
    });

    await check(makeInput());

    expect(sendCalls.length).toBe(2);
    const history = readEmitHistory();
    expect(history.emits.length).toBe(1);
    expect(history.emits[0]?.channels.length).toBe(1);
  });
});

describe("pattern-trace-auto-propose — live-channel discovery", () => {
  it("no live channels → no send, no history change", async () => {
    writeWatchList([{ symbol: "fooBar", threshold: 3 }]);
    mockLiveChannels = [];
    mockRunPatternTraceReturn = {
      triggered: true,
      payload: { kind_version: 1, candidate_name: "x" },
    };

    await check(makeInput());

    expect(listLiveChannelsCalls).toBe(1);
    expect(sendCalls).toEqual([]);
    expect(existsSync(emitHistoryPath)).toBe(false);
  });
});
