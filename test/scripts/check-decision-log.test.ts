// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "check-decision-log.sh",
);

// A schema-valid decision entry. The structural signal the gate keys on is the
// single `ts:` frontmatter field every entry opens with (not kind/severity).
const SAMPLE_ENTRY = `# Decision Log — Phase 9

---
ts: 2026-05-28T00:00:00Z
kind: tooling
severity: minor
phase: 9
affects: [scripts/check-decision-log.sh]
---

- **Context:** original context line.
- **Chosen:** the choice.
- **Reason:** the reason.
`;

// Same entry with a prose typo fixed — no new ts: line, so NOT a net-new entry.
const SAMPLE_ENTRY_TYPO_FIXED = SAMPLE_ENTRY.replace(
  "original context line.",
  "corrected context line.",
);

// A second, genuinely net-new entry (its own ts:) appended after the first.
const SAMPLE_ENTRY_PLUS_SECOND = `${SAMPLE_ENTRY}
---
ts: 2026-05-29T00:00:00Z
kind: sequencing
severity: minor
phase: 9
affects: [scripts/check-decision-log.sh]
---

- **Context:** second context.
- **Chosen:** second choice.
- **Reason:** second reason.
`;

let repo: string;

function git(dir: string, args: readonly string[]): void {
  Bun.spawnSync(["git", ...args], { cwd: dir });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdl-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

// Write the given files, commit, and return the resulting HEAD sha.
function writeCommit(
  dir: string,
  files: Readonly<Record<string, string>>,
  msg: string,
): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir });
  return new TextDecoder().decode(r.stdout).trim();
}

function runScript(
  cwd: string,
  args: readonly string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bash", SCRIPT_PATH, ...args], { cwd });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("scripts/check-decision-log.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("clean: no substrate change (docs only)", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(repo, { "docs/foo.md": "doc\n" }, "docs change");
    const { exitCode, stdout } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("violation: substrate change, no decision entry, no opt-out", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      { "src/channels/foo.ts": "export const x = 1;\n" },
      "substrate change",
    );
    const { exitCode, stderr } = runScript(repo, [base]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("DLOG-001");
  });

  it("clean: substrate change WITH a net-new decision entry (added ts: line)", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      {
        "src/channels/foo.ts": "export const x = 1;\n",
        "decisions/phase-9.md": SAMPLE_ENTRY,
      },
      "substrate + decision",
    );
    const { exitCode } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
  });

  it("violation: substrate change + decisions/ touched but NO net-new entry (header-only)", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      {
        "src/channels/foo.ts": "export const x = 1;\n",
        "decisions/phase-9.md": "# Decision Log — Phase 9\n",
      },
      "substrate + header-only decisions touch (no entry)",
    );
    const { exitCode, stderr } = runScript(repo, [base]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("DLOG-001");
    expect(stderr).toContain("no NET-NEW entry");
  });

  it("violation: substrate change + typo edit on an existing entry (no net-new ts:)", () => {
    const base = writeCommit(
      repo,
      { "README.md": "# x\n", "decisions/phase-9.md": SAMPLE_ENTRY },
      "base with an existing decision entry",
    );
    writeCommit(
      repo,
      {
        "src/channels/foo.ts": "export const x = 1;\n",
        "decisions/phase-9.md": SAMPLE_ENTRY_TYPO_FIXED,
      },
      "substrate + typo edit on existing entry",
    );
    const { exitCode, stderr } = runScript(repo, [base]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("DLOG-001");
  });

  it("clean: substrate change + net-new entry appended to an existing decisions file", () => {
    const base = writeCommit(
      repo,
      { "README.md": "# x\n", "decisions/phase-9.md": SAMPLE_ENTRY },
      "base with an existing decision entry",
    );
    writeCommit(
      repo,
      {
        "src/channels/foo.ts": "export const x = 1;\n",
        "decisions/phase-9.md": SAMPLE_ENTRY_PLUS_SECOND,
      },
      "substrate + appended new entry",
    );
    const { exitCode } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
  });

  it("clean: substrate change WITH an opt-out trailer", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      { "src/channels/foo.ts": "export const x = 1;\n" },
      "substrate change\n\nDecision-log: none (mechanical rename, no decision warranted)",
    );
    const { exitCode } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
  });

  it("clean: only *.test.ts under src changed (tests are not substrate)", () => {
    const base = writeCommit(repo, { "README.md": "# x\n" }, "base");
    writeCommit(
      repo,
      { "src/channels/foo.test.ts": "import { expect } from 'bun:test';\n" },
      "test only",
    );
    const { exitCode } = runScript(repo, [base]);
    expect(exitCode).toBe(0);
  });

  it("error: unresolvable base ref exits 2 (never silently passes)", () => {
    writeCommit(repo, { "README.md": "# x\n" }, "base");
    const { exitCode, stderr } = runScript(repo, ["definitely-not-a-ref"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not found");
  });
});
