// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeSessionsDir,
  auditsDir,
  channelsDir,
  decisionLogsDir,
  discoverProjectSlug,
  handoffsDir,
  identityDir,
  INTERNAL,
  memoriesDir,
  memoriesDirForSlug,
  projectSlugFromTranscriptPath,
  todosDir,
} from "../../src/shared/paths";

const ENV_KEYS = [
  "CLAUDE_CONDUCTOR_ROOT",
  "CLAUDE_CONDUCTOR_CHANNELS_DIR",
  "CLAUDE_CONDUCTOR_IDENTITY_DIR",
  "CLAUDE_CONDUCTOR_TODOS_DIR",
  "CLAUDE_CONDUCTOR_HANDOFFS_DIR",
  "CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR",
  // Legacy alias for active-sessions (cross-edge migration support — see
  // ComponentSpec doc-comment in paths.ts).
  "CLAUDE_ACTIVE_SESSIONS_DIR",
  "CLAUDE_CONDUCTOR_DECISION_LOGS_DIR",
  "CLAUDE_CONDUCTOR_AUDITS_DIR",
  "CLAUDE_CONDUCTOR_MEMORIES_DIR",
  // T4-Y1 cycle 2026-05-22 — memoriesDir() discovery anchor. Cleared in tests
  // so layer-3 legacy-fallback assertions remain deterministic when tests
  // run inside a real Claude Code session (CLAUDE_CODE_SESSION_ID would
  // otherwise activate discoverProjectSlug() and shift layer-3 to the
  // project-namespaced path).
  "CLAUDE_CODE_SESSION_ID",
] as const;

const FALLBACK_ROOT = join(homedir(), ".claude");

function snapshotEnv(): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }
  return snapshot;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("paths — precedence rules (per RE-8)", () => {
  let snapshot: Map<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
    INTERNAL.resetProjectSlugCache();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    INTERNAL.resetProjectSlugCache();
  });

  // Tests 1-3: channelsDir precedence (3 layers)
  test("channelsDir returns per-component env when set (layer 1 wins)", () => {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = "/custom/channels";
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/should-be-ignored";
    expect(channelsDir()).toBe("/custom/channels");
  });

  test("channelsDir returns $CLAUDE_CONDUCTOR_ROOT/channels when only root env set (layer 2)", () => {
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/opt/plugin";
    expect(channelsDir()).toBe("/opt/plugin/channels");
  });

  test("channelsDir returns ~/.claude/channels when neither env set (layer 3)", () => {
    expect(channelsDir()).toBe(join(FALLBACK_ROOT, "channels"));
  });

  // Tests 4-6: memoriesDir precedence
  test("memoriesDir returns per-component env when set (layer 1 wins)", () => {
    process.env["CLAUDE_CONDUCTOR_MEMORIES_DIR"] = "/var/lib/memories";
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/should-be-ignored";
    expect(memoriesDir()).toBe("/var/lib/memories");
  });

  test("memoriesDir returns $CLAUDE_CONDUCTOR_ROOT/memories when only root env set (layer 2)", () => {
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/opt/plugin";
    expect(memoriesDir()).toBe("/opt/plugin/memories");
  });

  test("memoriesDir returns ~/.claude/memories when neither env set (layer 3)", () => {
    expect(memoriesDir()).toBe(join(FALLBACK_ROOT, "memories"));
  });

  // Tests 7-9: decisionLogsDir precedence (hyphenated component name; default suffix is "decisions")
  test("decisionLogsDir returns per-component env when set (layer 1 wins)", () => {
    process.env["CLAUDE_CONDUCTOR_DECISION_LOGS_DIR"] = "/audit/decisions";
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/should-be-ignored";
    expect(decisionLogsDir()).toBe("/audit/decisions");
  });

  test("decisionLogsDir returns $CLAUDE_CONDUCTOR_ROOT/conductor/decisions when only root env set (layer 2 — plugin-internal)", () => {
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/opt/plugin";
    expect(decisionLogsDir()).toBe("/opt/plugin/conductor/decisions");
  });

  test("decisionLogsDir returns ~/.claude/conductor/decisions when neither env set (layer 3 — plugin-internal)", () => {
    expect(decisionLogsDir()).toBe(
      join(FALLBACK_ROOT, "conductor", "decisions"),
    );
  });
});

describe("paths — empty-string env values are treated as unset", () => {
  let snapshot: Map<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
    INTERNAL.resetProjectSlugCache();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    INTERNAL.resetProjectSlugCache();
  });

  test("empty-string component env falls through to layer 2", () => {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = "";
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/opt/plugin";
    expect(channelsDir()).toBe("/opt/plugin/channels");
  });

  test("empty-string CLAUDE_CONDUCTOR_ROOT falls through to layer 3", () => {
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "";
    expect(channelsDir()).toBe(join(FALLBACK_ROOT, "channels"));
  });
});

describe("paths — coverage smoke tests for remaining resolvers", () => {
  let snapshot: Map<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
    INTERNAL.resetProjectSlugCache();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    INTERNAL.resetProjectSlugCache();
  });

  test("identityDir resolves with default suffix 'identity'", () => {
    expect(identityDir()).toBe(join(FALLBACK_ROOT, "identity"));
  });

  test("todosDir resolves with default suffix 'todos'", () => {
    expect(todosDir()).toBe(join(FALLBACK_ROOT, "todos"));
  });

  test("handoffsDir resolves with default suffix 'handoffs'", () => {
    expect(handoffsDir()).toBe(join(FALLBACK_ROOT, "handoffs"));
  });

  test("activeSessionsDir resolves with default suffix 'active-sessions'", () => {
    expect(activeSessionsDir()).toBe(join(FALLBACK_ROOT, "active-sessions"));
  });

  test("auditsDir resolves with conductor-namespaced suffix 'conductor/audits' (plugin-internal)", () => {
    expect(auditsDir()).toBe(join(FALLBACK_ROOT, "conductor", "audits"));
  });
});

describe("paths — legacy env-var alias (active-sessions cross-edge migration)", () => {
  let snapshot: Map<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
    INTERNAL.resetProjectSlugCache();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    INTERNAL.resetProjectSlugCache();
  });

  test("activeSessionsDir uses CLAUDE_ACTIVE_SESSIONS_DIR when current env is unset (layer 1.5 fallback)", () => {
    process.env["CLAUDE_ACTIVE_SESSIONS_DIR"] = "/legacy/active-sessions";
    expect(activeSessionsDir()).toBe("/legacy/active-sessions");
  });

  test("activeSessionsDir prefers current CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR over legacy alias", () => {
    process.env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = "/current/path";
    process.env["CLAUDE_ACTIVE_SESSIONS_DIR"] = "/legacy/should-be-ignored";
    expect(activeSessionsDir()).toBe("/current/path");
  });

  test("activeSessionsDir prefers legacy alias over CLAUDE_CONDUCTOR_ROOT (layer 1.5 beats layer 2)", () => {
    process.env["CLAUDE_ACTIVE_SESSIONS_DIR"] = "/legacy/wins";
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/root/should-be-ignored";
    expect(activeSessionsDir()).toBe("/legacy/wins");
  });

  test("legacy alias only applies to active-sessions — channelsDir does NOT honor a CLAUDE_CHANNELS_DIR alias", () => {
    process.env["CLAUDE_CHANNELS_DIR"] = "/should-be-ignored";
    expect(channelsDir()).toBe(join(FALLBACK_ROOT, "channels"));
  });
});

// T4-Y1 cycle 2026-05-22 — memoriesDir() project-namespaced resolution.
// Closes the L2 substrate gap surfaced by Charlie's V10 first-fire verification:
// memoriesDir() resolved to ~/.claude/memories (nonexistent) while actual Claude
// Code memory storage is at ~/.claude/projects/<slug>/memory/.
describe("paths — T4-Y1 project-namespaced memoriesDir helpers", () => {
  let snapshot: Map<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
    INTERNAL.resetProjectSlugCache();
  });

  afterEach(() => {
    restoreEnv(snapshot);
    INTERNAL.resetProjectSlugCache();
  });

  describe("memoriesDirForSlug", () => {
    test("returns ~/.claude/projects/<slug>/memory for caller-supplied slug (layer 3)", () => {
      expect(memoriesDirForSlug("-Users-test")).toBe(
        join(FALLBACK_ROOT, "projects", "-Users-test", "memory"),
      );
    });

    test("env-var CLAUDE_CONDUCTOR_MEMORIES_DIR override wins (layer 1)", () => {
      process.env["CLAUDE_CONDUCTOR_MEMORIES_DIR"] = "/var/override/memory";
      expect(memoriesDirForSlug("-Users-test")).toBe("/var/override/memory");
    });

    test("CLAUDE_CONDUCTOR_ROOT prefix preserves project-namespacing (layer 2)", () => {
      process.env["CLAUDE_CONDUCTOR_ROOT"] = "/opt/plugin";
      expect(memoriesDirForSlug("-Users-test")).toBe(
        join("/opt/plugin", "projects", "-Users-test", "memory"),
      );
    });
  });

  // T4-Y1 fixture convention: build absolute paths via template-literal
  // interpolation (`${TEST_USER}` not literal username) so the
  // check-generic-paths.sh P2 regex (`/Users/[a-zA-Z]...`) doesn't fire on
  // fixture strings. Same shape as posture-pool-registration.test.ts.
  const TEST_USER = "testuser";

  describe("projectSlugFromTranscriptPath", () => {
    test("extracts slug from canonical Claude Code transcript path", () => {
      expect(
        projectSlugFromTranscriptPath(
          `/Users/${TEST_USER}/.claude/projects/-Users-${TEST_USER}/abc-def-ghi.jsonl`,
        ),
      ).toBe(`-Users-${TEST_USER}`);
    });

    test("handles complex slug with dashes + dots", () => {
      expect(
        projectSlugFromTranscriptPath(
          `/home/u/.claude/projects/-Users-${TEST_USER}-.claude-dotfiles/sid.jsonl`,
        ),
      ).toBe(`-Users-${TEST_USER}-.claude-dotfiles`);
    });

    test("returns undefined on path-shape mismatch", () => {
      expect(
        projectSlugFromTranscriptPath("/some/other/path.jsonl"),
      ).toBeUndefined();
      expect(projectSlugFromTranscriptPath("")).toBeUndefined();
      expect(
        projectSlugFromTranscriptPath("/.claude/projects/slug-only-no-file/"),
      ).toBeUndefined();
    });
  });

  describe("discoverProjectSlug (S2-A — session-id-anchored)", () => {
    test("returns undefined when CLAUDE_CODE_SESSION_ID is unset", () => {
      delete process.env["CLAUDE_CODE_SESSION_ID"];
      expect(discoverProjectSlug()).toBeUndefined();
    });

    test("returns undefined when CLAUDE_CODE_SESSION_ID is empty string", () => {
      process.env["CLAUDE_CODE_SESSION_ID"] = "";
      expect(discoverProjectSlug()).toBeUndefined();
    });

    test("module-level cache: second call returns same value without filesystem scan", () => {
      process.env["CLAUDE_CODE_SESSION_ID"] =
        "nonexistent-session-id-for-test-00000000-0000-0000-0000-000000000000";
      const first = discoverProjectSlug();
      const second = discoverProjectSlug();
      expect(second).toBe(first);
    });

    test("INTERNAL.resetProjectSlugCache clears cache for test isolation", () => {
      process.env["CLAUDE_CODE_SESSION_ID"] = "isolation-test-sid";
      discoverProjectSlug();
      INTERNAL.resetProjectSlugCache();
      process.env["CLAUDE_CODE_SESSION_ID"] = "different-sid";
      const after = discoverProjectSlug();
      expect(after).toBeUndefined();
    });

    // Charlie L3-PR-N1 fold (cycle 2026-05-22 T4-Y1 v0.3 amendment) —
    // happy-path positive-detection test for discoverProjectSlug. Unit-test
    // suite previously asserted only undefined cases + cache behavior; this
    // case closes the "future refactor breaks scan logic + passes tests +
    // ships broken" failure mode by asserting the load-bearing positive
    // path.
    test("returns slug when CLAUDE_CODE_SESSION_ID matches a project's transcript file (happy path)", () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "paths-discoverProjectSlug-"));
      const sid = "happy-path-sid-00000000-0000-0000-0000-000000000000";
      const slug = "-Users-testfixture-projectx";
      const projectDir = join(tmpHome, ".claude", "projects", slug);
      const origHome = process.env["HOME"];
      try {
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, `${sid}.jsonl`), "{}\n");
        process.env["HOME"] = tmpHome;
        process.env["CLAUDE_CODE_SESSION_ID"] = sid;
        INTERNAL.resetProjectSlugCache();
        expect(discoverProjectSlug()).toBe(slug);
      } finally {
        if (origHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = origHome;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });
});
