// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * T8 (plan v1.3 §Tests T8; backlog L121) — `removeOwnHeartbeat` emits the
 * `heartbeat-removed` self-stop event through the STOP-HOOK INTEGRATION path.
 *
 * The self-stop emission is already UNIT-covered (remove-heartbeat-telemetry
 * .test.ts calls `removeOwnHeartbeat` directly). T8 is the deferred INTEGRATION
 * rung: it drives the only self-stop caller — the `session-presence-unregister`
 * Stop check — end to end:
 *   resolve session id from the hook input -> read the collision-gate
 *   touched-state -> `removeOwnHeartbeat` per touched artifact -> emit the
 *   self-stop `heartbeat-removed` event AND unlink the heartbeat.
 * The event only fires if the check read the touched-state and invoked the
 * primitive, so asserting it after `check()` is the wiring assertion the unit
 * test cannot make. Closes the Phase-2 trigger decision tree's Branch B/D
 * full-coverage assertion (deferred at A2 PR #91 `fe3d27e6`).
 *
 * Scope note: the backlog sketched a `Bun.spawnSync(dispatcher.sh)` form, but
 * the dispatcher is a dotfiles (cross-edge) wrapper whose dispatch is generic +
 * separately tested; driving the conductor check directly with a synthetic Stop
 * input is the plugin-internal altitude (per the plugin-test-imports-not-cross-
 * edge convention) and exercises the same self-stop wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check } from "../../../src/hooks/checks/session-presence-unregister.ts";
import { stateFile } from "../../../src/hooks/checks/session-collision-gate.ts";
import {
  artifactIdFromPath,
  touchHeartbeat,
} from "../../../src/active-sessions/index.ts";
import { readPresenceFailures } from "../../../src/shared/presence-failure-log.ts";
import type { HookInput } from "../../../src/hooks/types.ts";
import { makeTmpHome, type TmpHome } from "../../../test-utils/index.ts";

let tmpHome: TmpHome | null = null;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let prevSessionEnv: string | undefined;
let REGISTRY_DIR = "";
const SID = "abababab-0000-4000-8000-00000000beef";

beforeEach(() => {
  tmpHome = makeTmpHome();
  prevHome = process.env["HOME"];
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevSessionEnv = process.env["CLAUDE_SESSION_ID"];
  process.env["HOME"] = tmpHome.home;
  REGISTRY_DIR = join(tmpHome.home, "registry");
  mkdirSync(REGISTRY_DIR, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = REGISTRY_DIR;
  // resolveSessionIdOrNull checks CLAUDE_SESSION_ID FIRST — clear it so the
  // synthetic `input.raw.session_id` (the real Stop-payload path) is exercised.
  delete process.env["CLAUDE_SESSION_ID"];
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevActiveSessionsDir === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  if (prevSessionEnv === undefined) delete process.env["CLAUDE_SESSION_ID"];
  else process.env["CLAUDE_SESSION_ID"] = prevSessionEnv;
  tmpHome?.cleanup();
  tmpHome = null;
});

/** A synthetic Stop hook input carrying `session_id` on the raw payload (the
 *  dispatcher passes it verbatim from the Stop event JSON). */
function stopInput(sessionId: string): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw: { session_id: sessionId, hook_event_name: "Stop" },
    dispatch: { verbose: false },
  };
}

/** Create a real artifact dir + write a live presence heartbeat for SID; return
 *  its artifact id and the heartbeat file path. */
function seedHeartbeat(repoName: string): {
  artifactId: string;
  hbPath: string;
} {
  if (tmpHome === null) throw new Error("tmpHome not initialized");
  const repo = join(tmpHome.home, repoName);
  mkdirSync(repo, { recursive: true });
  const artifactPath = realpathSync(repo);
  const artifactId = artifactIdFromPath(artifactPath);
  touchHeartbeat({ artifactId, sessionId: SID, artifactPath, now: Date.now() });
  return {
    artifactId,
    hbPath: join(REGISTRY_DIR, artifactId, "heartbeats", SID),
  };
}

/** Pre-seed the collision-gate touched-state the Stop check reads. */
function seedTouchedState(sessionId: string, touched: string[]): void {
  const file = stateFile(sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ session: sessionId, touched }));
}

function selfStopRemovals() {
  return readPresenceFailures().filter(
    (e) => e.kind === "heartbeat-removed" && e.detail.includes("self-stop"),
  );
}

describe("session-presence-unregister Stop check — T8 self-stop integration", () => {
  it("removes a touched artifact's heartbeat AND emits the self-stop heartbeat-removed event", async () => {
    const { artifactId, hbPath } = seedHeartbeat("repo-a");
    seedTouchedState(SID, [artifactId]);
    expect(existsSync(hbPath)).toBe(true); // live heartbeat before stop

    const result = await check(stopInput(SID));
    expect(result.exitCode).toBe(0); // Stop check is fail-open

    const removals = selfStopRemovals();
    expect(removals.length).toBe(1);
    expect(removals[0]?.detail).toContain("self-stop");
    expect(removals[0]?.detail).not.toContain("reason="); // self path, not reconcile-gc
    expect(existsSync(hbPath)).toBe(false); // heartbeat actually unlinked
  });

  it("loops over EVERY touched artifact (one self-stop removal each)", async () => {
    const a = seedHeartbeat("repo-a");
    const b = seedHeartbeat("repo-b");
    seedTouchedState(SID, [a.artifactId, b.artifactId]);

    await check(stopInput(SID));

    expect(selfStopRemovals().length).toBe(2); // the per-artifact loop fired twice
    expect(existsSync(a.hbPath)).toBe(false);
    expect(existsSync(b.hbPath)).toBe(false);
  });

  it("no touched-state for the session → pass, no removal emitted (empty path)", async () => {
    seedHeartbeat("repo-a"); // a heartbeat exists, but nothing recorded it as touched
    // no seedTouchedState → readTouchedFromState returns []

    const result = await check(stopInput(SID));
    expect(result.exitCode).toBe(0);
    expect(selfStopRemovals().length).toBe(0);
  });

  it("missing session_id on the input → pass, no removal (sessionless Stop)", async () => {
    const { artifactId } = seedHeartbeat("repo-a");
    seedTouchedState(SID, [artifactId]);

    const result = await check(stopInput("")); // empty id → resolveSessionIdOrNull null
    expect(result.exitCode).toBe(0);
    expect(selfStopRemovals().length).toBe(0); // never resolved a session → never removed
  });
});
