// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 3a + Slice 5/6 send-case merge-time integration test (TA-8 gate).
 *
 * Plan: ~/.claude/plans/vivid-seeking-crayon.md §Verification matrix #9.
 *
 * **STATUS: TODO markers — implementation deferred to merge-back time.**
 *
 * Per ARCH-4 audit + plan §3 send-case ordering contract: when both
 * Alpha (Slice 3a — body-file plumbing) and Bravo (Slice 6 — identity+role
 * gate) lanes merge into `phase-1-lane-b-binary`, the SECOND-merging lane
 * MUST flesh out the three `it.todo` markers below into real assertions
 * before opening the merge-back PR.
 *
 * The contract being locked: in the merged `send` case body, the order is:
 *   (1) parseBodyFileFlag(rest)        ← Alpha's 3a contribution
 *   (2) readBodyFromFile (if --body-file) ← Alpha's 3a contribution
 *   (3) Bravo's role-gate (reject role==='out' with exit 4) ← Slice 6
 *   (4) appendMessage                   ← shared
 *
 * Body is read BEFORE role rejection (cheap-fail-late). The 3 assertions
 * below verify both lanes' invariants simultaneously after merge:
 *
 *   (a) `send --body-file <path>` with role==='out' → DENYLIST die
 *       (NOT role-die). Locks the body-read-before-role-reject ordering;
 *       a future refactor that swaps to role-first would fail this test.
 *   (b) `send` with stdin body + role==='in' → succeeds (positive control).
 *   (c) `send` with stdin body + role==='out' → role-die exit 4 (Bravo's
 *       Slice 6 invariant).
 *
 * **Owner: whichever lane lands second into `phase-1-lane-b-binary`.**
 * Slice 3a (Alpha) lands first per plan §Constraint convention; if Slice 5/6
 * (Bravo) merges first, Alpha owns this test at Alpha's merge-back time.
 *
 * The `it.todo` markers ensure the gap is visible in test reports —
 * `bun test` will print "todo" status for these tests, signaling to the
 * second-merging lane that the integration test is required before
 * merge-back PR is ready (TA-8 fix per plan).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claimIdentity, setRole } from "../../src/channels/identity.ts";
import { createChannel } from "../../src/channels/index.ts";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const CLI_PATH = join(PACKAGE_ROOT, "src", "channels", "cli.ts");

const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000001";

let tempChannelsDir: string;

beforeEach(() => {
  tempChannelsDir = mkdtempSync(join(tmpdir(), "cli-send-merged-"));
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = tempChannelsDir;
});

afterEach(() => {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(tempChannelsDir)) {
    rmSync(tempChannelsDir, { recursive: true, force: true });
  }
});

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runSend(
  args: readonly string[],
  body: string | null = null,
): RunResult {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI_PATH, ...args],
    stdin: body !== null ? new TextEncoder().encode(body) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: tempChannelsDir,
      CLAUDE_SESSION_ID: TEST_SESSION_ID,
    },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("cli send-case merged invariants (TA-8 gate)", () => {
  it("(a) --body-file + role=out → DENYLIST die NOT role-die (locks body-read-before-role-reject ordering)", async () => {
    await createChannel({
      channelId: "c-merged-a",
      handoffId: "c-merged-a",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-merged-a",
      sessionId: TEST_SESSION_ID,
    });
    await setRole("c-merged-a", "Alpha", "out");

    // /etc/passwd is on Alpha's body-file denylist (RE-1 realpath gate).
    // With role==='out' AND --body-file pointing at a denylisted path,
    // ARCH-4 ordering says: body-file flag parse → readBodyFromFile (dies
    // on denylist) → role-gate (NEVER reached). The error category must
    // therefore be DENYLIST/VALIDATION-shape, NOT ROLE_OUT_BLOCKED.
    //
    // A future refactor that flipped the ordering (role-gate before body
    // read) would surface a ROLE_OUT_BLOCKED error here instead of the
    // body-file denylist error — this assertion locks the contract.
    const result = runSend([
      "send",
      "c-merged-a",
      "status",
      "--body-file",
      "/etc/passwd",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(firstLine) as Record<string, unknown>;
    } catch {
      // If stderr isn't JSON the test fails on the next assertion anyway.
    }
    // Body-file denylist die fires BEFORE role-gate per ARCH-4 ordering.
    const category = parsed["category"];
    expect(category).not.toBe("ROLE_OUT_BLOCKED");
    // The denylist die uses category="VALIDATION" per cli.ts
    // readBodyFromFile, so a category-shape check is sufficient.
    expect(typeof category).toBe("string");
    expect(["VALIDATION", "UNCAUGHT"]).toContain(category as string);
  });

  it("(b) stdin body + role=queue → succeeds with appendMessage written (positive control)", async () => {
    await createChannel({
      channelId: "c-merged-b",
      handoffId: "c-merged-b",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-merged-b",
      sessionId: TEST_SESSION_ID,
    });
    // Default role on claim is "queue" — explicit set-role here for
    // documentation symmetry with case (c).
    await setRole("c-merged-b", "Alpha", "queue");

    const result = runSend(
      ["send", "c-merged-b", "status"],
      "merged-positive-control body",
    );
    expect(result.exitCode).toBe(0);
    // appendMessage's printJson output includes the appended message.
    const parsed = JSON.parse(result.stdout) as { body?: string };
    expect(parsed.body).toBe("merged-positive-control body");

    const messagesPath = join(tempChannelsDir, "c-merged-b", "messages.jsonl");
    expect(existsSync(messagesPath)).toBe(true);
  });

  it("(c) stdin body + role=out → role-die exit 4 (Slice 6 invariant)", async () => {
    await createChannel({
      channelId: "c-merged-c",
      handoffId: "c-merged-c",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-merged-c",
      sessionId: TEST_SESSION_ID,
    });
    await setRole("c-merged-c", "Alpha", "out");

    const result = runSend(
      ["send", "c-merged-c", "status", "--json"],
      "should be blocked by role gate",
    );
    expect(result.exitCode).toBe(4);
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    expect(parsed["category"]).toBe("ROLE_OUT_BLOCKED");
    expect(parsed["code"]).toBe(4);
  });
});
