// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the reciprocation CLI (Tier 2 Verb 3).
 *
 * Pattern mirrors `test/audits/cli.test.ts` — spawnSync against the real
 * CLI file with `CLAUDE_CONDUCTOR_CHANNELS_DIR` override.
 *
 * Coverage per plan §7:
 *   - --help exits 0
 *   - missing --channel exits non-zero
 *   - missing --window exits non-zero
 *   - empty channel + valid window → JSON with edges:[]
 *   - channel with 2 verdicts + window covering both → correct edges + balance
 *
 * Note: `--window=cycle` resolution (LATEST.md frontmatter path) is exercised
 * by manual bake-test §8 in plan; automating it requires an env-var override
 * for the handoff path (deferred to v0.2 if Bravo audit flags).
 *
 * Plan: ~/.claude/plans/slice-T2V3-reciprocation-cli-2026-05-20.md v0.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const RECIP_CLI = resolvePath(
  import.meta.dir,
  "../../src/reciprocation/cli.ts",
);
const CHANNELS_CLI = resolvePath(import.meta.dir, "../../src/channels/cli.ts");
const TEST_SESSION_ALPHA = "11111111-2222-3333-4444-555555555555";
const TEST_SESSION_BRAVO = "22222222-3333-4444-5555-666666666666";

let tmpRoot: string;
let channelsDir: string;
const channelId = "recip-cli-test";

function envFor(sid: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_SESSION_ID: sid,
    CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
  };
}

function runChannels(
  args: readonly string[],
  opts: { stdin?: string; sid?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", CHANNELS_CLI, ...args], {
    env: envFor(opts.sid ?? TEST_SESSION_ALPHA),
    encoding: "utf-8",
    timeout: 10000,
    ...(opts.stdin !== undefined ? { input: opts.stdin } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runRecip(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", RECIP_CLI, ...args], {
    env: envFor(TEST_SESSION_ALPHA),
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function makeVerdictBody(opts: {
  target_peer: string;
  pr_number: number;
}): string {
  return JSON.stringify({
    kind_version: 1,
    target_pr: { repo: "claude-conductor", number: opts.pr_number },
    target_peer: opts.target_peer,
    lens_set_applied: ["RE"],
    audit_class: "inside-pair",
    audit_axes: ["surface"],
    verdict: "SHIP-CLEAN",
    counts: { blocker: 0, fold: 0, nit: 0 },
    three_option_ask: {
      a_ratify: "ship",
      b_fold_if_applicable: null,
      c_reframe_if_applicable: null,
    },
    findings: [],
    // Substrate-class PR (target_pr.repo = "claude-conductor"); the
    // send-time validator at substrate-class.ts:v0.1.1 requires non-empty
    // cross_edge_consumers_verified. Fixture enumerates a plausible
    // consumer-edge for shape-only purposes (test exercises reciprocation
    // graph builder, not consumer-verification semantics).
    cross_edge_consumers_verified: [
      "~/Repos/claude-conductor-dashboard/src/lib/server/adapters/active-sessions.ts",
    ],
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "recip-cli-test-"));
  channelsDir = join(tmpRoot, "channels");
  mkdirSync(channelsDir, { recursive: true });

  const create = runChannels(["create", channelId, "test-handoff"]);
  if (create.status !== 0) {
    throw new Error(
      `setup: create failed (${create.status}): ${create.stderr}`,
    );
  }
  const joinAlpha = runChannels(["join", channelId, "--as", "Alpha"], {
    sid: TEST_SESSION_ALPHA,
  });
  if (joinAlpha.status !== 0) {
    throw new Error(`setup: join Alpha failed: ${joinAlpha.stderr}`);
  }
  const joinBravo = runChannels(["join", channelId, "--as", "Bravo"], {
    sid: TEST_SESSION_BRAVO,
  });
  if (joinBravo.status !== 0) {
    throw new Error(`setup: join Bravo failed: ${joinBravo.stderr}`);
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("reciprocation CLI", () => {
  it("--help exits 0 with usage text", () => {
    const result = runRecip(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reciprocation CLI");
    expect(result.stdout).toContain("--channel");
    expect(result.stdout).toContain("--window");
  });

  it("missing --channel exits non-zero", () => {
    const result = runRecip(["--window", "2026-01-01..2026-12-31"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--channel");
  });

  it("missing --window exits non-zero", () => {
    const result = runRecip(["--channel", channelId]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--window");
  });

  it("empty channel + valid window → JSON with edges:[]", () => {
    const result = runRecip([
      "--channel",
      channelId,
      "--window",
      "2026-05-20T00:00:00.000Z..2026-05-21T00:00:00.000Z",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      channel_id: string;
      edges: readonly unknown[];
      balances: readonly unknown[];
      per_peer_audit_debt: Record<string, number>;
    };
    expect(parsed.channel_id).toBe(channelId);
    expect(parsed.edges).toHaveLength(0);
    expect(parsed.balances).toHaveLength(0);
    expect(parsed.per_peer_audit_debt).toEqual({});
  });

  it("2 verdicts (Alpha→Bravo + Bravo→Alpha) → correct edges + net 0 balance", () => {
    const alphaToBravo = makeVerdictBody({
      target_peer: "Bravo",
      pr_number: 101,
    });
    const sendAlpha = runChannels(["send", channelId, "audit-verdict"], {
      stdin: alphaToBravo,
      sid: TEST_SESSION_ALPHA,
    });
    if (sendAlpha.status !== 0) {
      throw new Error(`Alpha send failed: ${sendAlpha.stderr}`);
    }
    const bravoToAlpha = makeVerdictBody({
      target_peer: "Alpha",
      pr_number: 102,
    });
    const sendBravo = runChannels(["send", channelId, "audit-verdict"], {
      stdin: bravoToAlpha,
      sid: TEST_SESSION_BRAVO,
    });
    if (sendBravo.status !== 0) {
      throw new Error(`Bravo send failed: ${sendBravo.stderr}`);
    }

    const result = runRecip([
      "--channel",
      channelId,
      "--window",
      "2020-01-01T00:00:00.000Z..2030-01-01T00:00:00.000Z",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      edges: ReadonlyArray<{
        auditor_identity: string;
        target_peer: string;
        target_pr: { number: number };
      }>;
      balances: ReadonlyArray<{
        pair: readonly [string, string];
        a_to_b: number;
        b_to_a: number;
        net: number;
      }>;
      per_peer_audit_debt: Record<string, number>;
    };
    expect(parsed.edges).toHaveLength(2);
    expect(parsed.balances).toHaveLength(1);
    expect(parsed.balances[0]?.pair).toEqual(["Alpha", "Bravo"]);
    expect(parsed.balances[0]?.net).toBe(0);
    expect(parsed.per_peer_audit_debt["Alpha"]).toBe(0);
    expect(parsed.per_peer_audit_debt["Bravo"]).toBe(0);
  });
});
