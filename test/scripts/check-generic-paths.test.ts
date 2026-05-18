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
import { join } from "node:path";

const SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "check-generic-paths.sh",
);

let repo: string;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cgp-test-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function commit(dir: string, msg = "init"): void {
  Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "-q", "-m", msg], { cwd: dir });
}

function runScript(
  cwd: string,
  args: readonly string[] = [],
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(["bash", SCRIPT_PATH, ...args], { cwd });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("scripts/check-generic-paths.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("exits 0 on a clean tree", () => {
    writeFileSync(join(repo, "ok.ts"), "export const x = 1;\n");
    commit(repo);
    const { exitCode, stdout, stderr } = runScript(repo);
    if (exitCode !== 0) {
      console.error(`Unexpected exit ${exitCode}:`);
      console.error(`STDOUT: ${stdout}`);
      console.error(`STDERR: ${stderr}`);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
    expect(stdout).toContain("0 violations");
  });

  it("flags hardcoded substrate identifier in source code (P1)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    // Build the literal at runtime so this test file itself doesn't contain
    // the substrate identifier (avoids self-flagging in the parent repo).
    const ident = ["nbr", "uzz", "i"].join("");
    writeFileSync(
      join(repo, "src", "foo.ts"),
      `export const path = '/home/${ident}/data';\n`,
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[P1]");
    expect(stderr).toContain("src/foo.ts");
    expect(stderr).toContain("hardcoded user identifier");
  });

  it("flags hardcoded /Users/<name>/ paths (P2)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "bar.ts"),
      "export const root = '/Users/somebody/data';\n",
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[P2]");
    expect(stderr).toContain("src/bar.ts");
    expect(stderr).toContain("non-portable");
  });

  it("suppresses canonical SPDX header (Layer 2)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "headered.ts"),
      "// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 nbruzzi\n\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("suppresses JSDoc narration lines (Layer 3)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "narrated.ts"),
      "/**\n * See nbruzzi/claude-dotfiles for context.\n */\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags \\.claude/ literal in non-allowlisted source file (P3)", () => {
    mkdirSync(join(repo, "src", "hooks", "checks"), { recursive: true });
    writeFileSync(
      join(repo, "src", "hooks", "checks", "newcheck.ts"),
      "export function check() { return `${process.env.HOME}/.claude/newcheck-state`; }\n",
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[P3]");
    expect(stderr).toContain("src/hooks/checks/newcheck.ts");
    expect(stderr).toContain("route through paths.ts");
  });

  it("does NOT flag \\.claude/ in JSDoc narration (Layer 3 generic for P3)", () => {
    mkdirSync(join(repo, "src", "hooks", "checks"), { recursive: true });
    writeFileSync(
      join(repo, "src", "hooks", "checks", "narrated.ts"),
      "/**\n * Reads from ~/.claude/conductor/foo for context.\n */\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("scans markdown in commands/session/ directory (CLI-1 regression test)", () => {
    mkdirSync(join(repo, "commands", "session"), { recursive: true });
    // Build literals at runtime to avoid self-flagging this test file.
    const ident = ["nbr", "uzz", "i"].join("");
    writeFileSync(
      join(repo, "commands", "session", "fakehandoff.md"),
      `# Fake handoff\n\n\`\`\`bash\ncd /Users/${ident}/.claude-dotfiles\n\`\`\`\n`,
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[P1]");
    expect(stderr).toContain("commands/session/fakehandoff.md");
  });

  it("does NOT flag P3 alone in markdown files (documentation, not runtime)", () => {
    mkdirSync(join(repo, "skills"), { recursive: true });
    writeFileSync(
      join(repo, "skills", "doc.md"),
      "# Skill\n\nReads from ~/.claude/something/foo.\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags isolated hex SHA in source code (P4)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "fixture.ts"),
      "export const SHA = abc1234;\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stderr } = runScript(repo);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[P4]");
    expect(stderr).toContain("src/fixture.ts");
    expect(stderr).toContain("potential anonymization leak");
  });

  it("does NOT flag hex inside lowercase word (FP class: 'feedbac' in 'feedback')", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "fp.ts"),
      "export const label = 'feedback-driven';\nexport const succeeded = true;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("does NOT flag backtick-quoted hex (intentional code reference)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "quoted.ts"),
      "/**\n * Fixed in commit `fec3849`, see history.\n */\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("does NOT flag hex in JSDoc narration (Layer 3 generic for P4)", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "narrated.ts"),
      "/**\n * Example: branch refs/heads/worktree/abc12345 has the right shape.\n */\nexport const x = 1;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("does NOT flag P4 alone in test fixtures (test/ allowlist)", () => {
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(
      join(repo, "test", "fixture.test.ts"),
      "const SID = '11111111-1111-4111-8111-111111111111';\nconst SHA = abc1234567;\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("does NOT flag P4 alone in markdown files (documentation, not runtime)", () => {
    mkdirSync(join(repo, "commands"), { recursive: true });
    writeFileSync(
      join(repo, "commands", "doc.md"),
      "# Example\n\nFixed at commit abc1234567 per the slice-4 retrospective.\n",
    );
    commit(repo);
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  /* ── CLI-3b — --include-untracked flag (slice 6 / B2) ─────────────── */

  it("does NOT flag P3 leak in untracked file by default (tracked-only gate)", () => {
    writeFileSync(join(repo, "ok.ts"), "export const x = 1;\n");
    commit(repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "new-thing.ts"),
      'const home = "~/.claude/leak/";\n',
    );
    const { exitCode, stdout } = runScript(repo);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
    expect(stdout).toContain("1 untracked file(s) not scanned");
  });

  it("flags P3 leak in untracked file when --include-untracked is set", () => {
    writeFileSync(join(repo, "ok.ts"), "export const x = 1;\n");
    commit(repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "new-thing.ts"),
      'const home = "~/.claude/leak/";\n',
    );
    const { exitCode, stderr } = runScript(repo, ["--include-untracked"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/new-thing.ts");
    expect(stderr).toContain("error[P3]");
  });

  it("reports the untracked-included count in the clean summary", () => {
    writeFileSync(join(repo, "tracked.ts"), "export const x = 1;\n");
    commit(repo);
    writeFileSync(join(repo, "untracked.ts"), "export const y = 2;\n");
    const { exitCode, stdout } = runScript(repo, ["--include-untracked"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tracked files + 1 untracked files");
    expect(stdout).toContain("--include-untracked");
  });

  it("honors EXCLUDE_PATHSPECS for untracked files (top-level README.md not scanned)", () => {
    writeFileSync(join(repo, "ok.ts"), "export const x = 1;\n");
    commit(repo);
    // Untracked top-level README.md with a /Users/<name>/ leak (P2). The
    // EXCLUDE_PATHSPECS list at script lines 62-88 excludes top-level
    // docs; the flag must honor the same excludes on the untracked side
    // (matches CONTENT-CHARACTERIZATION semantics, not staging-state).
    writeFileSync(
      join(repo, "README.md"),
      "# Example\n\nSee /Users/alice/ for details.\n",
    );
    const { exitCode, stdout } = runScript(repo, ["--include-untracked"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("errors on unknown argument with helpful hint", () => {
    writeFileSync(join(repo, "ok.ts"), "export const x = 1;\n");
    commit(repo);
    const { exitCode, stderr } = runScript(repo, ["--bogus-flag"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown argument");
    expect(stderr).toContain("--help");
  });
});
