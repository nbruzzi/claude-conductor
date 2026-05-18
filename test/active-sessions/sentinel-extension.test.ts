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
  realpathSync,
  rmSync,
  symlinkSync,
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
const DOTFILES_ROOT = "/tmp/.claude-dotfiles-94a8058c";
const DOTFILES_ROOT_2 = "/tmp/.claude-dotfiles-76b84abc";

let tmpDir: string;
let prevActiveSessionsDir: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "sentinel-ext-"));
  tmpDir = join(base, "active-sessions");
  prevActiveSessionsDir = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevHome = process.env["HOME"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  // Redirect HOME so the breadcrumb log + canonical-claude-home anchor
  // artifact-id both compute under the test sandbox. The plugin's
  // canonicalClaudeHomeArtifactId now uses effectiveHome() (which honors
  // process.env.HOME); tests can rely on tmp-rooted artifact-ids.
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
  // Match production's effectiveHome() — process.env.HOME first, then
  // os.homedir(). The beforeEach sets HOME to the test sandbox.
  const home = process.env["HOME"] ?? homedir();
  return artifactIdFromPath(join(home, ".claude"));
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
    const updated = "/tmp/.claude-dotfiles-changed";
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

// ─── L588 race-fix: realpath canonicalization at setSentinelDotfilesRoot ───
describe("setSentinelDotfilesRoot — L588 realpath canonicalization", () => {
  it("stores realpath-canonicalized form when target exists (resolves symlink chain)", () => {
    // Create a real target dir + a symlink pointing at it. Pass the symlink
    // path to setSentinelDotfilesRoot; the stored form should be the realpath.
    const targetBase = mkdtempSync(join(tmpdir(), "l588-real-target-"));
    const symlinkPath = join(targetBase, "symlinked-worktree");
    const realTarget = join(targetBase, "actual-worktree");
    mkdirSync(realTarget, { recursive: true });
    symlinkSync(realTarget, symlinkPath);

    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: symlinkPath });

    const stored = readSentinelDotfilesRoot(SID);
    // Stored form is the realpath of `symlinkPath`. On macOS this also
    // resolves `/tmp` → `/private/tmp` (the tmpdir's ancestor chain); use
    // realpathSync on the same `symlinkPath` to compute the expected canonical.
    const expected = realpathSync(symlinkPath);
    expect(stored).toBe(expected);

    // Cleanup
    rmSync(targetBase, { recursive: true, force: true });
  });

  it("falls back to resolve() when target does not exist (fresh-provisioning race window)", () => {
    // Provisioner can pin the sentinel BEFORE the worktree directory is
    // fully written. realpathSync throws ENOENT; fallback resolve() strips
    // `.`/`..` but does NOT touch the filesystem, so the stored shape
    // still reflects the operator-intended path (just not canonicalized
    // against ancestor symlinks).
    const nonExistent = "/tmp/.claude-dotfiles-nonexistent-l588-fallback";

    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: nonExistent });

    const stored = readSentinelDotfilesRoot(SID);
    // resolve() returns the input as-is when already absolute + no ./../
    expect(stored).toBe(nonExistent);
  });

  it("idempotent re-pin with the same realpath produces identical OwnerRecord shape", () => {
    const targetBase = mkdtempSync(join(tmpdir(), "l588-idempotent-"));
    mkdirSync(join(targetBase, "wt"), { recursive: true });
    const path = join(targetBase, "wt");

    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: path });
    const first = readSentinelDotfilesRoot(SID);

    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: path });
    const second = readSentinelDotfilesRoot(SID);

    expect(second).toBe(first);

    rmSync(targetBase, { recursive: true, force: true });
  });
});

/* ─── Slice 7 A2 — telemetry instrumentation tests (T1-T11) ────────── */

describe("Slice 7 A2 — telemetry instrumentation (plan v1.4)", () => {
  it("T1 — setSentinelDotfilesRoot emits sentinel-dotfilesroot-set with prior + pid + host", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT_2 });
    const events = readPresenceFailures().filter(
      (e) => e.kind === "sentinel-dotfilesroot-set",
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    const second = events[events.length - 1];
    expect(second?.detail ?? "").toContain("dotfilesRoot=");
    expect(second?.detail ?? "").toContain("prior=");
    expect(second?.detail ?? "").toContain("pid=");
    expect(second?.detail ?? "").toContain("host=");
  });

  it("T2 — clearSentinelDotfilesRoot emits sentinel-dotfilesroot-cleared with prior + caller_top4", () => {
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    clearSentinelDotfilesRoot(SID);
    const events = readPresenceFailures().filter(
      (e) => e.kind === "sentinel-dotfilesroot-cleared",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.detail ?? "").toContain("prior=");
    expect(events[0]?.detail ?? "").toContain("caller_top4=");
  });

  it("T2b — clearSentinelDotfilesRoot emits even on no-op idempotent clear (no prior dotfilesRoot)", () => {
    touchHeartbeat({
      artifactId: canonicalArtifactId(),
      sessionId: SID,
      artifactPath: join(process.env["HOME"] ?? "", ".claude"),
      now: Date.now(),
    });
    clearSentinelDotfilesRoot(SID);
    const events = readPresenceFailures().filter(
      (e) => e.kind === "sentinel-dotfilesroot-cleared",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.detail ?? "").toContain("prior=null");
  });

  it("T3 — unregisterActiveSession emits session-unregistered with cleared count", () => {
    touchHeartbeat({
      artifactId: canonicalArtifactId(),
      sessionId: SID,
      artifactPath: join(process.env["HOME"] ?? "", ".claude"),
      now: Date.now(),
    });
    unregisterActiveSession(SID);
    const events = readPresenceFailures().filter(
      (e) => e.kind === "session-unregistered",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.detail ?? "").toContain("cleared=1");
    expect(events[0]?.detail ?? "").toContain("caller_top4=");
  });

  it("T4 — unregisterActiveSession does NOT emit when nothing cleared", () => {
    unregisterActiveSession(SID);
    const events = readPresenceFailures().filter(
      (e) => e.kind === "session-unregistered",
    );
    expect(events.length).toBe(0);
  });

  it("T5 — touchHeartbeat emits anomaly when canonical-anchor heartbeat exists without dotfilesRoot", () => {
    const anchorArtifactId = canonicalArtifactId();
    const anchorPath = join(process.env["HOME"] ?? "", ".claude");
    touchHeartbeat({
      artifactId: anchorArtifactId,
      sessionId: SID,
      artifactPath: anchorPath,
      now: Date.now() - 1000,
    });
    touchHeartbeat({
      artifactId: anchorArtifactId,
      sessionId: SID,
      artifactPath: anchorPath,
      now: Date.now(),
    });
    const events = readPresenceFailures().filter(
      (e) => e.kind === "heartbeat-no-dotfilesroot-on-existing",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.detail ?? "").toContain("existing.touchedAt=");
    expect(events[0]?.detail ?? "").toContain("existing.createdAt=");
  });

  it("T6 — touchHeartbeat does NOT emit anomaly when artifact is non-canonical", () => {
    const nonCanonicalArtifactId = artifactIdFromPath(
      join(process.env["HOME"] ?? "", ".claude-dotfiles"),
    );
    const path = join(process.env["HOME"] ?? "", ".claude-dotfiles");
    mkdirSync(path, { recursive: true });
    touchHeartbeat({
      artifactId: nonCanonicalArtifactId,
      sessionId: SID,
      artifactPath: path,
      now: Date.now() - 1000,
    });
    touchHeartbeat({
      artifactId: nonCanonicalArtifactId,
      sessionId: SID,
      artifactPath: path,
      now: Date.now(),
    });
    const events = readPresenceFailures().filter(
      (e) => e.kind === "heartbeat-no-dotfilesroot-on-existing",
    );
    expect(events.length).toBe(0);
  });

  it("T7 — tryReapHeartbeat emits heartbeat-reaped with target_sid + reaper_sid + caller_top4 (via unregisterActiveSession)", () => {
    touchHeartbeat({
      artifactId: canonicalArtifactId(),
      sessionId: SID,
      artifactPath: join(process.env["HOME"] ?? "", ".claude"),
      now: Date.now(),
    });
    unregisterActiveSession(SID);
    const events = readPresenceFailures().filter(
      (e) => e.kind === "heartbeat-reaped",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.detail ?? "").toContain(`target_sid=${SID}`);
    expect(events[0]?.detail ?? "").toContain("reaper_sid=");
    expect(events[0]?.detail ?? "").toContain("caller_top4=");
  });

  it("T9 — regression: setSentinelDotfilesRoot then touchHeartbeat does NOT emit anomaly (merge preserved)", () => {
    const anchorArtifactId = canonicalArtifactId();
    const anchorPath = join(process.env["HOME"] ?? "", ".claude");
    setSentinelDotfilesRoot({ sessionId: SID, dotfilesRoot: DOTFILES_ROOT });
    touchHeartbeat({
      artifactId: anchorArtifactId,
      sessionId: SID,
      artifactPath: anchorPath,
      now: Date.now(),
    });
    const events = readPresenceFailures();
    expect(
      events.find((e) => e.kind === "sentinel-dotfilesroot-set"),
    ).toBeDefined();
    expect(
      events.find((e) => e.kind === "heartbeat-no-dotfilesroot-on-existing"),
    ).toBeUndefined();
  });

  it("T11 — resetArtifactRegistry emits artifact-reset BEFORE rmSync with sid_prefix_sample + heartbeats_count", async () => {
    const { resetArtifactRegistry } =
      await import("../../src/active-sessions/index.ts");
    const anchorArtifactId = canonicalArtifactId();
    const anchorPath = join(process.env["HOME"] ?? "", ".claude");
    touchHeartbeat({
      artifactId: anchorArtifactId,
      sessionId: SID,
      artifactPath: anchorPath,
      now: Date.now(),
    });
    touchHeartbeat({
      artifactId: anchorArtifactId,
      sessionId: SID2,
      artifactPath: anchorPath,
      now: Date.now(),
    });
    resetArtifactRegistry(anchorArtifactId);
    const events = readPresenceFailures().filter(
      (e) => e.kind === "artifact-reset",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.detail ?? "").toContain(`artifactId=${anchorArtifactId}`);
    expect(events[0]?.detail ?? "").toContain("heartbeats_count=2");
    // readdir order is not guaranteed; assert both prefixes present.
    expect(events[0]?.detail ?? "").toContain(SID.slice(0, 8));
    expect(events[0]?.detail ?? "").toContain(SID2.slice(0, 8));
    expect(events[0]?.detail ?? "").toContain("sid_prefix_sample=[");
  });
});
