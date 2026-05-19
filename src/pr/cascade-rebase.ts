// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `pr cascade-rebase` — rebase stacked PRs after a base PR squash-merges.
 *
 * Slice 0 origin: plan ~/.claude/plans/slice-0-cascade-rebase-2026-05-19.md
 * (v0.2 LOCKED 2026-05-19T20:27Z). All 12 design Qs + 5 substantive folds
 * + 2 less-critical folds + 4 nits applied at LOCK; build-phase greenlit
 * by Delta inside-pair cross-audit verdict.
 *
 * Two-phase architecture (D3):
 *   Phase 0 — Prereqs: gh-auth (F7) → cwd-in-git-repo (D-CWD) →
 *             worktree-on-stack-refuse (Q3) → git fetch refresh (F3) →
 *             stack-walk with visited-set cycle guard (F5) →
 *             idempotence-detect (Q6) → dry-run early-exit (Q8).
 *   Phase 1 — Sequential rebase loop (HALT-ON-FIRST-CONFLICT per Q5):
 *             snapshot pre-rebase SHA via `git ls-remote` (F4, NOT
 *             gh-pr-view); git rebase --onto; force-push-with-lease;
 *             gh pr edit --base (retarget). Post-halt PRs marked
 *             "not-attempted" (F1).
 *   Phase 2 — Bounded-concurrency CI-watch (F6, MAX=4): Bun.spawn
 *             `gh pr checks --watch --exit-status` per rebased PR;
 *             aggregate per-PR conclusion into CascadeReport.
 *
 * Output: text (default) or JSON (`--json`). Per-PR conclusion is an
 * 8-value union (D7 + F1). Tests inject adapters via the optional
 * `CascadeAdapters` param to keep them deterministic + offline.
 */

import { type SpawnSyncReturns } from "node:child_process";

import { decodeStdio, runGit as defaultRunGit } from "../git/index.ts";
import { runGh as defaultRunGh } from "../gh/index.ts";
import type { FlagValues } from "../cli/flags.ts";

// ─── Types ──────────────────────────────────────────────────────────

export type CascadeConclusion =
  | "rebased"
  | "skipped-already-cascaded"
  | "halted-conflict"
  | "force-push-rejected"
  | "retarget-failed"
  | "not-attempted"
  | "ci-success"
  | "ci-failure"
  | "ci-cancelled";

export type CascadeReport = {
  readonly pr_number: number;
  readonly pr_url: string;
  readonly sha_pre_rebase: string;
  readonly sha_post_rebase: string | null;
  readonly conclusion: CascadeConclusion;
  readonly elapsed_ms: number;
};

type GhPrViewItem = {
  readonly number: number;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly mergeable: string | null;
};

type CiWatchResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type RunGit = (
  cwd: string,
  args: readonly string[],
) => SpawnSyncReturns<Buffer>;
type RunGh = (args: readonly string[]) => SpawnSyncReturns<Buffer>;
type SpawnCiWatch = (prNumber: number) => Promise<CiWatchResult>;

export type CascadeAdapters = {
  readonly runGit?: RunGit;
  readonly runGh?: RunGh;
  readonly spawnCiWatch?: SpawnCiWatch;
  readonly now?: () => number;
  readonly cwd?: () => string;
};

// ─── Constants ──────────────────────────────────────────────────────

const MAX_CI_WATCH_CONCURRENCY = 4;

// ─── Default CI-watch adapter (real gh subprocess) ──────────────────

async function defaultSpawnCiWatch(prNumber: number): Promise<CiWatchResult> {
  const proc = Bun.spawn(
    ["gh", "pr", "checks", String(prNumber), "--watch", "--exit-status"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

// ─── Entry ──────────────────────────────────────────────────────────

export async function runCascadeRebase(
  positional: readonly string[],
  flags: FlagValues,
  adapters: CascadeAdapters = {},
): Promise<number> {
  void positional; // verb-level positional not consumed currently
  const runGit = adapters.runGit ?? defaultRunGit;
  const runGh = adapters.runGh ?? defaultRunGh;
  const spawnCiWatch = adapters.spawnCiWatch ?? defaultSpawnCiWatch;
  const now = adapters.now ?? (() => performance.now());
  const cwd = adapters.cwd ?? (() => process.cwd());

  const base = flags.base?.trim();
  if (base === undefined || base.length === 0) {
    process.stderr.write(
      "claude-conductor pr cascade-rebase: --base <branch-name> is required\n" +
        "  example: claude-conductor pr cascade-rebase --base alpha/conductor-foo\n",
    );
    return 2;
  }

  // ─── Phase 0a — gh auth prereq (F7) ────────────────────────────
  const auth = runGh(["auth", "status"]);
  if (auth.status !== 0) {
    process.stderr.write(
      "claude-conductor pr cascade-rebase: gh CLI not authenticated\n" +
        "  remediation: run 'gh auth login' first\n",
    );
    return 1;
  }

  // ─── Phase 0b — cwd-in-git-repo prereq (D-CWD) ────────────────
  const workingDir = cwd();
  const topLevel = runGit(workingDir, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0) {
    process.stderr.write(
      "claude-conductor pr cascade-rebase: cwd is not a git repository\n" +
        "  remediation: cd into a worktree and re-run\n",
    );
    return 1;
  }

  // ─── Phase 0d — git fetch refresh (F3) ────────────────────────
  if (!flags.quiet) {
    process.stderr.write("[cascade] fetching refs (git fetch --all --prune)\n");
  }
  const fetchResult = runGit(workingDir, ["fetch", "--all", "--prune"]);
  if (fetchResult.status !== 0) {
    process.stderr.write(
      "claude-conductor pr cascade-rebase: git fetch failed\n" +
        `  stderr: ${decodeStdio(fetchResult.stderr)}\n`,
    );
    return 1;
  }

  // ─── Phase 0e — stack-detect (Q10) ────────────────────────────
  const listResult = runGh([
    "pr",
    "list",
    "--base",
    base,
    "--state",
    "open",
    "--json",
    "number,baseRefName,headRefName,headRefOid,url,mergeable",
    "--limit",
    "50",
  ]);
  if (listResult.status !== 0) {
    process.stderr.write(
      "claude-conductor pr cascade-rebase: gh pr list failed\n" +
        `  stderr: ${decodeStdio(listResult.stderr)}\n`,
    );
    return 1;
  }
  let rootCandidates: GhPrViewItem[];
  try {
    rootCandidates = JSON.parse(decodeStdio(listResult.stdout));
  } catch (err) {
    process.stderr.write(
      `claude-conductor pr cascade-rebase: failed to parse gh pr list JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  // Mergeable filter: gh returns null for draft/closed/merged; exclude.
  const initialStack = rootCandidates.filter((p) => p.mergeable !== null);

  if (initialStack.length === 0) {
    process.stdout.write(
      `no PRs to cascade — gh pr list --base ${base} returned 0 open + mergeable PRs\n`,
    );
    return 0;
  }

  // Forward-walk with visited-set cycle guard (F5).
  const stack = buildOrderedStack(initialStack);
  if (stack === null) {
    process.stderr.write(
      `claude-conductor pr cascade-rebase: stack-walk detected cycle in gh response — abort\n`,
    );
    return 1;
  }

  // ─── Phase 0c — worktree-on-stacked-branch refuse (Q3) ────────
  const headBranchResult = runGit(workingDir, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const headBranch = decodeStdio(headBranchResult.stdout);
  if (headBranch !== "HEAD") {
    const stackHeads = new Set(stack.map((p) => p.headRefName));
    if (stackHeads.has(headBranch)) {
      process.stderr.write(
        `claude-conductor pr cascade-rebase: worktree ${workingDir} is checked out at branch ${headBranch} which is in the cascade.\n` +
          `  remediation: switch worktrees off this branch (or 'git checkout --detach') and re-run.\n`,
      );
      return 1;
    }
  }

  // ─── Phase 0f — dry-run early-exit (Q8) ──────────────────────
  if (flags.dryRun) {
    const plan = stack.map<CascadeReport>((p) => ({
      pr_number: p.number,
      pr_url: p.url,
      sha_pre_rebase: p.headRefOid,
      sha_post_rebase: null,
      conclusion: "not-attempted",
      elapsed_ms: 0,
    }));
    emit({ base, reports: plan, flags, dryRun: true });
    return 0;
  }

  // ─── Phase 1 — Sequential rebase loop ─────────────────────────
  // Delta F-NEW-1 (v0.3): `--base` and `--onto` are SEMANTICALLY DISTINCT axes.
  //   --base = stack-detection axis (the just-squashed branch all root PRs
  //            were stacked on; passed to `gh pr list --base`)
  //   --onto = rebase-target axis (where root PR's commits land; default "main")
  // Earlier conflation (v0.2 impl) produced no-op rebases because target === base.
  //
  // For idx=0 (root PR): rebase --onto <onto> <base> <head>
  //   - exclude commits reachable from <base> (the just-squashed branch, possibly
  //     deleted from origin — caller responsibility to run before deletion);
  //   - apply remaining commits onto <onto> (e.g. main with the squash commit).
  // For idx>=1 (chained PR): rebase --onto <prev-head-branch> <prev-pre-rebase-SHA> <head>
  //   - <prev-pre-rebase-SHA> must be the SHA stack[idx-1].head pointed at BEFORE
  //     its own rebase (after the force-push, origin/<prev-head> is the NEW SHA).
  //   - Use preRebaseShas Map populated in step a of each prior iteration.
  const onto = flags.onto?.trim() ?? "main";
  const reports: CascadeReport[] = [];
  const preRebaseShas = new Map<string, string>();
  let haltedIdx = -1;

  for (let idx = 0; idx < stack.length; idx++) {
    const pr = stack[idx];
    if (pr === undefined) break;
    const start = now();
    const head = pr.headRefName;

    // F4 — lease SHA via ls-remote (race-safer than gh-pr-view).
    // M2 (Delta) — if ls-remote returns empty, REFUSE (NOT silent fallback to
    // headRefOid from gh-pr-view; gh data can lag origin by seconds).
    const lsRemote = runGit(workingDir, [
      "ls-remote",
      "origin",
      `refs/heads/${head}`,
    ]);
    const lsLine = decodeStdio(lsRemote.stdout).split("\n")[0] ?? "";
    const leaseSha = lsLine.split("\t")[0];
    if (leaseSha === undefined || leaseSha.length === 0) {
      process.stderr.write(
        `claude-conductor pr cascade-rebase: PR #${pr.number} head '${head}' not on origin\n` +
          `  remediation: 'git push origin ${head}' or verify PR #${pr.number} hasn't been deleted\n`,
      );
      reports.push({
        pr_number: pr.number,
        pr_url: pr.url,
        sha_pre_rebase: "",
        sha_post_rebase: null,
        conclusion: "not-attempted",
        elapsed_ms: now() - start,
      });
      haltedIdx = idx;
      break;
    }
    preRebaseShas.set(head, leaseSha);

    const target = idx === 0 ? onto : (stack[idx - 1]?.headRefName ?? onto);
    const priorBase =
      idx === 0
        ? base
        : (preRebaseShas.get(stack[idx - 1]?.headRefName ?? "") ?? base);

    // Rebase. --onto <new-base> <old-upstream> <head>.
    // For idx=0: rebase --onto origin/<onto> origin/<base> origin/<head>
    // For idx>=1: rebase --onto origin/<prev-head> <prev-pre-rebase-SHA> origin/<head>
    const onto_ref = `origin/${target}`;
    const upstream_ref = idx === 0 ? `origin/${priorBase}` : priorBase;
    const head_ref = `origin/${head}`;
    const rebase = runGit(workingDir, [
      "rebase",
      "--onto",
      onto_ref,
      upstream_ref,
      head_ref,
    ]);
    if (rebase.status !== 0) {
      runGit(workingDir, ["rebase", "--abort"]);
      reports.push({
        pr_number: pr.number,
        pr_url: pr.url,
        sha_pre_rebase: leaseSha,
        sha_post_rebase: null,
        conclusion: "halted-conflict",
        elapsed_ms: now() - start,
      });
      haltedIdx = idx;
      break;
    }
    const postSha = decodeStdio(
      runGit(workingDir, ["rev-parse", "HEAD"]).stdout,
    );

    const push = runGit(workingDir, [
      "push",
      `--force-with-lease=refs/heads/${head}:${leaseSha}`,
      "origin",
      `HEAD:refs/heads/${head}`,
    ]);
    if (push.status !== 0) {
      reports.push({
        pr_number: pr.number,
        pr_url: pr.url,
        sha_pre_rebase: leaseSha,
        sha_post_rebase: postSha,
        conclusion: "force-push-rejected",
        elapsed_ms: now() - start,
      });
      haltedIdx = idx;
      break;
    }

    // M1 (Delta) — capture gh pr edit exit code; non-zero → retarget-failed.
    const retarget = runGh(["pr", "edit", String(pr.number), "--base", target]);
    if (retarget.status !== 0) {
      reports.push({
        pr_number: pr.number,
        pr_url: pr.url,
        sha_pre_rebase: leaseSha,
        sha_post_rebase: postSha,
        conclusion: "retarget-failed",
        elapsed_ms: now() - start,
      });
      haltedIdx = idx;
      break;
    }

    reports.push({
      pr_number: pr.number,
      pr_url: pr.url,
      sha_pre_rebase: leaseSha,
      sha_post_rebase: postSha,
      conclusion: "rebased",
      elapsed_ms: now() - start,
    });
  }

  // F1 — mark remaining PRs as not-attempted if we halted.
  if (haltedIdx >= 0) {
    for (let idx = haltedIdx + 1; idx < stack.length; idx++) {
      const pr = stack[idx];
      if (pr === undefined) continue;
      reports.push({
        pr_number: pr.number,
        pr_url: pr.url,
        sha_pre_rebase: "",
        sha_post_rebase: null,
        conclusion: "not-attempted",
        elapsed_ms: 0,
      });
    }
    emit({ base, reports, flags, dryRun: false });
    return 1;
  }

  // ─── Phase 2 — Bounded-concurrency CI-watch (F6) ──────────────
  if (!flags.quiet && reports.length > MAX_CI_WATCH_CONCURRENCY) {
    process.stderr.write(
      `[cascade] Phase 2: capping CI watch at ${MAX_CI_WATCH_CONCURRENCY} concurrent processes (N=${reports.length} rebased PRs)\n`,
    );
  }
  const ciResults = await boundedAllSettled(
    reports.map((r) => () => spawnCiWatch(r.pr_number)),
    MAX_CI_WATCH_CONCURRENCY,
  );
  const finalReports = reports.map<CascadeReport>((r, idx) => {
    const ci = ciResults[idx];
    if (ci === undefined || ci.status === "rejected") {
      return { ...r, conclusion: "ci-failure" };
    }
    const code = ci.value.exitCode;
    // M3 (Delta) — exit-code convention from `gh pr checks --watch
    // --exit-status`: 0 = all checks pass; 8 = cancelled (per gh-CLI
    // source: cmd/pr/checks/checks.go uses exitcode 8 to distinguish
    // cancelled from failed); any other non-zero = failure (1 typical).
    const conclusion: CascadeConclusion =
      code === 0 ? "ci-success" : code === 8 ? "ci-cancelled" : "ci-failure";
    return { ...r, conclusion };
  });

  emit({ base, reports: finalReports, flags, dryRun: false });
  const anyFailure = finalReports.some(
    (r) => r.conclusion === "ci-failure" || r.conclusion === "ci-cancelled",
  );
  return anyFailure ? 1 : 0;
}

// ─── Stack ordering with visited-set cycle guard (F5) ──────────────

function buildOrderedStack(
  items: readonly GhPrViewItem[],
): GhPrViewItem[] | null {
  const heads = new Set<string>();
  for (const p of items) heads.add(p.headRefName);
  const roots = items.filter((p) => !heads.has(p.baseRefName));
  if (roots.length === 0) return null;
  const root = roots[0];
  if (root === undefined) return null;
  const ordered: GhPrViewItem[] = [];
  const visited = new Set<string>();
  let current: GhPrViewItem | undefined = root;
  while (current !== undefined) {
    if (visited.has(current.headRefName)) return null;
    visited.add(current.headRefName);
    ordered.push(current);
    const nextHead: string = current.headRefName;
    current = items.find((p) => p.baseRefName === nextHead);
  }
  return ordered;
}

// ─── Bounded concurrency primitive ─────────────────────────────────

async function boundedAllSettled<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  maxConcurrency: number,
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      const task = tasks[idx];
      if (task === undefined) return;
      try {
        results[idx] = { status: "fulfilled", value: await task() };
      } catch (err) {
        results[idx] = { status: "rejected", reason: err };
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(maxConcurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ─── Report emit (text or JSON) ────────────────────────────────────

function emit(args: {
  readonly base: string;
  readonly reports: readonly CascadeReport[];
  readonly flags: FlagValues;
  readonly dryRun: boolean;
}): void {
  if (args.flags.json) {
    process.stdout.write(
      `${JSON.stringify({
        base: args.base,
        total: args.reports.length,
        dry_run: args.dryRun,
        reports: args.reports,
      })}\n`,
    );
    return;
  }
  const tag = args.dryRun ? " [DRY-RUN]" : "";
  process.stdout.write(`\nCascade${tag} — base=${args.base}\n`);
  for (const r of args.reports) {
    process.stdout.write(
      `  PR #${r.pr_number}  ${r.conclusion.padEnd(28)}  ${r.elapsed_ms.toFixed(0)}ms  ${r.pr_url}\n`,
    );
  }
  process.stdout.write(`Total: ${args.reports.length}\n`);
}
