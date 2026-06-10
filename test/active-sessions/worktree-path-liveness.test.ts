// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * SPAWN-3 — `isWorktreePathLive` tier matrix (session-liveness.ts).
 *
 * Hermetic seams: `opts.sessionsDir` (T1 pidfile dir),
 * `CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR` (T2/T3 registry),
 * `CLAUDE_CONDUCTOR_CHANNELS_DIR` (T3's channel half of the OR-composer).
 *
 * The matrix pins the fail-directions the design audit demanded:
 *   - RE-1: foreign `<uuid>.json` telemetry files sharing the sessions dir are
 *     IGNORED (never routed to indeterminate — the vacuous-block trap).
 *   - RE-4: a fresh-malformed heartbeat contributes indeterminate ONLY on a
 *     plausible-attribution artifact; unrelated-artifact poison is ignored.
 *   - RE-5: an unresolvable target path is INDETERMINATE, never not-live.
 *   - Decision 5: live > indeterminate > not-live precedence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactIdFromPath } from "../../src/active-sessions/index.ts";
import { isWorktreePathLive } from "../../src/active-sessions/session-liveness.ts";

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = HOUR_MS;

let base: string;
let target: string;
let realTarget: string;
let sessionsDir: string;
let registryDir: string;
let channelsDir: string;
let prevRegistryEnv: string | undefined;
let prevChannelsEnv: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wpl-"));
  target = join(base, "repo-charlie-slug");
  sessionsDir = join(base, "sessions");
  registryDir = join(base, "active-sessions");
  channelsDir = join(base, "channels");
  mkdirSync(target, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });
  realTarget = realpathSync(target);
  prevRegistryEnv = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannelsEnv = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = registryDir;
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = channelsDir;
});

afterEach(() => {
  if (prevRegistryEnv === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevRegistryEnv;
  }
  if (prevChannelsEnv === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsEnv;
  }
  rmSync(base, { recursive: true, force: true });
});

function writeHeartbeat(
  artifactId: string,
  sessionId: string,
  body: string,
  mtimeMs: number,
): void {
  const dir = join(registryDir, artifactId, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(path, body);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

function ownerRecord(sessionId: string, dotfilesRoot?: string): string {
  const rec: Record<string, unknown> = {
    sessionId,
    pid: 4242,
    host: "test-host",
    createdAt: 1,
    touchedAt: 1,
  };
  if (dotfilesRoot !== undefined) rec["dotfilesRoot"] = dotfilesRoot;
  return `${JSON.stringify(rec)}\n`;
}

/** A pid that is dead by construction (spawn a no-op that has exited). */
function deadPid(): number {
  const r = spawnSync("true", [], { stdio: "ignore" });
  if (typeof r.pid !== "number" || r.pid <= 0) {
    throw new Error("could not obtain a dead pid");
  }
  return r.pid;
}

describe("isWorktreePathLive — verdict shape + RE-5 unverifiable target", () => {
  test("unresolvable target path → indeterminate, never not-live", () => {
    const now = Date.now();
    const verdict = isWorktreePathLive(
      join(base, "does-not-exist"),
      now,
      WINDOW_MS,
      { sessionsDir },
    );
    expect(verdict.verdict).toBe("indeterminate");
  });

  test("existing target, empty stores → not-live", () => {
    const now = Date.now();
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict).toEqual({ verdict: "not-live" });
  });
});

describe("T1 pidfile-cwd tier", () => {
  test("live pid with cwd == target → live(pidfile-cwd)", () => {
    const now = Date.now();
    writeFileSync(
      join(sessionsDir, `${String(process.pid)}.json`),
      JSON.stringify({ pid: process.pid, cwd: target, sessionId: "s" }),
    );
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict.verdict).toBe("live");
    if (verdict.verdict === "live") {
      expect(verdict.source).toBe("pidfile-cwd");
    }
  });

  test("live pid with cwd UNDER target → live(pidfile-cwd)", () => {
    const now = Date.now();
    const sub = join(target, "src");
    mkdirSync(sub);
    writeFileSync(
      join(sessionsDir, `${String(process.pid)}.json`),
      JSON.stringify({ pid: process.pid, cwd: sub }),
    );
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict.verdict).toBe("live");
  });

  test("DEAD pid with cwd == target → not-live (pidfile residue)", () => {
    const now = Date.now();
    const dead = deadPid();
    writeFileSync(
      join(sessionsDir, `${String(dead)}.json`),
      JSON.stringify({ pid: dead, cwd: target }),
    );
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict).toEqual({ verdict: "not-live" });
  });

  test("RE-1: fresh foreign <uuid>.json telemetry files are IGNORED, not indeterminate", () => {
    const now = Date.now();
    // The real ~/.claude/sessions mixes ~15:1 uuid-named telemetry files in
    // with the pidfiles; routing them to indeterminate would vacuous-block
    // every verdict globally.
    writeFileSync(
      join(sessionsDir, "0316dc0e-264e-4ddd-8f0a-cd0d63e3d53e.json"),
      JSON.stringify({ session_id: "0316dc0e", entries_touched: [] }),
    );
    writeFileSync(join(sessionsDir, "not-even-json.json"), "{{{{");
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict).toEqual({ verdict: "not-live" });
  });

  test("fresh UNPARSEABLE <pid>.json with ALIVE filename-pid → indeterminate", () => {
    const now = Date.now();
    writeFileSync(join(sessionsDir, `${String(process.pid)}.json`), "{{{{");
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict.verdict).toBe("indeterminate");
    if (verdict.verdict === "indeterminate") {
      expect(verdict.reason).toContain("unparseable pidfile");
    }
  });

  test("fresh unparseable <pid>.json with DEAD filename-pid → ignored (not-live)", () => {
    const now = Date.now();
    writeFileSync(join(sessionsDir, `${String(deadPid())}.json`), "{{{{");
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict).toEqual({ verdict: "not-live" });
  });

  test("STALE unparseable <pid>.json with alive pid → ignored (residue)", () => {
    const now = Date.now();
    const path = join(sessionsDir, `${String(process.pid)}.json`);
    writeFileSync(path, "{{{{");
    const old = now - 2 * WINDOW_MS;
    utimesSync(path, old / 1000, old / 1000);
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict).toEqual({ verdict: "not-live" });
  });
});

describe("T2 sentinel-dotfilesRoot tier", () => {
  test("fresh heartbeat with dotfilesRoot == target → live(sentinel-dotfilesroot)", () => {
    const now = Date.now();
    writeHeartbeat(
      "artifact-a",
      "sess-1",
      ownerRecord("sess-1", realTarget),
      now,
    );
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict.verdict).toBe("live");
    if (verdict.verdict === "live") {
      expect(verdict.source).toBe("sentinel-dotfilesroot");
    }
  });

  test("STALE sentinel heartbeat → not-live", () => {
    const now = Date.now();
    writeHeartbeat(
      "artifact-a",
      "sess-1",
      ownerRecord("sess-1", realTarget),
      now - 2 * WINDOW_MS,
    );
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, { sessionsDir });
    expect(verdict).toEqual({ verdict: "not-live" });
  });

  test("RE-4: fresh MALFORMED heartbeat on the candidate repo-family artifact → indeterminate", () => {
    const now = Date.now();
    const canonical = join(base, "repo");
    mkdirSync(canonical, { recursive: true });
    const familyArtifact = artifactIdFromPath(canonical);
    writeHeartbeat(familyArtifact, "sess-bad", "{{not json", now);
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, {
      sessionsDir,
      dotfilesCanonical: canonical,
    });
    expect(verdict.verdict).toBe("indeterminate");
    if (verdict.verdict === "indeterminate") {
      expect(verdict.reason).toContain("fresh malformed heartbeat");
    }
  });

  test("RE-4: fresh malformed heartbeat on an UNRELATED artifact is ignored → not-live", () => {
    const now = Date.now();
    const canonical = join(base, "repo");
    mkdirSync(canonical, { recursive: true });
    writeHeartbeat("zzzz-unrelated-repo", "sess-bad", "{{not json", now);
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, {
      sessionsDir,
      dotfilesCanonical: canonical,
    });
    expect(verdict).toEqual({ verdict: "not-live" });
  });

  test("STALE malformed heartbeat on a plausible artifact is residue → not-live", () => {
    const now = Date.now();
    const canonical = join(base, "repo");
    mkdirSync(canonical, { recursive: true });
    writeHeartbeat(
      artifactIdFromPath(canonical),
      "sess-bad",
      "{{not json",
      now - 2 * WINDOW_MS,
    );
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, {
      sessionsDir,
      dotfilesCanonical: canonical,
    });
    expect(verdict).toEqual({ verdict: "not-live" });
  });

  test("LIVE evidence beats a pending indeterminate (precedence)", () => {
    const now = Date.now();
    const canonical = join(base, "repo");
    mkdirSync(canonical, { recursive: true });
    // An indeterminate-contributing unparseable pidfile…
    writeFileSync(join(sessionsDir, `${String(process.pid)}.json`), "{{{{");
    // …AND a real live sentinel: live must win.
    writeHeartbeat(
      "artifact-a",
      "sess-1",
      ownerRecord("sess-1", realTarget),
      now,
    );
    const verdict = isWorktreePathLive(target, now, WINDOW_MS, {
      sessionsDir,
      dotfilesCanonical: canonical,
    });
    expect(verdict.verdict).toBe("live");
  });
});

describe("T3 sid-prefix tail tier", () => {
  test("sid-prefix tail with a fresh same-prefix heartbeat → live(sid-prefix-store)", () => {
    const now = Date.now();
    const canonical = join(base, "repo");
    mkdirSync(canonical, { recursive: true });
    const sidTarget = `${canonical}-deadbeef`;
    mkdirSync(sidTarget, { recursive: true });
    writeHeartbeat(
      "any-artifact",
      "deadbeef-1234-4321-aaaa-bbbbccccdddd",
      ownerRecord("deadbeef-1234-4321-aaaa-bbbbccccdddd"),
      now,
    );
    const verdict = isWorktreePathLive(sidTarget, now, WINDOW_MS, {
      sessionsDir,
      dotfilesCanonical: canonical,
    });
    expect(verdict.verdict).toBe("live");
    if (verdict.verdict === "live") {
      expect(verdict.source).toBe("sid-prefix-store");
    }
  });

  test("sid-prefix tail WITHOUT opts.dotfilesCanonical → tier silent (not-live)", () => {
    const now = Date.now();
    const canonical = join(base, "repo");
    mkdirSync(canonical, { recursive: true });
    const sidTarget = `${canonical}-deadbeef`;
    mkdirSync(sidTarget, { recursive: true });
    writeHeartbeat(
      "any-artifact",
      "deadbeef-1234-4321-aaaa-bbbbccccdddd",
      ownerRecord("deadbeef-1234-4321-aaaa-bbbbccccdddd"),
      now,
    );
    const verdict = isWorktreePathLive(sidTarget, now, WINDOW_MS, {
      sessionsDir,
    });
    expect(verdict).toEqual({ verdict: "not-live" });
  });

  test("named (non-sid) tail with same-prefix store entries → not-live (no false attribution)", () => {
    const now = Date.now();
    const canonical = join(base, "repo");
    mkdirSync(canonical, { recursive: true });
    const namedTarget = `${canonical}-charlie-spawn3`;
    mkdirSync(namedTarget, { recursive: true });
    writeHeartbeat(
      "any-artifact",
      "charlie11-2222-4333-aaaa-bbbbccccdddd",
      ownerRecord("charlie11-2222-4333-aaaa-bbbbccccdddd"),
      now,
    );
    const verdict = isWorktreePathLive(namedTarget, now, WINDOW_MS, {
      sessionsDir,
      dotfilesCanonical: canonical,
    });
    expect(verdict).toEqual({ verdict: "not-live" });
  });
});
