// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for `assertWiringComplete` — the boot-time dual-registry
 * wiring assertion + its recovery-path env-var downgrade.
 *
 * Plan: ~/.claude/plans/wiring-recovery-otter.md (Plan v1.1 post Bravo
 * Lane B v1 fold).
 *
 * Coverage:
 *   - Existing fail-CLOSED behavior preserved (Direction A + B errors → exit 2).
 *   - Env-var downgrade: HOOK_REGISTRY_ASSERT=warn triggers warn-only.
 *   - Audit log entry shape + path + truncation behavior.
 *   - Fail-soft on audit-write failure (recovery proceeds).
 *   - Strict equality on env-var value (truthy non-"warn" → fail-CLOSED).
 *   - sessionId optional inclusion when CLAUDE_SESSION_ID set.
 *
 * Test process.exit pattern: direct assignment per plugin precedent at
 * `test/channels/cli-import-safety.test.ts:121-133`. Mock turns
 * `process.exit(N)` into a no-op that records N to a side-channel array;
 * tests assert exit-was-called via the array. NOT spyOn (Vitest pattern;
 * plugin uses direct assignment).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWiringComplete,
  INTERNAL,
} from "../../src/hooks/registry-assertion.ts";
import type { OrderEntry } from "../../src/hooks/registry.ts";
import { RegistryBuilder } from "../../src/hooks/registry.ts";
import type { HookEvent } from "../../src/hooks/types.ts";
import { HOOK_EVENTS, pass } from "../../src/hooks/types.ts";

let exitCalls: number[];
let originalExit: typeof process.exit;
let originalHome: string | undefined;
let originalEnvAssert: string | undefined;
let originalSessionId: string | undefined;
let stderrCalls: string[];
let originalConsoleError: typeof console.error;
let tmpHome: string;

beforeEach(() => {
  exitCalls = [];
  originalExit = process.exit;
  process.exit = ((code?: number): never => {
    exitCalls.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;

  originalHome = process.env["HOME"];
  originalEnvAssert = process.env[INTERNAL.RECOVERY_ENV_VAR_NAME];
  originalSessionId = process.env["CLAUDE_SESSION_ID"];

  tmpHome = mkdtempSync(join(tmpdir(), "registry-assertion-test-"));
  process.env["HOME"] = tmpHome;
  delete process.env[INTERNAL.RECOVERY_ENV_VAR_NAME];
  delete process.env["CLAUDE_SESSION_ID"];

  stderrCalls = [];
  originalConsoleError = console.error;
  // Replace console.error directly — Bun's console.error doesn't necessarily
  // route through process.stderr.write, so process.stderr.write mocking
  // misses these calls.
  console.error = (...args: unknown[]): void => {
    stderrCalls.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };

  INTERNAL.resetAppendFile();
});

afterEach(() => {
  process.exit = originalExit;
  console.error = originalConsoleError;

  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalEnvAssert === undefined)
    delete process.env[INTERNAL.RECOVERY_ENV_VAR_NAME];
  else process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] = originalEnvAssert;
  if (originalSessionId === undefined) delete process.env["CLAUDE_SESSION_ID"];
  else process.env["CLAUDE_SESSION_ID"] = originalSessionId;

  INTERNAL.resetAppendFile();
  rmSync(tmpHome, { recursive: true, force: true });
});

function emptyOrders(): Record<HookEvent, readonly OrderEntry[]> {
  return Object.fromEntries(
    HOOK_EVENTS.map((e) => [e, [] as readonly OrderEntry[]]),
  ) as Record<HookEvent, readonly OrderEntry[]>;
}

function buildEmptyRegistry() {
  return new RegistryBuilder().seal();
}

/**
 * Build a registry with a blocking check registered for `event` but with
 * NO entry in that event's ORDER — triggers Direction B "silent disarm risk".
 */
function buildBrokenBlockingRegistry(event: HookEvent) {
  const builder = new RegistryBuilder();
  builder.register(event, {
    name: "phantom-blocker",
    fn: async () => pass(),
    description: "Test fixture — blocking but unwired.",
    canBlock: true,
    profiles: ["minimal", "standard", "strict"],
  });
  return builder.seal();
}

describe("assertWiringComplete — happy path", () => {
  test("clean wiring (empty registry + empty orders) → silent pass, no exit", () => {
    assertWiringComplete(buildEmptyRegistry(), emptyOrders());
    expect(exitCalls).toEqual([]);
    expect(stderrCalls.join("")).toBe("");
  });
});

describe("assertWiringComplete — fail-CLOSED (env-var unset)", () => {
  test("Direction A: ORDER references unregistered check → exit 2", () => {
    const orders = emptyOrders();
    (orders as Record<string, readonly OrderEntry[]>)["session-start"] = [
      { name: "phantom-check", earlyReturn: "never" },
    ];
    assertWiringComplete(buildEmptyRegistry(), orders);
    expect(exitCalls).toEqual([2]);
    expect(stderrCalls.join("")).toContain(
      "ORDER references unregistered check: phantom-check",
    );
  });

  test("Direction B: blocking check NOT in ORDER → exit 2 with disarm message", () => {
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([2]);
    expect(stderrCalls.join("")).toContain(
      "blocking check NOT in ORDER (silent disarm risk): phantom-blocker",
    );
  });

  test("fail-CLOSED stderr surfaces recovery hint per LB2-INFO-1", () => {
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([2]);
    expect(stderrCalls.join("")).toContain(
      "HOOK_REGISTRY_ASSERT=warn for pre-launch one-shot recovery",
    );
  });
});

describe("assertWiringComplete — recovery downgrade (HOOK_REGISTRY_ASSERT=warn)", () => {
  test("env=warn + wiring error → no exit, stderr contains DOWNGRADED marker", () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] =
      INTERNAL.RECOVERY_ENV_VAR_VALUE;
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([]);
    expect(stderrCalls.join("")).toContain("DOWNGRADED to warn");
  });

  test("env=warn → audit log entry appended at correct path with correct shape", () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] =
      INTERNAL.RECOVERY_ENV_VAR_VALUE;
    // Pre-create the log dir so default appendFileSync succeeds.
    const logsDir = join(tmpHome, ".claude", "logs");
    Bun.spawnSync(["mkdir", "-p", logsDir]);

    assertWiringComplete(
      buildBrokenBlockingRegistry("session-start"),
      emptyOrders(),
    );

    const logPath = INTERNAL.recoveryLogPath();
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content) as {
      ts: string;
      event: string;
      pid: number;
      cwd: string;
      argv: string[];
      errors: string[];
    };
    expect(entry.event).toBe(INTERNAL.RECOVERY_EVENT_NAME);
    expect(typeof entry.pid).toBe("number");
    expect(typeof entry.cwd).toBe("string");
    const e = entry as { argv: unknown; errors: unknown; ts: string };
    expect(Array.isArray(e.argv)).toBe(true);
    expect(Array.isArray(e.errors)).toBe(true);
    const argv = e.argv as string[];
    const errors = e.errors as string[];
    expect(argv.length).toBeLessThanOrEqual(3);
    expect(errors.length).toBe(1);
    const firstError = errors[0];
    expect(firstError).toBeDefined();
    if (firstError !== undefined)
      expect(firstError).toContain("phantom-blocker");
    expect(Number.isFinite(Date.parse(e.ts))).toBe(true);
  });

  test("env=warn + CLAUDE_SESSION_ID set → audit entry includes sessionId", () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] =
      INTERNAL.RECOVERY_ENV_VAR_VALUE;
    process.env["CLAUDE_SESSION_ID"] = "test-session-12345";
    Bun.spawnSync(["mkdir", "-p", join(tmpHome, ".claude", "logs")]);

    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );

    const content = readFileSync(INTERNAL.recoveryLogPath(), "utf-8").trim();
    const entry = JSON.parse(content) as { sessionId?: string };
    expect(entry.sessionId).toBe("test-session-12345");
  });

  test("env=warn + log dir missing → fail-soft, no exit, stderr surfaces append-fail warning", () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] =
      INTERNAL.RECOVERY_ENV_VAR_VALUE;
    // Note: ~/.claude/logs/ does NOT exist — appendFileSync will throw ENOENT.
    // Per LB2-MIN-2 fold: NO mkdir-p; fail-soft.

    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );

    expect(exitCalls).toEqual([]); // recovery still proceeds
    const stderr = stderrCalls.join("");
    expect(stderr).toContain("audit log append failed");
    expect(stderr).toContain("DOWNGRADED to warn");
  });

  test("env=warn + appendFile injected to throw → fail-soft, no exit", () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] =
      INTERNAL.RECOVERY_ENV_VAR_VALUE;
    INTERNAL.setAppendFile(() => {
      throw new Error("EROFS: read-only file system");
    });

    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );

    expect(exitCalls).toEqual([]);
    expect(stderrCalls.join("")).toContain("EROFS");
  });
});

describe("assertWiringComplete — env-var strict equality", () => {
  test('env="true" (truthy non-"warn") → fail-CLOSED preserved', () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] = "true";
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([2]);
  });

  test('env="" (empty string) → fail-CLOSED preserved', () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] = "";
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([2]);
  });

  test('env="WARN" (wrong case) → fail-CLOSED preserved', () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] = "WARN";
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([2]);
  });
});

describe("assertWiringComplete — audit log line bounds", () => {
  test("argv truncated to last 3 elements regardless of process.argv length", () => {
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] =
      INTERNAL.RECOVERY_ENV_VAR_VALUE;
    const captured: string[] = [];
    INTERNAL.setAppendFile((_path, content) => {
      captured.push(content);
    });

    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );

    expect(captured.length).toBe(1);
    const first = captured[0];
    if (first === undefined) throw new Error("captured first entry undefined");
    const entry = JSON.parse(first.trim()) as { argv: string[] };
    expect(entry.argv.length).toBeLessThanOrEqual(3);
  });
});

// T4-X2 — file-based kill-switch recovery path.
// Hard-coded path constant; drift-check against INTERNAL.RECOVERY_KILL_SWITCH_BASENAME
// in the final test of this block (which depends on the impl landing).
const KILL_SWITCH_BASENAME = "hook-registry-assert-warn";

function killSwitchFilePath(): string {
  return join(tmpHome, ".claude", KILL_SWITCH_BASENAME);
}

function armKillSwitch(): void {
  Bun.spawnSync(["mkdir", "-p", join(tmpHome, ".claude")]);
  Bun.spawnSync(["touch", killSwitchFilePath()]);
}

function disarmKillSwitch(): void {
  try {
    rmSync(killSwitchFilePath());
  } catch {
    // ignore; file may not exist
  }
}

describe("assertWiringComplete — recovery via file kill-switch (T4-X2)", () => {
  test("file present + wiring broken → recovery-mode (no exit) + audit log trigger:'file'", () => {
    armKillSwitch();
    Bun.spawnSync(["mkdir", "-p", join(tmpHome, ".claude", "logs")]);

    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );

    expect(exitCalls).toEqual([]); // recovery triggered, NOT fail-CLOSED
    expect(stderrCalls.join("")).toContain("DOWNGRADED to warn");
    expect(stderrCalls.join("")).toContain(KILL_SWITCH_BASENAME);

    const content = readFileSync(INTERNAL.recoveryLogPath(), "utf-8").trim();
    const entry = JSON.parse(content) as { trigger?: string };
    expect(entry.trigger).toBe("file");
  });

  test("file present + env=warn (BOTH triggers) → audit log trigger:'env' (env precedence)", () => {
    armKillSwitch();
    process.env[INTERNAL.RECOVERY_ENV_VAR_NAME] =
      INTERNAL.RECOVERY_ENV_VAR_VALUE;
    Bun.spawnSync(["mkdir", "-p", join(tmpHome, ".claude", "logs")]);

    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );

    expect(exitCalls).toEqual([]);
    const content = readFileSync(INTERNAL.recoveryLogPath(), "utf-8").trim();
    const entry = JSON.parse(content) as { trigger?: string };
    expect(entry.trigger).toBe("env");
  });

  test("file absent + env unset + wiring broken → fail-CLOSED + error mentions BOTH bypass paths (L4-N1)", () => {
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );

    expect(exitCalls).toEqual([2]);
    const stderr = stderrCalls.join("");
    expect(stderr).toContain("HOOK_REGISTRY_ASSERT=warn"); // env path
    expect(stderr).toContain(KILL_SWITCH_BASENAME); // file path
  });

  test("file present + wiring CLEAN → no exit + armed-state visibility reminder (L3-N1)", () => {
    armKillSwitch();

    assertWiringComplete(buildEmptyRegistry(), emptyOrders());

    expect(exitCalls).toEqual([]);
    const stderr = stderrCalls.join("");
    expect(stderr).toContain(KILL_SWITCH_BASENAME);
    expect(stderr).toContain("still ARMED");
  });

  test("rm of kill-switch file restores fail-CLOSED", () => {
    armKillSwitch();
    Bun.spawnSync(["mkdir", "-p", join(tmpHome, ".claude", "logs")]);
    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([]); // armed → recovery

    // Reset captured state; disarm.
    exitCalls.length = 0;
    stderrCalls.length = 0;
    disarmKillSwitch();

    assertWiringComplete(
      buildBrokenBlockingRegistry("pre-tool-use"),
      emptyOrders(),
    );
    expect(exitCalls).toEqual([2]); // disarmed → fail-CLOSED restored
  });

  test("kill-switch path resolution respects live HOME env (per feedback-homedir-not-live-from-env)", () => {
    // tmpHome is the test's HOME override (per beforeEach). The kill-switch
    // helper reads process.env['HOME'] LIVE, not os.homedir() cached. Verify
    // by arming with the current tmpHome, then asserting the file resolves
    // at tmpHome (not whatever real-HOME might be).
    armKillSwitch();
    expect(existsSync(killSwitchFilePath())).toBe(true);
    expect(killSwitchFilePath().startsWith(tmpHome)).toBe(true);

    // Now invoke assertWiringComplete with clean wiring — should pick up
    // file at tmpHome path (not real ~/.claude/), trigger armed-state
    // visibility reminder against tmpHome path.
    assertWiringComplete(buildEmptyRegistry(), emptyOrders());
    expect(exitCalls).toEqual([]);
  });

  test("INTERNAL constants drift-check (post-impl assertion)", () => {
    // Hard-coded test constant + helper must match impl-side INTERNAL exports.
    // Failure here indicates path-constant drift between test fixture and impl.
    expect(INTERNAL.RECOVERY_KILL_SWITCH_BASENAME).toBe(KILL_SWITCH_BASENAME);
    expect(INTERNAL.killSwitchPath()).toBe(killSwitchFilePath());
  });
});
