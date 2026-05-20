// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Integration tests for the pattern-trace CLI (Tier 3-D D2).
 *
 * Pattern: spawnSync against the real CLI file with synthetic channel
 * JSONL fixtures via HOME / CLAUDE_CONDUCTOR_CHANNELS_DIR override.
 * Git/PR sources are tested via the detector unit tests in detector.test.ts;
 * these CLI integration tests focus on flag parsing, output shape, and
 * the channel-source scanner path which is fully isolated.
 *
 * Coverage per plan §8 D2:
 *   - --help exits 0 with usage text
 *   - --symbol X with --source channel → channel-source events surfaced
 *   - --propagation-threshold N lowers threshold → memory_suggest fires
 *   - --emit-memory-proposal emits V2 kind=memory-proposal payload
 *   - --format human emits text output
 *   - Unknown flag exits 2
 *   - Missing --symbol exits 2
 *
 * Plan: slice-T3D-pattern-trace-2026-05-20.md v0.1 (D2 portion).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const PATTERN_TRACE_CLI = resolvePath(
  import.meta.dir,
  "../../src/pattern-trace/cli.ts",
);

let tmpHome: string;

function runPatternTrace(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", PATTERN_TRACE_CLI, ...args], {
    env: {
      ...process.env,
      HOME: tmpHome,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: join(tmpHome, "channels"),
      CLAUDE_CONDUCTOR_HANDOFFS_DIR: join(tmpHome, "handoffs"),
    },
    encoding: "utf-8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function writeChannelMessage(
  channelId: string,
  msg: Record<string, unknown>,
): void {
  const channelDir = join(tmpHome, "channels", channelId);
  mkdirSync(channelDir, { recursive: true });
  const line = `${JSON.stringify(msg)}\n`;
  const messagesPath = join(channelDir, "messages.jsonl");
  writeFileSync(messagesPath, line, { flag: "a" });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "pattern-trace-cli-test-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("pattern-trace CLI", () => {
  it("--help exits 0 with usage text", () => {
    const result = runPatternTrace(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pattern-trace CLI");
    expect(result.stdout).toContain("--symbol");
    expect(result.stdout).toContain("--emit-memory-proposal");
  });

  it("missing --symbol exits 2 with die() message", () => {
    const result = runPatternTrace([
      "--since",
      "2026-01-01T00:00:00Z",
      "--source",
      "channel",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--symbol");
  });

  it("unknown flag exits 2", () => {
    const result = runPatternTrace([
      "--symbol",
      "TestSym",
      "--unknown-flag",
      "x",
      "--since",
      "2026-01-01T00:00:00Z",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown flag");
  });

  it("--source channel surfaces channel-source events from synthetic JSONL", () => {
    writeChannelMessage("ch-test", {
      ts: "2026-05-20T01:00:00Z",
      from: "session-a",
      identity: "Alpha",
      kind: "status",
      body: "Introducing TestPattern for cycle work.",
    });
    writeChannelMessage("ch-test", {
      ts: "2026-05-20T02:00:00Z",
      from: "session-b",
      identity: "Bravo",
      kind: "status",
      body: "Adopting TestPattern in my next slice.",
    });

    const result = runPatternTrace([
      "--symbol",
      "TestPattern",
      "--source",
      "channel",
      "--since",
      "2026-05-20T00:00:00Z",
      "--format",
      "json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      sources_scanned: { channel: number };
      graph: {
        introducing_event: { author: string } | null;
        absorbing_events: ReadonlyArray<{ author: string }>;
        distinct_peers: readonly string[];
      };
    };
    expect(parsed.sources_scanned.channel).toBe(2);
    expect(parsed.graph.introducing_event?.author).toBe("Alpha");
    expect(parsed.graph.absorbing_events.length).toBe(1);
    expect(parsed.graph.absorbing_events[0]?.author).toBe("Bravo");
    expect(parsed.graph.distinct_peers).toEqual(["Alpha", "Bravo"]);
  });

  it("--propagation-threshold 2 fires memory-suggest at 2 distinct peers", () => {
    writeChannelMessage("ch-test", {
      ts: "2026-05-20T01:00:00Z",
      from: "session-a",
      identity: "Alpha",
      kind: "status",
      body: "TestSym2 here.",
    });
    writeChannelMessage("ch-test", {
      ts: "2026-05-20T02:00:00Z",
      from: "session-b",
      identity: "Bravo",
      kind: "status",
      body: "TestSym2 absorbing.",
    });

    const result = runPatternTrace([
      "--symbol",
      "TestSym2",
      "--source",
      "channel",
      "--since",
      "2026-05-20T00:00:00Z",
      "--propagation-threshold",
      "2",
      "--format",
      "json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      graph: { memory_suggest_triggered: boolean };
    };
    expect(parsed.graph.memory_suggest_triggered).toBe(true);
  });

  it("--emit-memory-proposal embeds V2-schema kind=memory-proposal payload when threshold met", () => {
    writeChannelMessage("ch-test", {
      ts: "2026-05-20T01:00:00Z",
      from: "session-a",
      identity: "Alpha",
      kind: "status",
      body: "TestSym3 introducing.",
    });
    writeChannelMessage("ch-test", {
      ts: "2026-05-20T02:00:00Z",
      from: "session-b",
      identity: "Bravo",
      kind: "status",
      body: "TestSym3 absorbing.",
    });

    const result = runPatternTrace([
      "--symbol",
      "TestSym3",
      "--source",
      "channel",
      "--since",
      "2026-05-20T00:00:00Z",
      "--propagation-threshold",
      "2",
      "--emit-memory-proposal",
      "--format",
      "json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      memory_proposal_payload?: {
        kind_version: number;
        candidate_name: string;
        memory_type: string;
        description: string;
        reason: string;
        proposed_body: string;
        amends_existing: string | null;
      };
    };
    expect(parsed.memory_proposal_payload).toBeDefined();
    expect(parsed.memory_proposal_payload?.kind_version).toBe(1);
    expect(parsed.memory_proposal_payload?.memory_type).toBe("feedback");
    expect(parsed.memory_proposal_payload?.candidate_name).toContain(
      "testsym3",
    );
    expect(parsed.memory_proposal_payload?.amends_existing).toBeNull();
  });

  it("--format human emits readable text output", () => {
    writeChannelMessage("ch-test", {
      ts: "2026-05-20T01:00:00Z",
      from: "session-a",
      identity: "Alpha",
      kind: "status",
      body: "TestSymHuman introducing.",
    });

    const result = runPatternTrace([
      "--symbol",
      "TestSymHuman",
      "--source",
      "channel",
      "--since",
      "2026-05-20T00:00:00Z",
      "--format",
      "human",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Pattern: TestSymHuman");
    expect(result.stdout).toContain("Introducing:");
    expect(result.stdout).toContain("Distinct peers:");
  });
});
