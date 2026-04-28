// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 2a regression suite.
 *
 * Covers:
 * - RE-1: touchHeartbeat's meta.json write is atomic-if-missing. Once meta
 *   exists, a subsequent touchHeartbeat with a later `now` must NOT rewrite
 *   `createdAt` — the prior pre-RE-1 writeAtomic-then-rename clobbered the
 *   earlier writer's timestamp whenever two first-writers raced through the
 *   `!existsSync` gate.
 *
 * - SE-1 / SE-2: resetArtifactRegistry refuses to touch anything outside the
 *   registry. Four orthogonal guards — id syntax, registry membership,
 *   symlink-substitution, realpath prefix equality — each must reject its
 *   dedicated attack vector.
 *
 * - Operator-reset log: a successful reset emits exactly one typed event
 *   with kind "operator-reset" so concurrent peer write failures can be
 *   correlated against a reset in post-mortem.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  artifactIdFromPath,
  listArtifactIds,
  readArtifactMeta,
  resetArtifactRegistry,
  setCoordinationRootsForTesting,
  touchHeartbeat,
  writeMetaIfMissing,
} from "../../src/active-sessions/index.ts";
import { readPresenceFailures } from "../../src/shared/presence-failure-log.ts";
import { makeTmpHome, type TmpHome } from "../../test-utils/index.ts";

let tmpHome: TmpHome | null = null;
let prevHome: string | undefined;
let prevActiveSessionsDir: string | undefined;
let REGISTRY_DIR = "";
let FAKE_REPO = "";
let ARTIFACT_PATH = "";
let ARTIFACT_ID = "";

function tmpHomeDir(): string {
  if (!tmpHome)
    throw new Error(
      "tmpHome not initialized — test is outside beforeEach scope",
    );
  return tmpHome.home;
}

beforeEach(() => {
  tmpHome = makeTmpHome();
  prevHome = process.env["HOME"];
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  process.env["HOME"] = tmpHome.home;

  REGISTRY_DIR = join(tmpHome.home, "registry");
  FAKE_REPO = join(tmpHome.home, "fake-repo");
  mkdirSync(REGISTRY_DIR, { recursive: true });
  mkdirSync(FAKE_REPO, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = REGISTRY_DIR;
  ARTIFACT_PATH = realpathSync(FAKE_REPO);
  ARTIFACT_ID = artifactIdFromPath(ARTIFACT_PATH);
  setCoordinationRootsForTesting({ roots: [realpathSync(tmpHome.home)] });
});

afterEach(() => {
  setCoordinationRootsForTesting(null);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevActiveSessionsDir === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  tmpHome?.cleanup();
  tmpHome = null;
});

describe("RE-1 atomic meta.json", () => {
  it("preserves existing createdAt when touched again with a later now", () => {
    const firstNow = 1_700_000_000_000;
    const laterNow = firstNow + 60_000;

    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-first",
      artifactPath: ARTIFACT_PATH,
      now: firstNow,
    });

    const metaAfterFirst = readArtifactMeta(ARTIFACT_ID);
    expect(metaAfterFirst?.createdAt).toBe(firstNow);

    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-second",
      artifactPath: ARTIFACT_PATH,
      now: laterNow,
    });

    const metaAfterSecond = readArtifactMeta(ARTIFACT_ID);
    expect(metaAfterSecond?.createdAt).toBe(firstNow);
  });

  it("still writes heartbeat body when meta is pre-planted (EEXIST path)", () => {
    // Plant meta directly so touchHeartbeat's writeMetaIfMissing hits the
    // "file already exists" branch and bails early. Heartbeat write must
    // still succeed.
    const artifactDir = join(REGISTRY_DIR, ARTIFACT_ID);
    mkdirSync(join(artifactDir, "heartbeats"), { recursive: true });
    writeFileSync(
      join(artifactDir, "meta.json"),
      `${JSON.stringify({ artifactPath: ARTIFACT_PATH, createdAt: 1 })}\n`,
      "utf-8",
    );

    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-late-arrival",
      artifactPath: ARTIFACT_PATH,
      now: 9999,
    });

    expect(
      existsSync(join(artifactDir, "heartbeats", "session-late-arrival")),
    ).toBe(true);
    expect(readArtifactMeta(ARTIFACT_ID)?.createdAt).toBe(1);
  });

  it("writeMetaIfMissing: first call writes, second call preserves the first", () => {
    // Direct test of the atomic-if-missing primitive. Calls the function
    // twice against the SAME metaFile — the second call must observe the
    // first's createdAt on disk. This is the exact race invariant RE-1
    // protects: two first-writers both pass their internal checks, but
    // only one wins the linkSync. Sequential calls here bypass the
    // !existsSync fast-path in touchHeartbeat and drive writeMetaIfMissing
    // directly, so the assertion is actually pinned to linkSync's EEXIST
    // semantic — not to the OwnerRecord createdAt-preservation code path.
    const artifactDir = join(REGISTRY_DIR, ARTIFACT_ID);
    mkdirSync(artifactDir, { recursive: true });
    const metaFile = join(artifactDir, "meta.json");

    writeMetaIfMissing(metaFile, {
      artifactPath: ARTIFACT_PATH,
      createdAt: 111,
    });
    expect(readArtifactMeta(ARTIFACT_ID)?.createdAt).toBe(111);

    writeMetaIfMissing(metaFile, {
      artifactPath: ARTIFACT_PATH,
      createdAt: 222,
    });
    expect(readArtifactMeta(ARTIFACT_ID)?.createdAt).toBe(111);
  });

  it("writeMetaIfMissing: leaves no orphan tmp file after EEXIST path", () => {
    // Regression guard — the `finally { unlinkSync(tmp) }` must reap the
    // tmp regardless of linkSync outcome. A leaked tmp would confuse
    // operators and litter the registry over time.
    const artifactDir = join(REGISTRY_DIR, ARTIFACT_ID);
    mkdirSync(artifactDir, { recursive: true });
    const metaFile = join(artifactDir, "meta.json");

    writeMetaIfMissing(metaFile, {
      artifactPath: ARTIFACT_PATH,
      createdAt: 111,
    });
    writeMetaIfMissing(metaFile, {
      artifactPath: ARTIFACT_PATH,
      createdAt: 222,
    });
    writeMetaIfMissing(metaFile, {
      artifactPath: ARTIFACT_PATH,
      createdAt: 333,
    });

    const leftovers = readdirSync(artifactDir).filter((f) =>
      f.startsWith("meta.json.tmp."),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("SE-1 / SE-2 resetArtifactRegistry guards", () => {
  it("rejects malformed artifactId synchronously", () => {
    expect(() => resetArtifactRegistry("../escape")).toThrow(
      /invalid artifactId/,
    );
    expect(() => resetArtifactRegistry("has/slash")).toThrow(
      /invalid artifactId/,
    );
    expect(() => resetArtifactRegistry("")).toThrow(/invalid artifactId/);
  });

  it("returns empty result on valid-format id that is not in the registry", () => {
    const fakeId = artifactIdFromPath("/definitely/not/a/real/artifact");
    expect(listArtifactIds()).not.toContain(fakeId);
    const result = resetArtifactRegistry(fakeId);
    expect(result).toEqual({ metaRemoved: false, heartbeatsRemoved: [] });
  });

  it("refuses to reset an artifact path that resolves to a symlink", () => {
    // Register an artifact the normal way, then replace the dir with a
    // symlink to a directory elsewhere. Reset must refuse rather than
    // following the symlink and rm-ing the target.
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-pre-symlink",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    const artifactDir = join(REGISTRY_DIR, ARTIFACT_ID);
    const sensitiveTarget = join(tmpHomeDir(), "sensitive");
    mkdirSync(sensitiveTarget, { recursive: true });
    writeFileSync(
      join(sensitiveTarget, "do-not-delete"),
      "preserve me",
      "utf-8",
    );
    rmSync(artifactDir, { recursive: true, force: true });
    symlinkSync(sensitiveTarget, artifactDir);

    expect(() => resetArtifactRegistry(ARTIFACT_ID)).toThrow(/symlink/);
    expect(existsSync(join(sensitiveTarget, "do-not-delete"))).toBe(true);
  });

  it("does not follow symlinked children inside a real artifact dir", () => {
    // Guard #4 (realpath equality) and guard #3 (lstat symlink check) both
    // evaluate the artifact dir itself. Once they pass, the dir is
    // quarantined-and-rm'd. But a real dir can still CONTAIN symlinks —
    // e.g. a stray child symlinking to something sensitive on the same
    // host. rmSync with recursive:true must unlink the symlink ENTRY, not
    // traverse into its target. This test pins that Node behavior: we
    // plant a symlinked child pointing at a file outside the registry,
    // run reset, and confirm the target survives.
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-with-evil-child",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    const artifactDirPath = join(REGISTRY_DIR, ARTIFACT_ID);

    const outsideTarget = join(tmpHomeDir(), "outside-registry");
    mkdirSync(outsideTarget, { recursive: true });
    const protectedFile = join(outsideTarget, "protected-file");
    writeFileSync(protectedFile, "must survive", "utf-8");

    // Plant a symlink INSIDE the artifact dir that points at the file
    // above. Place it under heartbeats/ so it looks like a plausible
    // stray entry a buggy caller might create.
    const evilLink = join(artifactDirPath, "heartbeats", "stray-symlink");
    symlinkSync(protectedFile, evilLink);

    const result = resetArtifactRegistry(ARTIFACT_ID);

    expect(existsSync(artifactDirPath)).toBe(false);
    expect(result.metaRemoved).toBe(true);
    // Target file must survive.
    expect(existsSync(protectedFile)).toBe(true);
    expect(existsSync(outsideTarget)).toBe(true);
  });
});

describe("resetArtifactRegistry happy path", () => {
  it("removes the artifact dir and returns the removed heartbeat sessionIds", () => {
    const sessions = ["session-a", "session-b", "session-c"];
    for (const s of sessions) {
      touchHeartbeat({
        artifactId: ARTIFACT_ID,
        sessionId: s,
        artifactPath: ARTIFACT_PATH,
        now: Date.now(),
      });
    }
    const artifactDir = join(REGISTRY_DIR, ARTIFACT_ID);
    expect(existsSync(artifactDir)).toBe(true);

    const result = resetArtifactRegistry(ARTIFACT_ID);

    expect(existsSync(artifactDir)).toBe(false);
    expect(listArtifactIds()).not.toContain(ARTIFACT_ID);
    expect(result.metaRemoved).toBe(true);
    expect(result.heartbeatsRemoved.sort()).toEqual([...sessions].sort());
  });

  it("leaves sibling artifacts untouched", () => {
    const otherRepo = join(tmpHomeDir(), "other-repo");
    mkdirSync(otherRepo, { recursive: true });
    const otherPath = realpathSync(otherRepo);
    const otherId = artifactIdFromPath(otherPath);

    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-a",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    touchHeartbeat({
      artifactId: otherId,
      sessionId: "session-sibling",
      artifactPath: otherPath,
      now: Date.now(),
    });

    resetArtifactRegistry(ARTIFACT_ID);

    expect(listArtifactIds()).toContain(otherId);
    expect(readArtifactMeta(otherId)?.artifactPath).toBe(otherPath);
  });

  it("sweeps stray tmp files inside the artifact dir", () => {
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-a",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    const artifactDir = join(REGISTRY_DIR, ARTIFACT_ID);
    const strayTmp = join(artifactDir, "meta.json.tmp.99999.0.abcdef");
    writeFileSync(strayTmp, "orphaned tmp", "utf-8");
    expect(existsSync(strayTmp)).toBe(true);

    resetArtifactRegistry(ARTIFACT_ID);

    expect(existsSync(strayTmp)).toBe(false);
    expect(existsSync(artifactDir)).toBe(false);
  });

  it("emits exactly one operator-reset event to the shared log", () => {
    touchHeartbeat({
      artifactId: ARTIFACT_ID,
      sessionId: "session-a",
      artifactPath: ARTIFACT_PATH,
      now: Date.now(),
    });
    const before = readPresenceFailures();
    const baseline = before.filter((e) => e.kind === "operator-reset").length;

    resetArtifactRegistry(ARTIFACT_ID);

    const after = readPresenceFailures();
    const resetEvents = after.filter((e) => e.kind === "operator-reset");
    expect(resetEvents.length).toBe(baseline + 1);
    const event = resetEvents[resetEvents.length - 1];
    expect(event?.source).toBe("active-sessions-registry");
    // artifactPath is redacted at the log boundary — $HOME → ~.
    // The raw path lives under tmpHome.home, so the redacted form ends in /fake-repo.
    expect(event?.artifactPath).toBe("~/fake-repo");
    expect(event?.detail).toContain(ARTIFACT_ID);
    expect(event?.detail).toContain("1 heartbeats removed");
  });
});
