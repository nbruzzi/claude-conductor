// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Preventive PreToolUse gate — detect another live Claude session editing
 * the same artifact BEFORE the edit collides.
 *
 * Applies to Edit/Write. Resolves the file to an artifact root (git repo or
 * coordination root), scans for live peer heartbeats, and blocks on the
 * first collision with a 30-minute cooldown. Within cooldown:
 *   - same peer-set  → pass (user already ack'd this peer-group)
 *   - peer-set changed → re-block (a new session joining is a new event)
 *
 * **Ordering is load-bearing.** Scan peers BEFORE writing own heartbeat —
 * a symmetric session-birth race (both sides arrive within the same
 * window) must not silently pass both sides. The peer missed on our first
 * scan will see us on their next PreToolUse once we've touched.
 *
 * On LockTimeoutError: fail-soft (pass) but log visibly to
 * ~/.claude/logs/.presence-gate-failures.log — silent lock failure would
 * defeat the feature's purpose.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactIdFromPath,
  artifactPathFromFile,
  isValidSessionId,
  listLivePeers,
  touchHeartbeat,
  type PeerInfo,
} from "../../active-sessions/index.ts";
import { isPeerCoordinatedWithSelf } from "../../channels/identity-context.ts";
import {
  appendPresenceFailure,
  failureLogPath,
} from "../../shared/presence-failure-log.ts";
import { LockTimeoutError, withLock } from "../lock.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { block, pass, warn } from "../types.ts";

const SOURCE = "session-collision-gate";

// HOME-derived paths are computed per-call so test harnesses can override
// process.env.HOME at runtime. A module-level const would bind HOME at import
// time and defeat test isolation. Matches the pattern in branch-enforcement.ts.
function home(): string {
  return process.env["HOME"] ?? "";
}
function stateDir(): string {
  return join(home(), ".claude", "logs");
}
function lockDir(): string {
  return join(stateDir(), ".session-collision-gate.lock");
}

/**
 * Per-session cooldown state. Sharding by sessionId fixes RE-4: two
 * concurrent sessions previously shared one `.session-collision-warnings`
 * file, and each loadState() whose `session !== sessionId` returned
 * freshState, wiping the peer's cooldowns on every write.
 *
 * sessionId is validated at the resolver boundary (`resolveSessionIdOrNull`),
 * but we re-validate here as defense-in-depth: phantom files such as
 * `.session-collision-warnings-undefined.json` observed in the wild are
 * evidence that a code path reached state-write with an unvalidated id.
 * Throwing here turns a silent landmine-file into a hook-visible error the
 * next time it occurs, while the `check()` entrypoint still fails-open.
 */
export function stateFile(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `stateFile: invalid sessionId (len=${String(sessionId).length})`,
    );
  }
  return join(stateDir(), `.session-collision-warnings-${sessionId}.json`);
}

const COOLDOWN_MS = 30 * 60 * 1000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ARTIFACTS = 100;

type Cooldown = {
  unblockUntil: number;
  peerSet: string[];
};

type State = {
  session: string;
  lastActive: number;
  cooldowns: Record<string, Cooldown>;
  touched: string[];
};

export async function check(input: HookInput): Promise<HookResult> {
  if (input.toolName !== "Edit" && input.toolName !== "Write") return pass();

  const file = input.filePath;
  if (!file) return pass();

  const sessionId = resolveSessionIdOrNull(input);
  if (!sessionId) return pass();
  // Belt-and-suspenders: resolver already validated, but re-check here so a
  // future refactor of the resolver cannot silently produce state files
  // such as `.session-collision-warnings-undefined.json`.
  if (!isValidSessionId(sessionId)) return pass();

  const artifactPath = artifactPathFromFile(file);
  if (!artifactPath) return pass();

  const artifactId = artifactIdFromPath(artifactPath);
  const now = Date.now();

  try {
    return withLock(
      () => {
        const state = loadState(sessionId, now);
        const peers = listLivePeers({ artifactId, self: sessionId, now });

        if (peers.length === 0) {
          touchHeartbeat({ artifactId, sessionId, artifactPath, now });
          rememberTouched(state, artifactId);
          persistState(state);
          return pass();
        }

        // Channel-coordination check (plan v2 Lane B / L161 fix): for each
        // collision-peer, ask whether they share an open channel with self.
        // If ALL collision-peers are channel-coordinated, the collision is
        // by-design (deliberate parallel work) and the BLOCK is wrong; we
        // downgrade to a warn() notification. If ANY peer is uncoordinated,
        // the existing BLOCK path engages (safety preserved for unexpected
        // concurrent sessions).
        const peerCoordination = new Map<string, boolean>();
        for (const peer of peers) {
          const result = isPeerCoordinatedWithSelf(sessionId, peer.sessionId);
          peerCoordination.set(peer.sessionId, result.coordinated);
        }
        const allCoordinated = peers.every(
          (p) => peerCoordination.get(p.sessionId) === true,
        );

        if (allCoordinated) {
          // Downgrade BLOCK → warn. Don't engage cooldown (no cooldown entry
          // for this artifact, no peer-set capture). Still touch heartbeat +
          // remember the artifact so other hooks see consistent state.
          touchHeartbeat({ artifactId, sessionId, artifactPath, now });
          rememberTouched(state, artifactId);
          persistState(state);
          return warn(
            SOURCE,
            formatCoordinatedNoticeMessage({ artifactPath, file, peers }),
          );
        }

        const currentPeerSet = peers.map((p) => p.sessionId).sort();
        const existingCooldown = state.cooldowns[artifactId];
        const inCooldown =
          existingCooldown && existingCooldown.unblockUntil > now;
        const peerSetUnchanged =
          inCooldown && samePeerSet(existingCooldown.peerSet, currentPeerSet);

        if (inCooldown && peerSetUnchanged) {
          touchHeartbeat({ artifactId, sessionId, artifactPath, now });
          rememberTouched(state, artifactId);
          persistState(state);
          return pass();
        }

        state.cooldowns[artifactId] = {
          unblockUntil: now + COOLDOWN_MS,
          peerSet: currentPeerSet,
        };
        persistState(state);

        const msg = formatBlockMessage({
          artifactPath,
          file,
          peers,
          peerCoordination,
          reblocking: Boolean(inCooldown),
        });
        return block(SOURCE, msg);
      },
      { lockDir: lockDir(), ownerTag: SOURCE },
    );
  } catch (err: unknown) {
    if (err instanceof LockTimeoutError) {
      logFailure(artifactPath, sessionId, err);
      console.error(
        `[${SOURCE}] lock timeout on ${artifactPath} — allowing edit; see ${failureLogPath()}`,
      );
      return pass();
    }
    throw err;
  }
}

function samePeerSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function rememberTouched(state: State, artifactId: string): void {
  if (!state.touched.includes(artifactId)) state.touched.push(artifactId);
}

function formatBlockMessage(args: {
  artifactPath: string;
  file: string;
  peers: PeerInfo[];
  /** Map<peer-session-id, coordinated?> — used for the (channel-coordinated)
   *  / (uncoordinated) annotation per plan v2 ARCH-2 fold. Mixed-peer
   *  collisions BLOCK but annotate per-peer so the operator can distinguish
   *  the deliberate sibling from the unexpected concurrent session. */
  peerCoordination: ReadonlyMap<string, boolean>;
  reblocking: boolean;
}): string {
  const lines = [
    args.reblocking
      ? "[session-collision-gate] New peer detected — cooldown reset:"
      : "[session-collision-gate] Another Claude session is active in this artifact:",
    "",
  ];
  for (const peer of args.peers) {
    const age = formatAge(peer.ageMs);
    const tag =
      args.peerCoordination.get(peer.sessionId) === true
        ? "(channel-coordinated)"
        : "(uncoordinated)";
    lines.push(
      `  ${peer.sessionId} — heartbeat ${age} ago (host: ${peer.owner.host}, pid: ${peer.owner.pid}) ${tag}`,
    );
  }
  lines.push("");
  lines.push(`Artifact: ${args.artifactPath}`);
  lines.push(
    `Your ${args.reblocking ? "retry" : "edit"} to ${args.file} may collide with their work.`,
  );
  lines.push("");
  lines.push("What to do next:");
  lines.push(
    "- Coordinated peers (channel-coord with you) are likely intentional — verify via /channel read",
  );
  lines.push(
    "- Uncoordinated peers are unexpected — check /channel list + confirm parallel intent",
  );
  lines.push(
    "- Re-run the Edit if confirmed — this gate enters a 30-min cooldown for this artifact",
  );
  lines.push(
    "- A new peer joining later will re-block, because a new collision is a new event",
  );
  lines.push("");
  lines.push(
    "To clear a stale peer heartbeat: /presence clear <peer-session-id>",
  );
  return lines.join("\n");
}

/**
 * Format the warn-level notification when ALL collision-peers are
 * channel-coordinated (plan v2 Lane B / L161 fix). No cooldown engagement;
 * the edit proceeds. Operator gets a brief visibility cue.
 */
function formatCoordinatedNoticeMessage(args: {
  artifactPath: string;
  file: string;
  peers: PeerInfo[];
}): string {
  const lines = [
    "[session-collision-gate] Coordinated edit detected — proceeding:",
    "",
  ];
  for (const peer of args.peers) {
    const age = formatAge(peer.ageMs);
    lines.push(
      `  ${peer.sessionId} — heartbeat ${age} ago (host: ${peer.owner.host}, pid: ${peer.owner.pid}) (channel-coordinated)`,
    );
  }
  lines.push("");
  lines.push(`Artifact: ${args.artifactPath}`);
  lines.push(
    `Edit to ${args.file} proceeding — both sessions are channel-coordinated (no cooldown).`,
  );
  lines.push("Verify state via /channel read if uncertain about peer intent.");
  return lines.join("\n");
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

// ─── State management ───────────────────────────────────────────────

function loadState(sessionId: string, now: number): State {
  const file = stateFile(sessionId);
  if (!existsSync(file)) return freshState(sessionId, now);
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return freshState(sessionId, now);
    const obj = parsed as Record<string, unknown>;
    const session = typeof obj["session"] === "string" ? obj["session"] : "";
    const lastActive =
      typeof obj["lastActive"] === "number" ? obj["lastActive"] : 0;
    if (session !== sessionId || now - lastActive > SESSION_TIMEOUT_MS) {
      return freshState(sessionId, now);
    }
    const cooldowns = parseCooldowns(obj["cooldowns"]);
    const touched = Array.isArray(obj["touched"])
      ? (obj["touched"] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [];
    return { session, lastActive: now, cooldowns, touched };
  } catch {
    return freshState(sessionId, now);
  }
}

function parseCooldowns(raw: unknown): Record<string, Cooldown> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, Cooldown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const entry = v as Record<string, unknown>;
    const unblockUntil = entry["unblockUntil"];
    const peerSet = entry["peerSet"];
    if (
      typeof unblockUntil !== "number" ||
      !Array.isArray(peerSet) ||
      !peerSet.every((p): p is string => typeof p === "string")
    ) {
      continue;
    }
    out[k] = { unblockUntil, peerSet: [...peerSet] };
  }
  return out;
}

function freshState(sessionId: string, now: number): State {
  return { session: sessionId, lastActive: now, cooldowns: {}, touched: [] };
}

function persistState(state: State): void {
  state.lastActive = Date.now();
  trimCooldowns(state);
  const file = stateFile(state.session);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state), "utf-8");
    renameSync(tmp, file);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] state write failed: ${msg}`);
  }
}

function trimCooldowns(state: State): void {
  const ids = Object.keys(state.cooldowns);
  if (ids.length <= MAX_ARTIFACTS) return;
  const sorted = ids
    .map((id) => {
      const entry = state.cooldowns[id];
      return { id, unblockUntil: entry ? entry.unblockUntil : 0 };
    })
    .sort((a, b) => b.unblockUntil - a.unblockUntil);
  const keep = new Set(sorted.slice(0, MAX_ARTIFACTS).map((s) => s.id));
  const pruned: typeof state.cooldowns = {};
  for (const id of ids) {
    if (keep.has(id)) {
      const entry = state.cooldowns[id];
      if (entry) pruned[id] = entry;
    }
  }
  state.cooldowns = pruned;
}

function logFailure(artifactPath: string, sessionId: string, err: Error): void {
  appendPresenceFailure({
    timestamp: new Date().toISOString(),
    sessionId,
    source: SOURCE,
    kind: "lock-timeout",
    artifactPath,
    detail: err.message,
  });
}

/**
 * Read the `touched` artifact list for a session — re-exported for the
 * presence CLI's `touch` subcommand so it operates on the sharded state
 * file written by this check. Returns `[]` on any read/parse failure, on
 * a cross-session mismatch, or when the supplied sessionId is invalid.
 */
export function readTouchedForSession(sessionId: string): string[] {
  if (!isValidSessionId(sessionId)) return [];
  const state = readStateForTesting(sessionId);
  return state ? state.touched : [];
}

/**
 * Exported for testing — reads the State from disk for the given session.
 * Returns null on invalid sessionId (swallows the `stateFile` throw so
 * tests/CLI consumers never see the defensive error).
 */
export function readStateForTesting(sessionId: string): State | null {
  if (!isValidSessionId(sessionId)) return null;
  try {
    const raw = readFileSync(stateFile(sessionId), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj["session"] !== sessionId) return null;
    const lastActive =
      typeof obj["lastActive"] === "number" ? obj["lastActive"] : 0;
    const cooldowns = parseCooldowns(obj["cooldowns"]);
    const touched = Array.isArray(obj["touched"])
      ? (obj["touched"] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [];
    return { session: sessionId, lastActive, cooldowns, touched };
  } catch {
    return null;
  }
}
