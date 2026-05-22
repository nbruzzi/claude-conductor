// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Boot-time wiring assertion for the dual-registry contract.
 *
 * Runs after RegistryBuilder.seal() and before any handler dispatches.
 *
 * Bidirectional check:
 *   A) Every ORDER entry resolves to a registered check (covers typos,
 *      missing register module calls, renamed checks).
 *   B) Every registered check with `canBlock: true` appears in some ORDER
 *      list for its event (security invariant — a blocking check that's
 *      registered but unwired is a silent disarm).
 *
 * Non-blocking checks may be deliberately registered-but-unwired (surfaced
 * via --list); blocking checks NEVER may be silently unwired.
 *
 * All errors accumulate before fail-CLOSED — operator gets one round-trip,
 * not N round-trips for N misses (per RE-9).
 *
 * Plugin-side: takes `allOrders` as a parameter. Dotfiles owns the ORDER
 * files (./handlers/*.order.ts) and constructs ALL_ORDERS at its own
 * dispatcher boot, then passes it in. This keeps Nick-specific handler
 * topology in dotfiles while the assertion logic lives in the plugin.
 *
 * # Recovery paths — `HOOK_REGISTRY_ASSERT=warn` env var OR `~/.claude/hook-registry-assert-warn` file kill-switch
 *
 * Two paths to DOWNGRADE the fail-CLOSED behavior to warn-only for a
 * single dispatcher invocation:
 *
 *   1. **Env var** (pre-launch only) — set `HOOK_REGISTRY_ASSERT=warn`
 *      BEFORE launching Claude Code. Per ~/CLAUDE.md "Hook bypass — env
 *      vars vs file kill-switches": PreToolUse hooks fire before bash
 *      evaluates the command, so env vars set inline (e.g.
 *      `HOOK_REGISTRY_ASSERT=warn claude code`) ARE visible if exported
 *      pre-launch; but env vars set INSIDE an already-wedged session are
 *      NOT visible to the dispatcher's process environment. Use this
 *      path when you can re-launch Claude Code with the env var set.
 *
 *   2. **File kill-switch** (in-session recovery; T4-X2 cycle 2026-05-22)
 *      — `touch ~/.claude/hook-registry-assert-warn`. The dispatcher
 *      checks for file presence at hook-fire time, post-tool-eval. This
 *      path is usable WHEN ALREADY WEDGED (the wedge condition itself —
 *      assertWiringComplete fail-CLOSED blocks PreToolUse, so the
 *      operator can't set env vars from within the session, but external
 *      shell `touch` works). Symmetric to existing file-based kill
 *      switches at `~/.claude/test-gate-on` (test-gate Stop) and
 *      `~/.claude/pre-commit-off` (pre-commit PreToolUse).
 *
 *   **Precedence (audit-log attribution):** when BOTH triggers fire,
 *   `trigger` is recorded as `"env"` — env-var path has documented
 *   precedence because the operator who set the env var explicitly
 *   intended that path. The file path is the in-session fallback when
 *   env-var was not pre-set. Both paths arm equivalently for the
 *   downgrade behavior; only the audit-log attribution differs.
 *
 * Every recovery use is audit-logged to `~/.claude/logs/.substrate-events.log`
 * (JSONL append). Entry shape:
 *   { ts: <iso>, event: "registry-assertion-warn-mode", pid: <int>,
 *     cwd: <string>, argv: <string[3]>, errors: <string[]>,
 *     trigger: "env" | "file", sessionId?: <string> }
 *
 * The `trigger` field (added T4-X2) distinguishes which recovery path
 * armed the downgrade. Existing log readers tolerate the new field per
 * JSONL forward-compat semantics; no current consumers exist outside
 * registry-assertion.ts (S3 primary-source-verified).
 *
 * `argv` captures `process.argv.slice(-3)` (last 3 elements: typically
 * script + event + isolation-flag). Bounds line length below PIPE_BUF
 * atomic-write threshold (~4KB on POSIX); ensures concurrent dispatcher
 * invocations interleave at line boundaries, not mid-entry.
 *
 * **Anti-default warning (env var):** DO NOT set `HOOK_REGISTRY_ASSERT=warn`
 * in shell rc files (`~/.zshrc`, `~/.bashrc`, etc.). The recovery path is
 * a security boundary; setting it as a default permanently weakens the
 * fail-CLOSED invariant. Use it only for the specific command that
 * needs to run while wiring is broken. Future versions may auto-detect
 * repeated use and escalate (per backlog).
 *
 * **Anti-default warning (file path):** DO NOT auto-create
 * `~/.claude/hook-registry-assert-warn` in shell rc files, dotfiles
 * provisioning scripts, or session startup hooks. The file-based recovery
 * path is a security boundary; creating it as a default permanently
 * weakens the fail-CLOSED invariant. Use it only for the specific
 * in-session recovery that needs to run while wiring is broken. The hook
 * emits an armed-state visibility reminder on EVERY assertWiringComplete
 * invocation while the file is present — operators should `rm` the file
 * as soon as recovery is complete.
 *
 * **Wedge-cohort cross-refs (T4-X2 motivation):**
 *   - `feedback-substrate-fix-self-mirror-mid-impl` — T4-X1 wedge incident
 *     2026-05-22 was the empirical motivation for the file-based recovery
 *     path (env var was already insufficient because the wedge blocked all
 *     PreToolUse, including the bash that could have set the env var).
 *   - `feedback-atomic-wiring-discipline` — substrate fixes must ship name
 *     + register + ORDER atomically.
 *   - `feedback-armed-bypass-runtime-visibility-discipline` (candidate) —
 *     persistent kill-switches require runtime-visible armed-state
 *     reminders to close the "forgot to rm" discipline gap.
 */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENTS, type HookEvent } from "./types.ts";
import type { OrderEntry, SealedRegistry } from "./registry.ts";

const RECOVERY_ENV_VAR_NAME = "HOOK_REGISTRY_ASSERT";
const RECOVERY_ENV_VAR_VALUE = "warn";
const RECOVERY_EVENT_NAME = "registry-assertion-warn-mode";
const RECOVERY_KILL_SWITCH_BASENAME = "hook-registry-assert-warn";

function recoveryLogPath(): string {
  return join(
    process.env["HOME"] ?? "",
    ".claude",
    "logs",
    ".substrate-events.log",
  );
}

/**
 * Resolve the file-based kill-switch path live from `process.env["HOME"]`
 * (NOT `os.homedir()` which caches per `feedback-homedir-not-live-from-env`).
 * Returns absolute path; existence not checked here — see
 * `isRecoveryKillSwitchPresent` for the presence check.
 */
function killSwitchPath(): string {
  return join(
    process.env["HOME"] ?? "",
    ".claude",
    RECOVERY_KILL_SWITCH_BASENAME,
  );
}

/**
 * Check for the kill-switch file presence. Fail-CLOSED on any FS error
 * (do not accidentally arm recovery on transient FS issues).
 */
function isRecoveryKillSwitchPresent(): boolean {
  try {
    return existsSync(killSwitchPath());
  } catch {
    return false;
  }
}

/**
 * Append wrapper isolated for test override per Lane B v1 LB2-MIN-3.
 * INTERNAL idiom mirrors `identity.ts` (sibling-parity).
 */
function defaultAppendFile(path: string, content: string): void {
  appendFileSync(path, content);
}

type AppendFile = (path: string, content: string) => void;

let appendFile: AppendFile = defaultAppendFile;

export const INTERNAL = {
  RECOVERY_ENV_VAR_NAME,
  RECOVERY_ENV_VAR_VALUE,
  RECOVERY_EVENT_NAME,
  RECOVERY_KILL_SWITCH_BASENAME,
  recoveryLogPath,
  killSwitchPath,
  isRecoveryKillSwitchPresent,
  /** Test-only: override the append-wrapper to simulate write failures. */
  setAppendFile(fn: AppendFile): void {
    appendFile = fn;
  },
  /** Test-only: restore the production append-wrapper. */
  resetAppendFile(): void {
    appendFile = defaultAppendFile;
  },
};

type RecoveryTrigger = "env" | "file";

type RecoveryLogEntry = {
  ts: string;
  event: typeof RECOVERY_EVENT_NAME;
  pid: number;
  cwd: string;
  argv: string[];
  errors: string[];
  trigger: RecoveryTrigger;
  sessionId?: string;
};

function logRecoveryEvent(
  errors: readonly string[],
  trigger: RecoveryTrigger,
): void {
  const entry: RecoveryLogEntry = {
    ts: new Date().toISOString(),
    event: RECOVERY_EVENT_NAME,
    pid: process.pid,
    cwd: process.cwd(),
    // Last 3 argv elements: typically [bun-runtime, script, ...args]; bounds
    // line length per LB2-MIN-4 to stay well below PIPE_BUF atomic threshold.
    argv: process.argv.slice(-3),
    errors: [...errors],
    trigger,
  };
  const sessionId = process.env["CLAUDE_SESSION_ID"];
  if (sessionId !== undefined && sessionId !== "") {
    entry.sessionId = sessionId;
  }
  try {
    appendFile(recoveryLogPath(), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // Audit log failure must NOT block recovery — observability is best-effort,
    // recovery is the load-bearing path. Surface to stderr per LB2-MIN-2 fold.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[registry] WARN: audit log append failed (${reason}); recovery proceeding without log entry`,
    );
  }
}

export function assertWiringComplete(
  registry: SealedRegistry,
  allOrders: Record<HookEvent, readonly OrderEntry[]>,
): void {
  // L3-N1 (T4-X2) — armed-state visibility. Fires on EVERY invocation when
  // the kill-switch file is present, regardless of wiring state. Closes the
  // "forgot to rm the file" discipline gap that no-auto-deletion opens.
  const killSwitchArmed = isRecoveryKillSwitchPresent();
  if (killSwitchArmed) {
    console.error(
      `[registry] WARN: kill-switch file ~/.claude/${RECOVERY_KILL_SWITCH_BASENAME} still ARMED — rm to disarm and restore fail-CLOSED.`,
    );
  }

  const errors: string[] = [];

  for (const event of HOOK_EVENTS) {
    const order = allOrders[event];
    const registered = registry.checksFor(event);

    // Direction A: every ORDER entry resolves to a registration.
    for (const entry of order) {
      if (!registered.has(entry.name)) {
        errors.push(
          `${event} ORDER references unregistered check: ${entry.name}`,
        );
      }
    }

    // Direction B: every blocking registration appears in this event's ORDER.
    const orderNames = new Set(order.map((e) => e.name));
    for (const reg of registered.values()) {
      if (reg.canBlock && !orderNames.has(reg.name)) {
        errors.push(
          `${event} blocking check NOT in ORDER (silent disarm risk): ${reg.name}`,
        );
      }
    }
  }

  if (errors.length === 0) return;

  // Recovery downgrade: env var === "warn" OR kill-switch file present →
  // audit log + warn + return. Env-var path has precedence for audit-log
  // attribution per JSDoc § "Precedence". Both paths arm equivalently.
  const envSet = process.env[RECOVERY_ENV_VAR_NAME] === RECOVERY_ENV_VAR_VALUE;
  if (envSet || killSwitchArmed) {
    const trigger: RecoveryTrigger = envSet ? "env" : "file";
    logRecoveryEvent(errors, trigger);
    const triggerLabel =
      trigger === "env"
        ? `${RECOVERY_ENV_VAR_NAME}=${RECOVERY_ENV_VAR_VALUE}`
        : `~/.claude/${RECOVERY_KILL_SWITCH_BASENAME} kill switch`;
    console.error(
      `[registry] wiring incomplete (DOWNGRADED to warn via ${triggerLabel}):\n  - ${errors.join("\n  - ")}`,
    );
    return;
  }

  // Default: fail-CLOSED. Error message mentions BOTH bypass paths per L4-N1.
  console.error(
    `[registry] wiring incomplete:\n  - ${errors.join("\n  - ")}\n` +
      `(set ${RECOVERY_ENV_VAR_NAME}=${RECOVERY_ENV_VAR_VALUE} for pre-launch one-shot recovery, ` +
      `or \`touch ~/.claude/${RECOVERY_KILL_SWITCH_BASENAME}\` for in-session recovery — see registry-assertion.ts JSDoc)`,
  );
  failBoot();
}

/** Explicit `: never` so TypeScript narrows correctly at call sites. */
function failBoot(): never {
  process.exit(2);
}
