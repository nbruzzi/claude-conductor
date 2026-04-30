// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — CLI verb test for D-ARCH5 prelude eval.
 *
 * Spawns the CLI as a subprocess (matching the slash-command eval
 * invocation pattern). Asserts stdout shape `export
 * CLAUDE_DOTFILES_ROOT_RESOLVED='<path>'` and that the path is
 * shell-safe (single-quoted; embedded quotes escaped).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "cli",
  "resolve-dotfiles-root.ts",
);
const SID = "94a8058c-d764-43e1-a87e-b43126b7fe90";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "rdr-cli-"));
  mkdirSync(join(tmpHome, ".claude", "logs"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function run(
  args: readonly string[],
  envOverride: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const merged: Record<string, string | undefined> = {
    HOME: tmpHome,
    CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR: join(tmpHome, "active-sessions"),
    ...envOverride,
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !(k in merged)) env[k] = v;
  }
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  // Drop any previously-set tier 1/3 env so subprocess doesn't inherit
  // a stale state from the surrounding test runner.
  delete env["CLAUDE_DOTFILES_ROOT"];
  delete env["DOTFILES_ROOT"];
  // Re-apply explicit overrides for this case.
  for (const [k, v] of Object.entries(envOverride)) {
    if (v !== undefined) env[k] = v;
  }

  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("resolve-dotfiles-root CLI verb (D-ARCH5)", () => {
  it("prints `export CLAUDE_DOTFILES_ROOT_RESOLVED='<path>'` for tier 1", async () => {
    const r = await run(["--session-id", SID], {
      CLAUDE_DOTFILES_ROOT: "/explicit/override",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      `export CLAUDE_DOTFILES_ROOT_RESOLVED='/explicit/override'\n`,
    );
  });

  it("falls through to tier 4 default when no env / sentinel set", async () => {
    const r = await run(["--session-id", SID]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("export CLAUDE_DOTFILES_ROOT_RESOLVED=");
    expect(r.stdout).toContain(".claude-dotfiles");
  });

  it("works without --session-id (falls through tier 2; tiers 1/3/4 still resolve)", async () => {
    const r = await run([], { CLAUDE_DOTFILES_ROOT: "/no-sid-path" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      `export CLAUDE_DOTFILES_ROOT_RESOLVED='/no-sid-path'\n`,
    );
  });

  it("shell-escapes paths containing single quotes (defensive)", async () => {
    const r = await run(["--session-id", SID], {
      CLAUDE_DOTFILES_ROOT: "/path/with'quote",
    });
    expect(r.exitCode).toBe(0);
    // Single quotes inside single-quoted strings use the `'\''` shell-
    // escape pattern (close, escaped quote, reopen).
    expect(r.stdout).toBe(
      `export CLAUDE_DOTFILES_ROOT_RESOLVED='/path/with'\\''quote'\n`,
    );
  });

  it("emits exactly one line (no trailing noise)", async () => {
    const r = await run(["--session-id", SID]);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });
});
