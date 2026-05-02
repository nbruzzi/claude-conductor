// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER 2 ci-verification-gate tests — Stop-time sentinel-aware verification.
 *
 * Each test builds:
 *   - 0..N sentinel files in tmpHome/.claude/.flags/ci-verification-armed-<sid>-<ts>.json
 *   - A synthetic transcript JSONL string written to tmpHome/transcript.jsonl
 *   - HookInput with transcriptPath + raw.session_id
 *
 * Coverage per ~/.claude/plans/typed-sleeping-snowglobe.md:
 *   - happy path (sentinel + claim + evidence exit-0)              → pass + cleanup
 *   - unverified (sentinel + claim + no evidence)                  → block
 *   - CI-red evidence (gh exit 1)                                  → block
 *   - past-tense without proximity                                  → no block
 *   - first-person claim                                            → claim detected
 *   - proximity to PR# / SHA                                        → claim detected
 *   - fenced code block claim                                       → no block
 *   - tool_result echo (claim word in user content, not assistant)  → no block
 *   - kill switches                                                 → pass
 *   - no sessionId / no transcriptPath / ENOENT / malformed line    → pass
 *   - push-without-claim warn                                       → warn
 *   - multiple violations                                           → block message lists all
 *   - INTERNAL helpers (extractClaim, stripFencedCode, readSentinels)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  check,
  INTERNAL,
} from "../../../src/hooks/checks/ci-verification-gate.ts";
import { DEFAULT_DISPATCH, type HookInput } from "../../../src/hooks/types.ts";

const SID = "44444444-5555-4666-8777-888888888888";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ci-gate-"));
  mkdirSync(join(tmpHome, ".claude", ".flags"), { recursive: true });
  mkdirSync(join(tmpHome, ".claude", ".cache"), { recursive: true });
  prevHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeSentinel(opts: {
  pushTs: string;
  command?: string;
  branchHint?: string;
}): string {
  const safe = opts.pushTs.replace(/[:.]/gu, "-");
  const path = join(
    tmpHome,
    ".claude",
    ".flags",
    `ci-verification-armed-${SID}-${safe}.json`,
  );
  const data = {
    push_ts: opts.pushTs,
    command_preview: opts.command ?? "git push",
    sessionId: SID,
    claimed: false,
    evidenced: false,
    ...(opts.branchHint !== undefined ? { branchHint: opts.branchHint } : {}),
  };
  writeFileSync(path, JSON.stringify(data));
  return path;
}

function sentinelCount(): number {
  const dir = join(tmpHome, ".claude", ".flags");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) =>
    f.startsWith(`ci-verification-armed-${SID}-`),
  ).length;
}

type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: { command: string } };

function assistantTurn(
  ts: string,
  blocks: AssistantBlock[],
): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: ts,
    sessionId: SID,
    message: {
      role: "assistant",
      content: blocks,
    },
  };
}

function userToolResultTurn(
  ts: string,
  toolUseId: string,
  isError: boolean,
): Record<string, unknown> {
  return {
    type: "user",
    timestamp: ts,
    sessionId: SID,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "<output>",
          is_error: isError,
        },
      ],
    },
  };
}

function writeTranscript(records: Record<string, unknown>[]): string {
  const path = join(tmpHome, "transcript.jsonl");
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(path, text);
  return path;
}

function inputFor(opts: {
  sessionId?: string | undefined;
  transcriptPath?: string | undefined;
}): HookInput {
  const raw: Record<string, unknown> =
    opts.sessionId === undefined ? {} : { session_id: opts.sessionId };
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: opts.transcriptPath,
    raw,
    dispatch: DEFAULT_DISPATCH,
  };
}

describe("ci-verification-gate", () => {
  describe("happy path", () => {
    it("sentinel + claim + gh evidence exit-0 → pass + sentinel cleaned up", async () => {
      writeSentinel({
        pushTs: "2026-05-02T10:00:00Z",
        command: "git push origin main",
      });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:01:00Z", [
          {
            type: "tool_use",
            id: "tu1",
            name: "Bash",
            input: { command: "gh pr checks 42 --watch" },
          },
        ]),
        userToolResultTurn("2026-05-02T10:02:00Z", "tu1", false),
        assistantTurn("2026-05-02T10:03:00Z", [
          {
            type: "text",
            text: "I shipped PR #42, run id 12345, conclusion success.",
          },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(sentinelCount()).toBe(0);
    });
  });

  describe("unverified claim → block", () => {
    it("sentinel + first-person claim + no evidence → block", async () => {
      writeSentinel({
        pushTs: "2026-05-02T10:00:00Z",
        command: "git push origin main",
      });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "I shipped PR #42 — all done." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(2);
      expect(result.source).toBe("ci-verification-gate");
      expect(result.stdout).toContain("CI Verification Gate");
      expect(result.stdout).toContain("Stop blocked");
      expect(result.stdout).toContain("git push origin main");
      expect(result.stdout).toContain("I shipped PR #42");
      expect(result.stdout).toContain("gh pr checks");
      expect(result.stdout).toContain(`ci-verification-gate-disabled-${SID}`);
      expect(sentinelCount()).toBe(1);
    });

    it("CI-red evidence (gh exit 1) does NOT count as evidence → block", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:01:00Z", [
          {
            type: "tool_use",
            id: "tu1",
            name: "Bash",
            input: { command: "gh pr checks 42" },
          },
        ]),
        userToolResultTurn("2026-05-02T10:02:00Z", "tu1", true),
        assistantTurn("2026-05-02T10:03:00Z", [
          { type: "text", text: "I shipped PR #42 anyway." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(2);
    });

    it("multiple violations → block message lists each", async () => {
      writeSentinel({
        pushTs: "2026-05-02T10:00:00Z",
        command: "git push origin a",
      });
      writeSentinel({
        pushTs: "2026-05-02T11:00:00Z",
        command: "git push origin b",
      });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:30:00Z", [
          { type: "text", text: "I shipped PR #1 — main." },
        ]),
        assistantTurn("2026-05-02T11:30:00Z", [
          { type: "text", text: "I shipped PR #2 — also done." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("[1]");
      expect(result.stdout).toContain("[2]");
      expect(result.stdout).toContain("git push origin a");
      expect(result.stdout).toContain("git push origin b");
    });
  });

  describe("ClaimEvent narrowing", () => {
    it("past-tense without first-person or proximity → no block", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          {
            type: "text",
            text: "Long ago that auth feature shipped, but anyway...",
          },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
    });

    it("first-person claim WITHOUT proximity is detected", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "I just shipped that change." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(2);
    });

    it("proximity to SHA WITHOUT first-person is detected", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "Merged commit abc1234 already." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(2);
    });

    it("claim word inside fenced code block is excluded", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          {
            type: "text",
            text: "Here's some code:\n```bash\necho 'I shipped PR #42'\n```\nThat's it.",
          },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
    });

    it("claim in user-turn tool_result content is NOT counted", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        userToolResultTurn("2026-05-02T10:05:00Z", "tu1", false),
        {
          type: "user",
          timestamp: "2026-05-02T10:06:00Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu99",
                content: "I shipped PR #42 (echoed in tool output)",
                is_error: false,
              },
            ],
          },
        },
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("kill switches", () => {
    it("session-scoped kill-switch → pass", async () => {
      const ks = INTERNAL.killSwitchPaths(SID);
      if (ks.session === undefined) throw new Error("expected");
      writeFileSync(ks.session, "");
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "I shipped PR #42." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
    });

    it("global kill-switch → pass", async () => {
      const ks = INTERNAL.killSwitchPaths(SID);
      writeFileSync(ks.global, "");
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "I shipped PR #42." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("defensive paths", () => {
    it("no sessionId → pass", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const result = await check(
        inputFor({ sessionId: undefined, transcriptPath: "/tmp/anything" }),
      );
      expect(result.exitCode).toBe(0);
    });

    it("no transcriptPath → pass", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: undefined }),
      );
      expect(result.exitCode).toBe(0);
    });

    it("transcript missing (ENOENT) → pass", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const result = await check(
        inputFor({
          sessionId: SID,
          transcriptPath: "/tmp/does-not-exist-cig.jsonl",
        }),
      );
      expect(result.exitCode).toBe(0);
    });

    it("malformed JSONL line is skipped, scan continues", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const path = join(tmpHome, "transcript.jsonl");
      writeFileSync(
        path,
        [
          "this is not json",
          JSON.stringify(
            assistantTurn("2026-05-02T10:05:00Z", [
              { type: "text", text: "I shipped PR #42." },
            ]),
          ),
        ].join("\n"),
      );
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: path }),
      );
      expect(result.exitCode).toBe(2);
    });
  });

  describe("push-without-claim warn", () => {
    it("sentinel exists but no claim and no evidence → warn", async () => {
      writeSentinel({
        pushTs: "2026-05-02T10:00:00Z",
        command: "git push origin feature-x",
      });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "Now let me look at the next step." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "push(es) detected without a shipped-claim",
      );
      expect(result.stdout).toContain("git push origin feature-x");
    });
  });

  describe("mtime-GC for stale sentinels", () => {
    it("reaps any sentinel >24h old regardless of state or session-id", async () => {
      // Stale sentinel from a different session, never resolved (claimed=false)
      const stalePath = join(
        tmpHome,
        ".claude",
        ".flags",
        "ci-verification-armed-99999999-aaaa-4bbb-8ccc-dddddddddddd-2026-04-01T00-00-00-000Z.json",
      );
      writeFileSync(
        stalePath,
        JSON.stringify({
          push_ts: "2026-04-01T00:00:00Z",
          command_preview: "git push origin old-branch",
          sessionId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          claimed: false,
          evidenced: false,
        }),
      );
      // Backdate mtime to 25h ago
      const past = Date.now() - 25 * 60 * 60 * 1000;
      utimesSync(stalePath, past / 1000, past / 1000);

      // Run TIER 2 (no transcript matches needed; just trigger cleanup pass)
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "Just doing some other work." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
      expect(existsSync(stalePath)).toBe(false); // reaped
    });

    it("preserves sentinels < 24h old even if unresolved", async () => {
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z" });
      const transcript = writeTranscript([
        assistantTurn("2026-05-02T10:05:00Z", [
          { type: "text", text: "Just doing some other work." },
        ]),
      ]);
      const result = await check(
        inputFor({ sessionId: SID, transcriptPath: transcript }),
      );
      expect(result.exitCode).toBe(0);
      // Sentinel still present (push-without-claim warn fired but sentinel preserved)
      expect(sentinelCount()).toBe(1);
    });
  });

  describe("INTERNAL helpers", () => {
    it("stripFencedCode removes fenced blocks", () => {
      const input = "before\n```\nfenced content\n```\nafter";
      expect(INTERNAL.stripFencedCode(input)).toBe("before\nafter");
    });

    it("extractClaim returns undefined for non-claim text", () => {
      expect(INTERNAL.extractClaim("just chatting", "ts", 0)).toBeUndefined();
    });

    it("extractClaim returns claim for first-person + claim word", () => {
      const c = INTERNAL.extractClaim("I shipped that PR", "ts", 5);
      expect(c).not.toBeUndefined();
      if (c === undefined) throw new Error("unreachable");
      expect(c.claimWord).toBe("shipped");
      expect(c.turnIdx).toBe(5);
    });

    it("extractClaim returns claim for proximity to PR#", () => {
      const c = INTERNAL.extractClaim(
        "PR #42 has been merged successfully",
        "ts",
        3,
      );
      expect(c).not.toBeUndefined();
    });

    it("extractClaim ignores fenced claim", () => {
      const c = INTERNAL.extractClaim(
        "Look:\n```\nI shipped PR #42\n```\nDone reviewing.",
        "ts",
        0,
      );
      expect(c).toBeUndefined();
    });

    it("readSentinels returns sorted-by-push_ts", () => {
      writeSentinel({ pushTs: "2026-05-02T11:00:00Z", command: "second" });
      writeSentinel({ pushTs: "2026-05-02T10:00:00Z", command: "first" });
      const sentinels = INTERNAL.readSentinels(SID);
      expect(sentinels.length).toBe(2);
      expect(sentinels[0]?.data.push_ts).toBe("2026-05-02T10:00:00Z");
      expect(sentinels[1]?.data.push_ts).toBe("2026-05-02T11:00:00Z");
    });
  });
});
