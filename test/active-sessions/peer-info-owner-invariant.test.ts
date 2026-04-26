// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TS-1 regression guard — proves that listLivePeers filters null owners, which
 * is what makes `PeerInfo.owner: OwnerRecord` (non-nullable) safe at every
 * reader.
 *
 * If someone removes the `if (!owner) continue;` filter without widening
 * PeerInfo.owner to `OwnerRecord | null`, this test catches the regression
 * at compile time (type assertion) AND at runtime (corrupt heartbeat test).
 *
 * Related: active-sessions/index.ts INVARIANT comment at the null-filter site.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  artifactIdFromPath,
  listLivePeers,
  setCoordinationRootsForTesting,
  touchHeartbeat,
  type OwnerRecord,
  type PeerInfo,
} from "../../src/active-sessions/index.ts";

const SANDBOX_ROOT = `/tmp/test-peer-owner-invariant-${process.pid}`;
let REGISTRY_DIR = "";
let ARTIFACT_PATH = "";
let ARTIFACT_ID = "";

const SELF_SESSION = "session-self-invariant";
const VALID_PEER = "session-valid-peer";
const CORRUPT_PEER = "session-corrupt-peer";

beforeEach(() => {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  const realRoot = realpathSync(SANDBOX_ROOT);
  REGISTRY_DIR = join(realRoot, "registry");
  const fakeRepo = join(realRoot, "fake-repo");
  mkdirSync(REGISTRY_DIR, { recursive: true });
  mkdirSync(fakeRepo, { recursive: true });
  process.env["CLAUDE_ACTIVE_SESSIONS_DIR"] = REGISTRY_DIR;
  ARTIFACT_PATH = realpathSync(fakeRepo);
  ARTIFACT_ID = artifactIdFromPath(ARTIFACT_PATH);
  setCoordinationRootsForTesting({ roots: [realRoot] });
});

afterEach(() => {
  setCoordinationRootsForTesting(null);
  delete process.env["CLAUDE_ACTIVE_SESSIONS_DIR"];
  try {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("PeerInfo.owner non-nullable invariant", () => {
  it("listLivePeers drops heartbeats with corrupt owner records", () => {
    const now = Date.now();

    // Valid peer — touchHeartbeat writes a structurally correct OwnerRecord.
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: VALID_PEER,
      artifactPath: ARTIFACT_PATH,
      now,
    });

    // Corrupt peer — plant garbage at the heartbeat path. readOwnerRecord
    // should return null for this, and listLivePeers should skip it entirely.
    const corruptPath = join(
      REGISTRY_DIR,
      ARTIFACT_ID,
      "heartbeats",
      CORRUPT_PEER,
    );
    writeFileSync(corruptPath, "{not valid json", "utf-8");

    const peers = listLivePeers({
      artifactId: ARTIFACT_ID,
      self: SELF_SESSION,
      now,
    });

    // Exactly one peer comes back — the corrupt one is filtered out, not
    // returned with `owner: null`.
    expect(peers).toHaveLength(1);
    expect(peers[0]?.sessionId).toBe(VALID_PEER);
  });

  it("PeerInfo.owner is non-nullable at the type level", () => {
    // Compile-time assertion: if someone widens PeerInfo.owner to
    // `OwnerRecord | null`, this line fails to typecheck because the return
    // type annotation forbids null. This catches the invariant violation at
    // the type-system level before any runtime test needs to run.
    const extractOwner = (peer: PeerInfo): OwnerRecord => peer.owner;

    const sample: PeerInfo = {
      sessionId: "x",
      ageMs: 0,
      owner: {
        sessionId: "x",
        pid: 1,
        host: hostname(),
        createdAt: 0,
        touchedAt: 0,
      },
    };
    const extracted = extractOwner(sample);
    expect(extracted.host).toBe(hostname());
  });
});
