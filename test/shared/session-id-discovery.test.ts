// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  resolveSessionId,
  formatRecoveryHint,
  describeSource,
  INTERNAL,
} from "../../src/shared/session-id-discovery.ts";

const REAL_SESSIONS_DIR = join(homedir(), ".claude", "sessions");
let tmpRoot: string;
let tmpSessionsDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "session-id-discovery-"));
  tmpSessionsDir = join(tmpRoot, "sessions");
  // mkdir lazily — some tests want it absent
  prevEnv = process.env["CLAUDE_SESSION_ID"];
  delete process.env["CLAUDE_SESSION_ID"];
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevEnv !== undefined) {
    process.env["CLAUDE_SESSION_ID"] = prevEnv;
  } else {
    delete process.env["CLAUDE_SESSION_ID"];
  }
});

// HOME-isolation guard: snapshot the real sessions dir before all tests, verify
// no new files appeared after all tests. Catches accidental writes via missing
// sessionsDir opt.
const realSessionsBefore = existsSync(REAL_SESSIONS_DIR)
  ? new Set(readdirSync(REAL_SESSIONS_DIR))
  : new Set<string>();

afterAll(() => {
  if (!existsSync(REAL_SESSIONS_DIR)) return;
  const realSessionsAfter = new Set(readdirSync(REAL_SESSIONS_DIR));
  const created: string[] = [];
  for (const f of realSessionsAfter) {
    if (!realSessionsBefore.has(f)) created.push(f);
  }
  if (created.length > 0) {
    throw new Error(
      `HOME isolation leak: tests wrote ${created.length} file(s) to real ${REAL_SESSIONS_DIR}: ${created.join(", ")}`,
    );
  }
});

const VALID_UUID_1 = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";
const VALID_UUID_2 = "f443f023-761d-443b-9714-d563b6fc41ab";
const VALID_UUID_3 = "5ce7ef0b-3b78-402f-80fa-abf5ebfdf9fe";

function shortRetry(): {
  retryCount: number;
  retryDelayMs: number;
  sessionsDir: string;
} {
  return { retryCount: 0, retryDelayMs: 1, sessionsDir: tmpSessionsDir };
}

function ensureSessionsDir(): void {
  // Idempotent — only create if absent. Helper functions call this each time
  // they write a file; wiping would clobber prior writes in the same test.
  if (!existsSync(tmpSessionsDir)) {
    mkdirSync(tmpSessionsDir, { recursive: true });
  }
}

function writeCCFile(pid: number, sessionId: string): void {
  ensureSessionsDir();
  writeFileSync(
    join(tmpSessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: "/x", startedAt: Date.now() }),
  );
}

function writeTelemetryFile(sessionId: string): void {
  ensureSessionsDir();
  writeFileSync(
    join(tmpSessionsDir, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  );
}

describe("isStrictUUID", () => {
  it("accepts valid UUID strings", () => {
    expect(INTERNAL.isStrictUUID(VALID_UUID_1)).toBe(true);
    expect(INTERNAL.isStrictUUID(VALID_UUID_2)).toBe(true);
  });

  it("rejects loose ids that pass active-sessions/index.ts:isValidSessionId", () => {
    // Per SE-1: tighten trust-boundary regex to UUID-shape specifically
    expect(INTERNAL.isStrictUUID("37567")).toBe(false); // PID-shape
    expect(INTERNAL.isStrictUUID("abc-123")).toBe(false); // legacy stub
    expect(INTERNAL.isStrictUUID("alice")).toBe(false);
    expect(INTERNAL.isStrictUUID("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(INTERNAL.isStrictUUID(42)).toBe(false);
    expect(INTERNAL.isStrictUUID(null)).toBe(false);
    expect(INTERNAL.isStrictUUID(undefined)).toBe(false);
  });
});

describe("truncateId", () => {
  it("truncates long ids to <first-8>...<last-4>", () => {
    // VALID_UUID_1 = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29"; last 4 chars = "5d29"
    expect(INTERNAL.truncateId(VALID_UUID_1)).toBe("ad41f287...5d29");
  });

  it("returns short ids as-is", () => {
    expect(INTERNAL.truncateId("short")).toBe("short");
    expect(INTERNAL.truncateId("twelve-char1")).toBe("twelve-char1"); // exactly 12
  });
});

describe("readCCBinaryFile", () => {
  it("returns null for missing file", () => {
    ensureSessionsDir();
    expect(
      INTERNAL.readCCBinaryFile(join(tmpSessionsDir, "doesnotexist.json")),
    ).toBeNull();
  });

  it("returns parsed object for valid CC binary file", () => {
    writeCCFile(12345, VALID_UUID_1);
    const result = INTERNAL.readCCBinaryFile(
      join(tmpSessionsDir, "12345.json"),
    );
    expect(result).toEqual({ pid: 12345, sessionId: VALID_UUID_1 });
  });

  it("returns null when sessionId field is non-UUID (e.g., a PID)", () => {
    ensureSessionsDir();
    writeFileSync(
      join(tmpSessionsDir, "12345.json"),
      JSON.stringify({ pid: 12345, sessionId: "37567" }),
    );
    expect(
      INTERNAL.readCCBinaryFile(join(tmpSessionsDir, "12345.json")),
    ).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    ensureSessionsDir();
    writeFileSync(join(tmpSessionsDir, "12345.json"), "{ not json");
    expect(
      INTERNAL.readCCBinaryFile(join(tmpSessionsDir, "12345.json")),
    ).toBeNull();
  });
});

describe("readTelemetryFile", () => {
  it("returns parsed object for valid telemetry file", () => {
    writeTelemetryFile(VALID_UUID_1);
    const result = INTERNAL.readTelemetryFile(
      join(tmpSessionsDir, `${VALID_UUID_1}.json`),
    );
    expect(result).toEqual({ session_id: VALID_UUID_1 });
  });

  it("returns null when session_id field is non-UUID", () => {
    ensureSessionsDir();
    writeFileSync(
      join(tmpSessionsDir, `${VALID_UUID_1}.json`),
      JSON.stringify({ session_id: "37567" }),
    );
    expect(
      INTERNAL.readTelemetryFile(join(tmpSessionsDir, `${VALID_UUID_1}.json`)),
    ).toBeNull();
  });
});

describe("listMtimeCandidates", () => {
  it("returns empty for empty dir", () => {
    ensureSessionsDir();
    expect(
      INTERNAL.listMtimeCandidates(tmpSessionsDir, 60_000, Date.now()),
    ).toEqual([]);
  });

  it("returns one candidate for one matching telemetry file", () => {
    writeTelemetryFile(VALID_UUID_1);
    const result = INTERNAL.listMtimeCandidates(
      tmpSessionsDir,
      60_000,
      Date.now(),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe(VALID_UUID_1);
  });

  it("skips PID-keyed files (per RE-1 — handled by ppid path)", () => {
    writeCCFile(12345, VALID_UUID_1);
    const result = INTERNAL.listMtimeCandidates(
      tmpSessionsDir,
      60_000,
      Date.now(),
    );
    expect(result).toEqual([]);
  });

  it("returns multiple candidates as ambiguous-eligible list", () => {
    writeTelemetryFile(VALID_UUID_1);
    writeTelemetryFile(VALID_UUID_2);
    const result = INTERNAL.listMtimeCandidates(
      tmpSessionsDir,
      60_000,
      Date.now(),
    );
    expect(result).toHaveLength(2);
    const ids = result.map((c) => c.sessionId).sort();
    expect(ids).toEqual([VALID_UUID_1, VALID_UUID_2].sort());
  });

  it("skips files where filename mismatches embedded session_id (per SE-1)", () => {
    ensureSessionsDir();
    writeFileSync(
      join(tmpSessionsDir, `${VALID_UUID_2}.json`),
      JSON.stringify({ session_id: VALID_UUID_1 }), // different from filename
    );
    const result = INTERNAL.listMtimeCandidates(
      tmpSessionsDir,
      60_000,
      Date.now(),
    );
    expect(result).toEqual([]);
  });

  it("excludes files outside the mtime window", () => {
    writeTelemetryFile(VALID_UUID_1);
    const now = Date.now();
    // Candidate's mtime is "now", but we ask with windowMs of 0 → should be excluded
    const result = INTERNAL.listMtimeCandidates(tmpSessionsDir, 0, now + 1000);
    expect(result).toEqual([]);
  });

  it("excludes future-dated files (clock skew defense)", () => {
    writeTelemetryFile(VALID_UUID_1);
    const fakeNow = Date.now() - 10 * 60 * 1000; // 10 min in past
    // File's mtime is "real now", but we pass fakeNow far in the past → file is "future-dated"
    const result = INTERNAL.listMtimeCandidates(
      tmpSessionsDir,
      60_000,
      fakeNow,
    );
    expect(result).toEqual([]);
  });
});

describe("sanityCheckHasCCFile", () => {
  it("returns false when no <pid>.json exists", () => {
    writeTelemetryFile(VALID_UUID_1);
    expect(INTERNAL.sanityCheckHasCCFile(VALID_UUID_1, tmpSessionsDir)).toBe(
      false,
    );
  });

  it("returns true when matching <pid>.json exists", () => {
    writeTelemetryFile(VALID_UUID_1);
    writeCCFile(12345, VALID_UUID_1);
    expect(INTERNAL.sanityCheckHasCCFile(VALID_UUID_1, tmpSessionsDir)).toBe(
      true,
    );
  });

  it("returns false when <pid>.json's sessionId doesn't match", () => {
    writeCCFile(12345, VALID_UUID_2);
    expect(INTERNAL.sanityCheckHasCCFile(VALID_UUID_1, tmpSessionsDir)).toBe(
      false,
    );
  });
});

describe("resolveSessionId — env path (DiscoveryResult variant: env)", () => {
  it("kind=env when env set + valid UUID", () => {
    process.env["CLAUDE_SESSION_ID"] = VALID_UUID_1;
    ensureSessionsDir();
    const result = resolveSessionId(shortRetry());
    expect(result.kind).toBe("env");
    if (result.kind === "env") expect(result.sessionId).toBe(VALID_UUID_1);
  });

  it("env set + invalid UUID (PID-shape) → falls through (per SE-1)", () => {
    process.env["CLAUDE_SESSION_ID"] = "37567"; // PID, not UUID
    ensureSessionsDir();
    // No CC binary or telemetry files → expect missing (would have been "env" with loose validation)
    const result = resolveSessionId(shortRetry());
    expect(result.kind).toBe("missing");
  });

  it("env set + empty string → falls through", () => {
    process.env["CLAUDE_SESSION_ID"] = "";
    ensureSessionsDir();
    const result = resolveSessionId(shortRetry());
    expect(result.kind).toBe("missing");
  });
});

describe("resolveSessionId — mtime fallback path (DiscoveryResult variants: mtime, missing, ambiguous)", () => {
  it("kind=missing when no candidates", () => {
    ensureSessionsDir();
    const result = resolveSessionId(shortRetry());
    expect(result.kind).toBe("missing");
  });

  it("kind=mtime when one candidate + matching <pid>.json (sanity check passes)", () => {
    writeTelemetryFile(VALID_UUID_1);
    writeCCFile(12345, VALID_UUID_1);
    const result = resolveSessionId(shortRetry());
    expect(result.kind).toBe("mtime");
    if (result.kind === "mtime") expect(result.sessionId).toBe(VALID_UUID_1);
  });

  it("downgrades to missing when sanity check fails (per SE-2)", () => {
    writeTelemetryFile(VALID_UUID_1);
    // No matching <pid>.json — sanity check should fail
    const result = resolveSessionId(shortRetry());
    expect(result.kind).toBe("missing");
  });

  it("kind=ambiguous when two candidates", () => {
    writeTelemetryFile(VALID_UUID_1);
    writeTelemetryFile(VALID_UUID_2);
    const result = resolveSessionId(shortRetry());
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });
});

describe("formatRecoveryHint", () => {
  it("returns empty for env/ppid/mtime", () => {
    expect(formatRecoveryHint({ kind: "env", sessionId: VALID_UUID_1 })).toBe(
      "",
    );
    expect(
      formatRecoveryHint({
        kind: "ppid",
        sessionId: VALID_UUID_1,
        pid: 12345,
        source: "/x",
      }),
    ).toBe("");
    expect(
      formatRecoveryHint({
        kind: "mtime",
        sessionId: VALID_UUID_1,
        mtime: 0,
        source: "/x",
      }),
    ).toBe("");
  });

  it("missing → recovery hint with env-var assignment, no cmd reconstruction (per SE-6)", () => {
    const hint = formatRecoveryHint({ kind: "missing" });
    expect(hint).toContain("CLAUDE_SESSION_ID");
    expect(hint).toContain("export CLAUDE_SESSION_ID=<your-session-id>");
    // Must NOT contain a reconstructed cmd
    expect(hint).not.toContain("bun run");
    expect(hint).not.toContain("argv");
  });

  it("ambiguous → list candidates with truncated ids (per SE-5)", () => {
    const hint = formatRecoveryHint({
      kind: "ambiguous",
      candidates: [
        { sessionId: VALID_UUID_1, mtime: 0, source: "/x" },
        { sessionId: VALID_UUID_2, mtime: 1000, source: "/y" },
      ],
    });
    // Truncated form: <first-8>...<last-4>
    expect(hint).toContain("ad41f287...5d29");
    expect(hint).toContain("f443f023...41ab");
    // Full IDs must NOT appear
    expect(hint).not.toContain(VALID_UUID_1);
    expect(hint).not.toContain(VALID_UUID_2);
  });
});

describe("describeSource", () => {
  it("returns short labels for each kind (DiscoveryResult variant: ppid)", () => {
    expect(describeSource({ kind: "env", sessionId: VALID_UUID_1 })).toBe(
      "env",
    );
    expect(
      describeSource({
        kind: "ppid",
        sessionId: VALID_UUID_1,
        pid: 12345,
        source: "/x",
      }),
    ).toContain("12345");
    expect(
      describeSource({
        kind: "mtime",
        sessionId: VALID_UUID_1,
        mtime: 0,
        source: "/x",
      }),
    ).toContain("mtime");
    expect(describeSource({ kind: "missing" })).toBe("missing");
    expect(
      describeSource({
        kind: "ambiguous",
        candidates: [
          { sessionId: VALID_UUID_1, mtime: 0, source: "/x" },
          { sessionId: VALID_UUID_2, mtime: 0, source: "/y" },
        ],
      }),
    ).toContain("2");
  });
});

describe("walkPpidTree (integration with current process)", () => {
  it("returns null when sessionsDir has no matching files in our actual ppid chain", () => {
    ensureSessionsDir();
    // Empty dir: walk returns null
    expect(INTERNAL.walkPpidTree(tmpSessionsDir)).toBeNull();
  });

  it("finds CC file via direct ppid lookup", () => {
    // Plant a CC file at our actual process.ppid; walk should find it on first hop
    const myPpid = process.ppid;
    writeCCFile(myPpid, VALID_UUID_3);
    const result = INTERNAL.walkPpidTree(tmpSessionsDir);
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.pid).toBe(myPpid);
      expect(result.sessionId).toBe(VALID_UUID_3);
    }
  });
});

// Two distinct UUIDs sharing an 8-hex prefix ("abcd1234") — for the
// prefix-collision safety test.
const VALID_UUID_4 = "abcd1234-0000-4000-8000-000000000001";
const VALID_UUID_5 = "abcd1234-0000-4000-8000-000000000002";

// A worktree path whose final segment is `.claude-dotfiles-<sid8>` for a uuid.
function worktreeDirFor(sessionId: string): string {
  return join(tmpRoot, `.claude-dotfiles-${sessionId.slice(0, 8)}`);
}

describe("extractSid8FromPath (INTERNAL — worktree basename parse)", () => {
  it("extracts the 8-hex prefix from a `.claude-dotfiles-<sid8>` final segment", () => {
    expect(INTERNAL.extractSid8FromPath("/x/.claude-dotfiles-ad41f287")).toBe(
      "ad41f287",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(INTERNAL.extractSid8FromPath("/x/.claude-dotfiles-deadbeef/")).toBe(
      "deadbeef",
    );
  });

  it("returns null for the canonical (suffix-less) dotfiles dir", () => {
    expect(INTERNAL.extractSid8FromPath("/x/.claude-dotfiles")).toBeNull();
  });

  it("returns null for non-hex / wrong-length / uppercase / empty suffixes", () => {
    expect(
      INTERNAL.extractSid8FromPath("/x/.claude-dotfiles-ZZZZZZZZ"),
    ).toBeNull();
    expect(INTERNAL.extractSid8FromPath("/x/.claude-dotfiles-1234")).toBeNull(); // too short
    expect(
      INTERNAL.extractSid8FromPath("/x/.claude-dotfiles-deadbeeff"),
    ).toBeNull(); // 9 chars
    expect(
      INTERNAL.extractSid8FromPath("/x/.claude-dotfiles-AD41F287"),
    ).toBeNull(); // uppercase (provisioner emits lowercase)
    expect(INTERNAL.extractSid8FromPath("/x/.claude-dotfiles-")).toBeNull();
    expect(INTERNAL.extractSid8FromPath("/x/some-other-dir")).toBeNull();
  });
});

describe("resolveSessionId — worktree tier (DiscoveryResult variant: worktree)", () => {
  it("disambiguates a cohort that mtime would call ambiguous (no <pid>.json needed)", () => {
    // The exact mtime-ambiguous setup: two fresh sibling telemetry files, and
    // deliberately NO CC pidfile — proving the worktree tier does not depend on
    // the SE-2 sanity check the mtime tier requires.
    writeTelemetryFile(VALID_UUID_1);
    writeTelemetryFile(VALID_UUID_2);
    const result = resolveSessionId({
      ...shortRetry(),
      startDir: worktreeDirFor(VALID_UUID_1),
    });
    expect(result.kind).toBe("worktree");
    if (result.kind === "worktree") {
      expect(result.sessionId).toBe(VALID_UUID_1);
      expect(result.prefix).toBe(VALID_UUID_1.slice(0, 8));
    }
  });

  it("falls through to mtime when startDir has no `-<sid8>` suffix", () => {
    writeTelemetryFile(VALID_UUID_1);
    writeCCFile(12345, VALID_UUID_1); // sanity passes for the mtime tier
    const result = resolveSessionId({
      ...shortRetry(),
      startDir: join(tmpRoot, ".claude-dotfiles"),
    });
    expect(result.kind).toBe("mtime");
    if (result.kind === "mtime") expect(result.sessionId).toBe(VALID_UUID_1);
  });

  it("falls through when the prefix matches zero telemetry files", () => {
    writeTelemetryFile(VALID_UUID_1);
    writeCCFile(12345, VALID_UUID_1);
    const result = resolveSessionId({
      ...shortRetry(),
      startDir: join(tmpRoot, ".claude-dotfiles-deadbeef"), // matches no stem
    });
    expect(result.kind).toBe("mtime");
    if (result.kind === "mtime") expect(result.sessionId).toBe(VALID_UUID_1);
  });

  it("never guesses on an 8-hex prefix collision — falls through to mtime ambiguous", () => {
    writeTelemetryFile(VALID_UUID_4);
    writeTelemetryFile(VALID_UUID_5);
    const result = resolveSessionId({
      ...shortRetry(),
      startDir: join(tmpRoot, ".claude-dotfiles-abcd1234"),
    });
    // >1 prefix match → worktree tier returns null → mtime sees 2 candidates.
    expect(result.kind).toBe("ambiguous");
  });

  it("ignores a garbage (non-hex) suffix and falls through", () => {
    writeTelemetryFile(VALID_UUID_1);
    writeCCFile(12345, VALID_UUID_1);
    const result = resolveSessionId({
      ...shortRetry(),
      startDir: join(tmpRoot, ".claude-dotfiles-ZZZZZZZZ"),
    });
    expect(result.kind).toBe("mtime");
  });

  it("requires the embedded session_id to match the filename (SE-1)", () => {
    // Telemetry file named for UUID_1 but body claims UUID_2 → rejected by the
    // body===stem guard → 0 worktree matches → mtime also rejects → missing.
    ensureSessionsDir();
    writeFileSync(
      join(tmpSessionsDir, `${VALID_UUID_1}.json`),
      JSON.stringify({ session_id: VALID_UUID_2 }),
    );
    const result = resolveSessionId({
      ...shortRetry(),
      startDir: worktreeDirFor(VALID_UUID_1),
    });
    expect(result.kind).toBe("missing");
  });
});

describe("formatRecoveryHint / describeSource — worktree variant", () => {
  it("formatRecoveryHint returns empty for worktree (a successful resolution)", () => {
    expect(
      formatRecoveryHint({
        kind: "worktree",
        sessionId: VALID_UUID_1,
        prefix: "ad41f287",
        source: "/x",
      }),
    ).toBe("");
  });

  it("describeSource labels worktree with the sid-prefix", () => {
    const s = describeSource({
      kind: "worktree",
      sessionId: VALID_UUID_1,
      prefix: "ad41f287",
      source: "/x",
    });
    expect(s).toContain("worktree");
    expect(s).toContain("ad41f287");
  });
});
