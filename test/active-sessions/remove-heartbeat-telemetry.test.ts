// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle-2 increment-2 2b — removeOwnHeartbeat honest-telemetry (§1 F1).
 *
 * The `--apply` GC mutation removes a DEAD PEER's heartbeat. Its removal record
 * in the presence-failure-log MUST be honest — it must NOT log
 * "self-stop pid=<operator>" (the forensic lie a never-auto-kill mutation must
 * avoid). The opts param `{reason, actorPid}` drives the honest detail
 * (target_sid + reason + actor pid + caller_top4); the Stop-hook self-removal
 * path (no opts) keeps the "self-stop" record. Round-trip: write -> remove ->
 * read the log.
 *
 * ("Own" in removeOwnHeartbeat is a deferred-rename misnomer — see the
 * primitive's JSDoc; the honest name is removeHeartbeat, a tracked cross-edge
 * follow-up. The telemetry already makes the multi-caller reality honest.)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  artifactIdFromPath,
  removeOwnHeartbeat,
  touchHeartbeat,
} from "../../src/active-sessions/index.ts";
import { readPresenceFailures } from "../../src/shared/presence-failure-log.ts";
import { makeTmpHome, type TmpHome } from "../../test-utils/index.ts";

let tmpHome: TmpHome | null = null;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let REGISTRY_DIR = "";
let ARTIFACT_PATH = "";
let ARTIFACT_ID = "";
const SID = "abababab-0000-4000-8000-00000000beef";

beforeEach(() => {
  tmpHome = makeTmpHome();
  prevHome = process.env["HOME"];
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  process.env["HOME"] = tmpHome.home;
  REGISTRY_DIR = join(tmpHome.home, "registry");
  const fakeRepo = join(tmpHome.home, "fake-repo");
  mkdirSync(REGISTRY_DIR, { recursive: true });
  mkdirSync(fakeRepo, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = REGISTRY_DIR;
  ARTIFACT_PATH = realpathSync(fakeRepo);
  ARTIFACT_ID = artifactIdFromPath(ARTIFACT_PATH);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevActiveSessionsDir === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  tmpHome?.cleanup();
  tmpHome = null;
});

function writeHeartbeat(): void {
  touchHeartbeat({
    artifactId: ARTIFACT_ID,
    sessionId: SID,
    artifactPath: ARTIFACT_PATH,
    now: Date.now(),
  });
}

function lastHeartbeatRemoved() {
  return readPresenceFailures()
    .filter((e) => e.kind === "heartbeat-removed")
    .at(-1);
}

describe("removeOwnHeartbeat — honest telemetry (§1 F1, 2b)", () => {
  it("a non-self caller (opts) logs an HONEST removal record — target_sid + reason + actor_pid + caller_top4, NOT self-stop", () => {
    writeHeartbeat();
    removeOwnHeartbeat(ARTIFACT_ID, SID, {
      reason: "reconcile-gc",
      actorPid: 99999,
    });
    const ev = lastHeartbeatRemoved();
    expect(ev).toBeDefined();
    expect(ev?.detail).toContain(`target_sid=${SID}`);
    expect(ev?.detail).toContain("reason=reconcile-gc");
    expect(ev?.detail).toContain("actor_pid=99999");
    expect(ev?.detail).toContain("caller_top4=");
    // The forensic lie the F1 telemetry exists to prevent:
    expect(ev?.detail).not.toContain("self-stop");
  });

  it("the Stop-hook self path (no opts) keeps the self-stop record", () => {
    writeHeartbeat();
    removeOwnHeartbeat(ARTIFACT_ID, SID);
    const ev = lastHeartbeatRemoved();
    expect(ev?.detail).toContain("self-stop");
    expect(ev?.detail).not.toContain("reason=");
  });
});
