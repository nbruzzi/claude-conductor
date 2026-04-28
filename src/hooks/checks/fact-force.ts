// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Fact-forcing gate — deny first edit per file, demand investigation before retry.
 *
 * Adapted from gateguard-fact-force.js (affaan-m/everything-claude-code).
 * Key insight: blocking the first edit forces Claude to present facts (importers,
 * public API, user instruction) before retrying. The read-tracker check warms
 * state on Read/Edit/Write so the normal read→edit workflow bypasses the gate.
 *
 * Scope: only fires on code files (see CODE_FILES). Markdown/yaml/json/txt edits
 * skip the gate entirely — the fact prompts ("list importers", "public API")
 * are code-specific and produce noise on prose/data files.
 *
 * State management:
 * - JSON files at ~/.claude/logs/.fact-force-state-<sessionId>.json, sharded
 *   per session so two concurrent Claude instances never overwrite each
 *   other's checked-set. The earlier single-file layout paired `stateFile()`
 *   with a `session` field; when two sessions raced, every cross-session
 *   loadState returned freshState, wiping the peer's checked list — the
 *   shared lock only serialized byte-level writes, not this logical overwrite.
 *   Pattern mirrors session-collision-gate.ts's `stateFile(sessionId)` shard.
 * - Session isolation via hook input `session_id` (stable across subprocess
 *   hook invocations; replaces an earlier ppid-based scheme that churned
 *   per invocation and reset the checked set on every tool call).
 * - 30-minute inactivity timeout resets state
 * - Bounded at 200 entries, drops oldest on overflow
 *
 * Kill switch: if ~/.claude/fact-force-off exists, the check passes
 * unconditionally.
 *
 * Concurrency: mutual exclusion via the shared withLock helper in ../lock.ts.
 * LockTimeoutError is caught and treated as a soft-fail — we'd rather allow an
 * un-gated edit than block the user when infra lock contention gets weird.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { isValidSessionId } from "../../active-sessions/index.ts";
import { LockTimeoutError, withLock } from "../lock.ts";
import { resolveSessionIdOrNull } from "../session-id.ts";
import type { HookInput, HookResult } from "../types.ts";
import { block, pass } from "../types.ts";
import {
  isScopeMarker,
  scopeMarkerPath,
  type ScopeMarker,
} from "./fact-force-scope-store.ts";

const SOURCE = "fact-force";

// HOME-derived paths are computed per-call so test harnesses can override
// process.env.HOME at runtime (see src/__tests__/helpers/tmp-repo.ts). A
// module-level const would bind HOME at import time and defeat test isolation.
function home(): string {
  return process.env["HOME"] ?? "";
}
function stateDir(): string {
  return `${home()}/.claude/logs`;
}
function stateFile(sessionId: string): string {
  // Defense-in-depth: reject anything that isValidSessionId rejects. The
  // check()/markChecked() entry points already filter via resolveSessionIdOrNull,
  // but a phantom `.fact-force-state-undefined.json` observed in the wild
  // proves some path reached state-write with an unvalidated id. Throwing
  // here turns a silent landmine-file into a hook-visible error the next
  // time it occurs; callers fail-open on the throw.
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `${SOURCE}.stateFile: invalid sessionId (len=${String(sessionId).length})`,
    );
  }
  return `${stateDir()}/.fact-force-state-${sessionId}.json`;
}
function stateTmp(sessionId: string): string {
  return `${stateFile(sessionId)}.tmp`;
}
function lockDir(): string {
  return `${stateDir()}/.fact-force.lock`;
}
function killSwitch(): string {
  return `${home()}/.claude/fact-force-off`;
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 200;
/**
 * State files past this size are treated as corrupted (concurrent-writer race,
 * hand-edit, format drift) and reset to fresh. 2× margin over MAX_ENTRIES so
 * normal touchState trimming never fires the corruption path.
 */
const CORRUPTION_THRESHOLD = 2 * MAX_ENTRIES;

/**
 * Extensions where "list importers / public API" facts are semantically
 * meaningful. Non-code files (prose, configs, data) bypass the gate —
 * they have no importers and no public surface. Intentionally narrower
 * than auto-format's FORMATTABLE set (which includes markdown/json/yaml
 * for prettier).
 */
const CODE_FILES: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".lua",
]);

/**
 * Exported for tests. Functions / getter-properties read process.env.HOME on
 * access, so tests that swap HOME in beforeEach see fresh paths without
 * needing a re-import. `stateFile` is a method (not a getter) because state
 * files are sharded per session-id. Symmetric with branch-enforcement.ts's
 * INTERNAL export.
 */
export const INTERNAL = {
  SESSION_TIMEOUT_MS,
  MAX_ENTRIES,
  CORRUPTION_THRESHOLD,
  stateFile(sessionId: string): string {
    return stateFile(sessionId);
  },
  get LOCK_DIR() {
    return lockDir();
  },
  get KILL_SWITCH() {
    return killSwitch();
  },
};

/**
 * Exported for testing. True when the canonical path has a code-file
 * extension. Case-insensitive (`.TS` matches `.ts`) and rejects dotfiles
 * like `/a/.env` where the leading dot is the basename, not a separator.
 */
export function isCodeFile(canonical: string): boolean {
  const lastDot = canonical.lastIndexOf(".");
  const lastSlash = canonical.lastIndexOf("/");
  // Dotfile guard — require at least one character between the last slash
  // and the last dot so `/a/.env` (lastDot === lastSlash + 1) is rejected.
  if (lastDot <= lastSlash + 1) return false;
  return CODE_FILES.has(canonical.substring(lastDot).toLowerCase());
}

/**
 * Allowlist — workflow-owned paths where the fact-forcing gate adds friction
 * without value. These are paths written by skills (handoff, auto-memory) whose
 * specs already dictate what to create and where, so the "facts" would just
 * restate the skill. Arbitrary new files (source, tests, configs) remain gated.
 *
 * Uses Bun.Glob semantics: a single-star wildcard matches within one path
 * segment only (it does not cross slashes), so the memory-file pattern below
 * covers direct children of a project's memory folder but not nested
 * subdirectories.
 */
function allowlistPatterns(): readonly string[] {
  const h = home();
  return [
    `${h}/.claude/handoffs/HANDOFF_*.md`,
    `${h}/.claude/handoffs/SESSION_LOG.md`,
    `${h}/.claude/handoffs/LATEST.md`,
    `${h}/.claude/projects/*/memory/*.md`,
    `${h}/.claude-dotfiles/.session-summary`,
  ];
}

/** Exported for testing. Returns true if the canonical path bypasses the gate. */
export function isAllowlisted(canonical: string): boolean {
  return allowlistPatterns().some((pattern) =>
    new Bun.Glob(pattern).match(canonical),
  );
}

type State = {
  checked: string[];
  lastActive: number;
  session: string;
};

/**
 * PreToolUse check: block first edit per file, allow retry after investigation.
 */
export async function check(input: HookInput): Promise<HookResult> {
  const file = input.filePath;
  if (!file) return pass();

  try {
    if (existsSync(killSwitch())) return pass();
  } catch (err: unknown) {
    // Fail-open on FS error — a kill switch that stops working when the
    // filesystem misbehaves is the opposite of a kill switch. Breadcrumb
    // prefers stack (which starts with the message) so unusual FS errors
    // (EBUSY on Samba, EACCES from SELinux, etc.) are diagnosable without
    // a repro.
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
      `[${SOURCE}] kill-switch check failed, failing open: ${detail}`,
    );
    return pass();
  }

  const canonical = resolve(file);
  if (isAllowlisted(canonical)) return pass();
  if (!isCodeFile(canonical)) return pass();

  const sessionId = resolveSessionIdOrNull(input);
  if (!sessionId) return pass();
  // Belt-and-suspenders: resolver already validated, but re-check here so a
  // future refactor of the resolver cannot silently produce state files
  // such as `.fact-force-state-undefined.json`.
  if (!isValidSessionId(sessionId)) return pass();

  try {
    return withLock(
      () => {
        const state = loadState(sessionId);

        // Per-file warm-up check FIRST — the read→edit workflow (or a
        // previously-gated retry) should pass without burning scope budget.
        // Per RE-1: tryConsumeScope must only run for genuinely-new paths,
        // otherwise a 25-file scope can be silently exhausted by re-edits to
        // <10 distinct files.
        if (state.checked.includes(canonical)) {
          touchState(state);
          return pass();
        }

        // Scope-approval bypass: for genuinely-new paths, if the user has
        // pre-authorized a window of file operations via /fact-force-scope,
        // consume one budget unit and pass the gate. This eliminates per-file
        // fact-statement friction for planned batches without losing the audit
        // trail (the scope marker captures the reason and approver-time).
        if (tryConsumeScope(sessionId)) {
          // Warm the per-file state so a subsequent retry doesn't gate even
          // if the scope is later exhausted/expired.
          state.checked.push(canonical);
          touchState(state);
          return pass();
        }

        // No warm-up + no scope: gate. Mark as checked for the retry, then block.
        state.checked.push(canonical);
        touchState(state);

        const isNew = !existsSync(canonical);
        return block(
          SOURCE,
          isNew ? writeGateMsg(canonical) : editGateMsg(canonical),
        );
      },
      { lockDir: lockDir(), ownerTag: SOURCE },
    );
  } catch (err: unknown) {
    if (err instanceof LockTimeoutError) {
      // Fail-soft: infra lock contention shouldn't gate user edits.
      console.error(`[${SOURCE}] lock timeout — allowing edit without gate`);
      return pass();
    }
    throw err;
  }
}

/**
 * Atomically consume one budget unit from the session's scope marker, if one
 * exists with valid TTL and remaining budget.
 *
 * Called inside the fact-force lock (withLock) so reads + writes against the
 * marker file are serialized within a session. Cross-session: each session has
 * its own marker file, so no contention.
 *
 * Fail-closed: any error path returns false (no scope honored, gate fires
 * normally). The marker is deleted on expiry, exhaustion, corruption, or
 * sessionId mismatch.
 */
function tryConsumeScope(sessionId: string): boolean {
  const target = scopeMarkerPath(sessionId);
  if (!existsSync(target)) return false;
  // Sub-step 0.10 TS-1: predicate-validated read replaces unchecked cast.
  // Closes the NaN-loop risk: if files_consumed parses as NaN, the
  // `consumed >= max_files` comparison silently returns false and the marker
  // would loop forever returning false on every gate. Predicate now requires
  // Number.isInteger + non-negative + files_consumed <= max_files.
  let marker: ScopeMarker;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
    if (!isScopeMarker(parsed)) {
      console.error(`[${SOURCE}] scope marker invalid shape — deleting`);
      tryUnlink(target);
      return false;
    }
    marker = parsed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] scope marker unreadable — deleting: ${msg}`);
    tryUnlink(target);
    return false;
  }
  if (marker.sessionId !== sessionId) {
    // Defense-in-depth: marker is keyed by sessionId in path, but verify the
    // body too in case of a hand-edit or copy-paste mistake.
    console.error(`[${SOURCE}] scope marker sessionId mismatch — deleting`);
    tryUnlink(target);
    return false;
  }
  const expiresAt = Date.parse(marker.expires_at);
  // RE-3: closed-on-left half-open interval — treat boundary as expired.
  // Hook and CLI must use the same comparison; CLI's listScopes uses
  // `expiresAt > now` for the active-set, which is equivalent to
  // `now < expiresAt`, so expired ≡ `now >= expiresAt` here.
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    tryUnlink(target);
    return false;
  }
  if (marker.files_consumed >= marker.max_files) {
    tryUnlink(target);
    return false;
  }
  // Budget available — increment + persist atomically (write-tmp + rename).
  const next: ScopeMarker = {
    ...marker,
    files_consumed: marker.files_consumed + 1,
  };
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[${SOURCE}] scope marker write failed — falling through: ${msg}`,
    );
    tryUnlink(tmp);
    return false;
  }
  // If this consumption exhausted the budget, delete the marker so subsequent
  // calls don't waste a re-read on an exhausted marker.
  if (next.files_consumed >= next.max_files) {
    tryUnlink(target);
  }
  return true;
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore — already gone or unwritable
  }
}

/**
 * Warm the state for a file path — called by read-tracker on Read/Edit/Write.
 * This ensures the normal read→edit workflow never triggers the gate.
 *
 * No-ops when sessionId is null (no valid session context) or when the file
 * is not a code file (gate wouldn't fire anyway).
 *
 * Kill-switch asymmetry: markChecked does NOT honor the kill switch, while
 * check() does. This is intentional — warm-up is never user-visible (it
 * doesn't block, only records that the file has been read), so bypassing
 * it adds no operator value. The kill switch is a user-facing escape hatch
 * for when the gate misbehaves, and the gate is the only user-visible path.
 */
export function markChecked(filePath: string, sessionId: string | null): void {
  if (!sessionId) return;
  // Same defense-in-depth as check(): reject format-invalid ids before
  // they reach stateFile and produce phantom state files.
  if (!isValidSessionId(sessionId)) return;
  const canonical = resolve(filePath);
  if (!isCodeFile(canonical)) return;

  try {
    withLock(
      () => {
        const state = loadState(sessionId);
        if (!state.checked.includes(canonical)) {
          state.checked.push(canonical);
          touchState(state);
        }
        return pass(); // return value unused
      },
      { lockDir: lockDir(), ownerTag: SOURCE },
    );
  } catch (err: unknown) {
    // Fail-soft — warm-up failures must never break the tool pipeline.
    // LockTimeoutError is expected under contention; anything else is a
    // real anomaly (FS error, corrupted state) and deserves a breadcrumb.
    if (err instanceof LockTimeoutError) return;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] markChecked failed: ${msg}`);
  }
}

// ─── State management ───────────────────────────────────────────

function loadState(sessionId: string): State {
  const file = stateFile(sessionId);
  try {
    if (!existsSync(file)) return freshState(sessionId);

    const raw = readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return freshState(sessionId);

    const obj = parsed as Record<string, unknown>;
    const checkedRaw = obj["checked"];

    // Corruption guard: oversized arrays short-circuit BEFORE the element-wise
    // narrowing below. If we checked length after narrowing, a corrupted
    // non-string-array collapses to [] first and the length check never fires.
    if (Array.isArray(checkedRaw) && checkedRaw.length > CORRUPTION_THRESHOLD) {
      console.error(
        `[${SOURCE}] state file oversized (${checkedRaw.length} entries > ${CORRUPTION_THRESHOLD}), resetting`,
      );
      return freshState(sessionId);
    }

    const checked =
      Array.isArray(checkedRaw) &&
      checkedRaw.every((f): f is string => typeof f === "string")
        ? checkedRaw
        : [];
    const lastActive =
      typeof obj["lastActive"] === "number" ? obj["lastActive"] : 0;
    const session = typeof obj["session"] === "string" ? obj["session"] : "";

    // Session timeout or different session → fresh start
    if (session !== sessionId || Date.now() - lastActive > SESSION_TIMEOUT_MS) {
      return freshState(sessionId);
    }

    return { checked, lastActive, session };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] state load failed — resetting: ${msg}`);
    return freshState(sessionId);
  }
}

function freshState(sessionId: string): State {
  return { checked: [], lastActive: Date.now(), session: sessionId };
}

function touchState(state: State): void {
  state.lastActive = Date.now();

  // Bounded: drop oldest entries on overflow
  if (state.checked.length > MAX_ENTRIES) {
    state.checked = state.checked.slice(-MAX_ENTRIES);
  }

  const file = stateFile(state.session);
  const tmp = stateTmp(state.session);
  try {
    writeFileSync(tmp, JSON.stringify(state), "utf-8");
    renameSync(tmp, file);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${SOURCE}] state write failed: ${msg}`);
  }
}

// ─── Gate messages ──────────────────────────────────────────────

function editGateMsg(file: string): string {
  return [
    `[Fact-Forcing Gate] Before editing ${file}, present these facts:`,
    "1. List ALL files that import this file (use Grep)",
    "2. List the public functions/types affected by this change",
    "3. Quote the user's current instruction verbatim",
    "Present the facts, then retry the same edit.",
  ].join("\n");
}

function writeGateMsg(file: string): string {
  return [
    `[Fact-Forcing Gate] Before creating ${file}, present these facts:`,
    "1. Name the file(s) that will import/call this new file",
    "2. Confirm no existing file serves the same purpose (use Glob)",
    "3. Quote the user's current instruction verbatim",
    "Present the facts, then retry.",
  ].join("\n");
}
