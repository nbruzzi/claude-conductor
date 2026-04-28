// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Auto-format edited files with prettier.
 * Array-form Bun.spawn — no shell injection.
 */

import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import type { HookInput, HookResult } from "../types.ts";
import { pass, warn } from "../types.ts";

const SOURCE = "auto-format";
const TIMEOUT_MS = 5_000;

const FORMATTABLE = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".md",
  ".html",
  ".yaml",
  ".yml",
]);

/**
 * Walk up from the file's directory to find the nearest ancestor containing
 * `.prettierignore`. Prettier does not walk up for ignore files — it resolves
 * `.prettierignore` relative to cwd only — so when the Claude session's cwd is
 * a sub-package (e.g. HeatPrice's `site/`) and the ignore lives at the repo
 * root, prettier silently skips the ignore and reformats files the user
 * explicitly excluded. This helper does the walk-up the hook needs.
 *
 * Incident 2026-04-19: session cwd was `/site/`, `.prettierignore` at repo root
 * excluded `planning/decisions.md`, prettier never saw the ignore, frozen
 * ledger rows were re-padded, verify:decisions-ledger-frozen failed on push.
 */
export function findIgnorePath(filePath: string): string | undefined {
  let dir = dirname(filePath);
  const fsRoot = parse(dir).root;
  while (true) {
    const candidate = join(dir, ".prettierignore");
    if (existsSync(candidate)) return candidate;
    if (dir === fsRoot) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function check(input: HookInput): Promise<HookResult> {
  const file = input.filePath;
  if (!file) return pass();

  const bunFile = Bun.file(file);
  if (!(await bunFile.exists())) return pass();

  const ext = file.substring(file.lastIndexOf("."));
  if (!FORMATTABLE.has(ext)) return pass();

  const ignorePath = findIgnorePath(file);
  // Array-form spawn — no shell interpolation. Double-dash prevents
  // filenames starting with -- from being interpreted as flags.
  // --ignore-path is passed explicitly so the hook honors an ancestor
  // .prettierignore regardless of where the Claude session was launched.
  const args = ["prettier", "--write"];
  if (ignorePath !== undefined) args.push("--ignore-path", ignorePath);
  args.push("--", file);
  const proc = Bun.spawn(args, {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    stdout: "ignore",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
  });

  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    if (proc.signalCode === "SIGTERM") {
      return warn(
        SOURCE,
        `prettier timed out after ${TIMEOUT_MS / 1000}s on ${file} — file may be unformatted`,
      );
    }
    // Non-timeout prettier failure surfaces as user-visible warn — silent
    // swallow (pass() with at most a console.error) hides quality regressions
    // until the user notices unformatted diff noise. Cover BOTH the with-stderr
    // and empty-stderr paths (e.g. OOM kill leaves stderr empty). Sub-step 0.10
    // RE-3, expanded per cross-audit RE-A4.
    const detail = stderr.trim()
      ? stderr.slice(0, 200)
      : `(no stderr output, exit code ${exitCode})`;
    return warn(
      SOURCE,
      `prettier failed on ${file}: ${detail} — file may be unformatted`,
    );
  }

  return pass();
}
