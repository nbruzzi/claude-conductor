// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * TIER 2 — Stop-time CI verification gate (blocking).
 *
 * At session-end, scans the transcript for shipped/merged/landed/deployed/done
 * claims and pairs them against the sentinel files written by TIER 4
 * (`ci-verification-pre-push-arm`). For each sentinel claimed but not evidenced
 * by a successful `gh pr checks` / `gh run (view|list|watch)` invocation, fail
 * Stop with a precise, actionable block message.
 *
 * Enforces ~/CLAUDE.md §"After Every Push — CI verification is mandatory"
 * (TIER 1 prose discipline). Structural fix for the failure mode caught on PR
 * #10 / 2026-05-01: claim-before-CI-verified.
 *
 * Sentinel-aware design (per RE finding #3 + Architecture concur in plan
 * audit): PushEvent ground truth comes from
 * `~/.claude/.flags/ci-verification-armed-<session>-<ts>.json` files written
 * at PreToolUse, NOT from transcript regex. Schema-drift critical (RE #1)
 * bypassed for push detection — only ClaimEvent + EvidenceEvent remain
 * transcript-derived (canary applies to those).
 *
 * Pairing semantics: each ClaimEvent pairs with the most-recent prior
 * sentinel push (sentinel push_ts <= claim ts). EvidenceEvent at any turn
 * with ts >= push_ts AND tool_response is_error===false satisfies the
 * pairing. Pre-push claims are unpaired (pass — past-tense referring to
 * prior session). Stale claims that re-pair with a verified prior push
 * continue to pass.
 *
 * ClaimEvent regex narrowed (per RE #6 + #15): require strong-signal context.
 *   - claim word: /\b(shipped|merged|landed|deployed|done)\b/i
 *   - AND first-person ("I", "we") OR proximity (within text) to PR/SHA/run-id
 *   - AND outside fenced code blocks
 *   - assistant text only (user turns excluded; tool_result echoes excluded)
 *
 * EvidenceEvent: assistant Bash tool_use with command matching
 * /\bgh\s+(?:pr\s+checks|run\s+(?:view|list|watch))\b/ AND subsequent user
 * tool_result with is_error===false (per A-PR-3 — wrong-PR `gh pr checks 999`
 * exits 1, not counted as evidence; CI-red `gh pr checks <real>` exits 1
 * too, correctly enforcing "no claim while CI red").
 *
 * Severity: blocking (canBlock=true, earlyReturn="on-block").
 *
 * Failure semantics:
 *   - KNOWN-EXPECTED errors (transcriptPath undefined, ENOENT on read,
 *     malformed JSONL line, BUDGET_MS overrun, kill-switch present)
 *     → catch-and-pass (defensive)
 *   - UNEXPECTED throws (EACCES, EBADF, OOM, regex catastrophic backtracking)
 *     → propagate to dispatcher's safety net (run-checks.ts:80-96
 *       fail-CLOSED-on-block-throw)
 *
 * Cleanup: when a sentinel is fully resolved (claimed && evidenced) the gate
 * deletes it on Stop pass. SessionEnd reaper + >24h mtime-GC at next
 * SessionStart handle residuals.
 *
 * Kill switches:
 *   - Session-scoped: ~/.claude/.flags/ci-verification-gate-disabled-<sessionId>
 *   - Global emergency: ~/.claude/.flags/ci-verification-gate-disabled
 *
 * HOME-per-call (per test-gate.ts:23-26).
 *
 * Block message format includes runnable command suggestions (per RE #4) and
 * BOTH session-scoped and global kill-switch instructions (per RE #5).
 *
 * Telemetry: emits per-scan record to
 * `~/.claude/.cache/ci-verification-gate-timing.jsonl` (per RE #10) —
 * instrumented from day 1; 1-week soak before relying on BUDGET_MS=200ms guard.
 *
 * Known limitations (documented; will not block merge):
 *   - Multi-remote / tag pushes match same as PR pushes — accept noise.
 *   - Pipe-separated commands (`git push | tee`) trigger reminder.
 *   - Subagent-launched pushes inherit parent's discipline via TIER 4
 *     sentinel; deeply-nested-subagent edges may slip — accept and document.
 *   - Schema-drift canary applies to claim/evidence detection only; push
 *     detection is sentinel-driven (immune to transcript schema changes).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openAsync } from "node:fs/promises";
import { join } from "node:path";

import type { HookInput, HookResult } from "../types.ts";
import { block, pass, warn } from "../types.ts";
import { extractSessionId } from "../session-id.ts";

const SOURCE = "ci-verification-gate";
const BUDGET_MS = 200;
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB tail cap
const ZERO_SCAN_THRESHOLD = 5;

const CLAIM_WORD_RE = /\b(shipped|merged|landed|deployed|done)\b/iu;
const FIRST_PERSON_CLAIM_RE =
  /\b(?:I|we)\s+(?:have\s+|just\s+|already\s+|finally\s+)?(?:shipped|merged|landed|deployed|finished|done)/iu;
const PR_PROXIMITY_RE =
  /\b(?:PR\s*#?\d+|pull\s+request|merge\s+commit|run\s+id|conclusion|[a-f0-9]{7,})\b/iu;
const EVIDENCE_RE = /\bgh\s+(?:pr\s+checks|run\s+(?:view|list|watch))\b/u;
const FENCE_RE = /^```/u;

type Sentinel = {
  push_ts: string;
  command_preview: string;
  sessionId: string;
  branchHint?: string;
  claimed: boolean;
  evidenced: boolean;
};

type SentinelFile = {
  path: string;
  data: Sentinel;
};

type ClaimEvent = {
  turnIdx: number;
  ts: string;
  claimWord: string;
  snippet: string;
};

type EvidenceEvent = {
  turnIdx: number;
  ts: string;
  toolUseId: string;
};

type Violation = {
  sentinel: SentinelFile;
  claim: ClaimEvent;
};

function homeFlagsDir(): string {
  return join(process.env["HOME"] ?? "", ".claude", ".flags");
}

function homeCacheDir(): string {
  return join(process.env["HOME"] ?? "", ".claude", ".cache");
}

function killSwitchPaths(sessionId: string | undefined): {
  session: string | undefined;
  global: string;
} {
  const dir = homeFlagsDir();
  return {
    session:
      sessionId === undefined
        ? undefined
        : join(dir, `${SOURCE}-disabled-${sessionId}`),
    global: join(dir, `${SOURCE}-disabled`),
  };
}

function zeroScanCounterPath(): string {
  return join(homeFlagsDir(), `${SOURCE}-zero-scans`);
}

function timingLogPath(): string {
  return join(homeCacheDir(), `${SOURCE}-timing.jsonl`);
}

function readSentinels(sessionId: string): SentinelFile[] {
  const dir = homeFlagsDir();
  if (!existsSync(dir)) return [];
  const prefix = `ci-verification-armed-${sessionId}-`;
  const out: SentinelFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const text = readFileSync(path, "utf-8");
      const data = JSON.parse(text) as Sentinel;
      if (typeof data.push_ts !== "string") continue;
      if (typeof data.sessionId !== "string") continue;
      out.push({ path, data });
    } catch {
      // Malformed sentinel — skip; SessionStart GC will eventually reap.
    }
  }
  // Order by push_ts ascending so most-recent-prior-push pairing is straightforward.
  out.sort((a, b) => (a.data.push_ts < b.data.push_ts ? -1 : 1));
  return out;
}

function writeSentinel(file: SentinelFile): void {
  try {
    writeFileSync(file.path, JSON.stringify(file.data));
  } catch {
    // Fail-open on writeback; pairing already determined.
  }
}

function deleteSentinel(file: SentinelFile): void {
  try {
    unlinkSync(file.path);
  } catch {
    // Idempotent — if already gone, fine.
  }
}

// LIFTED-FROM: ~/.claude-dotfiles/src/hooks/checks/feedback-minimal-output-detector.ts:77-94
// Phase-v lift candidate: consolidate transcript-scanner helpers (readTail +
// tryParse + stripFencedCode) in plugin/transcript-scanner.ts per plan
// decision ARCH-7 + B-PR-2 / PHASE-GATE-3 condition #12.
async function readTail(path: string, maxBytes: number): Promise<string> {
  const stat = statSync(path);
  const size = stat.size;
  if (size <= maxBytes) {
    return await Bun.file(path).text();
  }
  const offset = size - maxBytes;
  const fh = await openAsync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, offset);
    const raw = buf.toString("utf-8");
    const firstNewline = raw.indexOf("\n");
    return firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
  } finally {
    await fh.close();
  }
}

// LIFTED-FROM: ~/.claude-dotfiles/src/hooks/checks/feedback-minimal-output-detector.ts:127-133
// Phase-v lift candidate: plugin/transcript-scanner.ts (paired with readTail).
function tryParse(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function getString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

// LIFTED-FROM (pattern): ~/.claude-dotfiles/src/hooks/checks/feedback-minimal-output-detector.ts:135-161
// Adapted to a simpler line-based fence-skip (we only need outside-fence text,
// not the diff-prose detection feedback-minimal-output-detector also performs).
// Phase-v lift candidate: plugin/transcript-scanner.ts.
function stripFencedCode(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

function extractClaim(
  text: string,
  ts: string,
  turnIdx: number,
): ClaimEvent | undefined {
  const stripped = stripFencedCode(text);
  if (!CLAIM_WORD_RE.test(stripped)) return undefined;

  // Narrow to strong-signal contexts: first-person speech act OR proximity to PR/SHA.
  if (
    !FIRST_PERSON_CLAIM_RE.test(stripped) &&
    !PR_PROXIMITY_RE.test(stripped)
  ) {
    return undefined;
  }

  const m = CLAIM_WORD_RE.exec(stripped);
  if (!m) return undefined;
  const claimWord = m[1] ?? m[0];
  const idx = m.index;
  const start = Math.max(0, idx - 30);
  const end = Math.min(stripped.length, idx + claimWord.length + 30);
  const snippet = stripped.slice(start, end).replace(/\s+/gu, " ").trim();

  return { turnIdx, ts, claimWord, snippet };
}

type ScanCounters = {
  totalLines: number;
  assistantTextBlocks: number;
  claims: number;
  evidence: number;
};

type ScanResult = {
  claims: ClaimEvent[];
  evidence: EvidenceEvent[];
  counters: ScanCounters;
};

function scanTranscript(
  text: string,
  budgetExceeded: () => boolean,
): ScanResult {
  const claims: ClaimEvent[] = [];
  const evidence: EvidenceEvent[] = [];
  const counters: ScanCounters = {
    totalLines: 0,
    assistantTextBlocks: 0,
    claims: 0,
    evidence: 0,
  };

  // Pending evidence tool_use_ids → metadata of the assistant turn (we confirm
  // on matching user tool_result with is_error===false).
  const pendingEvidence = new Map<string, { ts: string; turnIdx: number }>();

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (budgetExceeded()) break;
    const line = lines[i];
    if (line === undefined || line === "") continue;
    counters.totalLines++;

    const entry = tryParse(line);
    if (!entry) continue;

    const type = getString(entry, "type");
    const ts = getString(entry, "timestamp") ?? "";
    const message = entry["message"];
    if (typeof message !== "object" || message === null) continue;
    const msg = message as Record<string, unknown>;
    const content = msg["content"];
    if (!Array.isArray(content)) continue;

    if (type === "assistant") {
      for (const blockItem of content) {
        if (typeof blockItem !== "object" || blockItem === null) continue;
        const b = blockItem as Record<string, unknown>;
        const btype = getString(b, "type");
        if (btype === "text") {
          const text2 = getString(b, "text");
          if (text2 === undefined) continue;
          counters.assistantTextBlocks++;
          const claim = extractClaim(text2, ts, i);
          if (claim !== undefined) {
            claims.push(claim);
            counters.claims++;
          }
        } else if (btype === "tool_use") {
          const name = getString(b, "name");
          const id = getString(b, "id");
          if (name !== "Bash" || id === undefined) continue;
          const input = b["input"];
          if (typeof input !== "object" || input === null) continue;
          const command = getString(
            input as Record<string, unknown>,
            "command",
          );
          if (command === undefined) continue;
          if (EVIDENCE_RE.test(command)) {
            pendingEvidence.set(id, { ts, turnIdx: i });
          }
        }
      }
    } else if (type === "user") {
      for (const blockItem of content) {
        if (typeof blockItem !== "object" || blockItem === null) continue;
        const b = blockItem as Record<string, unknown>;
        const btype = getString(b, "type");
        if (btype !== "tool_result") continue;
        const useId = getString(b, "tool_use_id");
        if (useId === undefined) continue;
        const pending = pendingEvidence.get(useId);
        if (pending === undefined) continue;
        const isError = b["is_error"];
        if (isError === false) {
          evidence.push({
            turnIdx: pending.turnIdx,
            ts: pending.ts,
            toolUseId: useId,
          });
          counters.evidence++;
        }
        pendingEvidence.delete(useId);
      }
    }
  }

  return { claims, evidence, counters };
}

function pairViolations(
  sentinels: SentinelFile[],
  scan: ScanResult,
): Violation[] {
  // For each sentinel, check claim/evidence pairing. Mark sentinel.claimed /
  // sentinel.evidenced based on what the transcript shows.
  const violations: Violation[] = [];

  for (const sentinel of sentinels) {
    const pushTs = sentinel.data.push_ts;
    const evidenceAfter = scan.evidence.filter((e) => e.ts >= pushTs);

    // A claim attaches to the most-recent-prior sentinel. Find any claim whose
    // most-recent-prior sentinel is THIS one.
    let claimedBySentinel: ClaimEvent | undefined;
    for (const claim of scan.claims) {
      const candidates = sentinels.filter((s) => s.data.push_ts <= claim.ts);
      const mostRecent = candidates[candidates.length - 1];
      if (mostRecent === undefined) continue;
      if (mostRecent.path === sentinel.path) {
        claimedBySentinel = claim;
        break;
      }
    }

    sentinel.data.claimed = claimedBySentinel !== undefined;
    sentinel.data.evidenced = evidenceAfter.length > 0;

    if (
      sentinel.data.claimed &&
      !sentinel.data.evidenced &&
      claimedBySentinel !== undefined
    ) {
      violations.push({ sentinel, claim: claimedBySentinel });
    }
  }

  return violations;
}

function formatBlockMessage(
  violations: Violation[],
  sessionId: string,
): string {
  const lines: string[] = [
    "── CI Verification Gate ──",
    "",
    `Stop blocked — ${violations.length} unverified shipped-claim(s) detected:`,
    "",
  ];

  violations.forEach((v, i) => {
    const idx = i + 1;
    const truncCmd =
      v.sentinel.data.command_preview.length > 80
        ? `${v.sentinel.data.command_preview.slice(0, 80)}…`
        : v.sentinel.data.command_preview;
    lines.push(`[${idx}] Push at ${v.sentinel.data.push_ts}: ${truncCmd}`);
    lines.push(`    Claim at ${v.claim.ts}: "${v.claim.snippet}"`);
    lines.push(
      "    No `gh pr checks` / `gh run (view|list|watch)` (exit-0) since push.",
    );
    lines.push("");
  });

  lines.push("Required before next Stop:");
  lines.push(
    "  gh run watch <run-id> --exit-status         # for branch pushes",
  );
  lines.push("  gh pr checks <pr> --watch                    # for open PRs");
  lines.push("");
  lines.push(
    'Then restate your shipped-claim with run id + "success" conclusion.',
  );
  lines.push("");
  lines.push(
    `Bypass once (this session only): touch ~/.claude/.flags/${SOURCE}-disabled-${sessionId}`,
  );
  lines.push(
    `Emergency global override:        touch ~/.claude/.flags/${SOURCE}-disabled`,
  );

  return lines.join("\n");
}

function pushWithoutClaimMessage(
  unclaimed: SentinelFile[],
  sessionId: string,
): string {
  const lines: string[] = [
    "── CI Verification Gate ──",
    "",
    `${unclaimed.length} push(es) detected without a shipped-claim yet — verify CI before next claim:`,
    "",
  ];
  for (const s of unclaimed) {
    lines.push(`  - Push at ${s.data.push_ts}: ${s.data.command_preview}`);
  }
  lines.push("");
  lines.push(
    "Run: gh pr checks <pr> --watch  /  gh run watch <id> --exit-status",
  );
  lines.push(`Disable: touch ~/.claude/.flags/${SOURCE}-disabled-${sessionId}`);
  return lines.join("\n");
}

function bumpZeroScanCounter(): number {
  const path = zeroScanCounterPath();
  let count = 0;
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf-8").trim();
      const n = Number.parseInt(text, 10);
      if (Number.isFinite(n)) count = n;
    }
  } catch {
    // Treat unreadable counter as zero.
  }
  count += 1;
  try {
    mkdirSync(homeFlagsDir(), { recursive: true });
    writeFileSync(path, String(count));
  } catch {
    // Telemetry write failure is non-fatal.
  }
  return count;
}

function resetZeroScanCounter(): void {
  const path = zeroScanCounterPath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Idempotent
  }
}

function emitTimingTelemetry(record: Record<string, unknown>): void {
  try {
    mkdirSync(homeCacheDir(), { recursive: true });
    appendFileSync(timingLogPath(), `${JSON.stringify(record)}\n`);
  } catch {
    // Telemetry is best-effort.
  }
}

export async function check(input: HookInput): Promise<HookResult> {
  const sessionId = extractSessionId(input.raw);

  // Kill switches (session-scoped first, then global emergency).
  const ks = killSwitchPaths(sessionId);
  try {
    if (ks.session !== undefined && existsSync(ks.session)) return pass();
    if (existsSync(ks.global)) return pass();
  } catch {
    return pass();
  }

  // Sentinels are scoped per-session; no sessionId → no enforcement target.
  if (sessionId === undefined) return pass();

  const transcriptPath = input.transcriptPath;
  if (transcriptPath === undefined) return pass();

  const start = Date.now();
  const budgetExceeded = (): boolean => Date.now() - start > BUDGET_MS;

  // Read sentinels (KNOWN-EXPECTED — fail-open on read errors).
  let sentinels: SentinelFile[];
  try {
    sentinels = readSentinels(sessionId);
  } catch {
    return pass();
  }
  const sentinelsPre = sentinels.length;

  // Read transcript tail (KNOWN-EXPECTED ENOENT → pass; other errors propagate).
  let text: string;
  try {
    text = await readTail(transcriptPath, MAX_BYTES);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return pass();
    throw err;
  }
  if (budgetExceeded()) return pass();

  // Scan transcript for claims + evidence.
  const scan = scanTranscript(text, budgetExceeded);

  // Schema-drift canary (RE #1) — applies to claim/evidence detection.
  if (
    scan.counters.totalLines >= 30 &&
    scan.counters.assistantTextBlocks === 0
  ) {
    const counter = bumpZeroScanCounter();
    if (counter > ZERO_SCAN_THRESHOLD) {
      console.error(
        `[${SOURCE}] zero-signal scan (${counter} consecutive sessions) — possible transcript schema drift`,
      );
    }
  } else if (scan.counters.assistantTextBlocks > 0) {
    resetZeroScanCounter();
  }

  // Pairing — write back claimed/evidenced flags onto sentinels.
  const violations = pairViolations(sentinels, scan);

  // Persist updated sentinel state.
  for (const s of sentinels) {
    writeSentinel(s);
  }

  // Telemetry.
  emitTimingTelemetry({
    ts: new Date().toISOString(),
    sessionId,
    sentinelsPre,
    sentinelsPost: sentinels.length,
    totalLines: scan.counters.totalLines,
    assistantTextBlocks: scan.counters.assistantTextBlocks,
    claims: scan.counters.claims,
    evidence: scan.counters.evidence,
    durationMs: Date.now() - start,
    violations: violations.length,
  });

  // Cleanup: delete sentinels that are claimed && evidenced (resolved).
  for (const s of sentinels) {
    if (s.data.claimed && s.data.evidenced) deleteSentinel(s);
  }

  if (violations.length > 0) {
    return block(
      SOURCE,
      formatBlockMessage(violations, sessionId),
      `${violations.length} unverified`,
    );
  }

  // Push-without-claim warn (RE #2): sentinels exist but no claims yet, and no
  // evidence either — surface as informational so the agent is reminded.
  const unclaimed = sentinels.filter((s) => !s.data.claimed);
  if (unclaimed.length > 0 && scan.counters.evidence === 0) {
    return warn(
      SOURCE,
      pushWithoutClaimMessage(unclaimed, sessionId),
      `${unclaimed.length} push(es) without claim`,
    );
  }

  return pass();
}

// Test-only exports for fixture-driven unit tests.
export const INTERNAL = {
  killSwitchPaths,
  homeFlagsDir,
  homeCacheDir,
  zeroScanCounterPath,
  timingLogPath,
  readSentinels,
  scanTranscript,
  pairViolations,
  formatBlockMessage,
  pushWithoutClaimMessage,
  extractClaim,
  stripFencedCode,
  CLAIM_WORD_RE,
  FIRST_PERSON_CLAIM_RE,
  PR_PROXIMITY_RE,
  EVIDENCE_RE,
  BUDGET_MS,
  ZERO_SCAN_THRESHOLD,
};
