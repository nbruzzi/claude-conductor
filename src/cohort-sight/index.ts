// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cohort-sight — a read-only "captain board" of live sessions (D2; Nick-blessed
 * 2026-06-05 via Echo's huddle seed; Delta owns).
 *
 * The OBSERVE rung of the liveness ladder (vs the mtime-INFERENCE substrate):
 * it CONSUMES two artifacts the harness + the channel already publish, with
 * ZERO new writes and ZERO new protocol —
 *   1. `~/.claude/sessions/<pid>.json` — the harness-written per-session
 *      registry { pid, sessionId, cwd, status:"busy"|"idle", startedAt,
 *      updatedAt, ... }. The HARNESS declares alive + busy/idle + its own
 *      heartbeat; we just read it. One file per live `claude` process; only the
 *      NUMERIC `<pid>.json` stems are pidfiles (UUID-keyed files are telemetry,
 *      skipped).
 *   2. the coordination channel `metadata.json` identities map — sessionId ->
 *      NATO letter (Alpha/Bravo/...), via `readMetadata`.
 * fused with a same-host `process.kill(pid, 0)` existence probe (signal 0 sends
 * nothing; EPERM => exists-but-not-ours => alive; ESRCH => gone).
 *
 * AUGMENT-ONLY + DEGRADABLE by construction: this module only READS + reports.
 * No caller mutates from it, and NO state-deleting (reaper/GC) path may EVER
 * depend on it — the pidfile is an UNDOCUMENTED, CC-version-coupled harness
 * artifact (per the C1 pid-SPIKE caveat). Every read is fail-soft: an unreadable
 * pidfile is surfaced in `blindSpots[]` (never thrown), and a missing sessions
 * dir yields an empty board. Sight, not safety.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  COORDINATION_CHANNEL_ID,
  readMetadata,
  type ChannelMetadata,
} from "../channels/index.ts";

/** Harness-declared activity status, or "unknown" when absent/unreadable. */
export type CohortSightStatus = "busy" | "idle" | "unknown";

/** One session's fused observation row. */
export type CohortSightRow = {
  /** NATO letter from the coordination channel identities map, or null when the
   *  session holds no cohort identity (a non-cohort session on this host — shown
   *  unlabeled, since the board observes the whole host honestly). */
  identity: string | null;
  sessionId: string;
  /** The session's real OS pid (the `<pid>.json` stem == the embedded pid). */
  pid: number;
  /** Harness-declared busy/idle — the OBSERVE signal the mtime proxy infers. */
  status: CohortSightStatus;
  cwd: string | null;
  /** now - pidfile.updatedAt (the harness's own heartbeat), or null if absent. */
  ageMs: number | null;
  /** process.kill(pid,0): true = signalable/alive (incl. EPERM = exists-not-ours),
   *  false = ESRCH/gone or invalid pid. OS ground-truth of process existence. */
  pidAlive: boolean;
};

/** A `<pid>.json` that existed but could not be turned into a row — surfaced,
 *  never silently dropped (a board honest about its own blind spots). */
export type CohortSightBlindSpot = {
  file: string;
  reason: "unparseable" | "missing-fields";
};

export type CohortSight = {
  generatedAt: number;
  channel: string;
  rows: CohortSightRow[];
  blindSpots: CohortSightBlindSpot[];
};

/**
 * `~/.claude/sessions` — the harness pidfile dir. Resolved directly (it is NOT a
 * conductor-managed component, so not via `shared/paths` resolveComponent);
 * mirrors `session-id-discovery`'s `effectiveSessionsDir`. `HOME` is honored so a
 * test sandbox's fake `$HOME` works.
 */
function defaultSessionsDir(): string {
  return join(process.env["HOME"] ?? homedir(), ".claude", "sessions");
}

/**
 * Same-host OS-pid existence probe. `process.kill(pid, 0)` sends NO signal — it
 * only tests existence/permission. EPERM => exists but not ours => alive
 * (protect-safe); ESRCH / invalid => not alive. POSIX, portable (macOS+Linux),
 * no /proc, no fork.
 *
 * NOTE: mirrors S2's `isOsPidAlive` (active-sessions); a candidate to unify into
 * one shared probe once S2 lands. Kept local here so cohort-sight stays
 * independent of the (separate, in-flight) S2 slice.
 */
function isPidSignalable(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

type SessionPidfile = {
  pid: number;
  sessionId: string;
  cwd: string | null;
  status: CohortSightStatus;
  updatedAt: number | null;
};

/**
 * Read + validate one numeric `<pid>.json`. Returns the parsed record, or a
 * blind-spot reason. Fail-soft: any read/parse failure => "unparseable";
 * present-but-malformed (missing pid/sessionId) => "missing-fields".
 */
function readSessionPidfile(
  path: string,
): SessionPidfile | { error: CohortSightBlindSpot["reason"] } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").trim();
  } catch {
    return { error: "unparseable" };
  }
  if (raw.length === 0) return { error: "unparseable" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "unparseable" };
  }

  const obj = parsed as Record<string, unknown>;
  const pid = obj["pid"];
  const sessionId = obj["sessionId"];
  if (typeof pid !== "number" || typeof sessionId !== "string") {
    return { error: "missing-fields" };
  }
  const cwdRaw = obj["cwd"];
  const statusRaw = obj["status"];
  const updatedAtRaw = obj["updatedAt"];
  return {
    pid,
    sessionId,
    cwd: typeof cwdRaw === "string" ? cwdRaw : null,
    status:
      statusRaw === "busy" || statusRaw === "idle" ? statusRaw : "unknown",
    updatedAt: typeof updatedAtRaw === "number" ? updatedAtRaw : null,
  };
}

/**
 * Invert the channel identities map to sessionId -> NATO letter. Fail-soft: an
 * unreadable/absent metadata yields an empty map (every row then shows
 * identity=null — degrade-safe, still a useful host-wide board).
 */
function sessionIdToIdentity(channel: string): Map<string, string> {
  const map = new Map<string, string>();
  let meta: ChannelMetadata;
  try {
    meta = readMetadata(channel);
  } catch {
    return map;
  }
  const identities = meta.identities ?? {};
  for (const [letter, claim] of Object.entries(identities)) {
    map.set(claim.session_id, letter);
  }
  return map;
}

/**
 * Build the cohort-sight board: one row per numeric `<pid>.json`, identity-
 * annotated from the channel, with a live `kill(pid,0)` probe. Read-only +
 * fail-soft throughout. `opts.sessionsDirOverride` / `opts.identityMapOverride`
 * are TEST injection hooks (production reads the real dir + channel).
 */
export function buildCohortSight(
  now: number,
  opts: {
    channel?: string;
    sessionsDirOverride?: string;
    identityMapOverride?: ReadonlyMap<string, string>;
  } = {},
): CohortSight {
  const channel = opts.channel ?? COORDINATION_CHANNEL_ID;
  const dir = opts.sessionsDirOverride ?? defaultSessionsDir();
  const identityMap = opts.identityMapOverride ?? sessionIdToIdentity(channel);

  const rows: CohortSightRow[] = [];
  const blindSpots: CohortSightBlindSpot[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Missing/unreadable sessions dir => empty board (degrade-safe).
    return { generatedAt: now, channel, rows, blindSpots };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const stem = entry.slice(0, -".json".length);
    // Numeric stems are the `<pid>.json` registry; UUID-keyed files are
    // telemetry (resolved elsewhere) — skip them.
    if (!/^\d+$/.test(stem)) continue;

    const result = readSessionPidfile(join(dir, entry));
    if ("error" in result) {
      blindSpots.push({ file: entry, reason: result.error });
      continue;
    }
    rows.push({
      identity: identityMap.get(result.sessionId) ?? null,
      sessionId: result.sessionId,
      pid: result.pid,
      status: result.status,
      cwd: result.cwd,
      ageMs:
        result.updatedAt === null ? null : Math.max(0, now - result.updatedAt),
      pidAlive: isPidSignalable(result.pid),
    });
  }

  // Stable order: identified cohort sessions first (alpha by letter), then the
  // unlabeled ones by sessionId — deterministic output for the board + tests.
  rows.sort((a, b) => {
    if (a.identity !== null && b.identity === null) return -1;
    if (a.identity === null && b.identity !== null) return 1;
    if (a.identity !== null && b.identity !== null) {
      return a.identity.localeCompare(b.identity);
    }
    return a.sessionId.localeCompare(b.sessionId);
  });

  return { generatedAt: now, channel, rows, blindSpots };
}
