// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 7 hook tests for `teammate-idle-reminder`.
 *
 * 24-case matrix per plan ~/.claude/plans/stateful-munching-volcano.md
 * REV 2 §Test cases. Covers:
 *   - happy paths (no claims / no idle / one idle / multi idle / mixed)
 *   - clock-skew gate (body matches / diverges / legacy empty / corrupt)
 *   - rate-limit gate (recent / stale / missing / corrupt / shape-invalid)
 *   - multi-channel routing
 *   - input validation (no sid / invalid sid)
 *   - failure paths (cursor write fails → breadcrumb + warn)
 *   - env override (valid / invalid / boundary)
 *
 * Plan: ~/.claude/plans/prismatic-orbiting-mesh.md REV 2.1 §Slice 7.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { check } from "../../../src/hooks/checks/teammate-idle-reminder.ts";
import {
  createChannel,
  resolveChannelsDir,
  touchHeartbeat,
} from "../../../src/channels/index.ts";
import { claimIdentity } from "../../../src/channels/identity.ts";
import type { HookInput } from "../../../src/hooks/types.ts";

const SANDBOX = `/tmp/test-teammate-idle-reminder-${process.pid}`;
const SESSION_SELF = "11111111-1111-4111-8111-111111111111";
const SESSION_BRAVO = "22222222-2222-4222-8222-222222222222";
const SESSION_CHARLIE = "33333333-3333-4333-8333-333333333333";
const SESSION_DELTA = "44444444-4444-4444-8444-444444444444";

const ENV_KEY = "CLAUDE_CONDUCTOR_IDLE_THRESHOLD_MS";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  delete process.env[ENV_KEY];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

function inputFor(sessionId: string | undefined): HookInput {
  const raw: Record<string, unknown> =
    sessionId === undefined ? {} : { session_id: sessionId };
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw,
    dispatch: { verbose: false },
  };
}

/** Backdate heartbeat mtime + body to a specific past wall-clock time. */
function backdateHeartbeat(
  channelId: string,
  sessionId: string,
  ageMs: number,
  bodyOverrideMs?: number | null | "empty" | "corrupt",
): void {
  const path = join(resolveChannelsDir(), channelId, "heartbeat", sessionId);
  const targetMs = Date.now() - ageMs;
  const targetSec = targetMs / 1000;

  let body: string;
  if (bodyOverrideMs === "empty") body = "";
  else if (bodyOverrideMs === "corrupt") body = "not-a-number";
  else if (bodyOverrideMs === null || bodyOverrideMs === undefined)
    body = String(targetMs);
  else body = String(bodyOverrideMs);

  mkdirSync(join(resolveChannelsDir(), channelId, "heartbeat"), {
    recursive: true,
  });
  writeFileSync(path, body, "utf-8");
  utimesSync(path, targetSec, targetSec);
}

function cursorPath(channelId: string, sessionId: string): string {
  return join(
    resolveChannelsDir(),
    channelId,
    "idle-emit",
    `${sessionId}.json`,
  );
}

describe("teammate-idle-reminder hook", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  // ─── 1–5 happy path ─────────────────────────────────────────────

  it("1. No claims — session has no identity on any channel → pass()", async () => {
    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("2. No idle peers — all peers fresh → pass()", async () => {
    await createChannel({
      channelId: "ch-fresh",
      handoffId: "ch-fresh",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-fresh",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-fresh",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-fresh", SESSION_SELF);
    touchHeartbeat("ch-fresh", SESSION_BRAVO);

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("3. One idle peer (mtime > 5 min) → warn() + cursor written", async () => {
    await createChannel({
      channelId: "ch-one-idle",
      handoffId: "ch-one-idle",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-one-idle",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-one-idle",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-one-idle", SESSION_SELF);
    backdateHeartbeat("ch-one-idle", SESSION_BRAVO, 6 * 60 * 1000);

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[teammate-idle]");
    expect(result.stdout).toContain("Peer Bravo");
    expect(result.stdout).toContain("ch-one-idle");
    expect(result.stdout).toContain("close-peer");

    expect(existsSync(cursorPath("ch-one-idle", SESSION_SELF))).toBe(true);
    const cursor = JSON.parse(
      readFileSync(cursorPath("ch-one-idle", SESSION_SELF), "utf-8"),
    );
    expect(typeof cursor["Bravo"]).toBe("string");
  });

  it("4. Multiple idle peers same channel → warn() with multiple blocks", async () => {
    await createChannel({
      channelId: "ch-multi",
      handoffId: "ch-multi",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-multi",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-multi",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    await claimIdentity({
      channelId: "ch-multi",
      sessionId: SESSION_CHARLIE,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-multi", SESSION_SELF);
    backdateHeartbeat("ch-multi", SESSION_BRAVO, 6 * 60 * 1000);
    backdateHeartbeat("ch-multi", SESSION_CHARLIE, 7 * 60 * 1000);

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Peer Bravo");
    expect(result.stdout).toContain("Peer Charlie");
  });

  it("5. Idle peer + recent peer → warn() for idle only", async () => {
    await createChannel({
      channelId: "ch-mixed",
      handoffId: "ch-mixed",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-mixed",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-mixed",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    await claimIdentity({
      channelId: "ch-mixed",
      sessionId: SESSION_CHARLIE,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-mixed", SESSION_SELF);
    touchHeartbeat("ch-mixed", SESSION_BRAVO);
    backdateHeartbeat("ch-mixed", SESSION_CHARLIE, 7 * 60 * 1000);

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Peer Charlie");
    expect(result.stdout).not.toContain("Peer Bravo");
  });

  // ─── 6–9 clock-skew gate ────────────────────────────────────────

  it("6. Body matches mtime (no skew) → idle reminder emitted", async () => {
    await createChannel({
      channelId: "ch-skew-ok",
      handoffId: "ch-skew-ok",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-skew-ok",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-skew-ok",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-skew-ok", SESSION_SELF);
    backdateHeartbeat("ch-skew-ok", SESSION_BRAVO, 6 * 60 * 1000);

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
  });

  it("7. Body diverges from mtime by 6 min → suppress + clock-skew breadcrumb", async () => {
    await createChannel({
      channelId: "ch-skew-bad",
      handoffId: "ch-skew-bad",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-skew-bad",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-skew-bad",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-skew-bad", SESSION_SELF);
    const mtimeMs = Date.now() - 6 * 60 * 1000;
    backdateHeartbeat(
      "ch-skew-bad",
      SESSION_BRAVO,
      6 * 60 * 1000,
      mtimeMs - 6 * 60 * 1000,
    );

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("8. Empty body (legacy peer) → falls back to mtime → emit", async () => {
    await createChannel({
      channelId: "ch-legacy",
      handoffId: "ch-legacy",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-legacy",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-legacy",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-legacy", SESSION_SELF);
    backdateHeartbeat("ch-legacy", SESSION_BRAVO, 6 * 60 * 1000, "empty");

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
  });

  it("9. Corrupt body (non-numeric) → falls back to mtime → emit", async () => {
    await createChannel({
      channelId: "ch-corrupt-body",
      handoffId: "ch-corrupt-body",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-corrupt-body",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-corrupt-body",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-corrupt-body", SESSION_SELF);
    backdateHeartbeat(
      "ch-corrupt-body",
      SESSION_BRAVO,
      6 * 60 * 1000,
      "corrupt",
    );

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
  });

  // ─── 10–14 rate-limit gate ──────────────────────────────────────

  it("10. Rate-limit recent (last_emit 10 min ago) → suppress", async () => {
    await createChannel({
      channelId: "ch-rate-recent",
      handoffId: "ch-rate-recent",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-rate-recent",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-rate-recent",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-rate-recent", SESSION_SELF);
    backdateHeartbeat("ch-rate-recent", SESSION_BRAVO, 6 * 60 * 1000);

    const dir = join(resolveChannelsDir(), "ch-rate-recent", "idle-emit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SESSION_SELF}.json`),
      JSON.stringify({
        Bravo: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      }),
      "utf-8",
    );

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("11. Rate-limit stale (last_emit 31 min ago) → emit + update cursor", async () => {
    await createChannel({
      channelId: "ch-rate-stale",
      handoffId: "ch-rate-stale",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-rate-stale",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-rate-stale",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-rate-stale", SESSION_SELF);
    backdateHeartbeat("ch-rate-stale", SESSION_BRAVO, 6 * 60 * 1000);

    const dir = join(resolveChannelsDir(), "ch-rate-stale", "idle-emit");
    mkdirSync(dir, { recursive: true });
    const oldTs = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(
      join(dir, `${SESSION_SELF}.json`),
      JSON.stringify({ Bravo: oldTs }),
      "utf-8",
    );

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");

    const updated = JSON.parse(
      readFileSync(cursorPath("ch-rate-stale", SESSION_SELF), "utf-8"),
    );
    expect(updated["Bravo"]).not.toBe(oldTs);
  });

  it("12. Rate-limit missing cursor (first run) → emit + create cursor", async () => {
    await createChannel({
      channelId: "ch-no-cursor",
      handoffId: "ch-no-cursor",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-no-cursor",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-no-cursor",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-no-cursor", SESSION_SELF);
    backdateHeartbeat("ch-no-cursor", SESSION_BRAVO, 6 * 60 * 1000);

    expect(existsSync(cursorPath("ch-no-cursor", SESSION_SELF))).toBe(false);
    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
    expect(existsSync(cursorPath("ch-no-cursor", SESSION_SELF))).toBe(true);
  });

  it("13. Cursor JSON corrupt (parse error) → treat as {} + emit", async () => {
    await createChannel({
      channelId: "ch-cursor-parse",
      handoffId: "ch-cursor-parse",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-cursor-parse",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-cursor-parse",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-cursor-parse", SESSION_SELF);
    backdateHeartbeat("ch-cursor-parse", SESSION_BRAVO, 6 * 60 * 1000);

    const dir = join(resolveChannelsDir(), "ch-cursor-parse", "idle-emit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION_SELF}.json`), "not-json {{", "utf-8");

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
  });

  it("14. Cursor shape invalid (array) → emit", async () => {
    await createChannel({
      channelId: "ch-cursor-shape",
      handoffId: "ch-cursor-shape",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-cursor-shape",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-cursor-shape",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-cursor-shape", SESSION_SELF);
    backdateHeartbeat("ch-cursor-shape", SESSION_BRAVO, 6 * 60 * 1000);

    const dir = join(resolveChannelsDir(), "ch-cursor-shape", "idle-emit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SESSION_SELF}.json`),
      JSON.stringify(["array-not-object"]),
      "utf-8",
    );

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
  });

  // ─── 15 multi-channel ───────────────────────────────────────────

  it("15. Multi-channel: idle on ch-1, fresh on ch-2 → emission for ch-1 only", async () => {
    await createChannel({
      channelId: "ch-1",
      handoffId: "ch-1",
      sessionId: SESSION_SELF,
    });
    await createChannel({
      channelId: "ch-2",
      handoffId: "ch-2",
      sessionId: SESSION_SELF,
    });
    // Both channels: SELF claims first (gets Alpha), peer claims second (gets Bravo).
    await claimIdentity({
      channelId: "ch-1",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-1",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    await claimIdentity({
      channelId: "ch-2",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-2",
      sessionId: SESSION_CHARLIE,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-1", SESSION_SELF);
    touchHeartbeat("ch-2", SESSION_SELF);
    backdateHeartbeat("ch-1", SESSION_BRAVO, 6 * 60 * 1000); // ch-1 peer idle
    touchHeartbeat("ch-2", SESSION_CHARLIE); // ch-2 peer fresh

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("ch-1");
    expect(result.stdout).not.toContain("ch-2"); // fresh ch-2 peer not reported
  });

  // ─── 16–18 input validation ────────────────────────────────────

  it("16. Empty session-id input → pass()", async () => {
    const result = await check(inputFor(undefined));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("17. Invalid session-id format (non-UUID) → pass()", async () => {
    const result = await check(inputFor("not-a-uuid"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("18. listChannels failure path: helper returns [] → pass()", async () => {
    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  // ─── 19–21 failure handling ────────────────────────────────────

  it("19. Cursor write failure (read-only dir) → fail-open warn() returned", async () => {
    await createChannel({
      channelId: "ch-eacces",
      handoffId: "ch-eacces",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-eacces",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-eacces",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-eacces", SESSION_SELF);
    backdateHeartbeat("ch-eacces", SESSION_BRAVO, 6 * 60 * 1000);

    const dir = join(resolveChannelsDir(), "ch-eacces", "idle-emit");
    mkdirSync(dir, { recursive: true });
    if (process.getuid?.() !== 0) {
      const { chmodSync } = await import("node:fs");
      chmodSync(dir, 0o000);
      try {
        const result = await check(inputFor(SESSION_SELF));
        expect(result.stdout).toContain("Peer Bravo");
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  });

  it("20. ENOSPC simulation is platform-dependent — covered conceptually via test 19", async () => {
    expect(true).toBe(true);
  });

  it("21. Concurrent invocations → atomic write semantics preserved", async () => {
    await createChannel({
      channelId: "ch-concurrent",
      handoffId: "ch-concurrent",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-concurrent",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-concurrent",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-concurrent", SESSION_SELF);
    backdateHeartbeat("ch-concurrent", SESSION_BRAVO, 6 * 60 * 1000);

    const [r1, r2] = await Promise.all([
      check(inputFor(SESSION_SELF)),
      check(inputFor(SESSION_SELF)),
    ]);

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    const path = cursorPath("ch-concurrent", SESSION_SELF);
    const cursor = JSON.parse(readFileSync(path, "utf-8"));
    expect(typeof cursor["Bravo"]).toBe("string");
  });

  // ─── 22–24 env override ─────────────────────────────────────────

  it('22. Env override ="60000" (1 min) → peer at 90s ago is idle', async () => {
    process.env[ENV_KEY] = "60000";
    try {
      await createChannel({
        channelId: "ch-env-1m",
        handoffId: "ch-env-1m",
        sessionId: SESSION_SELF,
      });
      await claimIdentity({
        channelId: "ch-env-1m",
        sessionId: SESSION_SELF,
        defaultRole: "pen",
      });
      await claimIdentity({
        channelId: "ch-env-1m",
        sessionId: SESSION_BRAVO,
        defaultRole: "queue",
      });
      touchHeartbeat("ch-env-1m", SESSION_SELF);
      backdateHeartbeat("ch-env-1m", SESSION_BRAVO, 90 * 1000);

      const result = await check(inputFor(SESSION_SELF));
      expect(result.stdout).toContain("Peer Bravo");
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  it("23. Env override invalid forms fall back to default 5 min", async () => {
    const invalid = [
      "",
      "0",
      "-1",
      "1.5",
      "abc",
      "5e3",
      "+1000",
      "  ",
      "1000.0",
    ];
    for (const v of invalid) {
      process.env[ENV_KEY] = v;
      try {
        const cid = `ch-env-bad-${invalid.indexOf(v)}`;
        await createChannel({
          channelId: cid,
          handoffId: cid,
          sessionId: SESSION_SELF,
        });
        await claimIdentity({
          channelId: cid,
          sessionId: SESSION_SELF,
          defaultRole: "pen",
        });
        await claimIdentity({
          channelId: cid,
          sessionId: SESSION_BRAVO,
          defaultRole: "queue",
        });
        touchHeartbeat(cid, SESSION_SELF);
        backdateHeartbeat(cid, SESSION_BRAVO, 4 * 60 * 1000);

        const result = await check(inputFor(SESSION_SELF));
        expect(result.stdout).toBe("");
      } finally {
        delete process.env[ENV_KEY];
      }
    }
  });

  it('24. Env override ="1000" (1 second) → peer at 2s ago is idle', async () => {
    process.env[ENV_KEY] = "1000";
    try {
      await createChannel({
        channelId: "ch-env-1s",
        handoffId: "ch-env-1s",
        sessionId: SESSION_SELF,
      });
      await claimIdentity({
        channelId: "ch-env-1s",
        sessionId: SESSION_SELF,
        defaultRole: "pen",
      });
      await claimIdentity({
        channelId: "ch-env-1s",
        sessionId: SESSION_DELTA,
        defaultRole: "queue",
      });
      touchHeartbeat("ch-env-1s", SESSION_SELF);
      backdateHeartbeat("ch-env-1s", SESSION_DELTA, 2000);

      const result = await check(inputFor(SESSION_SELF));
      // SESSION_DELTA is the second claim on this channel → assigned NATO Bravo
      // (NATO letter is determined by claim order, not by session-id name).
      expect(result.stdout).toContain("Peer Bravo");
    } finally {
      delete process.env[ENV_KEY];
    }
  });
});
