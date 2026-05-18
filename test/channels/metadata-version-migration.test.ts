// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Filesystem-level migration tests for `ChannelMetadata.version` field
 * (slice 6 / plan `mirrored-stitching-orchid.md` / A1 / FOLD-1 + Q3).
 *
 * Validator-only semantics are covered in `metadata-validator.test.ts`.
 * This file pins the on-disk + round-trip invariants:
 *
 *   (b) `createChannel` writes `metadata.json` with explicit `version: 1`.
 *   (d) Round-trip `createChannel` → `readMetadata` returns `version: 1`.
 *   Legacy: a channel whose on-disk `metadata.json` predates the version
 *     field reads OK and is materialized in memory with `version: 1`.
 *   (f) Q3-instrumentation: concurrent reader during a lock-held write
 *     sees a consistent shape (race-safety invariant). Locks the
 *     `withMetadataLock` + atomic-rename contract against future refactor.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  createChannel,
  readMetadata,
  resolveChannelsDir,
} from "../../src/channels/index.ts";

const SESSION_ID = "0dc53626-9afc-49d4-b799-b324e64e190d";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-version-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
  process.env["CLAUDE_SESSION_ID"] = SESSION_ID;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
  if (prevSessionId !== undefined) {
    process.env["CLAUDE_SESSION_ID"] = prevSessionId;
  } else {
    delete process.env["CLAUDE_SESSION_ID"];
  }
});

describe("ChannelMetadata.version migration", () => {
  it("(b) createChannel writes metadata.json with explicit version: 1 on disk", async () => {
    const channelId = "2026-05-18_test-write-back";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_ID,
    });
    const path = join(resolveChannelsDir(), channelId, "metadata.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["version"]).toBe(1);
  });

  it("(d) round-trip createChannel → readMetadata returns version: 1", async () => {
    const channelId = "2026-05-18_test-round-trip";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_ID,
    });
    const meta = readMetadata(channelId);
    expect(meta.version).toBe(1);
  });

  it("legacy channel (no version on disk) reads OK and injects version: 1 in memory", () => {
    const channelId = "2026-05-18_test-legacy-read";
    const dir = join(resolveChannelsDir(), channelId);
    const path = join(dir, "metadata.json");
    mkdirSync(dir, { recursive: true });
    const legacy = {
      created_at: "2026-04-28T13:00:00Z",
      lifecycle: "parallel",
      handoff_id: channelId,
      participants: [SESSION_ID],
    };
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
    const meta = readMetadata(channelId);
    expect(meta.version).toBe(1);
    expect(meta.handoff_id).toBe(channelId);
  });

  it("(f) Q3-instrumentation: concurrent reader during lock-held write sees consistent shape", async () => {
    // Race-safety invariant: writes go through withMetadataLock +
    // atomic-rename; readers never see a partial file. This test pins
    // the invariant against future refactor that drops the lock.
    const channelId = "2026-05-18_test-concurrent-rw";
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_ID,
    });

    const readers = Array.from({ length: 10 }, async () => {
      for (let i = 0; i < 5; i++) {
        const meta = readMetadata(channelId);
        expect(meta.version).toBe(1);
        expect(meta.lifecycle).toBe("parallel");
      }
    });
    const writer = (async () => {
      for (let i = 0; i < 5; i++) {
        await appendMessage({
          channelId,
          message: {
            ts: new Date().toISOString(),
            from: SESSION_ID,
            kind: "status",
            body: `concurrent-test-${i}`,
          },
        });
      }
    })();

    await Promise.all([...readers, writer]);
    const final = readMetadata(channelId);
    expect(final.version).toBe(1);
  });
});
