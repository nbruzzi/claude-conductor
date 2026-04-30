// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — REV 0.2 sentinel extension matrix.
 *
 * Covers the 4 new exports from active-sessions/index.ts:
 * - setSentinelDotfilesRoot — anchor-pin (force-creates anchor heartbeat
 *   if absent; idempotent re-pin)
 * - readSentinelDotfilesRoot — round-trip + null on absent + sentinel-corrupt
 *   breadcrumb on parse failure
 * - clearSentinelDotfilesRoot — idempotent; preserves other heartbeat fields
 * - unregisterActiveSession — idempotent; cross-artifact sweep; never throws
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactIdFromPath,
  clearSentinelDotfilesRoot,
  readSentinelDotfilesRoot,
  setSentinelDotfilesRoot,
  touchHeartbeat,
  unregisterActiveSession,
} from "../../src/active-sessions/index.ts";
import { readPresenceFailures } from "../../src/shared/presence-failure-log.ts";

const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";
const SID2 = "76b84abc-a6a2-4395-bb65-f5bd799c525c";
const DOTFILES_ROOT = "/Users/test/.claude-dotfiles-94a8058c";
const DOTFILES_ROOT_2 = "/Users/test/.claude-dotfiles-76b84abc";

let tmpDir: string;
let prevActiveSessionsDir: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "sentinel-ext-"));
  tmpDir = join(base, "active-sessions");
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevHome = process.env["HOME"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  // Redirect HOME so the breadcrumb log lands in the test sandbox, not
  // the real ~/.claude/logs/. The active-sessions canonical-claude-home
  // anchor still computes against the real homedir() (cached at module
  // load), so tests interact with a stable artifact-id derived from the
  // real path.
  process.env["HOME"] = base;
  // appendPresenceFailure uses appendFileSync without mkdir; create the
  // ~/.claude/logs/ dir under the test sandbox so breadcrumbs aren't
  // silently dropped.
  mkdirSync(join(base, ".claude", "logs"), { recursive: true });
});

afterEach(() => {
  if (prevActiveSessionsDir === undefined) {
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  } else {
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prevActiveSessionsDir;
  }
  if (prevHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = prevHome;
  }
  try {
    rmSync(join(tmpDir, ".."), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function canonicalArtifactId(): string {
  return artifactIdFromPath(join(homedir(), ".claude"));
}

describe("setSentinelDotfilesRoot + readSentinelDotfilesRoot", () => {
  it("round-trips a written sentinel value", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);
  });

  it("returns null when no sentinel has been written", () => {
    expect(readSentinelDotfilesRoot(SID)).toBeNull();
  });

  it("force-creates the anchor heartbeat record if absent (ARCH-1 anchor-pin)", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });

    const heartbeatFile = join(
      tmpDir,
      canonicalArtifactId(),
      "heartbeats",
      SID,
    );
    const raw = readFileSync(heartbeatFile, "utf-8");
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body["sessionId"]).toBe(SID);
    expect(body["dotfilesRoot"]).toBe(DOTFILES_ROOT);
  });

  it("re-pinning the same sid+value is a no-op merge (idempotent)", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);
  });

  it("re-pinning the same sid with a NEW value updates the field", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    const updated = "/Users/test/.claude-dotfiles-changed";
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: updated });
    expect(readSentinelDotfilesRoot(SID)).toBe(updated);
  });

  it("ignores invalid sessionId silently", () => {
    setSentinelDotfilesRoot({
      sessionId: "../etc/passwd",
      dotfilesRoot: DOTFILES_ROOT,
    });
    expect(readSentinelDotfilesRoot("../etc/passwd")).toBeNull();
  });

  it("ignores empty dotfilesRoot silently", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: "" });
    expect(readSentinelDotfilesRoot(SID)).toBeNull();
  });
});

describe("readSentinelDotfilesRoot — corruption handling", () => {
  it("emits sentinel-corrupt breadcrumb when heartbeat body is malformed", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    const heartbeatFile = join(
      tmpDir,
      canonicalArtifactId(),
      "heartbeats",
      SID,
    );
    writeFileSync(heartbeatFile, "{not-json", "utf-8");

    const result = readSentinelDotfilesRoot(SID);
    expect(result).toBeNull();

    const events = readPresenceFailures();
    expect(events.find((e) => e.kind === "sentinel-corrupt")).toBeDefined();
  });
});

describe("clearSentinelDotfilesRoot", () => {
  it("removes the dotfilesRoot field but preserves other heartbeat fields", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    clearSentinelDotfilesRoot(SID);
    expect(readSentinelDotfilesRoot(SID)).toBeNull();

    const heartbeatFile = join(
      tmpDir,
      canonicalArtifactId(),
      "heartbeats",
      SID,
    );
    const raw = readFileSync(heartbeatFile, "utf-8");
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body["sessionId"]).toBe(SID);
    expect(body["dotfilesRoot"]).toBeUndefined();
    expect(typeof body["pid"]).toBe("number");
    expect(typeof body["createdAt"]).toBe("number");
  });

  it("is idempotent — second clear is a no-op", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    clearSentinelDotfilesRoot(SID);
    expect(() => {
      clearSentinelDotfilesRoot(SID);
    }).not.toThrow();
    expect(readSentinelDotfilesRoot(SID)).toBeNull();
  });

  it("is a no-op when no heartbeat exists", () => {
    expect(() => {
      clearSentinelDotfilesRoot(SID);
    }).not.toThrow();
  });
});

describe("unregisterActiveSession", () => {
  it("returns 0 when the session has no heartbeats", () => {
    expect(unregisterActiveSession(SID)).toBe(0);
  });

  it("removes the anchor heartbeat written by setSentinelDotfilesRoot", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    expect(readSentinelDotfilesRoot(SID)).toBe(DOTFILES_ROOT);

    const cleared = unregisterActiveSession(SID);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(readSentinelDotfilesRoot(SID)).toBeNull();
  });

  it("removes heartbeats across multiple artifact-ids for the same sid", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });

    const otherArtifactPath = "/some/other/artifact";
    const otherArtifactId = artifactIdFromPath(otherArtifactPath);
    touchHeartbeat({
      artifactId: otherArtifactId,
      sessionId: SID,
      artifactPath: otherArtifactPath,
      now: Date.now(),
    });

    const cleared = unregisterActiveSession(SID);
    expect(cleared).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent — second call returns 0", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    unregisterActiveSession(SID);
    expect(unregisterActiveSession(SID)).toBe(0);
  });

  it("does not affect other sessions' heartbeats", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    setSentinelDotfilesRoot({ sessionId: SID2, dotfilesRoot: DOTFILES_ROOT_2 });

    unregisterActiveSession(SID);

    expect(readSentinelDotfilesRoot(SID)).toBeNull();
    expect(readSentinelDotfilesRoot(SID2)).toBe(DOTFILES_ROOT_2);
  });

  it("returns 0 on invalid sessionId without throwing", () => {
    expect(unregisterActiveSession("../bad")).toBe(0);
  });
});
