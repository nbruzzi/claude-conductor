// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle 6 item-3 increment-2b — channels CLI verbs `handoff-archive` /
 * `handoff-prune`. Subprocess tests (Bun.spawnSync, mirroring cli.test.ts):
 * spawn the verb with CLAUDE_CONDUCTOR_HANDOFFS_DIR pointed at a tmp fixture dir
 * + parse stdout JSON. The CLI sweep uses getWallClockNow() (real wall-clock),
 * so age fixtures back-date mtime relative to Date.now().
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const CLI_PATH = join(PACKAGE_ROOT, "src", "channels", "cli.ts");
const TEST_SID = "00000000-0000-4000-8000-000000000001";
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cli-handoff-archive-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: readonly string[], handoffsDir: string = tmpDir): RunResult {
  const r = Bun.spawnSync({
    cmd: ["bun", CLI_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_HANDOFFS_DIR: handoffsDir,
      CLAUDE_SESSION_ID: TEST_SID,
    },
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** Write a HANDOFF_<id>.md with a controlled age (back-dated from real now). */
function writeOldHandoff(id: string, ageDays: number): string {
  const name = `HANDOFF_${id}.md`;
  const path = join(tmpDir, name);
  writeFileSync(path, `# Handoff ${id}\n`);
  const mtime = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(path, mtime, mtime);
  return name;
}

describe("channels CLI: handoff-archive verb (increment-2b)", () => {
  it("report-mode (no --apply): prints the sweep JSON; mutates nothing", () => {
    const old = writeOldHandoff("old", 60);
    const r = run([
      "handoff-archive",
      "--retention-days",
      "14",
      "--keep-recent",
      "0",
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      ok: boolean;
      archivable: { name: string }[];
    };
    expect(out.ok).toBe(true);
    expect(out.archivable.map((c) => c.name)).toContain(old);
    // report-only: the handoff is NOT moved.
    expect(existsSync(join(tmpDir, old))).toBe(true);
  });

  it("--apply: MOVES each candidate into .archive/ + reports applied:true", () => {
    const old = writeOldHandoff("apply-old", 60);
    const r = run([
      "handoff-archive",
      "--apply",
      "--retention-days",
      "14",
      "--keep-recent",
      "0",
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      applied: boolean;
      archived: string[];
    };
    expect(out.applied).toBe(true);
    expect(out.archived).toContain(old);
    // moved (recoverable): gone from live, present in .archive/.
    expect(existsSync(join(tmpDir, old))).toBe(false);
    expect(existsSync(join(tmpDir, ".archive", old))).toBe(true);
  });

  it("--apply REFUSES on a degraded sweep (ok:false): applied:false, mutates nothing", () => {
    // handoffsDir pointed at a FILE -> latestTargetName throws -> F1 ok:false.
    const filePath = join(tmpDir, "as-file");
    writeFileSync(filePath, "x");
    const r = run(["handoff-archive", "--apply"], filePath);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; applied: boolean };
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
  });
});

describe("channels CLI: handoff-prune verb (increment-2b)", () => {
  it("purges archived entries past retention; keeps recent; prints purged[]", () => {
    mkdirSync(join(tmpDir, ".archive"), { recursive: true });
    const oldArch = join(tmpDir, ".archive", "HANDOFF_old.md");
    writeFileSync(oldArch, "archived");
    const oldMtime = new Date(Date.now() - 60 * DAY_MS);
    utimesSync(oldArch, oldMtime, oldMtime);
    const recentArch = join(tmpDir, ".archive", "HANDOFF_recent.md");
    writeFileSync(recentArch, "archived");
    const r = run([
      "handoff-prune",
      "--retention-days",
      "30",
      "--max-entries",
      "50",
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { purged: string[] };
    expect(out.purged).toContain("HANDOFF_old.md");
    expect(existsSync(recentArch)).toBe(true);
  });
});
