// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * L496 regression: stdin-pipe and --body-file send paths produce
 * body_ref-only JSONL lines when body exceeds SMALL_MESSAGE_MAX_BYTES
 * (3 KiB). No `body` field accompanies the `body_ref` — i.e., no
 * dual-write schema violation.
 *
 * Backlog L496 reframe: original 2026-05-06 + 2026-05-13 render warnings
 * fired on in-memory state that never persisted. Primary-source jq scan
 * of 1373 messages across 51 channels (6 live + 45 archive) on
 * 2026-05-17 returned zero `body && body_ref` JSONL lines. This test
 * pins the correct behavior in regression so any future write-path
 * change that reintroduces the dual-write surface fails loud.
 *
 * Coverage:
 *   - stdin-pipe send with 4 KiB body → body_ref only, no inline body
 *   - --body-file send with 4 KiB body → body_ref only, no inline body
 *   - stdin-pipe send with 1 KiB body → inline body only, no body_ref
 *   - --body-file send with 1 KiB body → inline body only, no body_ref
 *
 * Pattern mirrors test/channels/cli-body-file.test.ts (flake-resistance
 * pre-checked 5/5 green 2026-05-17 per RE-3 fold). Real subprocess
 * invocation through Bun.spawnSync ensures end-to-end argv → write-path
 * coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolvePath(import.meta.dir, "../../src/channels/cli.ts");
const TEST_SESSION_ID = "55555555-5555-5555-5555-555555555555";

let tmpRoot: string;
let channelsDir: string;
let channelId: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cli-body-ref-regression-"));
  channelsDir = join(tmpRoot, "channels");
  mkdirSync(channelsDir, { recursive: true });
  channelId = "body-ref-regression";

  const create = spawnSync(
    "bun",
    ["run", CLI_PATH, "create", channelId, "test-handoff"],
    {
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: TEST_SESSION_ID,
        CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
      },
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (create.status !== 0) {
    throw new Error(
      `setup: create failed (${create.status}): ${create.stderr}`,
    );
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sendViaStdin(body: string): SpawnSyncReturns<string> {
  return spawnSync("bun", ["run", CLI_PATH, "send", channelId, "status"], {
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: TEST_SESSION_ID,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
    },
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
    input: body,
  });
}

function sendViaBodyFile(body: string): SpawnSyncReturns<string> {
  const bodyPath = join(tmpRoot, "body.txt");
  writeFileSync(bodyPath, body, "utf-8");
  return spawnSync(
    "bun",
    ["run", CLI_PATH, "send", channelId, "status", "--body-file", bodyPath],
    {
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: TEST_SESSION_ID,
        CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDir,
      },
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function readSingleMessage(): Record<string, unknown> {
  const jsonlPath = join(channelsDir, channelId, "messages.jsonl");
  const lines = readFileSync(jsonlPath, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0);
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

describe("L496 — stdin-pipe send produces body_ref-only for large body", () => {
  it("stdin-pipe with 4 KiB body produces body_ref only (no inline body field)", () => {
    const body = "x".repeat(4 * 1024);
    const result = sendViaStdin(body);
    expect(result.status).toBe(0);

    const msg = readSingleMessage();
    expect(msg["body_ref"]).toBeTypeOf("string");
    expect(msg["body"]).toBeUndefined();
  });

  it("--body-file with 4 KiB body produces body_ref only (clean control)", () => {
    const body = "x".repeat(4 * 1024);
    const result = sendViaBodyFile(body);
    expect(result.status).toBe(0);

    const msg = readSingleMessage();
    expect(msg["body_ref"]).toBeTypeOf("string");
    expect(msg["body"]).toBeUndefined();
  });
});

describe("L496 — small body stays inline (no shunt below threshold)", () => {
  it("stdin-pipe with 1 KiB body produces inline body only (no body_ref)", () => {
    const body = "x".repeat(1024);
    const result = sendViaStdin(body);
    expect(result.status).toBe(0);

    const msg = readSingleMessage();
    expect(msg["body"]).toBeTypeOf("string");
    expect(msg["body"]).toBe(body);
    expect(msg["body_ref"]).toBeUndefined();
  });

  it("--body-file with 1 KiB body produces inline body only (clean control)", () => {
    const body = "x".repeat(1024);
    const result = sendViaBodyFile(body);
    expect(result.status).toBe(0);

    const msg = readSingleMessage();
    expect(msg["body"]).toBeTypeOf("string");
    expect(msg["body"]).toBe(body);
    expect(msg["body_ref"]).toBeUndefined();
  });
});
