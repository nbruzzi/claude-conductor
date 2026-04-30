// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, test } from "bun:test";

import {
  INTERNAL,
  parseDisableHooksEnv,
  type DisableHooksResult,
} from "../../src/shared/disable-hooks.ts";

// Test fixture: a representative registry shape spanning multiple events,
// blocking + non-blocking, and one cross-event hook.
const KNOWN_NAMES = new Set<string>([
  "destructive-cmd",
  "pre-commit",
  "channels-gc-reaper",
  "identity-injector",
  "task-coordinator",
  "teammate-idle-reminder",
  "session-presence-register",
  "session-presence-unregister",
  "active-channels-load",
  "channel-gc",
]);

const BLOCKING_NAMES = new Set<string>([
  "destructive-cmd",
  "pre-commit",
  "task-coordinator",
]);

const NAME_TO_EVENTS = new Map<string, readonly string[]>([
  ["destructive-cmd", ["pre-tool-use"]],
  ["pre-commit", ["pre-tool-use"]],
  ["task-coordinator", ["pre-tool-use"]],
  ["channels-gc-reaper", ["session-start"]],
  ["identity-injector", ["session-start"]],
  ["channel-gc", ["session-start"]],
  ["active-channels-load", ["session-start"]],
  ["session-presence-register", ["session-start"]],
  ["session-presence-unregister", ["stop"]],
  ["teammate-idle-reminder", ["user-prompt-submit"]],
]);

function call(
  raw: string | undefined,
  currentEvent: string,
): DisableHooksResult {
  return parseDisableHooksEnv(
    raw,
    KNOWN_NAMES,
    BLOCKING_NAMES,
    NAME_TO_EVENTS,
    currentEvent,
  );
}

describe("parseDisableHooksEnv — Path 1 (env unset/whitespace-only)", () => {
  test("undefined → empty result, no breadcrumbs, no stderrLines", () => {
    const r = call(undefined, "session-start");
    expect(r.disabled.size).toBe(0);
    expect(r.unknown).toEqual([]);
    expect(r.cross_event).toEqual([]);
    expect(r.stderrLines).toEqual([]);
    expect(r.breadcrumbs).toEqual([]);
  });

  test('empty string "" → empty result, no breadcrumbs', () => {
    const r = call("", "session-start");
    expect(r.disabled.size).toBe(0);
    expect(r.stderrLines).toEqual([]);
    expect(r.breadcrumbs).toEqual([]);
  });

  test("whitespace-only → empty result, no breadcrumbs (no env-set != misconfig)", () => {
    const r = call("   ", "session-start");
    expect(r.disabled.size).toBe(0);
    expect(r.stderrLines).toEqual([]);
    expect(r.breadcrumbs).toEqual([]);
  });
});

describe("parseDisableHooksEnv — Path 2 (empty-after-trim, fail-loud)", () => {
  test('comma-only "," → fail-loud message + breadcrumb', () => {
    const r = call(",", "session-start");
    expect(r.disabled.size).toBe(0);
    expect(r.stderrLines.length).toBe(1);
    expect(r.stderrLines[0]).toContain("empty disable list");
    expect(r.breadcrumbs.length).toBe(1);
    expect(r.breadcrumbs[0]?.detail).toContain("empty disable list");
  });

  test('multi-comma ",,," → fail-loud message + breadcrumb', () => {
    const r = call(",,,", "session-start");
    expect(r.stderrLines.length).toBe(1);
    expect(r.breadcrumbs.length).toBe(1);
  });

  test('whitespace-only-tokens " , , " → fail-loud message + breadcrumb', () => {
    const r = call(" , , ", "session-start");
    expect(r.stderrLines.length).toBe(1);
    expect(r.stderrLines[0]).toBe(INTERNAL.EMPTY_AFTER_TRIM_MSG);
    expect(r.breadcrumbs[0]?.detail).toBe(INTERNAL.EMPTY_AFTER_TRIM_MSG);
  });
});

describe("parseDisableHooksEnv — Path 3 (single valid name on current event)", () => {
  test("single non-blocking valid name → disabled, no warnings", () => {
    const r = call("channels-gc-reaper", "session-start");
    expect([...r.disabled]).toEqual(["channels-gc-reaper"]);
    expect(r.unknown).toEqual([]);
    expect(r.cross_event).toEqual([]);
    expect(r.stderrLines).toEqual([]);
    expect(r.breadcrumbs).toEqual([]);
  });

  test("single blocking valid name → disabled + louder warning + breadcrumb", () => {
    const r = call("destructive-cmd", "pre-tool-use");
    expect([...r.disabled]).toEqual(["destructive-cmd"]);
    expect(r.stderrLines.length).toBe(1);
    expect(r.stderrLines[0]).toContain("WARNING");
    expect(r.stderrLines[0]).toContain("BLOCKING");
    expect(r.stderrLines[0]).toContain("destructive-cmd");
    expect(r.stderrLines[0]).toContain("destructive-cmd-off");
    expect(r.stderrLines[0]).toContain("Logged to");
    expect(r.breadcrumbs.length).toBe(1);
    expect(r.breadcrumbs[0]?.detail).toContain("BLOCKING");
  });
});

describe("parseDisableHooksEnv — Path 3 (multiple valid names)", () => {
  test("multi-name, all on current event → all disabled", () => {
    const r = call(
      "channels-gc-reaper,identity-injector,channel-gc",
      "session-start",
    );
    expect(r.disabled.size).toBe(3);
    expect(r.disabled.has("channels-gc-reaper")).toBe(true);
    expect(r.disabled.has("identity-injector")).toBe(true);
    expect(r.disabled.has("channel-gc")).toBe(true);
  });

  test("dedup: a,b,a → single a in disabled", () => {
    const r = call(
      "channels-gc-reaper,identity-injector,channels-gc-reaper",
      "session-start",
    );
    expect(r.disabled.size).toBe(2);
    expect([...r.disabled].sort()).toEqual([
      "channels-gc-reaper",
      "identity-injector",
    ]);
  });
});

describe("parseDisableHooksEnv — whitespace + trailing-comma tolerance", () => {
  test('"a, b , c " (whitespace per token) → all disabled', () => {
    const r = call(" channels-gc-reaper , identity-injector ", "session-start");
    expect(r.disabled.size).toBe(2);
  });

  test('trailing comma "a,b," → all disabled, no fail-loud', () => {
    const r = call("channels-gc-reaper,identity-injector,", "session-start");
    expect(r.disabled.size).toBe(2);
    expect(r.stderrLines).toEqual([]);
  });

  test('mixed whitespace + trailing " a , b , " → all disabled', () => {
    const r = call(
      " channels-gc-reaper , identity-injector , ",
      "session-start",
    );
    expect(r.disabled.size).toBe(2);
    expect(r.stderrLines).toEqual([]);
  });
});

describe("parseDisableHooksEnv — unknown names + fuzzy match", () => {
  test("single unknown with Levenshtein-1 match → suggestion in stderrLines", () => {
    const r = call("channels-gc-reapr", "session-start");
    expect(r.disabled.size).toBe(0);
    expect(r.unknown).toEqual(["channels-gc-reapr"]);
    expect(r.stderrLines.length).toBeGreaterThan(0);
    const joined = r.stderrLines.join("\n");
    expect(joined).toContain("unknown hook name");
    expect(joined).toContain('"channels-gc-reapr"');
    expect(joined).toContain("Did you mean");
    expect(joined).toContain('"channels-gc-reaper"');
    expect(joined).toContain("fail-open");
    expect(r.breadcrumbs.length).toBe(1);
  });

  test("single unknown without Levenshtein-1 match → no suggestion line", () => {
    const r = call("totally-different-name", "session-start");
    expect(r.unknown).toEqual(["totally-different-name"]);
    const joined = r.stderrLines.join("\n");
    expect(joined).toContain("unknown hook name");
    expect(joined).not.toContain("Did you mean");
  });

  test("multiple unknowns enumerated in ONE pass with per-line suggestions", () => {
    const r = call(
      "channels-gc-reapr,identity-injectr,unknown-xyz",
      "session-start",
    );
    expect(r.unknown.length).toBe(3);
    const header = r.stderrLines[0] ?? "";
    expect(header).toContain("3 unknown hook names");
    expect(r.stderrLines.some((l) => l.includes("channels-gc-reapr"))).toBe(
      true,
    );
    expect(r.stderrLines.some((l) => l.includes("identity-injectr"))).toBe(
      true,
    );
    expect(r.stderrLines.some((l) => l.includes("unknown-xyz"))).toBe(true);
    expect(r.breadcrumbs.length).toBe(1);
  });

  test("mixed valid + unknown → partial-success applies valid, logs unknown", () => {
    const r = call("channels-gc-reaper,unknown-typo", "session-start");
    expect([...r.disabled]).toEqual(["channels-gc-reaper"]);
    expect(r.unknown).toEqual(["unknown-typo"]);
    expect(r.stderrLines.some((l) => l.includes("unknown-typo"))).toBe(true);
  });
});

describe("parseDisableHooksEnv — cross-event hint (Bravo Q4)", () => {
  test("name valid for different event → cross_event entry, NOT disabled", () => {
    const r = call("channels-gc-reaper", "pre-tool-use");
    expect(r.disabled.size).toBe(0);
    expect(r.unknown).toEqual([]);
    expect(r.cross_event.length).toBe(1);
    expect(r.cross_event[0]?.name).toBe("channels-gc-reaper");
    expect(r.cross_event[0]?.actual_events).toEqual(["session-start"]);
    const joined = r.stderrLines.join("\n");
    expect(joined).toContain("does not run on the current event");
    expect(joined).toContain('"pre-tool-use"');
    expect(joined).toContain("session-start");
    expect(joined).toContain("IF the env var is still set");
  });

  test("name on stop event, current event session-start → cross_event hint", () => {
    const r = call("session-presence-unregister", "session-start");
    expect(r.disabled.size).toBe(0);
    expect(r.cross_event.length).toBe(1);
    expect(r.cross_event[0]?.actual_events).toEqual(["stop"]);

    const r2 = call("session-presence-unregister", "stop");
    expect([...r2.disabled]).toEqual(["session-presence-unregister"]);
    expect(r2.cross_event).toEqual([]);
  });
});

describe("parseDisableHooksEnv — case sensitivity", () => {
  test("PascalCase name → unknown (NOT match against lowercase)", () => {
    const r = call("Destructive-Cmd", "pre-tool-use");
    expect(r.disabled.size).toBe(0);
    expect(r.unknown).toEqual(["Destructive-Cmd"]);
  });

  test("lowercase invariant → exact match", () => {
    const r = call("destructive-cmd", "pre-tool-use");
    expect([...r.disabled]).toEqual(["destructive-cmd"]);
  });
});

describe("parseDisableHooksEnv — combined error classes (partial-success)", () => {
  test("valid + unknown + cross-event → all reported on session-start", () => {
    const r = call(
      "channels-gc-reaper,destructive-cmd,typo-name",
      "session-start",
    );

    expect([...r.disabled]).toEqual(["channels-gc-reaper"]);
    expect(r.cross_event.length).toBe(1);
    expect(r.cross_event[0]?.name).toBe("destructive-cmd");
    expect(r.unknown).toEqual(["typo-name"]);

    expect(r.breadcrumbs.length).toBe(2);

    const joined = r.stderrLines.join("\n");
    expect(joined).toContain("unknown");
    expect(joined).toContain("does not run on the current event");
  });

  test("blocking + unknown on pre-tool-use → louder warning + unknown line + 2 breadcrumbs", () => {
    const r = call("destructive-cmd,unknown-xyz", "pre-tool-use");
    expect([...r.disabled]).toEqual(["destructive-cmd"]);
    expect(r.unknown).toEqual(["unknown-xyz"]);
    expect(r.breadcrumbs.length).toBe(2);
    const joined = r.stderrLines.join("\n");
    expect(joined).toContain("WARNING");
    expect(joined).toContain("BLOCKING");
    expect(joined).toContain("unknown");
  });
});

describe("parseDisableHooksEnv — INVARIANT (RE-NEW-2)", () => {
  test("non-empty raw with all-unknown produces unknown signal", () => {
    const r = call("totally-bogus-name", "session-start");
    const hasSignal =
      r.disabled.size > 0 ||
      r.unknown.length > 0 ||
      r.cross_event.length > 0 ||
      r.stderrLines.includes(INTERNAL.EMPTY_AFTER_TRIM_MSG);
    expect(hasSignal).toBe(true);
  });

  test("non-empty raw with all-cross-event produces cross-event signal", () => {
    const r = call("channels-gc-reaper", "pre-tool-use");
    const hasSignal =
      r.disabled.size > 0 ||
      r.unknown.length > 0 ||
      r.cross_event.length > 0 ||
      r.stderrLines.includes(INTERNAL.EMPTY_AFTER_TRIM_MSG);
    expect(hasSignal).toBe(true);
  });

  test("comma-only raw produces empty-after-trim signal", () => {
    const r = call(",,", "session-start");
    expect(r.stderrLines).toContain(INTERNAL.EMPTY_AFTER_TRIM_MSG);
  });
});

describe("INTERNAL.editDistance + fuzzyMatch helpers", () => {
  test("editDistance(a,a) = 0", () => {
    expect(INTERNAL.editDistance("foo", "foo")).toBe(0);
  });

  test("editDistance — single insertion = 1", () => {
    expect(INTERNAL.editDistance("foo", "fooo")).toBe(1);
  });

  test("editDistance — single deletion = 1", () => {
    expect(INTERNAL.editDistance("fooo", "foo")).toBe(1);
  });

  test("editDistance — single substitution = 1", () => {
    expect(INTERNAL.editDistance("foo", "fop")).toBe(1);
  });

  test("editDistance — distance > 1 returns ≥ 2 (early-exit floor)", () => {
    expect(INTERNAL.editDistance("foo", "bar")).toBeGreaterThanOrEqual(2);
  });

  test("fuzzyMatch finds Levenshtein-1 neighbor", () => {
    const known = new Set<string>(["channels-gc-reaper", "identity-injector"]);
    expect(INTERNAL.fuzzyMatch("channels-gc-reapr", known)).toBe(
      "channels-gc-reaper",
    );
  });

  test("fuzzyMatch returns null when no Levenshtein-1 neighbor", () => {
    const known = new Set<string>(["channels-gc-reaper", "identity-injector"]);
    expect(INTERNAL.fuzzyMatch("totally-different", known)).toBe(null);
  });
});
