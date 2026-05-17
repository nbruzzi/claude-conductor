// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 3 Slice 2 — REV 0.2 ARCH-5 integration test.
 *
 * Slash commands prepend a shell prelude that calls the
 * resolve-dotfiles-root CLI. Post-L:894 (2026-05-17), the preferred form
 * is direct-assign with `--print`:
 *
 *   CLAUDE_DOTFILES_ROOT_RESOLVED="$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --print --session-id "$CLAUDE_SESSION_ID" 2>/dev/null)" \
 *     || { echo "[prelude] resolve-dotfiles-root failed; falling back" >&2; CLAUDE_DOTFILES_ROOT_RESOLVED=""; }
 *
 * Legacy form (preserved for backwards-compat):
 *
 *   eval "$(bun run "${CLAUDE_PLUGIN_ROOT:-$HOME/claude-conductor}/src/cli/resolve-dotfiles-root.ts" --session-id "$CLAUDE_SESSION_ID")"
 *
 * The plan's failure-mode invariant: if the bun-run subprocess fails
 * (broken lockfile, missing exports map, plugin not bun-installed), the
 * caller's `|| { ... fallback ... }` chain kicks in; `CLAUDE_DOTFILES_ROOT_RESOLVED`
 * stays unset/empty, and the downstream `${...:-${CLAUDE_DOTFILES_ROOT:-$HOME/.claude-dotfiles}}`
 * fallback takes over.
 *
 * This test spawns a subshell, runs both prelude shapes, and verifies:
 *   - SUCCESS legacy eval path: CLAUDE_DOTFILES_ROOT_RESOLVED set + matches resolver output.
 *   - SUCCESS legacy tier-1 (CLAUDE_DOTFILES_ROOT) round-trip.
 *   - SUCCESS --print direct-assign path: VAR set to bare path on one line.
 *   - SUCCESS --print tier-1 round-trip.
 *   - FAILURE legacy path (non-existent CLI): no var assignment; var stays unset.
 *   - FAILURE direct-assign path: fallback kicks in; downstream chain still works.
 *   - --help path: usage block on stdout; exit 0.
 *   - argv parse error: unknown flag → exit 2 + stderr message; --session-id missing
 *     value → exit 2.
 *   - --print output contract: bare path, single line, no shell syntax.
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

describe("slash-command prelude — legacy eval form (D-ARCH5)", () => {
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

describe("slash-command prelude — --print direct-assign (post-L:894)", () => {
  it("SUCCESS path: VAR=$(... --print) sets CLAUDE_DOTFILES_ROOT_RESOLVED to a non-empty path", async () => {
    const script = `
set -euo pipefail
CLAUDE_DOTFILES_ROOT_RESOLVED="$(bun run '${CLI_PATH}' --print --session-id '${SID}' 2>/dev/null)" \\
  || { echo "[prelude] resolve-dotfiles-root failed; falling back" >&2; CLAUDE_DOTFILES_ROOT_RESOLVED=""; }
echo "RESOLVED=\${CLAUDE_DOTFILES_ROOT_RESOLVED:-UNSET}"
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("RESOLVED=");
    expect(r.stdout).not.toContain("RESOLVED=UNSET");
    expect(r.stdout).toContain(".claude-dotfiles");
  });

  it("SUCCESS path: tier 1 (CLAUDE_DOTFILES_ROOT) round-trips through --print", async () => {
    const script = `
set -euo pipefail
export CLAUDE_DOTFILES_ROOT='/explicit/override'
CLAUDE_DOTFILES_ROOT_RESOLVED="$(bun run '${CLI_PATH}' --print --session-id '${SID}' 2>/dev/null)" \\
  || { CLAUDE_DOTFILES_ROOT_RESOLVED=""; }
echo "RESOLVED=\${CLAUDE_DOTFILES_ROOT_RESOLVED:-UNSET}"
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("RESOLVED=/explicit/override");
  });

  it("--print output contract: bare path, single line, no `export` keyword, no quoting", async () => {
    const script = `
set -euo pipefail
out="$(bun run '${CLI_PATH}' --print --session-id '${SID}')"
# Assert no shell syntax in the output
case "$out" in
  *export*) echo "FAIL: output contains 'export'"; exit 1 ;;
  *\\'*)    echo "FAIL: output contains single-quote"; exit 1 ;;
  *)        echo "OK"; echo "PATH=$out" ;;
esac
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK");
    expect(r.stdout).toContain("PATH=");
    expect(r.stdout).not.toContain("export");
  });

  it("FAILURE path: --print with non-existent CLI triggers fallback breadcrumb on stderr", async () => {
    const script = `
set -euo pipefail
export CLAUDE_DOTFILES_ROOT='/fallback/path'
CLAUDE_DOTFILES_ROOT_RESOLVED="$(bun run /definitely/not/a/real/script.ts --print --session-id '${SID}' 2>/dev/null)" \\
  || { echo "[prelude] resolve-dotfiles-root failed; falling back" >&2; CLAUDE_DOTFILES_ROOT_RESOLVED=""; }
TARGET="\${CLAUDE_DOTFILES_ROOT_RESOLVED:-\${CLAUDE_DOTFILES_ROOT:-\$HOME/.claude-dotfiles}}"
echo "TARGET=\${TARGET}"
`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("TARGET=/fallback/path");
    expect(r.stderr).toContain("[prelude] resolve-dotfiles-root failed");
  });
});

describe("resolve-dotfiles-root CLI — flag handling (L:894 folds)", () => {
  it("--help prints usage block + exits 0", async () => {
    const script = `bun run '${CLI_PATH}' --help`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--print");
    expect(r.stdout).toContain("--session-id");
  });

  it("-h shortcut prints usage block + exits 0", async () => {
    const script = `bun run '${CLI_PATH}' -h`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  it("argv parse error (unknown flag) exits 2 with stderr message", async () => {
    const script = `bun run '${CLI_PATH}' --bogus-flag 2>&1 1>/dev/null; echo "exit=$?"`;
    const r = await runShell(script);
    // exit code from echo is 0; the captured "exit=N" indicates the resolver's
    // exit code
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("exit=2");
  });

  it("argv parse error (--session-id with no value) exits 2", async () => {
    const script = `bun run '${CLI_PATH}' --session-id 2>&1 1>/dev/null; echo "exit=$?"`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("exit=2");
  });

  it("argv parse error (--session-id followed by another flag) exits 2", async () => {
    const script = `bun run '${CLI_PATH}' --session-id --print 2>&1 1>/dev/null; echo "exit=$?"`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("exit=2");
  });

  it("--print without --session-id still resolves (tiers 1/3/4 work)", async () => {
    const script = `bun run '${CLI_PATH}' --print`;
    const r = await runShell(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    expect(r.stdout).toContain(".claude-dotfiles");
  });

  it("argv interleaving: --print --session-id <sid> equivalent to --session-id <sid> --print", async () => {
    const a = await runShell(
      `bun run '${CLI_PATH}' --print --session-id '${SID}'`,
    );
    const b = await runShell(
      `bun run '${CLI_PATH}' --session-id '${SID}' --print`,
    );
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});
