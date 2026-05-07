// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * channels CLI tests — `join --as / --role / --force / --from-session` (P2).
 *
 * Plan: ~/.claude/plans/giggly-bouncing-spark.md (Plan v1.3 §change-list #8).
 *
 * Subprocess-based via `Bun.spawnSync` per Bravo MAJ-3 — verifies the actual
 * `bun run src/channels/cli.ts join --as Alpha` shell-out path that
 * slash-commands use, including:
 *
 *   - flag-parse errno propagation
 *   - exit-code shape (5 = ALREADY_HELD_SELF, 6 = STILL_ACTIVE, 7 = CAS_MISMATCH)
 *   - `--json` structured stderr format
 *
 * Mirrors test/channels/cli.test.ts:160-181 `runSlice5` pattern (subprocess
 * env-isolated sandbox + UUID-shaped CLAUDE_SESSION_ID for the strict-shape
 * gate at session-id-discovery boundary).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claimIdentityNamed } from "../../src/channels/identity.ts";
import { createChannel } from "../../src/channels/index.ts";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const CLI_PATH = join(PACKAGE_ROOT, "src", "channels", "cli.ts");

// UUID-shaped session ids — required by the strict-UUID gate at
// session-id-discovery boundary; mirrors cli.test.ts:41-42.
const SESSION_OLD = "00000000-0000-4000-8000-000000000001";
const SESSION_NEW = "00000000-0000-4000-8000-000000000002";

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "cli-join-as-"));
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = sandbox;
});

afterEach(() => {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function runJoin(
  args: readonly string[],
  sessionId: string = SESSION_NEW,
): RunResult {
  const result = Bun.spawnSync({
    cmd: ["bun", CLI_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: sandbox,
      CLAUDE_SESSION_ID: sessionId,
    },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

type JoinOutput = {
  metadata: { participants: readonly string[] };
  identity: {
    identity: string;
    role: string;
    joined_at: string;
    is_new_participant: boolean;
    takeover_displaced_session_id?: string | null;
  };
};

describe("channels CLI — join --as (P2 channel-as-flag plan)", () => {
  // ─── Happy path ────────────────────────────────────────────────

  it("happy path: join --as Alpha → exitCode 0, identity.identity='Alpha', identity.role='queue'", async () => {
    await createChannel({
      channelId: "c-cja-1",
      handoffId: "c-cja-1",
      sessionId: SESSION_NEW,
    });
    const result = runJoin(["join", "c-cja-1", "--as", "Alpha"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as JoinOutput;
    expect(parsed.identity.identity).toBe("Alpha");
    expect(parsed.identity.role).toBe("queue");
    expect(parsed.identity.is_new_participant).toBe(true);
    expect(parsed.identity.takeover_displaced_session_id).toBeUndefined();
    expect(parsed.metadata.participants).toContain(SESSION_NEW);
  });

  // ─── Flag-parser failures (exit non-zero, mostly category=ARGS) ────

  it("missing --as value → non-zero exit + stderr 'expected value, got missing value'", async () => {
    await createChannel({
      channelId: "c-cja-2",
      handoffId: "c-cja-2",
      sessionId: SESSION_NEW,
    });
    const result = runJoin(["join", "c-cja-2", "--as"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--as");
    expect(result.stderr).toContain("missing value");
  });

  it("invalid letter --as alpha (lowercase) → non-zero exit + stderr 'invalid identity'", async () => {
    await createChannel({
      channelId: "c-cja-3",
      handoffId: "c-cja-3",
      sessionId: SESSION_NEW,
    });
    const result = runJoin(["join", "c-cja-3", "--as", "alpha"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("invalid identity");
  });

  // ─── Optional flags ────────────────────────────────────────────

  it("--as Alpha --role pen → identity.role='pen'", async () => {
    await createChannel({
      channelId: "c-cja-4",
      handoffId: "c-cja-4",
      sessionId: SESSION_NEW,
    });
    const result = runJoin([
      "join",
      "c-cja-4",
      "--as",
      "Alpha",
      "--role",
      "pen",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as JoinOutput;
    expect(parsed.identity.role).toBe("pen");
  });

  // ─── Force takeover (Decision §4) ──────────────────────────────

  it("force takeover: prior holder + --as Alpha --force → exitCode 0, takeover_displaced_session_id set", async () => {
    await createChannel({
      channelId: "c-cja-5",
      handoffId: "c-cja-5",
      sessionId: SESSION_OLD,
    });
    await claimIdentityNamed({
      channelId: "c-cja-5",
      sessionId: SESSION_OLD,
      identity: "Alpha",
    });
    // SESSION_NEW takes over with --force.
    const result = runJoin(
      ["join", "c-cja-5", "--as", "Alpha", "--force"],
      SESSION_NEW,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as JoinOutput;
    expect(parsed.identity.identity).toBe("Alpha");
    expect(parsed.identity.takeover_displaced_session_id).toBe(SESSION_OLD);
  });

  // ─── CAS check (Decision §9) ───────────────────────────────────

  it("CAS pass: --as Alpha --force --from-session <holder-sid> → exitCode 0", async () => {
    await createChannel({
      channelId: "c-cja-6",
      handoffId: "c-cja-6",
      sessionId: SESSION_OLD,
    });
    await claimIdentityNamed({
      channelId: "c-cja-6",
      sessionId: SESSION_OLD,
      identity: "Alpha",
    });
    const result = runJoin(
      [
        "join",
        "c-cja-6",
        "--as",
        "Alpha",
        "--force",
        "--from-session",
        SESSION_OLD,
      ],
      SESSION_NEW,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as JoinOutput;
    expect(parsed.identity.takeover_displaced_session_id).toBe(SESSION_OLD);
  });

  it("CAS mismatch: --as Alpha --force --from-session <bogus> → exit 7, stderr 'CAS check failed'", async () => {
    await createChannel({
      channelId: "c-cja-7",
      handoffId: "c-cja-7",
      sessionId: SESSION_OLD,
    });
    await claimIdentityNamed({
      channelId: "c-cja-7",
      sessionId: SESSION_OLD,
      identity: "Alpha",
    });
    const bogusSession = "00000000-0000-4000-8000-000000000099";
    const result = runJoin(
      [
        "join",
        "c-cja-7",
        "--as",
        "Alpha",
        "--force",
        "--from-session",
        bogusSession,
      ],
      SESSION_NEW,
    );
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("CAS check failed");
  });

  // ─── Active-peer rejection (Decision §10) ──────────────────────

  it("die on active no-force: --as Alpha (held by other) → exit 6, stderr 'is held by session ... Pass --force'", async () => {
    await createChannel({
      channelId: "c-cja-8",
      handoffId: "c-cja-8",
      sessionId: SESSION_OLD,
    });
    await claimIdentityNamed({
      channelId: "c-cja-8",
      sessionId: SESSION_OLD,
      identity: "Alpha",
    });
    const result = runJoin(["join", "c-cja-8", "--as", "Alpha"], SESSION_NEW);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("is held by session");
    expect(result.stderr).toContain("Pass --force");
  });

  // ─── Same-session bifurcation (Decision §11) ───────────────────

  it("same-letter idempotent rejoin: same session re-runs --as Alpha → success, is_new_participant=false", async () => {
    await createChannel({
      channelId: "c-cja-9",
      handoffId: "c-cja-9",
      sessionId: SESSION_NEW,
    });
    // Initial claim via library.
    await claimIdentityNamed({
      channelId: "c-cja-9",
      sessionId: SESSION_NEW,
      identity: "Alpha",
    });
    // Re-run via CLI subprocess — should be idempotent rejoin per §11(a).
    const result = runJoin(["join", "c-cja-9", "--as", "Alpha"], SESSION_NEW);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as JoinOutput;
    expect(parsed.identity.identity).toBe("Alpha");
    expect(parsed.identity.is_new_participant).toBe(false);
  });

  it("same-session-different-letter: session holds Alpha, runs --as Bravo → exit 5, stderr 'already holds'", async () => {
    await createChannel({
      channelId: "c-cja-10",
      handoffId: "c-cja-10",
      sessionId: SESSION_NEW,
    });
    await claimIdentityNamed({
      channelId: "c-cja-10",
      sessionId: SESSION_NEW,
      identity: "Alpha",
    });
    // Same session tries different letter — §11(b) reject.
    const result = runJoin(["join", "c-cja-10", "--as", "Bravo"], SESSION_NEW);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("already holds identity 'Alpha'");
  });

  // ─── --from-session without --force (validation) ───────────────

  it("--from-session without --force → exit 2 (validation), stderr 'requires --force'", async () => {
    await createChannel({
      channelId: "c-cja-11",
      handoffId: "c-cja-11",
      sessionId: SESSION_NEW,
    });
    const result = runJoin(
      ["join", "c-cja-11", "--as", "Alpha", "--from-session", SESSION_OLD],
      SESSION_NEW,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requires --force");
  });

  // ─── --json structured-stderr parity ───────────────────────────

  it("--json parity: structured JSON stderr for IdentityActiveError (exit 6)", async () => {
    await createChannel({
      channelId: "c-cja-12",
      handoffId: "c-cja-12",
      sessionId: SESSION_OLD,
    });
    await claimIdentityNamed({
      channelId: "c-cja-12",
      sessionId: SESSION_OLD,
      identity: "Alpha",
    });
    const result = runJoin(
      ["join", "c-cja-12", "--as", "Alpha", "--json"],
      SESSION_NEW,
    );
    expect(result.exitCode).toBe(6);
    // First line of stderr is structured JSON {code, category, message, ...}.
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    const parsed = JSON.parse(firstLine) as {
      code: number;
      category: string;
      message: string;
    };
    expect(parsed.code).toBe(6);
    expect(typeof parsed.category).toBe("string");
    expect(parsed.message).toContain("is held by session");
  });
});
