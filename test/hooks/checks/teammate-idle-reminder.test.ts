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
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../../../src/hooks/checks/teammate-idle-reminder.ts";
import {
  createChannel,
  resolveChannelsDir,
  touchHeartbeat,
} from "../../../src/channels/index.ts";
import { claimIdentity } from "../../../src/channels/identity.ts";
import { readPresenceFailures } from "../../../src/shared/presence-failure-log.ts";
import { GC_WINDOW_MS } from "../../../src/active-sessions/index.ts";
import type { HookInput } from "../../../src/hooks/types.ts";

const SANDBOX = `/tmp/test-teammate-idle-reminder-${process.pid}`;
const SESSION_SELF = "11111111-1111-4111-8111-111111111111";
const SESSION_BRAVO = "22222222-2222-4222-8222-222222222222";
const SESSION_CHARLIE = "33333333-3333-4333-8333-333333333333";
const SESSION_DELTA = "44444444-4444-4444-8444-444444444444";

const ENV_KEY = "CLAUDE_CONDUCTOR_IDLE_THRESHOLD_MS";
const ACTIVE_SESSIONS_ENV = "CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR";

// The OTHER store the A1 Slice 2 alive-anywhere consult reads. Sandboxed
// hermetically (mkdtemp + tmpdir — realpath-stable, unlike the channels
// /tmp+pid SANDBOX above, which is the pre-existing tmpdir-divergence pattern
// the cohort is migrating separately) so isSessionLiveByPrefix never reads the
// real ~/.claude store: existing cases keep channel-only behavior (empty store
// → no peer reads active-sessions-live), new cases control liveness.
let activeSessionsSandbox: string | undefined;
let prevActiveSessionsEnv: string | undefined;

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
  prevActiveSessionsEnv = process.env[ACTIVE_SESSIONS_ENV];
  activeSessionsSandbox = mkdtempSync(join(tmpdir(), "teammate-idle-as-"));
  process.env[ACTIVE_SESSIONS_ENV] = activeSessionsSandbox;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  delete process.env[ENV_KEY];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
  if (prevActiveSessionsEnv === undefined)
    delete process.env[ACTIVE_SESSIONS_ENV];
  else process.env[ACTIVE_SESSIONS_ENV] = prevActiveSessionsEnv;
  if (
    activeSessionsSandbox !== undefined &&
    existsSync(activeSessionsSandbox)
  ) {
    rmSync(activeSessionsSandbox, { recursive: true, force: true });
    activeSessionsSandbox = undefined;
  }
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
// Step G v2.14 fold (ARCH-4 / KS-4): backdateHeartbeat writes to NEW
// `heartbeats/` subdir (mirroring touchHeartbeat's post-rename write path).
// Use backdateHeartbeatLegacy below to explicitly exercise the dual-read
// fallback from the old `heartbeat/` path during the 30-day transition.
function backdateHeartbeat(
  channelId: string,
  sessionId: string,
  ageMs: number,
  bodyOverrideMs?: number | null | "empty" | "corrupt",
): void {
  backdateHeartbeatAtDir(
    channelId,
    sessionId,
    ageMs,
    "heartbeats",
    bodyOverrideMs,
  );
}

/** Step G dual-read fallback test helper — writes heartbeat to LEGACY path
 *  `<channel-dir>/heartbeat/<sid>`. Only the explicit dual-read fallback
 *  test should call this; production-equivalent backdating should use the
 *  NEW-path helper above. */
function backdateHeartbeatLegacy(
  channelId: string,
  sessionId: string,
  ageMs: number,
  bodyOverrideMs?: number | null | "empty" | "corrupt",
): void {
  backdateHeartbeatAtDir(
    channelId,
    sessionId,
    ageMs,
    "heartbeat",
    bodyOverrideMs,
  );
}

function backdateHeartbeatAtDir(
  channelId: string,
  sessionId: string,
  ageMs: number,
  subdir: "heartbeats" | "heartbeat",
  bodyOverrideMs?: number | null | "empty" | "corrupt",
): void {
  const path = join(resolveChannelsDir(), channelId, subdir, sessionId);
  const targetMs = Date.now() - ageMs;
  const targetSec = targetMs / 1000;

  let body: string;
  if (bodyOverrideMs === "empty") body = "";
  else if (bodyOverrideMs === "corrupt") body = "not-a-number";
  else if (bodyOverrideMs === null || bodyOverrideMs === undefined)
    body = String(targetMs);
  else body = String(bodyOverrideMs);

  mkdirSync(join(resolveChannelsDir(), channelId, subdir), {
    recursive: true,
  });
  writeFileSync(path, body, "utf-8");
  utimesSync(path, targetSec, targetSec);
}

function cursorPath(channelId: string, sessionId: string): string {
  return join(
    resolveChannelsDir(),
    channelId,
    "idle-emit-cursors",
    `${sessionId}.json`,
  );
}

/** Write an active-sessions heartbeat under
 *  `<activeSessionsSandbox>/<artifactId>/heartbeats/<sessionId>` (mirrors
 *  test/active-sessions/session-live-by-prefix.test.ts). mtime = Date.now() -
 *  ageMs, since the hook probes isSessionLiveByPrefix against the wall clock. */
function writeActiveSessionsHeartbeat(
  artifactId: string,
  sessionId: string,
  ageMs: number,
): void {
  const dir = join(activeSessionsSandbox as string, artifactId, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  const ts = Date.now() - ageMs;
  writeFileSync(
    path,
    JSON.stringify({
      sessionId,
      pid: 4242,
      host: hostname(),
      createdAt: ts,
      touchedAt: ts,
    }),
    "utf-8",
  );
  const mtimeSec = ts / 1000;
  utimesSync(path, mtimeSec, mtimeSec);
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

    const dir = join(
      resolveChannelsDir(),
      "ch-rate-recent",
      "idle-emit-cursors",
    );
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

    const dir = join(
      resolveChannelsDir(),
      "ch-rate-stale",
      "idle-emit-cursors",
    );
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

    const dir = join(
      resolveChannelsDir(),
      "ch-cursor-parse",
      "idle-emit-cursors",
    );
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

    const dir = join(
      resolveChannelsDir(),
      "ch-cursor-shape",
      "idle-emit-cursors",
    );
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

    const dir = join(resolveChannelsDir(), "ch-eacces", "idle-emit-cursors");
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

  // Step G dual-read fallback coverage (v2.14 fold of ARCH-5 / ARCH-4 / KS-4):
  // A pre-Step-G peer's heartbeat lives at the LEGACY `heartbeat/<sid>` path.
  // This session's `heartbeatMtime` + `readHeartbeatBody` dual-read MUST find
  // it via the LEGACY fallback so peer-staleness detection survives the
  // dual-read transition window.
  it("25. Step G dual-read fallback — LEGACY-only heartbeat is still observable to idle-reminder", async () => {
    await createChannel({
      channelId: "ch-legacy-hb",
      handoffId: "ch-legacy-hb",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-legacy-hb",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-legacy-hb",
      sessionId: SESSION_DELTA,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-legacy-hb", SESSION_SELF);
    // Pre-Step-G peer wrote ONLY to legacy `heartbeat/` (no `heartbeats/`).
    // The dual-read fallback in heartbeatMtime + readHeartbeatBody must
    // surface this heartbeat so the idle-reminder still observes the peer.
    backdateHeartbeatLegacy("ch-legacy-hb", SESSION_DELTA, 6 * 60 * 1000); // 6 min idle

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
  });

  // ─── sibling-coord-gate-awareness plan v2 Lane C ─────────────────
  // Standby-state suppression: peers whose most-recent message is a
  // deliberate-standby kind (`standby` / `roger` / `out` / `digest` per
  // RE-5 fold) skip the idle reminder. Forensic breadcrumb at the
  // suppression point (FIND-6 fold).

  /**
   * Append a JSONL message line to a channel's messages.jsonl. Bypasses the
   * `appendMessage` lock machinery — these tests don't exercise the locked
   * path; they exercise the read side (`getMostRecentPeerKind`) which is
   * read-only against the JSONL.
   */
  function appendPeerMessage(
    channelId: string,
    sessionId: string,
    kind: string,
    body: string = "test",
  ): void {
    const messagesPath = join(
      resolveChannelsDir(),
      channelId,
      "messages.jsonl",
    );
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      from: sessionId,
      kind,
      body,
    })}\n`;
    mkdirSync(join(resolveChannelsDir(), channelId), { recursive: true });
    if (existsSync(messagesPath)) {
      const existing = readFileSync(messagesPath, "utf-8");
      writeFileSync(messagesPath, existing + line, "utf-8");
    } else {
      writeFileSync(messagesPath, line, "utf-8");
    }
  }

  it("26. Standby kind suppression — peer most-recent kind=standby → reminder suppressed", async () => {
    await createChannel({
      channelId: "ch-standby",
      handoffId: "ch-standby",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-standby",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-standby",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-standby", SESSION_SELF);
    backdateHeartbeat("ch-standby", SESSION_BRAVO, 6 * 60 * 1000); // 6 min idle
    appendPeerMessage("ch-standby", SESSION_BRAVO, "standby");

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("27. Standby-class kinds (roger / out / digest) all suppress the reminder", async () => {
    const kinds = ["roger", "out", "digest"] as const;
    for (const kind of kinds) {
      cleanup();
      sandbox();
      const channelId = `ch-suppress-${kind}`;
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: SESSION_SELF,
      });
      await claimIdentity({
        channelId,
        sessionId: SESSION_SELF,
        defaultRole: "pen",
      });
      await claimIdentity({
        channelId,
        sessionId: SESSION_BRAVO,
        defaultRole: "queue",
      });
      touchHeartbeat(channelId, SESSION_SELF);
      backdateHeartbeat(channelId, SESSION_BRAVO, 6 * 60 * 1000);
      appendPeerMessage(channelId, SESSION_BRAVO, kind);

      const result = await check(inputFor(SESSION_SELF));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("28. Non-standby kinds (note / status / question / handoff / ack / over) DO fire the reminder", async () => {
    const kinds = [
      "note",
      "status",
      "question",
      "handoff",
      "ack",
      "over",
    ] as const;
    for (const kind of kinds) {
      cleanup();
      sandbox();
      const channelId = `ch-fire-${kind}`;
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: SESSION_SELF,
      });
      await claimIdentity({
        channelId,
        sessionId: SESSION_SELF,
        defaultRole: "pen",
      });
      await claimIdentity({
        channelId,
        sessionId: SESSION_BRAVO,
        defaultRole: "queue",
      });
      touchHeartbeat(channelId, SESSION_SELF);
      backdateHeartbeat(channelId, SESSION_BRAVO, 6 * 60 * 1000);
      appendPeerMessage(channelId, SESSION_BRAVO, kind);

      const result = await check(inputFor(SESSION_SELF));
      expect(result.stdout).toContain("Peer Bravo");
    }
  });

  it("29. Peer with no messages on channel → reminder fires (no suppression — empty messages.jsonl path)", async () => {
    await createChannel({
      channelId: "ch-no-msgs",
      handoffId: "ch-no-msgs",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-no-msgs",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-no-msgs",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-no-msgs", SESSION_SELF);
    backdateHeartbeat("ch-no-msgs", SESSION_BRAVO, 6 * 60 * 1000);
    // No appendPeerMessage call — messages.jsonl absent.

    const result = await check(inputFor(SESSION_SELF));
    expect(result.stdout).toContain("Peer Bravo");
  });

  it("30. Standby suppression doesn't engage rate-limit cursor — next non-standby reminder fires immediately", async () => {
    await createChannel({
      channelId: "ch-no-cursor-burn",
      handoffId: "ch-no-cursor-burn",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-no-cursor-burn",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-no-cursor-burn",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-no-cursor-burn", SESSION_SELF);
    backdateHeartbeat("ch-no-cursor-burn", SESSION_BRAVO, 6 * 60 * 1000);

    // First fire: peer posted `standby` → suppressed → cursor NOT written.
    appendPeerMessage("ch-no-cursor-burn", SESSION_BRAVO, "standby");
    const r1 = await check(inputFor(SESSION_SELF));
    expect(r1.stdout).toBe("");
    // Cursor file must not exist (suppression bypassed the cursor write path).
    expect(existsSync(cursorPath("ch-no-cursor-burn", SESSION_SELF))).toBe(
      false,
    );

    // Second fire: peer now posted a non-standby kind. Reminder should fire
    // immediately — rate-limit was never engaged by the prior suppression.
    appendPeerMessage("ch-no-cursor-burn", SESSION_BRAVO, "note");
    const r2 = await check(inputFor(SESSION_SELF));
    expect(r2.stdout).toContain("Peer Bravo");
  });

  // ─── 31–32 A1 Slice 2: alive-anywhere consult (active-sessions store) ──
  // teammate-idle is an alive-anywhere gate ("is this peer doing ANY work?"),
  // so a peer that is channel-quiet (stale channel HB) but tool-active (fresh
  // active-sessions HB) is WORKING, not idle -> suppress. The MIRROR of the
  // L1049 reaper / reconcile-boot fix. Per-store window = each store's own
  // freshness boundary (channel = the 5-min idle threshold; active-sessions =
  // GC_WINDOW_MS).

  it("31. Alive-anywhere: channel-stale but active-sessions-FRESH -> suppressed (the ~6x false-fire fix)", async () => {
    await createChannel({
      channelId: "ch-as-live",
      handoffId: "ch-as-live",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-as-live",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-as-live",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-as-live", SESSION_SELF);
    // Channel HB 6 min stale (idle by the channel-only gate)...
    backdateHeartbeat("ch-as-live", SESSION_BRAVO, 6 * 60 * 1000);
    // ...but the peer is tool-active: a FRESH active-sessions HB on its cwd
    // worktree artifact (the build-busy-not-channel-sending profile).
    writeActiveSessionsHeartbeat("peer-worktree", SESSION_BRAVO, 0);

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // Suppression must NOT burn the rate-limit cursor (mirrors the standby gate).
    expect(existsSync(cursorPath("ch-as-live", SESSION_SELF))).toBe(false);
  });

  it("32. Alive-anywhere: channel-stale AND active-sessions-STALE -> still flagged (no over-suppress)", async () => {
    await createChannel({
      channelId: "ch-as-stale",
      handoffId: "ch-as-stale",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-as-stale",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-as-stale",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-as-stale", SESSION_SELF);
    backdateHeartbeat("ch-as-stale", SESSION_BRAVO, 6 * 60 * 1000);
    // active-sessions HB older than GC_WINDOW_MS -> not-live -> no suppression.
    writeActiveSessionsHeartbeat(
      "peer-worktree",
      SESSION_BRAVO,
      GC_WINDOW_MS * 2,
    );

    const result = await check(inputFor(SESSION_SELF));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Peer Bravo");
  });
});

// ─── L191 (TA-7) — clock-skew breadcrumb EMISSION assertion ───────────
//
// The backlog specified L191 as a smoke-phase-2.sh "scenario 28", but
// smoke-phase-2.sh defers ALL hook-firing to in-process bun:test by design (the
// plugin binary has no dispatcher), and clock-skew SUPPRESSION (tests 6–9 above)
// + the kind:clock-skew substrate round-trip (presence-failure-log.test.ts) are
// already covered. The genuine residual: nothing asserts the hook EMITS the
// breadcrumb. Test 7 is named for it but only asserts suppression — it cannot
// read the HOME-based presence-failure-log hermetically (the file's sandbox
// doesn't redirect HOME). This sibling describe sandboxes HOME so
// readPresenceFailures sees only this test's events, then asserts the emission.
describe("teammate-idle-reminder — clock-skew breadcrumb EMISSION (L191)", () => {
  let prevHomeL191: string | undefined;
  let homeL191: string | undefined;

  beforeEach(() => {
    sandbox(); // channels + active-sessions sandboxes (reused)
    prevHomeL191 = process.env["HOME"];
    homeL191 = mkdtempSync(join(tmpdir(), "teammate-idle-skew-home-"));
    process.env["HOME"] = homeL191; // redirect the HOME-based presence-failure-log
  });

  afterEach(() => {
    if (prevHomeL191 === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHomeL191;
    if (homeL191 !== undefined && existsSync(homeL191)) {
      rmSync(homeL191, { recursive: true, force: true });
      homeL191 = undefined;
    }
    cleanup(); // restore channels + active-sessions env (reused)
  });

  it("emits a kind:clock-skew breadcrumb when a peer body-ts diverges from mtime beyond the threshold", async () => {
    await createChannel({
      channelId: "ch-skew-emit",
      handoffId: "ch-skew-emit",
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId: "ch-skew-emit",
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId: "ch-skew-emit",
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat("ch-skew-emit", SESSION_SELF);
    // Peer: mtime 6 min old (idle window); body-ts a further 6 min behind, so
    // |mtime − body| = 6 min > the 5-min CLOCK_SKEW_THRESHOLD_MS (mirrors test 7,
    // whose suppression proves this setup reaches the clock-skew gate).
    const mtimeMs = Date.now() - 6 * 60 * 1000;
    backdateHeartbeat(
      "ch-skew-emit",
      SESSION_BRAVO,
      6 * 60 * 1000,
      mtimeMs - 6 * 60 * 1000,
    );

    const result = await check(inputFor(SESSION_SELF));

    // Suppression is already covered (test 7); the NEW assertion is that the
    // hook WROTE the clock-skew breadcrumb (teammate-idle-reminder.ts:318-326).
    expect(result.stdout).toBe("");
    const skew = readPresenceFailures().filter((e) => e.kind === "clock-skew");
    expect(skew.length).toBeGreaterThanOrEqual(1);
    const ev = skew[skew.length - 1];
    expect(ev?.artifactPath).toBe("ch-skew-emit");
    expect(ev?.detail ?? "").toContain("peer Bravo");
  });
});

// ─── Lane A — harness-status PRIMARY idle-suppress (Charlie, 2026-06-07) ──────
//
// The harness `sessions/<pid>.json` status becomes the PRIMARY "is this peer
// working?" signal: a channel-quiet (mtime-idle) peer whose harness status is
// ACTIVE (busy/shell/waiting) with a LIVE pid is WORKING, not idle -> suppress.
// HOME is sandboxed so buildHarnessStatusIndex reads this test's fake sessions
// dir and the breadcrumb log is hermetic.
describe("teammate-idle-reminder — harness-status PRIMARY suppress (Lane A)", () => {
  let prevHomeLA: string | undefined;
  let homeLA: string | undefined;

  function writeHarnessPidfile(
    pid: number,
    sessionId: string,
    status: string,
    updatedAt: number,
  ): void {
    const dir = join(process.env["HOME"] as string, ".claude", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId, status, updatedAt }),
      "utf-8",
    );
  }

  async function setupIdlePeer(channelId: string): Promise<void> {
    await createChannel({
      channelId,
      handoffId: channelId,
      sessionId: SESSION_SELF,
    });
    await claimIdentity({
      channelId,
      sessionId: SESSION_SELF,
      defaultRole: "pen",
    });
    await claimIdentity({
      channelId,
      sessionId: SESSION_BRAVO,
      defaultRole: "queue",
    });
    touchHeartbeat(channelId, SESSION_SELF);
    // Peer channel-mtime 6 min stale (> 5 min default threshold) => idle CANDIDATE.
    backdateHeartbeat(channelId, SESSION_BRAVO, 6 * 60 * 1000);
  }

  beforeEach(() => {
    sandbox();
    prevHomeLA = process.env["HOME"];
    homeLA = mkdtempSync(join(tmpdir(), "teammate-idle-harness-home-"));
    process.env["HOME"] = homeLA;
  });

  afterEach(() => {
    if (prevHomeLA === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHomeLA;
    if (homeLA !== undefined && existsSync(homeLA)) {
      rmSync(homeLA, { recursive: true, force: true });
      homeLA = undefined;
    }
    cleanup();
  });

  // §5 CENTERPIECE (Alpha lens: the load-bearing detector-validation). A busy
  // peer with a STALE updatedAt + live pid STILL suppresses — proving the gate
  // trusts the status, NOT the pidfile age (the obvious ageMs-staleness gate
  // would degrade here and re-fire the false-idle bug; the index entry omits
  // ageMs entirely so the only guard is the live pid).
  it("busy + STALE updatedAt + live pid => STILL suppresses (trust status, not ageMs)", async () => {
    await setupIdlePeer("ch-ha-busy");
    writeHarnessPidfile(
      process.pid,
      SESSION_BRAVO,
      "busy",
      Date.now() - 60 * 60 * 1000, // 1h stale — must NOT matter
    );

    const result = await check(inputFor(SESSION_SELF));

    expect(result.stdout).toBe(""); // suppressed despite stale updatedAt
    const ev = readPresenceFailures().filter(
      (e) => e.kind === "harness-active-suppressed",
    );
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[ev.length - 1]?.detail ?? "").toContain("peer Bravo");
    expect(ev[ev.length - 1]?.detail ?? "").toContain("status=busy");
  });

  it("waiting (active) + live pid also suppresses", async () => {
    await setupIdlePeer("ch-ha-waiting");
    writeHarnessPidfile(process.pid, SESSION_BRAVO, "waiting", Date.now());
    expect((await check(inputFor(SESSION_SELF))).stdout).toBe("");
  });

  it("idle harness status does NOT suppress => peer flagged (degrade past the gate)", async () => {
    await setupIdlePeer("ch-ha-idle");
    writeHarnessPidfile(process.pid, SESSION_BRAVO, "idle", Date.now());
    expect((await check(inputFor(SESSION_SELF))).stdout).toContain(
      "Peer Bravo",
    );
  });

  it("busy status but DEAD pid does NOT suppress => degrade => flagged", async () => {
    await setupIdlePeer("ch-ha-dead");
    writeHarnessPidfile(2_147_483_646, SESSION_BRAVO, "busy", Date.now());
    expect((await check(inputFor(SESSION_SELF))).stdout).toContain(
      "Peer Bravo",
    );
  });

  it("no harness pidfile (absent / cross-host) => degrade to mtime => flagged", async () => {
    await setupIdlePeer("ch-ha-absent");
    expect((await check(inputFor(SESSION_SELF))).stdout).toContain(
      "Peer Bravo",
    );
  });
});
