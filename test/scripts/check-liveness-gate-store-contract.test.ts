// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for scripts/check-liveness-gate-store-contract.sh (A1 enforcement-check,
 * LGC-001). The check is an allow-list-gated TRIPWIRE: any src/ (non-test) file
 * that CALLS a liveness prefix-helper (isSessionLiveByPrefix /
 * isSidPrefixLiveOnChannel) must be on the ALLOWLIST (a classified, store-
 * contract-verified gate); a NEW caller is flagged so it cannot ship a single-
 * store alive-anywhere gate silently.
 *
 * Each case runs the real script against a HERMETIC temp git repo (mkdtemp +
 * git init) so it never reads the parent repo's tree.
 */

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
  "check-liveness-gate-store-contract.sh",
);

// The two liveness prefix-helper names, assembled at runtime so this test file
// is never itself a "caller" if some future scope-widening scans test/.
const FN_ACTIVE = ["isSessionLive", "ByPrefix"].join("");
const FN_CHANNEL = ["isSidPrefixLive", "OnChannel"].join("");

let repo: string;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lgc-test-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function write(rel: string, body: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function commit(): void {
  Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-q", "-m", "fixture"], { cwd: repo });
}

function run(): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bash", SCRIPT_PATH], { cwd: repo });
  return {
    exitCode: r.exitCode ?? -1,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

describe("scripts/check-liveness-gate-store-contract.sh", () => {
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it("exits 0 on a tree with no liveness-prefix-helper callers", () => {
    write("src/foo.ts", "export const x = 1;\n");
    commit();
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags a NEW src file calling the active-sessions prefix-helper (LGC-001)", () => {
    write(
      "src/new-gate.ts",
      `import { ${FN_ACTIVE} } from "../active-sessions/index.ts";\nexport const live = ${FN_ACTIVE}("aa", 0);\n`,
    );
    commit();
    const { exitCode, stderr } = run();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[LGC-001]");
    expect(stderr).toContain("src/new-gate.ts");
    expect(stderr).toContain("liveness-gate-store-contract");
  });

  it("flags a NEW src file calling the channel prefix-helper (LGC-001)", () => {
    write(
      "src/other-gate.ts",
      `import { ${FN_CHANNEL} } from "../channels/index.ts";\nexport const live = ${FN_CHANNEL}("aa", "coordination", 0, 60000);\n`,
    );
    commit();
    const { exitCode, stderr } = run();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[LGC-001]");
    expect(stderr).toContain("src/other-gate.ts");
  });

  it("does NOT flag an ALLOW-LISTED gate calling a prefix-helper", () => {
    // A known, classified gate path (the dotfiles worktree reaper) is on the
    // ALLOWLIST — verified-compliant, so calling the helper is expected.
    write(
      "src/hooks/checks/dotfiles-worktree-gc.ts",
      `import { ${FN_ACTIVE} } from "../../active-sessions/index.ts";\nexport const live = ${FN_ACTIVE}("aa", 0);\n`,
    );
    commit();
    const { exitCode } = run();
    expect(exitCode).toBe(0);
  });

  it("does NOT flag a comment-only mention (not a call)", () => {
    write(
      "src/doc.ts",
      `// the mirror of ${FN_ACTIVE} for the channel store\nexport const x = 1;\n`,
    );
    commit();
    const { exitCode } = run();
    expect(exitCode).toBe(0);
  });

  it("does NOT scan test files (a .test.ts caller is out of scope)", () => {
    write(
      "src/foo.test.ts",
      `import { ${FN_ACTIVE} } from "../active-sessions/index.ts";\nexport const live = ${FN_ACTIVE}("aa", 0);\n`,
    );
    commit();
    const { exitCode } = run();
    expect(exitCode).toBe(0);
  });

  // Delta's N1 (#198): the awk comment-strip must not mis-handle .ts syntax.
  it("flags a TS #private-field call — a leading # is a private field, NOT a comment (LGC-001)", () => {
    // Pre-fix the bash-`#` strip dropped this line as a comment -> false-negative.
    write(
      "src/private-field-gate.ts",
      `export class Gate {\n  #live = ${FN_ACTIVE}("aa", 0);\n}\n`,
    );
    commit();
    const { exitCode, stderr } = run();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error[LGC-001]");
    expect(stderr).toContain("src/private-field-gate.ts");
  });

  it("does NOT flag a single-line /* */ block-comment mention", () => {
    // Pre-fix a `/*`-opener line was not stripped (^* matches ` * `, not `/*`)
    // -> false-positive; the added `/*` rule strips it.
    write(
      "src/block-comment.ts",
      `/* see ${FN_ACTIVE} for the active-sessions probe */\nexport const x = 1;\n`,
    );
    commit();
    const { exitCode } = run();
    expect(exitCode).toBe(0);
  });
});
