// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 3a value-export integrity + dual-resolver regression + consumer-shape smoke.
 * Plan: ~/.claude/plans/vivid-seeking-crayon.md §6 (TA-1 fix).
 *
 * Assertion shapes:
 *   (a) Value-export presence: every name imported via the package-published
 *       path resolves to a non-undefined runtime binding. Catches missing
 *       names + accidental `export type` typo on a value name (which would
 *       erase at runtime). 20 names = 20 explicit tests.
 *   (b) Type-export sentinels: separate `api.type-test.ts` (compile-only).
 *   (c) ARCH-1 dual-resolver regression: non-UUID `CLAUDE_SESSION_ID` hits
 *       channels-internal lenient path verbatim but falls through
 *       shared/session-id-discovery's strict path. Documents the divergent
 *       gate behavior at runtime.
 *   (d) Consumer-shape smoke: round-trip via published path proves the
 *       exports map gates correctly + the surface is consumable as Slice 3b
 *       will consume it.
 *
 * Tests (a) + (d) overlap intentionally — (a) is the cheap shape gate
 * (20 names), (d) is the wiring gate (3-name round-trip). Documented per
 * TA-9 known-follow-up to prevent future dedup misjudgment.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as api from "claude-conductor/channels/api";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-api-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpRoot, "channels");
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

// ─── (a) Value-export presence ──────────────────────────────────────
// One test per value name; explicit (not it.each) so failure messages
// point at the broken export by name. 24 names total (added
// `CHANNEL_KINDS` + `renderKindPrefix` in Phase 0 of Phase 4 Step A
// commit `8708359`; added `explicitlyOutPeers` + `makeSendOutMutator`
// in the v5 out-kind atomicity commit per ARCH-1 + ARCH-7 folds of the
// staged-diff cross-audit cycle).

describe("api.ts value exports — presence + runtime resolution (TA-1 fix)", () => {
  it("appendMessage is a function", () => {
    expect(typeof api.appendMessage).toBe("function");
  });
  it("archiveChannel is a function", () => {
    expect(typeof api.archiveChannel).toBe("function");
  });
  it("CHANNEL_KINDS is an array", () => {
    expect(Array.isArray(api.CHANNEL_KINDS)).toBe(true);
    expect(api.CHANNEL_KINDS.length).toBeGreaterThan(0);
  });
  it("channelIdFromHandoff is a function", () => {
    expect(typeof api.channelIdFromHandoff).toBe("function");
  });
  it("closeChannel is a function", () => {
    expect(typeof api.closeChannel).toBe("function");
  });
  it("createChannel is a function", () => {
    expect(typeof api.createChannel).toBe("function");
  });
  it("explicitlyOutPeers is a function", () => {
    expect(typeof api.explicitlyOutPeers).toBe("function");
  });
  it("heartbeatMtime is a function", () => {
    expect(typeof api.heartbeatMtime).toBe("function");
  });
  it("isChannelMessage is a function", () => {
    expect(typeof api.isChannelMessage).toBe("function");
  });
  it("isValidIdentity is a function", () => {
    expect(typeof api.isValidIdentity).toBe("function");
  });
  it("joinChannel is a function", () => {
    expect(typeof api.joinChannel).toBe("function");
  });
  it("listChannels is a function", () => {
    expect(typeof api.listChannels).toBe("function");
  });
  it("makeSendOutMutator is a function", () => {
    expect(typeof api.makeSendOutMutator).toBe("function");
  });
  it("NATO_POOL is an array", () => {
    expect(Array.isArray(api.NATO_POOL)).toBe(true);
    expect(api.NATO_POOL.length).toBeGreaterThan(0);
  });
  it("newestHeartbeatMtime is a function", () => {
    expect(typeof api.newestHeartbeatMtime).toBe("function");
  });
  it("pruneArchive is a function", () => {
    expect(typeof api.pruneArchive).toBe("function");
  });
  it("readBodyFile is a function", () => {
    expect(typeof api.readBodyFile).toBe("function");
  });
  it("readMessages is a function", () => {
    expect(typeof api.readMessages).toBe("function");
  });
  it("readMessagesAfter is a function", () => {
    expect(typeof api.readMessagesAfter).toBe("function");
  });
  it("readMessagesTail is a function", () => {
    expect(typeof api.readMessagesTail).toBe("function");
  });
  it("readMetadata is a function", () => {
    expect(typeof api.readMetadata).toBe("function");
  });
  it("renderKindPrefix is a function", () => {
    expect(typeof api.renderKindPrefix).toBe("function");
  });
  it("resolveArchiveDir is a function", () => {
    expect(typeof api.resolveArchiveDir).toBe("function");
  });
  it("resolveChannelsDir is a function", () => {
    expect(typeof api.resolveChannelsDir).toBe("function");
  });
  it("resolveSessionId is a function", () => {
    expect(typeof api.resolveSessionId).toBe("function");
  });
  it("touchHeartbeat is a function", () => {
    expect(typeof api.touchHeartbeat).toBe("function");
  });
  it("validateChannelMetadata is a function", () => {
    expect(typeof api.validateChannelMetadata).toBe("function");
  });
});

// ─── (c) ARCH-1 dual-resolver regression ────────────────────────────

describe("ARCH-1 dual-resolver divergence (cross-edge env-var contract)", () => {
  it("non-UUID CLAUDE_SESSION_ID: channels-internal lenient path returns it; strict path falls through", async () => {
    // Path-safe id that passes isValidSessionId but fails STRICT_UUID.
    process.env["CLAUDE_SESSION_ID"] = "test-session";

    // (a) Channels-internal resolver via api re-export — lenient gate.
    const channelsResult = api.resolveSessionId(undefined);
    expect(channelsResult).toBe("test-session");

    // (b) Strict-UUID CLI-context resolver via shared/session-id-discovery
    //     — falls through env path (STRICT_UUID rejects "test-session");
    //     ppid-walk in this test env returns null (no CC binary in our
    //     overridden empty sessionsDir); mtime fallback returns missing.
    const discovery =
      await import("claude-conductor/shared/session-id-discovery");
    const sessionsDir = join(tmpRoot, "sessions"); // empty/non-existent
    const result = discovery.resolveSessionId({
      sessionsDir,
      retryCount: 0,
      retryDelayMs: 1,
    });
    expect(result.kind).toBe("missing");

    // The two resolvers DIVERGE on the same env var. This is intentional.
  });
});

// ─── (d) Consumer-shape smoke ───────────────────────────────────────

describe("Consumer-shape smoke (TA-5 fix) — round-trip via published path", () => {
  it("createChannel → appendMessage → readMessages round-trip", async () => {
    // Use a UUID for sessionId so both resolvers agree (the dual-resolver
    // divergence is exercised by the previous test, not here).
    const sessionId = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";
    process.env["CLAUDE_SESSION_ID"] = sessionId;

    const channelId = "smoke-test-channel";
    const meta = await api.createChannel({
      channelId,
      handoffId: "smoke-handoff",
      sessionId,
    });
    expect(meta.handoff_id).toBe("smoke-handoff");
    expect(meta.participants).toContain(sessionId);

    // Append via the public surface (not internal).
    await api.appendMessage({
      channelId,
      message: {
        ts: new Date().toISOString(),
        kind: "status",
        from: sessionId,
        body: "smoke",
      },
    });

    // Read back via the public surface.
    const messages = api.readMessages(channelId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("smoke");
    expect(messages[0]?.from).toBe(sessionId);

    // Confirm the channel was created in the env-var-overridden dir.
    expect(
      existsSync(join(tmpRoot, "channels", channelId, "metadata.json")),
    ).toBe(true);
  });
});
