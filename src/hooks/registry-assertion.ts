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
 * # Recovery path — `HOOK_REGISTRY_ASSERT=warn`
 *
 * When the env var `HOOK_REGISTRY_ASSERT` is set to `"warn"` AND wiring
 * errors are detected, the assertion DOWNGRADES from fail-CLOSED to
 * warn-only for that single dispatcher invocation. Allows the agent to
 * run recovery commands (e.g. `git checkout HEAD -- <broken-order-file>`)
 * without terminal intervention. Single-shot per command-line invocation;
 * the env var has no persistence semantics (process-scope only).
 *
 * Every recovery use is audit-logged to `~/.claude/logs/.substrate-events.log`
 * (JSONL append). Entry shape:
 *   { ts: <iso>, event: "registry-assertion-warn-mode", pid: <int>,
 *     cwd: <string>, argv: <string[3]>, errors: <string[]>, sessionId?: <string> }
 *
 * `argv` captures `process.argv.slice(-3)` (last 3 elements: typically
 * script + event + isolation-flag). Bounds line length below PIPE_BUF
 * atomic-write threshold (~4KB on POSIX); ensures concurrent dispatcher
 * invocations interleave at line boundaries, not mid-entry.
 *
 * **Anti-default warning:** DO NOT set `HOOK_REGISTRY_ASSERT=warn` in
 * shell rc files (`~/.zshrc`, `~/.bashrc`, etc.). The recovery path is
 * a security boundary; setting it as a default permanently weakens the
 * fail-CLOSED invariant. Use it only for the specific command that
 * needs to run while wiring is broken. Future versions may auto-detect
 * repeated use and escalate (per backlog).
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENTS, type HookEvent } from "./types.ts";
import type { OrderEntry, SealedRegistry } from "./registry.ts";

const RECOVERY_ENV_VAR_NAME = "HOOK_REGISTRY_ASSERT";
const RECOVERY_ENV_VAR_VALUE = "warn";
const RECOVERY_EVENT_NAME = "registry-assertion-warn-mode";

function recoveryLogPath(): string {
  return join(
    process.env["HOME"] ?? "",
    ".claude",
    "logs",
    ".substrate-events.log",
  );
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
  recoveryLogPath,
  /** Test-only: override the append-wrapper to simulate write failures. */
  setAppendFile(fn: AppendFile): void {
    appendFile = fn;
  },
  /** Test-only: restore the production append-wrapper. */
  resetAppendFile(): void {
    appendFile = defaultAppendFile;
  },
};

type RecoveryLogEntry = {
  ts: string;
  event: typeof RECOVERY_EVENT_NAME;
  pid: number;
  cwd: string;
  argv: string[];
  errors: string[];
  sessionId?: string;
};

function logRecoveryEvent(errors: readonly string[]): void {
  const entry: RecoveryLogEntry = {
    ts: new Date().toISOString(),
    event: RECOVERY_EVENT_NAME,
    pid: process.pid,
    cwd: process.cwd(),
    // Last 3 argv elements: typically [bun-runtime, script, ...args]; bounds
    // line length per LB2-MIN-4 to stay well below PIPE_BUF atomic threshold.
    argv: process.argv.slice(-3),
    errors: [...errors],
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

  // Recovery downgrade: env var === "warn" → audit log + warn + return.
  // Strict equality only; truthy non-"warn" values preserve fail-CLOSED.
  if (process.env[RECOVERY_ENV_VAR_NAME] === RECOVERY_ENV_VAR_VALUE) {
    logRecoveryEvent(errors);
    console.error(
      `[registry] wiring incomplete (DOWNGRADED to warn via ${RECOVERY_ENV_VAR_NAME}=${RECOVERY_ENV_VAR_VALUE}):\n  - ${errors.join("\n  - ")}`,
    );
    return;
  }

  // Default: fail-CLOSED.
  console.error(
    `[registry] wiring incomplete:\n  - ${errors.join("\n  - ")}\n` +
      `(set ${RECOVERY_ENV_VAR_NAME}=${RECOVERY_ENV_VAR_VALUE} for one-shot recovery — see registry-assertion.ts JSDoc)`,
  );
  failBoot();
}

/** Explicit `: never` so TypeScript narrows correctly at call sites. */
function failBoot(): never {
  process.exit(2);
}
