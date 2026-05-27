// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Subprocess integration test for the audit verify CLI verb
 * (Cycle 2 Pair B substrate-debt — Charlie-pen Lane R per
 * `~/.claude/plans/cycle-2-substrate-debt-pair-b-2026-05-27.md` §4).
 *
 * **Distinct lens vs `test/audit/verify.test.ts` (in-process):** invokes
 * the CLI as a child process via `spawnSync` + parses stdout JSON +
 * asserts exit code. Demonstrates the OPERATOR-FACING surface —
 * `AuditVerifyOutput` JSON only (`AuditVerifyInternalState.skipped_pre_v0_3`
 * is INTERNAL and NOT serialized into stdout per `src/audit/verify.ts:135-149`
 * JSDoc). Operators reading the JSON cannot distinguish "all v0.3 verified"
 * from "all pre-v0.3 skipped"; only the exit code distinguishes partial
 * (exit 2) from clean ok (exit 0).
 *
 * **Silent-success-masking gap surfaced:** Charlie substrate-finding
 * `e74b0971` (Pair B private 2026-05-27T11:05Z) + cohort visibility
 * `159c8dfc` (bernstein arc 11:38Z) + per-NATO empirical-43 `c1204ab1`
 * 11:42Z. This Lane R integration test wires the verifier as a CI canary
 * that surfaces chain state mechanically; Cycle 3+ substrate fix should
 * expose `skipped_pre_v0_3` in `AuditVerifyOutput` JSON to close the
 * silent-success-masking gap.
 *
 * **Fixture generation pattern:** programmatic (mirrors `verify.test.ts`
 * `beforeEach` bootstrap + wrapAuditVerdictBody pattern). Avoids static
 * fixture brittleness across substrate evolution. Each test sets up
 * its own tmpDir + cohort-keys + channel state, invokes the CLI as a
 * subprocess, and asserts on stdout JSON + exit code.
 *
 * Coverage organized by fixture class:
 *   1. clean-v3-chain: 1-3 chained v0.3; expect exit 0 + ok:true + breaks:[]
 *   2. broken-chain: 2-entry v0.3 with chain mismatch; expect exit 1 + ok:false
 *   3. mixed-pre-v3: pre-v0.3 + v0.3 entries; expect exit 2 partial (non-strict) / exit 1 (--strict)
 *   4. SILENT-SUCCESS-MASKING DEMONSTRATION: stdout JSON identical-shape between
 *      "vacuous-ok empty channel" and "ok with skipped pre-v0.3" — only exit-code distinguishes
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { runBootstrap } from "../../src/audit/cli.ts";
import { importPrivateKey } from "../../src/channels/key-surface.ts";
import {
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";
import { computePayloadHash } from "../../src/channels/audit-signature-chain.ts";

const AUDIT_CLI = path.resolve(import.meta.dir, "../../src/audit/cli.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function unwrap<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`unwrap: expected non-null/non-undefined ${label}`);
  }
  return value;
}

let tmpDir: string;
let prevHome: string | undefined;
let prevChannelsDir: string | undefined;
let prevNatoEnv: string | undefined;
let channelsDirAbs: string;
let cohortDirAbs: string;
let channelId: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "audit-verify-cli-subprocess-"),
  );
  prevHome = process.env["HOME"];
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevNatoEnv = process.env["CLAUDE_CONDUCTOR_NATO"];
  process.env["HOME"] = tmpDir;
  channelsDirAbs = path.join(tmpDir, "channels");
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = channelsDirAbs;
  delete process.env["CLAUDE_CONDUCTOR_NATO"];
  cohortDirAbs = path.join(tmpDir, ".claude", "keys", "cohort");
  mkdirSync(cohortDirAbs, { recursive: true });
  channelId = "lane-r-test-" + Math.random().toString(36).slice(2, 10);
  mkdirSync(path.join(channelsDirAbs, channelId), { recursive: true });
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevChannelsDir === undefined)
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  else process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  if (prevNatoEnv === undefined) delete process.env["CLAUDE_CONDUCTOR_NATO"];
  else process.env["CLAUDE_CONDUCTOR_NATO"] = prevNatoEnv;
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function appendChannelMessage(msg: Record<string, unknown>): void {
  const messagesPath = path.join(channelsDirAbs, channelId, "messages.jsonl");
  writeFileSync(messagesPath, JSON.stringify(msg) + "\n", { flag: "a" });
}

/**
 * Canonical audit-verdict body for tests. Uses far-future signed_at to
 * stay within key history active window after runBootstrap. Mirrors the
 * pattern in `test/audit/verify.test.ts`.
 */
const CANONICAL_BODY: AuditVerdictBody = {
  kind_version: 1,
  target_pr: { repo: "conductor", number: 999 },
  target_peer: "Alpha",
  lens_set_applied: ["RE"],
  audit_class: "inside-pair",
  audit_axes: ["depth"],
  verdict: "SHIP-CLEAN",
  counts: { blocker: 0, fold: 0, nit: 0 },
  three_option_ask: {
    a_ratify: "Lane R subprocess test fixture",
    b_fold_if_applicable: null,
    c_reframe_if_applicable: null,
  },
  findings: [],
  signed_at: "2099-12-31T23:59:59.999Z",
  prev_audit_body_ref: null,
  signer_role: "queue",
};

type AuditVerifyOutputJson = {
  ok: boolean;
  key_ids_used: string[];
  total_audit_verdicts: number;
  breaks: { ts: string; reason: string; detail: string }[];
  // S2-B (Pair B Cycle 2 substrate-debt) — both counters now exposed in
  // JSON output for silent-success-masking gap closure per slice plan §4.4.
  skipped_pre_v0_3: number;
  unparseable: number;
};

type SubprocessResult = SpawnSyncReturns<string> & {
  parsed: AuditVerifyOutputJson | null;
};

/**
 * Invoke `bun run src/audit/cli.ts verify <channelId> --output json
 * --pubkey-dir <cohortDirAbs> [--strict]` as a subprocess + parse stdout
 * JSON.
 *
 * Subprocess invocation is the load-bearing distinction from
 * `test/audit/verify.test.ts` (in-process). Operators invoke `bun run
 * conductor audit verify ...` in CI / shell — this test exercises THAT
 * surface, not the in-process function call.
 */
function runVerifySubprocess(
  opts: { strict?: boolean } = {},
): SubprocessResult {
  const args: string[] = [
    "run",
    AUDIT_CLI,
    "verify",
    channelId,
    "--output",
    "json",
    "--pubkey-dir",
    cohortDirAbs,
  ];
  if (opts.strict) args.push("--strict");
  const result = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 15000,
    env: process.env,
  });
  let parsed: AuditVerifyOutputJson | null = null;
  try {
    parsed = JSON.parse(result.stdout) as AuditVerifyOutputJson;
  } catch {
    /* leave parsed=null when stdout isn't JSON (e.g., --help, error paths) */
  }
  return { ...result, parsed };
}

describe("audit verify CLI subprocess — Section 1: clean-v3-chain fixture", () => {
  it("T1.1: empty channel (no audit-verdicts) → exit 0 + vacuous-ok JSON", () => {
    const result = runVerifySubprocess();
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const out = unwrap(result.parsed);
    expect(out.ok).toBe(true);
    expect(out.total_audit_verdicts).toBe(0);
    expect(out.key_ids_used).toEqual([]);
    expect(out.breaks).toEqual([]);
  });

  it("T1.2: single bootstrap audit-verdict v0.3 → exit 0 + ok:true + total:1", async () => {
    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = unwrap(await importPrivateKey(bootstrap.secretKeyPath));
    const envelopeJson = await wrapAuditVerdictBody(
      CANONICAL_BODY,
      priv,
      "charlie",
    );
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: envelopeJson,
      body_ref: "body-ref-bootstrap",
    });
    const result = runVerifySubprocess();
    expect(result.status).toBe(0);
    const out = unwrap(result.parsed);
    expect(out.ok).toBe(true);
    expect(out.total_audit_verdicts).toBe(1);
    expect(out.key_ids_used).toEqual(["charlie"]);
    expect(out.breaks).toEqual([]);
  });

  it("T1.3: 3-entry chained v0.3 (clean-v3-chain) → exit 0 + ok:true + total:3", async () => {
    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = unwrap(await importPrivateKey(bootstrap.secretKeyPath));

    // Entry 1: bootstrap (prev_audit_body_ref: null)
    const env1Json = await wrapAuditVerdictBody(
      CANONICAL_BODY,
      priv,
      "charlie",
    );
    const env1 = JSON.parse(env1Json) as { payload: string };
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: env1Json,
      body_ref: "body-ref-1",
    });

    // Entry 2: chained via SHA-256 of entry 1's canonical payload
    const prev1Hash = await computePayloadHash(env1.payload);
    const body2: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 1000 },
      prev_audit_body_ref: prev1Hash,
    };
    const env2Json = await wrapAuditVerdictBody(body2, priv, "charlie");
    const env2 = JSON.parse(env2Json) as { payload: string };
    appendChannelMessage({
      ts: "2026-05-26T18:01:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: env2Json,
      body_ref: "body-ref-2",
    });

    // Entry 3: chained via SHA-256 of entry 2's canonical payload
    const prev2Hash = await computePayloadHash(env2.payload);
    const body3: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 1001 },
      prev_audit_body_ref: prev2Hash,
    };
    const env3Json = await wrapAuditVerdictBody(body3, priv, "charlie");
    appendChannelMessage({
      ts: "2026-05-26T18:02:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: env3Json,
      body_ref: "body-ref-3",
    });

    const result = runVerifySubprocess();
    expect(result.status).toBe(0);
    const out = unwrap(result.parsed);
    expect(out.ok).toBe(true);
    expect(out.total_audit_verdicts).toBe(3);
    expect(out.key_ids_used).toEqual(["charlie"]);
    expect(out.breaks).toEqual([]);
  });
});

describe("audit verify CLI subprocess — Section 2: broken-chain fixture", () => {
  it("T2.1: 2-entry chain with mismatched prev_audit_body_ref → exit 1 + ok:false + breaks≥1", async () => {
    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = unwrap(await importPrivateKey(bootstrap.secretKeyPath));

    // Entry 1: bootstrap
    const env1Json = await wrapAuditVerdictBody(
      CANONICAL_BODY,
      priv,
      "charlie",
    );
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: env1Json,
      body_ref: "body-ref-1",
    });

    // Entry 2: WRONG prev_audit_body_ref (all-zeros hash, deliberately not matching entry 1)
    const wrongHash = "0".repeat(64);
    const body2: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 1002 },
      prev_audit_body_ref: wrongHash,
    };
    const env2Json = await wrapAuditVerdictBody(body2, priv, "charlie");
    appendChannelMessage({
      ts: "2026-05-26T18:01:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: env2Json,
      body_ref: "body-ref-2",
    });

    const result = runVerifySubprocess();
    expect(result.status).toBe(1);
    const out = unwrap(result.parsed);
    expect(out.ok).toBe(false);
    expect(out.total_audit_verdicts).toBe(2);
    expect(out.breaks.length).toBeGreaterThanOrEqual(1);
    // At least one break should reference the chain mismatch
    const chainBreak = out.breaks.find(
      (b) =>
        b.reason.toLowerCase().includes("chain") ||
        b.detail.toLowerCase().includes("prev_audit_body_ref"),
    );
    expect(chainBreak).toBeDefined();
  });
});

describe("audit verify CLI subprocess — Section 3: mixed-pre-v3 fixture (S2-B GAP CLOSED)", () => {
  /**
   * Per Pair B Cycle 2 substrate-debt S2-B (slice plan §4.4): the
   * `skipped_pre_v0_3` + `unparseable` counters are now exposed in
   * `AuditVerifyOutput` JSON output. Prior to S2-B these were
   * internal-only (only the EXIT CODE distinguished partial from
   * vacuous-ok); now JSON consumers can distinguish at the structural
   * shape level. This section locks the closed-gap behavior as CI
   * canary going forward — any future regression that removes the
   * field would fail T3.1 + T4.1 + T11 in verify.test.ts.
   *
   * Original gap framing preserved in git history at PRs #143 / #144 /
   * #146 / #148 plus [[feedback-verifier-silent-success-skip-conditional]].
   */
  it("T3.1: pre-v0.3 raw body only → exit 2 partial + skipped_pre_v0_3 visible in JSON (S2-B closure)", () => {
    // Emit a pre-v0.3 raw audit-verdict body (no payloadType envelope; just an inner-body JSON)
    const rawBody = JSON.stringify(CANONICAL_BODY);
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-legacy",
      kind: "audit-verdict",
      body: rawBody,
      body_ref: "legacy-1",
    });
    const result = runVerifySubprocess();
    // Empirical: even with ZERO v0.3 entries + 1 skipped pre-v0.3, the verifier
    // elevates to partial (exit 2). Skipped > 0 OR mixed pre-v0.3 / v0.3 → partial.
    // Per src/audit/cli.ts:299-302 exit-code mapping.
    expect(result.status).toBe(2);
    const out = unwrap(result.parsed);
    // ok:true + total:0 + breaks:[] preserved (chain-eligible state unchanged).
    expect(out.ok).toBe(true);
    expect(out.total_audit_verdicts).toBe(0);
    expect(out.breaks).toEqual([]);
    // S2-B GAP CLOSURE: skipped_pre_v0_3 + unparseable now exposed in JSON.
    // Operators can distinguish "vacuous-ok empty channel" from "ok with N
    // skipped pre-v0.3 entries" at the JSON-shape level — no exit-code-only
    // signal required. Per src/audit/verify.ts:120-152.
    expect(out.skipped_pre_v0_3).toBe(1);
    expect(out.unparseable).toBe(0);
  });

  it("T3.2: pre-v0.3 raw body only + --strict → exit 1 (partial elevated to broken)", () => {
    const rawBody = JSON.stringify(CANONICAL_BODY);
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-legacy",
      kind: "audit-verdict",
      body: rawBody,
      body_ref: "legacy-1",
    });
    const result = runVerifySubprocess({ strict: true });
    // --strict elevates partial to broken: exit 1 instead of 2 or 0
    // Per src/audit/cli.ts:299-302: "--strict treat partial (exit 2) as broken (exit 1)"
    expect(result.status).toBe(1);
  });

  it("T3.3: 1 pre-v0.3 + 1 v0.3 → partial state (exit 2 non-strict; exit 1 with --strict)", async () => {
    // Pre-v0.3 entry
    const rawBody = JSON.stringify(CANONICAL_BODY);
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-legacy",
      kind: "audit-verdict",
      body: rawBody,
      body_ref: "legacy-1",
    });

    // V0.3 entry
    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = unwrap(await importPrivateKey(bootstrap.secretKeyPath));
    const envelopeJson = await wrapAuditVerdictBody(
      CANONICAL_BODY,
      priv,
      "charlie",
    );
    appendChannelMessage({
      ts: "2026-05-26T18:01:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: envelopeJson,
      body_ref: "body-ref-v3",
    });

    // Non-strict: exit 2 (partial)
    const result = runVerifySubprocess();
    expect(result.status).toBe(2);
    const out = unwrap(result.parsed);
    expect(out.ok).toBe(true);
    expect(out.total_audit_verdicts).toBe(1);
    expect(out.breaks).toEqual([]);

    // --strict: partial elevated to broken (exit 1)
    const strictResult = runVerifySubprocess({ strict: true });
    expect(strictResult.status).toBe(1);
  });
});

describe("audit verify CLI subprocess — Section 4: S2-B silent-success-masking gap closure cross-test", () => {
  /**
   * Per Pair B Cycle 2 substrate-debt S2-B (slice plan §4.4 + Charlie
   * Lane R PR #144 origin): stdout JSON shape is now STRUCTURALLY
   * DISTINGUISHABLE between "empty channel" (no audit-verdicts) and
   * "pre-v0.3 raw body only" (1 skipped entry). The JSON output exposes
   * `skipped_pre_v0_3` + `unparseable` counters so consumers can detect
   * partial state without depending on the CLI exit-code matrix.
   *
   * This test was the canary that LOCKED the gap as CI evidence prior
   * to S2-B; it now FLIPS to lock the CLOSURE — any future regression
   * that removes the JSON field would fail this assertion. Per
   * [[feedback-deny-list-over-allow-list-for-skip-gates]] +
   * [[feedback-verifier-silent-success-skip-conditional]] (Bravo §11 NEW).
   */
  it("T4.1: empty-channel JSON shape != pre-v0.3-only JSON shape (structural distinction via skipped_pre_v0_3)", () => {
    const emptyResult = runVerifySubprocess();
    expect(emptyResult.status).toBe(0);
    const emptyOut = unwrap(emptyResult.parsed);
    // Empty channel: skipped_pre_v0_3 = 0 (S2-B field present + zero).
    expect(emptyOut.skipped_pre_v0_3).toBe(0);
    expect(emptyOut.unparseable).toBe(0);

    // Reset channel state by removing messages file
    const messagesPath = path.join(channelsDirAbs, channelId, "messages.jsonl");
    writeFileSync(messagesPath, "");

    // Emit a pre-v0.3 raw entry
    const rawBody = JSON.stringify(CANONICAL_BODY);
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-legacy",
      kind: "audit-verdict",
      body: rawBody,
      body_ref: "legacy-1",
    });
    const partialResult = runVerifySubprocess();
    const partialOut = unwrap(partialResult.parsed);
    // Partial state: skipped_pre_v0_3 = 1 (S2-B field present + non-zero).
    expect(partialOut.skipped_pre_v0_3).toBe(1);
    expect(partialOut.unparseable).toBe(0);

    // S2-B CLOSURE: JSON SHAPES STRUCTURALLY DIFFER on the new field.
    // Operators no longer need to inspect exit codes from shell to
    // distinguish vacuous-ok from partial — the JSON shape carries the
    // signal directly. Same-shaped fields (ok / total / breaks /
    // key_ids_used) still match because those are unchanged by skip state.
    expect(partialOut).not.toEqual(emptyOut);
    expect(partialOut.ok).toBe(emptyOut.ok); // both still true
    expect(partialOut.total_audit_verdicts).toBe(emptyOut.total_audit_verdicts); // both 0
    expect(partialOut.breaks).toEqual(emptyOut.breaks); // both []
    expect(partialOut.key_ids_used).toEqual(emptyOut.key_ids_used); // both []
    // The distinguishing field — locked as CI canary going forward.
    expect(partialOut.skipped_pre_v0_3).not.toBe(emptyOut.skipped_pre_v0_3);

    // Exit codes still differ (operator-visible signal preserved).
    expect(emptyResult.status).toBe(0); // vacuous-ok
    expect(partialResult.status).toBe(2); // partial (pre-v0.3 skipped)
  });
});
