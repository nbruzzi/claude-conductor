// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 6 item-4 — reconcile-boot pause-protection + N1 enumeration resilience.
 *
 * Kept SEPARATE from reconcile-boot.test.ts (Delta's Cycle-2 logic suite) to
 * avoid a shared-test-file merge with Delta's increment-2 (--apply GC).
 *
 * Pause-protection (Option X): a deliberately paused session must NEVER be
 * gc_eligible, across ALL its artifacts — because `pausedAt` lives on the
 * session's canonical-claude-home anchor only, the gc_eligible AND-term does a
 * SESSION-level lookup (`readSessionPausedAt(session_id)`), not a per-candidate
 * owner read. This test proves a paused session's NON-anchor candidate is
 * protected too — the case a per-candidate `owner.pausedAt` check would miss.
 *
 * It also re-guards the `readOwnerRecord` pausedAt-carry from the consumer side:
 * if the parse-back dropped pausedAt, readSessionPausedAt returns null, the
 * lookup misses, and the paused candidates would wrongly go gc_eligible.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GC_WINDOW_MS,
  canonicalClaudeHomeArtifactId,
  runReconcileBoot,
} from "../../src/active-sessions/index.ts";

let tmpDir: string;
let prev: string | undefined;
let prevChannels: string | undefined;
let prevConfig: string | undefined;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reconcile-pause-"));
  prev = process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  prevChannels = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevConfig = process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = tmpDir;
  // Isolate the channels dir + worktree-provisioner config: runReconcileBoot's
  // default scope now enumerates identity (channels dir) and worktrees (repo
  // config, default ~/.claude/worktree-provisioner.json). Point both at
  // non-existent paths so the pause-focused presence tests stay deterministic.
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = join(tmpDir, "no-channels");
  process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = join(
    tmpDir,
    "no-config.json",
  );
});

afterEach(() => {
  if (prev === undefined)
    delete process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = prev;
  if (prevChannels === undefined)
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannels;
  if (prevConfig === undefined)
    delete process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"];
  else process.env["CLAUDE_CONDUCTOR_WORKTREE_PROVISIONER_CONFIG"] = prevConfig;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * Write a heartbeat with a back-dated mtime (`ageMs` from NOW). `pausedAt`, when
 * given, is written into the OwnerRecord body — this is what the canonical
 * anchor of a paused session carries.
 */
function writeHeartbeat(
  artifactId: string,
  sessionId: string,
  ageMs: number,
  opts: { pausedAt?: number } = {},
): void {
  const dir = join(tmpDir, artifactId, "heartbeats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sessionId);
  writeFileSync(
    path,
    JSON.stringify({
      sessionId,
      pid: 4242,
      host: hostname(),
      createdAt: NOW - ageMs,
      touchedAt: NOW - ageMs,
      ...(opts.pausedAt !== undefined ? { pausedAt: opts.pausedAt } : {}),
    }),
  );
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
}

describe("runReconcileBoot — pause-protection (Option X) + N1 resilience", () => {
  it("a paused session is protected from GC across ALL its artifacts; an unpaused twin is not", () => {
    const anchorId = canonicalClaudeHomeArtifactId();
    const paused = "abababab-0000-4000-8000-00000000000a";
    const unpaused = "cdcdcdcd-0000-4000-8000-00000000000c";
    const stale = GC_WINDOW_MS + 1; // stale + past the GC floor

    // Paused session: anchor heartbeat carrying pausedAt, PLUS a heartbeat on a
    // separate work artifact with NO marker of its own (pause is session-global,
    // resolved via the anchor lookup).
    writeHeartbeat(anchorId, paused, stale, { pausedAt: NOW - stale });
    writeHeartbeat("work-file", paused, stale);

    // Unpaused twin: identical stale+past-floor heartbeat, no pause marker.
    writeHeartbeat("work-file", unpaused, stale);

    const out = runReconcileBoot({ now: NOW });

    // EVERY candidate of the paused session is protected — anchor AND work-file.
    const pausedCandidates = out.candidates.filter(
      (c) => c.session_id === paused,
    );
    expect(pausedCandidates.length).toBe(2);
    expect(pausedCandidates.every((c) => c.gc_eligible === false)).toBe(true);

    // The unpaused twin IS gc_eligible — the protection is the pause, not the age.
    const unpausedCandidate = out.candidates.find(
      (c) => c.session_id === unpaused,
    );
    expect(unpausedCandidate?.classification).toBe("stale");
    expect(unpausedCandidate?.gc_eligible).toBe(true);

    // Only the unpaused session contributes to the GC count.
    expect(out.gc_eligible_count).toBe(1);
  });

  it("N1: a structurally-broken artifact does not abort enumeration; valid artifacts still reconcile", () => {
    // Valid stale+past-floor heartbeat that must still be enumerated.
    writeHeartbeat(
      "good",
      "12121212-0000-4000-8000-000000000001",
      GC_WINDOW_MS + 1,
    );

    // Broken artifact: `heartbeats` is a FILE, not a dir, so listing its
    // heartbeats throws (ENOTDIR). The per-artifact try/catch must skip it.
    const badArtifact = join(tmpDir, "bad-artifact");
    mkdirSync(badArtifact, { recursive: true });
    writeFileSync(join(badArtifact, "heartbeats"), "not a directory");

    const out = runReconcileBoot({ now: NOW });

    expect(out.ok).toBe(true); // did not crash on the bad artifact
    expect(
      out.candidates.some((c) => c.session_id.startsWith("12121212")),
    ).toBe(true); // the good artifact still reconciled
  });
});
