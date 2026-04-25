// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  activeSessionsDir,
  auditsDir,
  channelsDir,
  decisionLogsDir,
  handoffsDir,
  identityDir,
  memoriesDir,
  todosDir,
} from "../../src/shared/paths";

const ENV_KEYS = [
  "CLAUDE_CONDUCTOR_ROOT",
  "CLAUDE_CONDUCTOR_CHANNELS_DIR",
  "CLAUDE_CONDUCTOR_IDENTITY_DIR",
  "CLAUDE_CONDUCTOR_TODOS_DIR",
  "CLAUDE_CONDUCTOR_HANDOFFS_DIR",
  "CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR",
  "CLAUDE_CONDUCTOR_DECISION_LOGS_DIR",
  "CLAUDE_CONDUCTOR_AUDITS_DIR",
  "CLAUDE_CONDUCTOR_MEMORIES_DIR",
] as const;

const FALLBACK_ROOT = join(homedir(), ".claude", "conductor");

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
  });

  afterEach(() => {
    restoreEnv(snapshot);
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

  test("channelsDir returns ~/.claude/conductor/channels when neither env set (layer 3)", () => {
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

  test("memoriesDir returns ~/.claude/conductor/memories when neither env set (layer 3)", () => {
    expect(memoriesDir()).toBe(join(FALLBACK_ROOT, "memories"));
  });

  // Tests 7-9: decisionLogsDir precedence (hyphenated component name; default suffix is "decisions")
  test("decisionLogsDir returns per-component env when set (layer 1 wins)", () => {
    process.env["CLAUDE_CONDUCTOR_DECISION_LOGS_DIR"] = "/audit/decisions";
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/should-be-ignored";
    expect(decisionLogsDir()).toBe("/audit/decisions");
  });

  test("decisionLogsDir returns $CLAUDE_CONDUCTOR_ROOT/decisions when only root env set (layer 2)", () => {
    process.env["CLAUDE_CONDUCTOR_ROOT"] = "/opt/plugin";
    expect(decisionLogsDir()).toBe("/opt/plugin/decisions");
  });

  test("decisionLogsDir returns ~/.claude/conductor/decisions when neither env set (layer 3)", () => {
    expect(decisionLogsDir()).toBe(join(FALLBACK_ROOT, "decisions"));
  });
});

describe("paths — empty-string env values are treated as unset", () => {
  let snapshot: Map<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
  });

  afterEach(() => {
    restoreEnv(snapshot);
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
  });

  afterEach(() => {
    restoreEnv(snapshot);
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

  test("auditsDir resolves with default suffix 'audits'", () => {
    expect(auditsDir()).toBe(join(FALLBACK_ROOT, "audits"));
  });
});
