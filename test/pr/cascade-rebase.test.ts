// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, mock, test } from "bun:test";
import { type SpawnSyncReturns } from "node:child_process";

import {
  runCascadeRebase,
  type CascadeAdapters,
} from "../../src/pr/cascade-rebase.ts";
import type { FlagValues } from "../../src/cli/flags.ts";

/**
 * Slice 0 §Test grid §0-9 — cascade-rebase impl coverage via adapter
 * injection (offline + deterministic; no real gh/git calls).
 */

// ─── Helpers ────────────────────────────────────────────────────────

function fakeFlags(overrides: Partial<FlagValues> = {}): FlagValues {
  return {
    json: false,
    quiet: true,
    help: false,
    sinceMtime: undefined,
    sinceCursor: false,
    as: undefined,
    role: undefined,
    force: false,
    fromSession: undefined,
    base: "alpha/old-base",
    dryRun: false,
    onto: undefined,
    ...overrides,
  };
}

function spawnSyncOk(stdout: string): SpawnSyncReturns<Buffer> {
  return {
    status: 0,
    signal: null,
    pid: 1,
    stdout: Buffer.from(stdout, "utf-8"),
    stderr: Buffer.from("", "utf-8"),
    output: [null, Buffer.from(stdout), Buffer.from("")],
  };
}
function spawnSyncErr(stderr: string, exit = 1): SpawnSyncReturns<Buffer> {
  return {
    status: exit,
    signal: null,
    pid: 1,
    stdout: Buffer.from("", "utf-8"),
    stderr: Buffer.from(stderr, "utf-8"),
    output: [null, Buffer.from(""), Buffer.from(stderr)],
  };
}

const THREE_PR_STACK_JSON = JSON.stringify([
  {
    number: 100,
    url: "https://github.com/n/r/pull/100",
    baseRefName: "alpha/old-base",
    headRefName: "alpha/follow-1",
    headRefOid: "aaa1111",
    mergeable: "MERGEABLE",
  },
  {
    number: 101,
    url: "https://github.com/n/r/pull/101",
    baseRefName: "alpha/follow-1",
    headRefName: "alpha/follow-2",
    headRefOid: "bbb2222",
    mergeable: "MERGEABLE",
  },
  {
    number: 102,
    url: "https://github.com/n/r/pull/102",
    baseRefName: "alpha/follow-2",
    headRefName: "alpha/follow-3",
    headRefOid: "ccc3333",
    mergeable: "MERGEABLE",
  },
]);

type RouteMap = {
  readonly ghHandler?: (
    args: readonly string[],
  ) => SpawnSyncReturns<Buffer> | undefined;
  readonly gitHandler?: (
    cwd: string,
    args: readonly string[],
  ) => SpawnSyncReturns<Buffer> | undefined;
};

function defaultGhHandler(args: readonly string[]): SpawnSyncReturns<Buffer> {
  if (args[0] === "auth" && args[1] === "status") return spawnSyncOk("ok");
  if (args[0] === "pr" && args[1] === "list")
    return spawnSyncOk(THREE_PR_STACK_JSON);
  if (args[0] === "pr" && args[1] === "edit") return spawnSyncOk("");
  return spawnSyncOk("");
}
function defaultGitHandler(
  _cwd: string,
  args: readonly string[],
): SpawnSyncReturns<Buffer> {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
    return spawnSyncOk("/fake/repo");
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref")
    return spawnSyncOk("main");
  if (args[0] === "rev-parse") return spawnSyncOk("postsha111");
  if (args[0] === "fetch") return spawnSyncOk("");
  if (args[0] === "ls-remote") return spawnSyncOk("leasesha000\trefs/heads/x");
  if (args[0] === "rebase") return spawnSyncOk("");
  if (args[0] === "push") return spawnSyncOk("");
  return spawnSyncOk("");
}

function makeAdapters(
  routes: RouteMap = {},
  overrides: Partial<CascadeAdapters> = {},
): CascadeAdapters {
  return {
    runGh: (args) => routes.ghHandler?.(args) ?? defaultGhHandler(args),
    runGit: (cwd, args) =>
      routes.gitHandler?.(cwd, args) ?? defaultGitHandler(cwd, args),
    spawnCiWatch: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    now: () => 1000,
    cwd: () => "/fake/repo",
    ...overrides,
  };
}

// ─── §0 — Phase 0 prereqs ─────────────────────────────────────────

describe("Phase 0 prereqs", () => {
  test("T0.1 — gh auth status non-zero → exit 1 with clear error", async () => {
    let captured = "";
    const errSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = errSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags(),
        makeAdapters({
          ghHandler: (a) =>
            a[0] === "auth" ? spawnSyncErr("not logged in") : undefined,
        }),
      );
      expect(code).toBe(1);
      expect(captured).toContain("not authenticated");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("T0.2 — cwd not a git repo → exit 1", async () => {
    let captured = "";
    const errSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = errSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags(),
        makeAdapters({
          gitHandler: (_cwd, a) =>
            a[0] === "rev-parse" && a[1] === "--show-toplevel"
              ? spawnSyncErr("not a git repo")
              : undefined,
        }),
      );
      expect(code).toBe(1);
      expect(captured).toContain("not a git repository");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("T0.3 — git fetch is invoked before stack-walk", async () => {
    const gitCalls: string[][] = [];
    await runCascadeRebase(
      [],
      fakeFlags({ dryRun: true }),
      makeAdapters({
        gitHandler: (_cwd, args) => {
          gitCalls.push([...args]);
          return undefined;
        },
      }),
    );
    const fetchIdx = gitCalls.findIndex((a) => a[0] === "fetch");
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
  });
});

// ─── §2 — Stack detection ─────────────────────────────────────────

describe("Stack detection", () => {
  test("T2.1 — empty gh pr list → exit 0 + 'no PRs to cascade'", async () => {
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags(),
        makeAdapters({
          ghHandler: (a) => {
            if (a[0] === "auth") return spawnSyncOk("ok");
            if (a[0] === "pr" && a[1] === "list") return spawnSyncOk("[]");
            return undefined;
          },
        }),
      );
      expect(code).toBe(0);
      expect(captured).toContain("no PRs to cascade");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T2.4 — mergeable=null PRs excluded from stack", async () => {
    const draft = JSON.stringify([
      {
        number: 200,
        url: "u",
        baseRefName: "alpha/old-base",
        headRefName: "x",
        headRefOid: "s",
        mergeable: null,
      },
    ]);
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags(),
        makeAdapters({
          ghHandler: (a) => {
            if (a[0] === "auth") return spawnSyncOk("ok");
            if (a[0] === "pr" && a[1] === "list") return spawnSyncOk(draft);
            return undefined;
          },
        }),
      );
      expect(code).toBe(0);
      expect(captured).toContain("no PRs to cascade");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T2.5 — cycle (PR has head == base) → exit 1", async () => {
    const cyclic = JSON.stringify([
      {
        number: 300,
        url: "u",
        baseRefName: "x",
        headRefName: "x",
        headRefOid: "s",
        mergeable: "MERGEABLE",
      },
    ]);
    let captured = "";
    const errSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = errSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags(),
        makeAdapters({
          ghHandler: (a) => {
            if (a[0] === "auth") return spawnSyncOk("ok");
            if (a[0] === "pr" && a[1] === "list") return spawnSyncOk(cyclic);
            return undefined;
          },
        }),
      );
      expect(code).toBe(1);
      expect(captured).toContain("cycle");
    } finally {
      process.stderr.write = orig;
    }
  });
});

// ─── §5 — Dry-run ─────────────────────────────────────────────────

describe("Dry-run", () => {
  test("T5.1 — --dry-run reports plan + exits 0 + does NOT rebase/push", async () => {
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const gitCalls: string[][] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ dryRun: true }),
        makeAdapters({
          gitHandler: (_cwd, a) => {
            gitCalls.push([...a]);
            return undefined;
          },
        }),
      );
      expect(code).toBe(0);
      expect(captured).toContain("DRY-RUN");
      expect(
        gitCalls.some((a) => a[0] === "rebase" && a[1] !== "--abort"),
      ).toBe(false);
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
    } finally {
      process.stdout.write = orig;
    }
  });
});

// ─── §6 — Worktree-on-stacked-branch refuse ──────────────────────

describe("Worktree-on-stacked-branch refuse", () => {
  test("T6.1 — CWD HEAD == in-stack head → REFUSE + exit 1", async () => {
    let captured = "";
    const errSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = errSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags(),
        makeAdapters({
          gitHandler: (_cwd, a) => {
            if (a[0] === "rev-parse" && a[1] === "--abbrev-ref")
              return spawnSyncOk("alpha/follow-1");
            return undefined;
          },
        }),
      );
      expect(code).toBe(1);
      expect(captured).toContain("checked out at branch alpha/follow-1");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("T6.3 — CWD detached HEAD → proceed (no refuse)", async () => {
    const code = await runCascadeRebase(
      [],
      fakeFlags({ dryRun: true }),
      makeAdapters({
        gitHandler: (_cwd, a) => {
          if (a[0] === "rev-parse" && a[1] === "--abbrev-ref")
            return spawnSyncOk("HEAD");
          return undefined;
        },
      }),
    );
    expect(code).toBe(0);
  });
});

// ─── §7 — Output mode ────────────────────────────────────────────

describe("Output mode", () => {
  test("T7.1 — text mode renders rows + total summary", async () => {
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ dryRun: true }),
        makeAdapters(),
      );
      expect(code).toBe(0);
      expect(captured).toContain("PR #100");
      expect(captured).toContain("Total:");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T7.2 — --json output parseable + report has 6 required fields", async () => {
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ dryRun: true, json: true }),
        makeAdapters(),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(captured.trim());
      expect(parsed.base).toBe("alpha/old-base");
      expect(parsed.total).toBe(3);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.reports).toHaveLength(3);
      const first = parsed.reports[0];
      for (const key of [
        "pr_number",
        "pr_url",
        "sha_pre_rebase",
        "sha_post_rebase",
        "conclusion",
        "elapsed_ms",
      ]) {
        expect(first).toHaveProperty(key);
      }
    } finally {
      process.stdout.write = orig;
    }
  });
});

// ─── §8 — Flag validation ────────────────────────────────────────

describe("Flag validation", () => {
  test("T8.1 — missing --base → exit 2 + clear error", async () => {
    let captured = "";
    const errSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = errSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ base: undefined }),
        makeAdapters(),
      );
      expect(code).toBe(2);
      expect(captured).toContain("--base");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("T8.2 — empty --base → exit 2", async () => {
    const code = await runCascadeRebase(
      [],
      fakeFlags({ base: "" }),
      makeAdapters(),
    );
    expect(code).toBe(2);
  });

  test("T8.3 — whitespace-only --base → exit 2", async () => {
    const code = await runCascadeRebase(
      [],
      fakeFlags({ base: "   " }),
      makeAdapters(),
    );
    expect(code).toBe(2);
  });
});

// ─── §1 / §3 / §9 — Happy path + halt-on-conflict + concurrency ─

describe("Happy path + halt", () => {
  test("T1.1 — 3-PR stack rebases cleanly + ci-success → exit 0", async () => {
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ json: true }),
        makeAdapters(
          {},
          {
            spawnCiWatch: async () => ({
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            }),
          },
        ),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(captured.trim());
      expect(parsed.reports).toHaveLength(3);
      for (const r of parsed.reports) expect(r.conclusion).toBe("ci-success");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T3.2 + T3.3 — rebase conflict @ PR-2 → halt + PR-3 not-attempted", async () => {
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    let rebaseCount = 0;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ json: true }),
        makeAdapters({
          gitHandler: (_cwd, a) => {
            if (a[0] === "rebase" && a[1] === "--onto") {
              rebaseCount += 1;
              if (rebaseCount === 2) return spawnSyncErr("conflict", 1);
            }
            return undefined;
          },
        }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(captured.trim());
      expect(parsed.reports).toHaveLength(3);
      expect(parsed.reports[0].conclusion).toBe("rebased");
      expect(parsed.reports[1].conclusion).toBe("halted-conflict");
      expect(parsed.reports[2].conclusion).toBe("not-attempted");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T-onto.1 (Delta F-NEW-1) — --onto unset → idx=0 rebase targets origin/main; priorBase is --base value", async () => {
    const rebaseCalls: readonly string[][] = [];
    const calls = rebaseCalls as string[][];
    await runCascadeRebase(
      [],
      fakeFlags({ json: true }), // onto undefined → default "main"
      makeAdapters(
        {
          gitHandler: (_cwd, args) => {
            if (args[0] === "rebase" && args[1] === "--onto") {
              calls.push([...args]);
            }
            return undefined;
          },
        },
        { spawnCiWatch: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      ),
    );
    // For the 3-PR stack: idx=0 should rebase --onto origin/main origin/alpha/old-base origin/alpha/follow-1
    const root = calls[0];
    expect(root).toBeDefined();
    if (!root) return;
    expect(root[0]).toBe("rebase");
    expect(root[1]).toBe("--onto");
    expect(root[2]).toBe("origin/main");
    expect(root[3]).toBe("origin/alpha/old-base"); // priorBase = --base
    expect(root[4]).toBe("origin/alpha/follow-1");
  });

  test("T-onto.2 (Delta F-NEW-1) — --onto explicit → idx=0 rebase targets that branch", async () => {
    const calls: string[][] = [];
    await runCascadeRebase(
      [],
      fakeFlags({ json: true, onto: "release/v2" }),
      makeAdapters(
        {
          gitHandler: (_cwd, args) => {
            if (args[0] === "rebase" && args[1] === "--onto")
              calls.push([...args]);
            return undefined;
          },
        },
        { spawnCiWatch: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      ),
    );
    expect(calls[0]?.[2]).toBe("origin/release/v2");
  });

  test("T-priorBase (Delta F-NEW-1 point-4) — idx>=1 priorBase uses pre-rebase SHA from preRebaseShas Map, NOT branch-name", async () => {
    const calls: string[][] = [];
    let lsRemoteCount = 0;
    await runCascadeRebase(
      [],
      fakeFlags({ json: true }),
      makeAdapters(
        {
          gitHandler: (_cwd, args) => {
            if (args[0] === "rebase" && args[1] === "--onto")
              calls.push([...args]);
            if (args[0] === "ls-remote") {
              lsRemoteCount += 1;
              // Each PR gets a distinct pre-rebase SHA
              return spawnSyncOk(
                `pre-rebase-sha-${lsRemoteCount}\trefs/heads/x`,
              );
            }
            return undefined;
          },
        },
        { spawnCiWatch: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      ),
    );
    // idx=0: priorBase = "origin/alpha/old-base" (the --base value)
    // idx=1: priorBase = "pre-rebase-sha-1" (PR-1's pre-rebase SHA, raw — no origin/ prefix)
    // idx=2: priorBase = "pre-rebase-sha-2"
    expect(calls[1]?.[3]).toBe("pre-rebase-sha-1");
    expect(calls[2]?.[3]).toBe("pre-rebase-sha-2");
    // And idx=1+ target is the prev PR's headRefName branch (post-rebase)
    expect(calls[1]?.[2]).toBe("origin/alpha/follow-1");
    expect(calls[2]?.[2]).toBe("origin/alpha/follow-2");
  });

  test("T-retarget-failed (Delta M1) — gh pr edit non-zero → conclusion=retarget-failed + halt", async () => {
    let captured = "";
    const outSpy = mock((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = outSpy as unknown as typeof process.stdout.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ json: true }),
        makeAdapters({
          ghHandler: (a) => {
            if (a[0] === "auth") return spawnSyncOk("ok");
            if (a[0] === "pr" && a[1] === "list")
              return spawnSyncOk(THREE_PR_STACK_JSON);
            if (a[0] === "pr" && a[1] === "edit")
              return spawnSyncErr("pr is closed", 1);
            return undefined;
          },
        }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(captured.trim());
      expect(parsed.reports[0].conclusion).toBe("retarget-failed");
      expect(parsed.reports[1].conclusion).toBe("not-attempted");
      expect(parsed.reports[2].conclusion).toBe("not-attempted");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("T-ls-remote-empty-refuses (Delta M2) — empty ls-remote → REFUSE + halt with clear error", async () => {
    let stderrCap = "";
    const errSpy = mock((c: string | Uint8Array) => {
      stderrCap += typeof c === "string" ? c : "";
      return true;
    });
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = errSpy as unknown as typeof process.stderr.write;
    try {
      const code = await runCascadeRebase(
        [],
        fakeFlags({ json: true }),
        makeAdapters({
          gitHandler: (_cwd, a) => {
            if (a[0] === "ls-remote") return spawnSyncOk(""); // empty result
            return undefined;
          },
        }),
      );
      expect(code).toBe(1);
      expect(stderrCap).toContain("not on origin");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("T9.4 — 5-PR stack engages Phase 2 concurrency cap (still exits 0 on all-success)", async () => {
    const stack5 = JSON.parse(THREE_PR_STACK_JSON);
    stack5.push({
      number: 103,
      url: "u4",
      baseRefName: "alpha/follow-3",
      headRefName: "alpha/follow-4",
      headRefOid: "ddd4444",
      mergeable: "MERGEABLE",
    });
    stack5.push({
      number: 104,
      url: "u5",
      baseRefName: "alpha/follow-4",
      headRefName: "alpha/follow-5",
      headRefOid: "eee5555",
      mergeable: "MERGEABLE",
    });
    const code = await runCascadeRebase(
      [],
      fakeFlags({ json: true }),
      makeAdapters(
        {
          ghHandler: (a) => {
            if (a[0] === "auth") return spawnSyncOk("ok");
            if (a[0] === "pr" && a[1] === "list")
              return spawnSyncOk(JSON.stringify(stack5));
            return spawnSyncOk("");
          },
        },
        {
          spawnCiWatch: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        },
      ),
    );
    expect(code).toBe(0);
  });
});
