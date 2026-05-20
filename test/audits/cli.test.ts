// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the audits CLI (Slice 3 Layer 4 — flag parsing + integration
 * roundtrip).
 *
 * Pattern mirrors `test/channels/cli-body-file.test.ts`: spawnSync
 * against the real CLI file with `CLAUDE_CONDUCTOR_CHANNELS_DIR` override
 * to isolate per-test channels.
 *
 * Coverage matches plan §Test plan Phase 3 (audit-queue subset):
 *
 *   T3.1  happy path — JSON output shape matches §D4
 *   T3.2  missing --for → error exit
 *   T3.3  unknown flag → error exit
 *
 * Plan: ~/.claude/plans/slice-3-audit-queue-bandwidth-2026-05-19.md v0.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const AUDITS_CLI = resolvePath(import.meta.dir, "../../src/audits/cli.ts");
const CHANNELS_CLI = resolvePath(import.meta.dir, "../../src/channels/cli.ts");
const TEST_SESSION_ID = "11111111-2222-3333-4444-555555555555";
const TEST_SESSION_ID_BRAVO = "22222222-3333-4444-5555-666666666666";

let tmpRoot: string;
let channelsDir: string;
const channelId = "audit-queue-cli-test";

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

function runAudits(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", AUDITS_CLI, ...args], {
    env: envFor(TEST_SESSION_ID),
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "audits-cli-test-"));
  channelsDir = join(tmpRoot, "channels");
  mkdirSync(channelsDir, { recursive: true });

  const create = runChannels(["create", channelId, "test-handoff"]);
  if (create.status !== 0) {
    throw new Error(
      `setup: create failed (${create.status}): ${create.stderr}`,
    );
  }
  // Two identities so the ask-from-X-to-Y mapping has stamped identities.
  const joinAlpha = runChannels(["join", channelId, "--as", "Alpha"], {
    sid: TEST_SESSION_ID,
  });
  if (joinAlpha.status !== 0) {
    throw new Error(`setup: join Alpha failed: ${joinAlpha.stderr}`);
  }
  const joinBravo = runChannels(["join", channelId, "--as", "Bravo"], {
    sid: TEST_SESSION_ID_BRAVO,
  });
  if (joinBravo.status !== 0) {
    throw new Error(`setup: join Bravo failed: ${joinBravo.stderr}`);
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("audits CLI — T3.1 happy path", () => {
  it("queue --for prints JSON with pending audit-ask after post", () => {
    const askBody = JSON.stringify({
      kind_version: 1,
      target_pr: { repo: "claude-conductor", number: 999 },
      target_peer: "Bravo",
      tier: "3-lens-convergence",
      lens_set_requested: ["RE", "Architecture", "TA"],
      audit_class: "inside-pair",
    });
    const send = runChannels(["send", channelId, "audit-ask"], {
      stdin: askBody,
      sid: TEST_SESSION_ID,
    });
    if (send.status !== 0) {
      throw new Error(`audit-ask send failed: ${send.stderr}`);
    }

    const result = runAudits([
      "queue",
      "--for",
      "Bravo",
      "--channel",
      channelId,
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      channel_id: string;
      target_identity: string;
      as_of_ms: number;
      pending: ReadonlyArray<{
        pr_repo: string;
        pr_number: number;
        from_identity: string;
        tier: string;
        audit_class: string;
      }>;
    };
    expect(parsed.channel_id).toBe(channelId);
    expect(parsed.target_identity).toBe("Bravo");
    expect(parsed.pending).toHaveLength(1);
    const pending0 = parsed.pending[0];
    expect(pending0?.pr_number).toBe(999);
    expect(pending0?.from_identity).toBe("Alpha");
    expect(pending0?.tier).toBe("3-lens-convergence");
    expect(pending0?.audit_class).toBe("inside-pair");
  });
});

describe("audits CLI — T3.2 missing --for errors", () => {
  it("exits non-zero when --for is omitted", () => {
    const result = runAudits(["queue", "--channel", channelId]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--for");
  });

  it("exits non-zero when --channel is omitted", () => {
    const result = runAudits(["queue", "--for", "Bravo"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--channel");
  });
});

describe("audits CLI — T3.3 unknown flag errors", () => {
  it("exits non-zero on unknown flag", () => {
    const result = runAudits([
      "queue",
      "--for",
      "Bravo",
      "--channel",
      channelId,
      "--bogus",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown flag");
  });

  it("exits non-zero on unknown subcommand", () => {
    const result = runAudits(["nope"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown subcommand");
  });

  it("prints help on --help", () => {
    const result = runAudits(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("queue --for");
  });
});
