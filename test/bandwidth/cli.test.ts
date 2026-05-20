// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the bandwidth CLI (Slice 3 Layer 4 — flag parsing +
 * integration roundtrip + unclaimed-identity STALE path).
 *
 * Coverage matches plan §Test plan Phase 3 (bandwidth subset):
 *
 *   T3.4  happy path — JSON output shape matches §D4 (bandwidth)
 *   T3.5  identity unclaimed → STALE (heartbeat_age_ms null)
 *   T3.6  missing --for → error exit
 *
 * Plan: ~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md v0.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const BANDWIDTH_CLI = resolvePath(
  import.meta.dir,
  "../../src/bandwidth/cli.ts",
);
const CHANNELS_CLI = resolvePath(import.meta.dir, "../../src/channels/cli.ts");
const TEST_SESSION_ID = "33333333-4444-5555-6666-777777777777";
const TEST_SESSION_ID_DELTA = "44444444-5555-6666-7777-888888888888";

let tmpRoot: string;
let channelsDir: string;
const channelId = "bandwidth-cli-test";

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
    env: envFor(opts.sid ?? TEST_SESSION_ID),
    encoding: "utf-8",
    timeout: 10000,
    input: opts.stdin,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runBandwidth(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", BANDWIDTH_CLI, ...args], {
    env: envFor(TEST_SESSION_ID),
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bandwidth-cli-test-"));
  channelsDir = join(tmpRoot, "channels");
  mkdirSync(channelsDir, { recursive: true });

  const create = runChannels(["create", channelId, "test-handoff"]);
  if (create.status !== 0) {
    throw new Error(
      `setup: create failed (${create.status}): ${create.stderr}`,
    );
  }
  // Charlie claims an identity; Echo is intentionally UNCLAIMED for T3.5.
  const joinCharlie = runChannels(["join", channelId, "--as", "Charlie"], {
    sid: TEST_SESSION_ID,
  });
  if (joinCharlie.status !== 0) {
    throw new Error(`setup: join Charlie failed: ${joinCharlie.stderr}`);
  }
  // Bravo claim used for T3.4 happy path.
  const joinBravo = runChannels(["join", channelId, "--as", "Bravo"], {
    sid: TEST_SESSION_ID_DELTA,
  });
  if (joinBravo.status !== 0) {
    throw new Error(`setup: join Bravo failed: ${joinBravo.stderr}`);
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("bandwidth CLI — T3.4 happy path", () => {
  it("show --for prints JSON with state + inputs shape", () => {
    const result = runBandwidth([
      "show",
      "--for",
      "Bravo",
      "--channel",
      channelId,
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      channel_id: string;
      identity: string;
      derived_at_ms: number;
      state: string;
      inputs: {
        msg_density_30min: number;
        audits_delivered_90min: number;
        heartbeat_age_ms: number | null;
        open_audit_asks: number;
      };
    };
    expect(parsed.channel_id).toBe(channelId);
    expect(parsed.identity).toBe("Bravo");
    expect(["SATURATED", "ACTIVE", "IDLE-AVAILABLE", "STALE"]).toContain(
      parsed.state,
    );
    expect(typeof parsed.inputs.msg_density_30min).toBe("number");
    expect(typeof parsed.inputs.audits_delivered_90min).toBe("number");
    expect(typeof parsed.inputs.open_audit_asks).toBe("number");
  });
});

describe("bandwidth CLI — T3.5 unclaimed identity → STALE", () => {
  it("returns STALE for an identity that has no claim on the channel", () => {
    const result = runBandwidth([
      "show",
      "--for",
      "Echo", // never claimed in beforeEach
      "--channel",
      channelId,
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      state: string;
      inputs: { heartbeat_age_ms: number | null };
    };
    expect(parsed.state).toBe("STALE");
    expect(parsed.inputs.heartbeat_age_ms).toBeNull();
  });
});

describe("bandwidth CLI — T3.6 missing flag errors", () => {
  it("exits non-zero when --for is omitted", () => {
    const result = runBandwidth(["show", "--channel", channelId]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--for");
  });

  it("exits non-zero when --channel is omitted", () => {
    const result = runBandwidth(["show", "--for", "Bravo"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--channel");
  });

  it("exits non-zero on unknown subcommand", () => {
    const result = runBandwidth(["wat"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown subcommand");
  });

  it("prints help on --help", () => {
    const result = runBandwidth(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("show --for");
  });
});
