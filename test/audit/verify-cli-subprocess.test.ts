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

describe("audit verify CLI subprocess — Section 3: mixed-pre-v3 fixture (SILENT-SUCCESS-MASKING DEMONSTRATION)", () => {
  /**
   * Asserts the current behavior: pre-v0.3 raw bodies are silently
   * skipped from JSON output (only `total_audit_verdicts` counts v0.3;
   * `breaks` doesn't list skipped pre-v0.3 entries). The INTERNAL
   * `skipped_pre_v0_3` counter is NOT serialized into stdout JSON per
   * `src/audit/verify.ts:135-149`. Only the EXIT CODE distinguishes
   * partial (skipped present) from clean-ok (no skipped).
   *
   * Cycle 3+ substrate fix should expose `skipped_pre_v0_3` in JSON
   * output — this test will need to be updated then to assert the new
   * field. Per Charlie slice plan body §4.4 (Cycle 3 deferred scope).
   */
  it("T3.1: pre-v0.3 raw body only → exit 2 partial (JSON shape masks skipped pre-v0.3 from operator)", () => {
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
    // SILENT-SUCCESS-MASKING: ok:true + total:0 + breaks:[] is INDISTINGUISHABLE
    // from "empty channel with no audit-verdicts" per T1.1 at the JSON-output
    // level. Operator reading JSON output cannot tell that 1 pre-v0.3 entry
    // exists and was skipped — only the EXIT CODE distinguishes (0 vacuous-ok
    // vs 2 partial). See T4.1 cross-test for the explicit demonstration.
    expect(out.ok).toBe(true);
    expect(out.total_audit_verdicts).toBe(0);
    expect(out.breaks).toEqual([]);
    // Per src/audit/verify.ts:120-133: AuditVerifyOutput shape has no
    // `skipped_pre_v0_3` field. Cycle 3 substrate-debt: expose this in
    // output JSON so operators can distinguish partial from clean-ok at
    // the JSON-shape level, not just via exit-code.
    expect(out).not.toHaveProperty("skipped_pre_v0_3");
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

describe("audit verify CLI subprocess — Section 4: silent-success-masking demonstration cross-test", () => {
  /**
   * Cross-test: stdout JSON shape is IDENTICAL between "T1.1 empty
   * channel" (no audit-verdicts at all) and "T3.1 pre-v0.3 raw body
   * only" (1 skipped entry). The only signal that distinguishes them
   * is the EXIT CODE — vacuous-ok=0 vs partial=2. This is the
   * silent-success-masking gap; Cycle 3+ substrate fix should expose
   * `skipped_pre_v0_3` in JSON output to enable operators to
   * distinguish without parsing exit codes from shell.
   */
  it("T4.1: empty-channel JSON shape == pre-v0.3-only JSON shape (only exit code differs)", () => {
    const emptyResult = runVerifySubprocess();
    expect(emptyResult.status).toBe(0);
    const emptyOut = unwrap(emptyResult.parsed);

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

    // JSON SHAPES IDENTICAL
    expect(partialOut).toEqual(emptyOut);
    expect(partialOut.ok).toBe(emptyOut.ok); // both true
    expect(partialOut.total_audit_verdicts).toBe(emptyOut.total_audit_verdicts); // both 0
    expect(partialOut.breaks).toEqual(emptyOut.breaks); // both []
    expect(partialOut.key_ids_used).toEqual(emptyOut.key_ids_used); // both []

    // EXIT CODES DIFFER — the only operator-visible signal
    expect(emptyResult.status).toBe(0); // vacuous-ok
    expect(partialResult.status).toBe(2); // partial (pre-v0.3 skipped)

    // Cycle 3+ substrate-debt: expose skipped_pre_v0_3 in JSON output
    // so this assertion class can move from "exit code only" to
    // "JSON-output-distinguishable" — closes the silent-success-masking gap.
  });
});
