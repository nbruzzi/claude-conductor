// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — REV 0.2 ARCH-5 integration test.
 *
 * Slash commands prepend a shell eval prelude that calls the
 * resolve-dotfiles-root CLI:
 *
 *   eval "$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --session-id "$CLAUDE_SESSION_ID")"
 *
 * The plan's failure-mode invariant: if the bun-run subprocess fails
 * (broken lockfile, missing exports map, plugin not bun-installed), the
 * eval produces empty stdout, `CLAUDE_DOTFILES_ROOT_RESOLVED` stays
 * unset, and the slash command's downstream fallback kicks in
 * (`$CLAUDE_DOTFILES_ROOT` env → `$HOME/.claude-dotfiles` default).
 *
 * This test spawns a subshell, runs the eval pattern, and verifies:
 * - SUCCESS path: CLAUDE_DOTFILES_ROOT_RESOLVED is set + matches the
 *   resolver's output.
 * - FAILURE path (synthetic — running a non-existent script): eval
 *   produces no var assignment; CLAUDE_DOTFILES_ROOT_RESOLVED stays unset.
 *
 * Doesn't exercise the breadcrumb path on bun-run failure (silent
 * fall-through is the design — operators see absence of the var, not a
 * breadcrumb on the resolve-dotfiles-root side).
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
  tmpHome = mkdtempSync(join(tmpdir(), "prelude-"));
  mkdirSync(join(tmpHome, ".claude", "logs"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function runShell(
  script: string,
  envOverride: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["HOME"] = tmpHome;
  env["CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR"] = join(
    tmpHome,
    "active-sessions",
  );
  delete env["CLAUDE_DOTFILES_ROOT"];
  delete env["DOTFILES_ROOT"];
  delete env["CLAUDE_DOTFILES_ROOT_RESOLVED"];
  for (const [k, v] of Object.entries(envOverride)) env[k] = v;

  const proc = Bun.spawn(["bash", "-c", script], {
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

describe("slash-command prelude eval (D-ARCH5 integration)", () => {
  it("SUCCESS path: eval sets CLAUDE_DOTFILES_ROOT_RESOLVED to a non-empty path", async () => {
    const script = `
set -euo pipefail
eval "$(bun run '${CLI_PATH}' --session-id '${SID}')"
echo "RESOLVED=\${CLAUDE_DOTFILES_ROOT_RESOLVED:-UNSET}"
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("RESOLVED=");
    expect(r.stdout).not.toContain("RESOLVED=UNSET");
    expect(r.stdout).toContain(".claude-dotfiles");
  });

  it("SUCCESS path: tier 1 (CLAUDE_DOTFILES_ROOT) round-trips through eval", async () => {
    const script = `
set -euo pipefail
export CLAUDE_DOTFILES_ROOT='/explicit/override'
eval "$(bun run '${CLI_PATH}' --session-id '${SID}')"
echo "RESOLVED=\${CLAUDE_DOTFILES_ROOT_RESOLVED:-UNSET}"
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("RESOLVED=/explicit/override");
  });

  it("FAILURE path (non-existent CLI): eval produces no assignment; var stays unset", async () => {
    const script = `
set -euo pipefail
eval "$(bun run /definitely/not/a/real/script.ts --session-id '${SID}' 2>/dev/null || true)"
echo "RESOLVED=\${CLAUDE_DOTFILES_ROOT_RESOLVED:-UNSET}"
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("RESOLVED=UNSET");
  });

  it("FAILURE path: downstream fallback expansion still works when prelude var is unset", async () => {
    const script = `
set -euo pipefail
export CLAUDE_DOTFILES_ROOT='/fallback/path'
eval "$(bun run /definitely/not/a/real/script.ts --session-id '${SID}' 2>/dev/null || true)"
TARGET="\${CLAUDE_DOTFILES_ROOT_RESOLVED:-\${CLAUDE_DOTFILES_ROOT:-\$HOME/.claude-dotfiles}}"
echo "TARGET=\${TARGET}"
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("TARGET=/fallback/path");
  });
});
