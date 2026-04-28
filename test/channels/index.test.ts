// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  archiveChannel,
  channelIdFromHandoff,
  closeChannel,
  createChannel,
  heartbeatMtime,
  joinChannel,
  listChannels,
  newestHeartbeatMtime,
  pruneArchive,
  readBodyFile,
  readMessages,
  readMetadata,
  resolveArchiveDir,
  resolveChannelsDir,
  resolveSessionId,
  touchHeartbeat,
  type ChannelMessage,
} from "../../src/channels/index.ts";

const SANDBOX = `/tmp/test-channels-${process.pid}`;
const SESSION = "sess-test";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  delete process.env["CLAUDE_SESSION_ID"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    ts: new Date().toISOString(),
    from: SESSION,
    kind: "note",
    body: "hello",
    ...overrides,
  };
}

describe("channels", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  describe("channelIdFromHandoff", () => {
    it("strips HANDOFF_ prefix and .md suffix", async () => {
      expect(channelIdFromHandoff("HANDOFF_2026-04-19_11-30.md")).toBe(
        "2026-04-19_11-30",
      );
    });

    it("accepts a full path", async () => {
      expect(
        channelIdFromHandoff(
          join(homedir(), ".claude", "handoffs", "HANDOFF_2026-04-19_11-30.md"),
        ),
      ).toBe("2026-04-19_11-30");
    });

    it("throws when filename does not start with HANDOFF_", async () => {
      expect(() => channelIdFromHandoff("LATEST.md")).toThrow();
      expect(() => channelIdFromHandoff("/some/path/other.md")).toThrow();
    });

    it("throws on empty id after stripping", async () => {
      expect(() => channelIdFromHandoff("HANDOFF_.md")).toThrow();
    });
  });

  describe("resolveSessionId", () => {
    it("prefers CLAUDE_SESSION_ID env", async () => {
      process.env["CLAUDE_SESSION_ID"] = "env-session";
      expect(resolveSessionId({ session_id: "raw-session" })).toBe(
        "env-session",
      );
    });

    it("falls back to hook input session_id", async () => {
      expect(resolveSessionId({ session_id: "raw-session" })).toBe(
        "raw-session",
      );
    });

    it("throws when neither source yields an id", async () => {
      expect(() => resolveSessionId({})).toThrow();
      expect(() => resolveSessionId(undefined)).toThrow();
    });

    it("ignores empty session_id string", async () => {
      expect(() => resolveSessionId({ session_id: "" })).toThrow();
    });
  });

  describe("create / join / close", () => {
    it("creates a channel with the creator as sole participant", async () => {
      const meta = await createChannel({
        channelId: "c-1",
        handoffId: "c-1",
        sessionId: SESSION,
      });
      expect(meta.participants).toEqual([SESSION]);
      expect(meta.lifecycle).toBe("parallel");
      expect(meta.closed_at).toBeUndefined();
      expect(heartbeatMtime("c-1", SESSION)).not.toBeNull();
    });

    it("refuses duplicate create", async () => {
      await createChannel({
        channelId: "c-dup",
        handoffId: "c-dup",
        sessionId: SESSION,
      });
      await expect(
        createChannel({
          channelId: "c-dup",
          handoffId: "c-dup",
          sessionId: "other",
        }),
      ).rejects.toThrow(/already exists/u);
    });

    it("join adds a participant idempotently", async () => {
      await createChannel({
        channelId: "c-j",
        handoffId: "c-j",
        sessionId: SESSION,
      });
      const m1 = await joinChannel({ channelId: "c-j", sessionId: "peer-1" });
      expect(m1.participants).toEqual([SESSION, "peer-1"]);
      const m2 = await joinChannel({ channelId: "c-j", sessionId: "peer-1" });
      expect(m2.participants).toEqual([SESSION, "peer-1"]);
    });

    it("close sets closed_at and refuses subsequent appends", async () => {
      await createChannel({
        channelId: "c-c",
        handoffId: "c-c",
        sessionId: SESSION,
      });
      await closeChannel({ channelId: "c-c", sessionId: SESSION });
      expect(() => appendMessage({ channelId: "c-c", message: msg() })).toThrow(
        /closed/u,
      );
    });

    it("close is idempotent", async () => {
      await createChannel({
        channelId: "c-cc",
        handoffId: "c-cc",
        sessionId: SESSION,
      });
      const a = await closeChannel({ channelId: "c-cc", sessionId: SESSION });
      const b = await closeChannel({ channelId: "c-cc", sessionId: SESSION });
      expect(b.closed_at).toBe(a.closed_at);
    });

    it("join refuses to re-open a closed channel", async () => {
      await createChannel({
        channelId: "c-cj",
        handoffId: "c-cj",
        sessionId: SESSION,
      });
      await closeChannel({ channelId: "c-cj", sessionId: SESSION });
      await expect(
        joinChannel({ channelId: "c-cj", sessionId: "peer" }),
      ).rejects.toThrow(/closed/u);
    });
  });

  describe("appendMessage + readMessages", () => {
    it("round-trips a small message inline", async () => {
      await createChannel({
        channelId: "c-m",
        handoffId: "c-m",
        sessionId: SESSION,
      });
      appendMessage({ channelId: "c-m", message: msg({ body: "hello" }) });
      const msgs = readMessages("c-m");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.body).toBe("hello");
      expect(msgs[0]?.body_ref).toBeUndefined();
    });

    it("redirects oversized bodies to sidecar and reads them back", async () => {
      await createChannel({
        channelId: "c-big",
        handoffId: "c-big",
        sessionId: SESSION,
      });
      const big = "x".repeat(8 * 1024);
      const appended = appendMessage({
        channelId: "c-big",
        message: msg({ body: big }),
      });
      expect(appended.body_ref).toBeDefined();
      expect(appended.body).toBeUndefined();
      const msgs = readMessages("c-big");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.body_ref).toBe(appended.body_ref ?? "");
      if (!appended.body_ref) throw new Error("missing body_ref");
      expect(readBodyFile("c-big", appended.body_ref)).toBe(big);
    });

    it("skips corrupt lines without throwing", async () => {
      await createChannel({
        channelId: "c-corrupt",
        handoffId: "c-corrupt",
        sessionId: SESSION,
      });
      appendMessage({
        channelId: "c-corrupt",
        message: msg({ body: "good-1" }),
      });
      const path = join(resolveChannelsDir(), "c-corrupt", "messages.jsonl");
      writeFileSync(
        path,
        readFileSync(path, "utf-8") + "this is not json\n",
        "utf-8",
      );
      appendMessage({
        channelId: "c-corrupt",
        message: msg({ body: "good-2" }),
      });
      const msgs = readMessages("c-corrupt");
      expect(msgs.map((m) => m.body)).toEqual(["good-1", "good-2"]);
    });

    it("refuses messages with invalid kind", async () => {
      await createChannel({
        channelId: "c-k",
        handoffId: "c-k",
        sessionId: SESSION,
      });
      const path = join(resolveChannelsDir(), "c-k", "messages.jsonl");
      writeFileSync(
        path,
        JSON.stringify({ ts: "x", from: "y", kind: "bogus", body: "z" }) + "\n",
        "utf-8",
      );
      const msgs = readMessages("c-k");
      expect(msgs).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    it("newestHeartbeatMtime returns the max across participants", async () => {
      await createChannel({
        channelId: "c-hb",
        handoffId: "c-hb",
        sessionId: SESSION,
      });
      const t0 = heartbeatMtime("c-hb", SESSION);
      expect(t0).not.toBeNull();
      const before = Date.now();
      touchHeartbeat("c-hb", "peer-2");
      const newest = newestHeartbeatMtime("c-hb");
      expect(newest).not.toBeNull();
      if (newest === null) throw new Error();
      expect(newest).toBeGreaterThanOrEqual(before - 1);
    });

    it("returns null for unknown session", async () => {
      await createChannel({
        channelId: "c-hb-2",
        handoffId: "c-hb-2",
        sessionId: SESSION,
      });
      expect(heartbeatMtime("c-hb-2", "not-a-participant")).toBeNull();
    });
  });

  describe("listChannels + readMetadata", () => {
    it("lists non-archived channels by default", async () => {
      await createChannel({
        channelId: "c-a",
        handoffId: "c-a",
        sessionId: SESSION,
      });
      await createChannel({
        channelId: "c-b",
        handoffId: "c-b",
        sessionId: SESSION,
      });
      archiveChannel("c-b");
      const live = listChannels();
      expect(live.map((c) => c.id).sort()).toEqual(["c-a"]);
      const all = listChannels({ includeArchived: true });
      expect(all.map((c) => c.id).sort()).toEqual(["c-a", "c-b"]);
      expect(all.find((c) => c.id === "c-b")?.archived).toBe(true);
    });

    it("readMetadata returns a parsed ChannelMetadata", async () => {
      await createChannel({
        channelId: "c-meta",
        handoffId: "c-meta",
        sessionId: SESSION,
      });
      const meta = readMetadata("c-meta");
      expect(meta.participants).toEqual([SESSION]);
      expect(meta.handoff_id).toBe("c-meta");
    });

    it("listChannels skips malformed channel dirs", async () => {
      await createChannel({
        channelId: "c-ok",
        handoffId: "c-ok",
        sessionId: SESSION,
      });
      mkdirSync(join(resolveChannelsDir(), "c-bad"), { recursive: true });
      writeFileSync(
        join(resolveChannelsDir(), "c-bad", "metadata.json"),
        "{ not json",
        "utf-8",
      );
      expect(listChannels().map((c) => c.id)).toEqual(["c-ok"]);
    });
  });

  describe("pruneArchive", () => {
    it("purges entries older than retention", async () => {
      await createChannel({
        channelId: "c-old",
        handoffId: "c-old",
        sessionId: SESSION,
      });
      archiveChannel("c-old");
      const archive = resolveArchiveDir();
      const oldPath = join(archive, "c-old");
      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
      utimesSync(oldPath, new Date(tenDaysAgo), new Date(tenDaysAgo));
      const purged = pruneArchive({ retentionDays: 1, maxEntries: 100 });
      expect(purged).toContain("c-old");
      expect(existsSync(oldPath)).toBe(false);
    });

    it("caps archive at maxEntries, oldest-first", async () => {
      const archive = resolveArchiveDir();
      mkdirSync(archive, { recursive: true });
      for (let i = 0; i < 5; i++) {
        const id = `c-${i}`;
        await createChannel({
          channelId: id,
          handoffId: id,
          sessionId: SESSION,
        });
        archiveChannel(id);
        const mtime = new Date(Date.now() - (10 - i) * 1000);
        utimesSync(join(archive, id), mtime, mtime);
      }
      const purged = pruneArchive({ retentionDays: 365, maxEntries: 3 });
      expect(purged.sort()).toEqual(["c-0", "c-1"]);
      expect(
        listChannels({ includeArchived: true })
          .map((c) => c.id)
          .sort(),
      ).toEqual(["c-2", "c-3", "c-4"]);
    });

    it("returns empty array when archive does not exist", async () => {
      expect(pruneArchive({ retentionDays: 30, maxEntries: 100 })).toEqual([]);
    });
  });
});
