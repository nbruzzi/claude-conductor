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
import { CHANNEL_KINDS, createChannel } from "../../src/channels/index.ts";

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

  it("(d) stdin body + role=out + kind=out → succeeds (Layer 3 carve-out per plan v4)", async () => {
    // Phase 4 Step A Layer 3 carve-out: an out-role peer can still
    // announce departure via kind=out. The role-gate at cli.ts blocks
    // ALL other kinds. This is the one allowed send from an out-role
    // peer — sibling to the auto-`out` extension of
    // `session-presence-unregister.ts` (Stop hook posts kind=out for
    // every channel the session touched). Manual kind=out is the
    // operator-driven path; auto-out is the Stop-hook path. Both must
    // succeed when role=out.
    await createChannel({
      channelId: "c-merged-d",
      handoffId: "c-merged-d",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-merged-d",
      sessionId: TEST_SESSION_ID,
    });
    await setRole("c-merged-d", "Alpha", "out");

    const result = runSend(
      ["send", "c-merged-d", "out"],
      "session ended; out-role peer announcing departure",
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { kind?: string };
    expect(parsed.kind).toBe("out");

    const messagesPath = join(tempChannelsDir, "c-merged-d", "messages.jsonl");
    expect(existsSync(messagesPath)).toBe(true);
  });

  it("(e) role=out + every non-out CHANNEL_KINDS member → role-die exit 4 (SSOT-iteration coverage per audit RE-MINOR-1 + ARCH-2 folds)", async () => {
    // Drift-catch: when CHANNEL_KINDS gains Layer 4 `digest` (or any
    // future kind), this loop auto-covers the carve-out's truth-table
    // for the new kind. Sibling-shape to message-roundtrip's
    // CHANNEL_KINDS iteration (Phase 0 ARCH-2 fold). If a future
    // refactor accidentally narrowed the carve-out (e.g. allowed
    // kind=ack through), this test fails for that specific kind by
    // name — easier-to-diagnose failure than a single status-only
    // assertion.
    await createChannel({
      channelId: "c-merged-e",
      handoffId: "c-merged-e",
      sessionId: TEST_SESSION_ID,
    });
    await claimIdentity({
      channelId: "c-merged-e",
      sessionId: TEST_SESSION_ID,
    });
    await setRole("c-merged-e", "Alpha", "out");

    for (const kind of CHANNEL_KINDS.filter((k) => k !== "out")) {
      const result = runSend(
        ["send", "c-merged-e", kind, "--json"],
        `body for ${kind} should not land`,
      );
      expect(result.exitCode).toBe(4);
      const firstLine = result.stderr.trim().split("\n")[0] ?? "";
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      expect(parsed["category"]).toBe("ROLE_OUT_BLOCKED");
      expect(parsed["code"]).toBe(4);
      // Error message embeds the rejected kind name (CLI-4 fold).
      const msg =
        typeof parsed["message"] === "string" ? parsed["message"] : "";
      expect(msg).toContain(`'${kind}'`);
    }
  });
});

describe("cli kinds verb (Layer 3 per-kind help)", () => {
  function runKinds() {
    return Bun.spawnSync({
      cmd: ["bun", CLI_PATH, "kinds"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_CONDUCTOR_CHANNELS_DIR: tempChannelsDir,
        CLAUDE_SESSION_ID: TEST_SESSION_ID,
      },
    });
  }

  it("prints per-kind reference + recommended body conventions + verification-budget pointer", () => {
    const proc = runKinds();
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);

    // Recommended body content (MINOR-1 fold) + worked examples
    // (audit ARCH-1 fold — plan v4 §256-267 verbatim).
    expect(stdout).toContain("`received` or `ack`");
    expect(stdout).toContain("`will fold MAJOR-1 by next prompt`");
    expect(stdout).toContain("`your turn on L3`");
    expect(stdout).toContain("`running tests; ~5 min`");
    expect(stdout).toContain("`session ended`");

    // Verification-budget pointer + Layer-4 deferred-doc breadcrumb.
    expect(stdout).toContain("verification-budget");
    expect(stdout).toContain(
      "docs/conventions/message-kinds-and-verification.md",
    );

    // Carve-out semantic explained — CLI-flag style (MINOR-2 fold).
    expect(stdout).toContain("role is 'out'");
    expect(stdout).toContain("kind=out");
  });

  it("KINDS_HELP enumerates every CHANNEL_KINDS member (SSOT-iteration drift catch per audit ARCH-2 fold)", () => {
    // Paired structural test: any future CHANNEL_KINDS extension that
    // forgets to extend KINDS_HELP fails here by the specific missing
    // kind name. Sibling-shape to channel-kinds-ssot.test.ts's
    // renderKindPrefix exhaustive test. Future Layer 4 `digest`
    // addition is the immediate forcing function.
    const proc = runKinds();
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    for (const k of CHANNEL_KINDS) {
      // KINDS_HELP format is `  <kind-padded-10> — <gloss>`. Match
      // start-of-line + padded-kind so substrings like "out" don't
      // false-match against the carve-out prose ("kind=out").
      expect(stdout).toContain(`  ${k.padEnd(10, " ")}—`);
    }
  });
});
