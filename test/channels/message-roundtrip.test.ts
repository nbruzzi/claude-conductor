// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 7 joint piece (Alpha-owned): ChannelMessage round-trip tests.
 *
 * Plan: ~/.claude/plans/vivid-seeking-crayon.md §Slice 7 + parent plan §212.
 *
 * Verifies appendMessage → readMessages round-trip preserves all
 * ChannelMessage fields exactly, including the Slice 1 schema-additive
 * fields (identity, role) and the Slice 6 send-attached identity+role
 * shape. Catches future serialization drift, schema violations on read,
 * and tolerant-reader regressions.
 *
 * Coverage:
 *   - All 4 ChannelKind values (note, question, handoff, status).
 *   - All 3 ChannelRole values (pen, queue, out).
 *   - Optional fields absent (legacy shape).
 *   - Optional fields present (Slice 6 shape).
 *   - Body content fidelity: UTF-8 multibyte, CRLF, special chars.
 *   - body_ref shunt path (large body → sidecar file).
 *   - Multi-message ordering preserved.
 *   - Tolerant reader: unknown fields stripped silently.
 *   - Schema rejection: invalid kind dropped from read.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendMessage,
  CHANNEL_KINDS,
  createChannel,
  readMessages,
  resolveChannelsDir,
  type ChannelMessage,
  type ChannelRole,
} from "../../src/channels/api.ts";
import { isChannelMessage } from "../../src/channels/index.ts";

const SESSION = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";
let sandbox: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "msg-roundtrip-")));
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(sandbox, "channels");
  process.env["CHANNELS_DIR"] = join(sandbox, "channels");
});

afterEach(() => {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  delete process.env["CHANNELS_DIR"];
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

async function setup(channelId: string): Promise<void> {
  await createChannel({ channelId, handoffId: channelId, sessionId: SESSION });
}

function baseMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    ts: new Date().toISOString(),
    from: SESSION,
    kind: "note",
    body: "default",
    ...overrides,
  };
}

describe("ChannelMessage round-trip — Slice 7 invariant lock", () => {
  describe("required fields preserved exactly", () => {
    it("minimal message (ts, from, kind, body)", async () => {
      await setup("c-min");
      const sent = baseMsg({ body: "hello" });
      await appendMessage({ channelId: "c-min", message: sent });
      const [received] = readMessages("c-min");
      expect(received).toBeDefined();
      expect(received?.ts).toBe(sent.ts);
      expect(received?.from).toBe(sent.from);
      expect(received?.kind).toBe(sent.kind);
      expect(received?.body).toBe(sent.body);
    });

    it("preserves every CHANNEL_KINDS value across round-trip", async () => {
      // Anchored to the SSOT tuple (per ARCH-2 fold on Phase 0). When
      // Layer 3 / Layer 4 commits append walkie-talkie + digest kinds
      // to `CHANNEL_KINDS`, this loop body widens automatically — no
      // separate edit to a parallel literal kind-list.
      await setup("c-kinds");
      for (const k of CHANNEL_KINDS) {
        await appendMessage({
          channelId: "c-kinds",
          message: baseMsg({ kind: k, body: `body-${k}` }),
        });
      }
      const messages = readMessages("c-kinds");
      expect(messages).toHaveLength(CHANNEL_KINDS.length);
      expect(messages.map((m) => m.kind).sort()).toEqual(
        [...CHANNEL_KINDS].sort(),
      );
    });
  });

  describe("Slice 1 additive fields (identity, role)", () => {
    it("preserves identity field across round-trip", async () => {
      await setup("c-id");
      await appendMessage({
        channelId: "c-id",
        message: baseMsg({ identity: "Alpha", body: "with-identity" }),
      });
      const [received] = readMessages("c-id");
      expect(received?.identity).toBe("Alpha");
    });

    it("preserves role field across round-trip", async () => {
      await setup("c-role");
      await appendMessage({
        channelId: "c-role",
        message: baseMsg({ role: "pen", body: "with-role" }),
      });
      const [received] = readMessages("c-role");
      expect(received?.role).toBe("pen");
    });

    it("preserves all 3 ChannelRole values (pen, queue, out)", async () => {
      await setup("c-roles");
      const roles: ChannelRole[] = ["pen", "queue", "out"];
      for (const r of roles) {
        await appendMessage({
          channelId: "c-roles",
          message: baseMsg({ role: r, identity: "Alpha", body: `r-${r}` }),
        });
      }
      const messages = readMessages("c-roles");
      expect(messages).toHaveLength(3);
      expect(messages.map((m) => m.role).sort()).toEqual(roles.slice().sort());
    });

    it("preserves identity + role together (Slice 6 send-attached shape)", async () => {
      await setup("c-both");
      await appendMessage({
        channelId: "c-both",
        message: baseMsg({
          identity: "Bravo",
          role: "queue",
          body: "full-shape",
        }),
      });
      const [received] = readMessages("c-both");
      expect(received?.identity).toBe("Bravo");
      expect(received?.role).toBe("queue");
    });

    it("optional fields absent → undefined post-readback (not null or empty string)", async () => {
      await setup("c-abs");
      await appendMessage({
        channelId: "c-abs",
        message: baseMsg({ body: "legacy-shape" }),
      });
      const [received] = readMessages("c-abs");
      expect(received?.identity).toBeUndefined();
      expect(received?.role).toBeUndefined();
      expect(received?.body_ref).toBeUndefined();
    });
  });

  describe("body content fidelity", () => {
    it("preserves UTF-8 multibyte characters", async () => {
      await setup("c-utf8");
      const content = "héllo 世界 🦀 αβγ";
      await appendMessage({
        channelId: "c-utf8",
        message: baseMsg({ body: content }),
      });
      const [received] = readMessages("c-utf8");
      expect(received?.body).toBe(content);
    });

    it("preserves CRLF + tab + special characters", async () => {
      await setup("c-special");
      const content = "line1\r\nline2\tcolumn\twith\rcarriage";
      await appendMessage({
        channelId: "c-special",
        message: baseMsg({ body: content }),
      });
      const [received] = readMessages("c-special");
      expect(received?.body).toBe(content);
    });

    it("preserves quotes + backslashes + braces", async () => {
      await setup("c-escape");
      const content = `{"json":"in body","nested":{"key":"value\\\\with\\""}}`;
      await appendMessage({
        channelId: "c-escape",
        message: baseMsg({ body: content }),
      });
      const [received] = readMessages("c-escape");
      expect(received?.body).toBe(content);
    });
  });

  describe("body_ref sidecar shunt", () => {
    it("large body shunted to body_ref + readable round-trip", async () => {
      await setup("c-large");
      const big = "x".repeat(8 * 1024);
      const appended = await appendMessage({
        channelId: "c-large",
        message: baseMsg({ body: big }),
      });
      expect(appended.body_ref).toBeDefined();
      expect(appended.body).toBeUndefined();

      const [received] = readMessages("c-large");
      expect(received?.body_ref).toBe(appended.body_ref);
      expect(received?.body).toBeUndefined();
    });
  });

  describe("L409 body_preview (send-time blank-preview fix)", () => {
    it("shunted large body populates a single-line, truncated body_preview", async () => {
      await setup("c-bp");
      const big = "alpha bravo charlie delta echo ".repeat(200); // ~6KB > 3072
      const appended = await appendMessage({
        channelId: "c-bp",
        message: baseMsg({ body: big }),
      });
      expect(appended.body_ref).toBeDefined();
      expect(appended.body).toBeUndefined();
      expect(appended.body_preview).toBeDefined();
      // <= 200 content codepoints + at most a single trailing ellipsis
      expect(
        Array.from(appended.body_preview ?? "").length,
      ).toBeLessThanOrEqual(201);
      expect(appended.body_preview?.startsWith("alpha bravo charlie")).toBe(
        true,
      );
      // round-trips through serialize → JSONL → readMessages (extra field preserved)
      const [received] = readMessages("c-bp");
      expect(received?.body_preview).toBe(appended.body_preview);
      expect(received?.body).toBeUndefined();
      expect(received?.body_ref).toBe(appended.body_ref);
    });

    it("collapses newlines so the preview stays single-line (tail/JSONL safety)", async () => {
      await setup("c-bp-nl");
      const big = "line one\nline two\r\nline three\t".repeat(150); // > 3072 w/ breaks
      const appended = await appendMessage({
        channelId: "c-bp-nl",
        message: baseMsg({ body: big }),
      });
      expect(appended.body_preview).toBeDefined();
      expect(appended.body_preview).not.toContain("\n");
      expect(appended.body_preview).not.toContain("\r");
    });

    it("truncates on codepoint boundaries — never splits an astral surrogate", async () => {
      await setup("c-bp-cp");
      const big = "🦀".repeat(2000); // 4 bytes each → ~8KB; truncation lands mid-stream
      const appended = await appendMessage({
        channelId: "c-bp-cp",
        message: baseMsg({ body: big }),
      });
      expect(appended.body_preview).toBeDefined();
      const cps = Array.from((appended.body_preview ?? "").replace(/…$/u, ""));
      expect(cps.length).toBeGreaterThan(0);
      // a split surrogate would not equal the whole crab codepoint
      for (const cp of cps) expect(cp).toBe("🦀");
    });

    it("small (non-shunted) body → no body_preview", async () => {
      await setup("c-bp-small");
      const appended = await appendMessage({
        channelId: "c-bp-small",
        message: baseMsg({ body: "tiny inline body" }),
      });
      expect(appended.body_ref).toBeUndefined();
      expect(appended.body).toBe("tiny inline body");
      expect(appended.body_preview).toBeUndefined();
    });

    it("isChannelMessage rejects a non-string body_preview (shape hygiene)", () => {
      expect(
        isChannelMessage({
          ts: new Date().toISOString(),
          from: SESSION,
          kind: "note",
          body_ref: "deadbeef",
          body_preview: 123,
        }),
      ).toBe(false);
    });
  });

  describe("multi-message ordering", () => {
    it("preserves append order across N messages", async () => {
      await setup("c-order");
      const N = 10;
      for (let i = 0; i < N; i++) {
        await appendMessage({
          channelId: "c-order",
          message: baseMsg({ body: `msg-${i}` }),
        });
      }
      const messages = readMessages("c-order");
      expect(messages).toHaveLength(N);
      for (let i = 0; i < N; i++) {
        expect(messages[i]?.body).toBe(`msg-${i}`);
      }
    });

    it("preserves ts ordering ascending", async () => {
      await setup("c-ts");
      for (let i = 0; i < 5; i++) {
        await appendMessage({
          channelId: "c-ts",
          message: baseMsg({ body: `t-${i}` }),
        });
      }
      const messages = readMessages("c-ts");
      for (let i = 1; i < messages.length; i++) {
        const prev = messages[i - 1]?.ts ?? "";
        const cur = messages[i]?.ts ?? "";
        expect(prev <= cur).toBe(true);
      }
    });
  });

  describe("tolerant reader + schema enforcement", () => {
    it("tolerates unknown fields without rejecting message (forward-compat)", async () => {
      await setup("c-unknown");
      const path = join(resolveChannelsDir(), "c-unknown", "messages.jsonl");
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        from: SESSION,
        kind: "note",
        body: "with-extras",
        future_field: "ignored",
        another_unknown: { nested: true },
      });
      writeFileSync(path, line + "\n", { flag: "a" });

      const [received] = readMessages("c-unknown");
      expect(received).toBeDefined();
      // Required + known fields preserved exactly even with unknown extras
      expect(received?.body).toBe("with-extras");
      expect(received?.kind).toBe("note");
      expect(received?.from).toBe(SESSION);
      // Forward-compat contract: reader does NOT reject on unknown fields.
      // Whether they're preserved or stripped at runtime is implementation
      // choice (TS types elide them either way).
    });

    it("invalid kind dropped from read (schema rejection)", async () => {
      await setup("c-bad");
      const path = join(resolveChannelsDir(), "c-bad", "messages.jsonl");
      await appendMessage({
        channelId: "c-bad",
        message: baseMsg({ body: "valid" }),
      });
      const badLine = JSON.stringify({
        ts: new Date().toISOString(),
        from: SESSION,
        kind: "bogus",
        body: "should-be-dropped",
      });
      writeFileSync(path, badLine + "\n", { flag: "a" });

      const messages = readMessages("c-bad");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body).toBe("valid");
    });
  });
});
