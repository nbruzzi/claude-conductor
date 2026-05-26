// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for audit-verdict signature-chain verifier (Cycle 1 substrate-core
 * PR-A6; Pair B Charlie-pen per slice plan
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §2.3 + §6.1).
 *
 * Coverage organized by Section:
 *   1. Empty channel (vacuously ok)
 *   2. Intact chain (multi-entry v0.3 roundtrip)
 *   3. Tamper detection (mutate payload post-sign)
 *   4. Chain-discontinuity (mutate prev_audit_body_ref)
 *   5. Revoked key (history entry status='revoked')
 *   6. Skipped pre-v0.3 raw bodies (partial state)
 *   7. Unparseable audit-verdict body (unsupported state)
 *   8. Exit code precedence (broken > unsupported > partial > ok)
 *   9. Multi-NATO key_ids_used ordering
 *  10. Human render output
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBootstrap } from "../../src/audit/cli.ts";
import {
  exitCodeFor,
  renderHuman,
  verifyChannelAuditChain,
} from "../../src/audit/verify.ts";
import {
  importPrivateKey,
  readKeyHistory,
  writeKeyHistory,
} from "../../src/channels/key-surface.ts";
import {
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";
import { computePayloadHash } from "../../src/channels/audit-signature-chain.ts";

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-verify-test-"));
  prevHome = process.env["HOME"];
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevNatoEnv = process.env["CLAUDE_CONDUCTOR_NATO"];
  process.env["HOME"] = tmpDir;
  channelsDirAbs = path.join(tmpDir, "channels");
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = channelsDirAbs;
  delete process.env["CLAUDE_CONDUCTOR_NATO"];
  cohortDirAbs = path.join(tmpDir, ".claude", "keys", "cohort");
  mkdirSync(cohortDirAbs, { recursive: true });
  channelId = "test-channel-" + Math.random().toString(36).slice(2, 10);
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
 * Canonical audit-verdict body for tests. Uses a far-future signed_at
 * (2099-12-31) to ensure it falls within the key history's active window
 * after runBootstrap (active_from = bootstrap time; active_until = null →
 * any signed_at >= active_from resolves successfully). This sidesteps the
 * clock-dependency footgun where a backdated hardcoded signed_at would
 * fall before the live-clock active_from and cause resolveKeyAtTime to
 * return "no-active-key-at-timestamp" (which maps to key-rotation-
 * discontinuity break and would mask the test-intended break class).
 */
const CANONICAL_BODY: AuditVerdictBody = {
  kind_version: 1,
  target_pr: { repo: "conductor", number: 99 },
  target_peer: "Alpha",
  lens_set_applied: ["RE"],
  audit_class: "inside-pair",
  audit_axes: ["depth"],
  verdict: "SHIP-CLEAN",
  counts: { blocker: 0, fold: 0, nit: 0 },
  three_option_ask: {
    a_ratify: "PR cleared",
    b_fold_if_applicable: null,
    c_reframe_if_applicable: null,
  },
  findings: [],
  signed_at: "2099-12-31T23:59:59.999Z",
  prev_audit_body_ref: null,
  signer_role: "queue",
};

describe("verifyChannelAuditChain — Section 1: empty channel", () => {
  it("T1.1: channel with no messages is vacuously ok", async () => {
    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(true);
    expect(result.output.total_audit_verdicts).toBe(0);
    expect(result.output.key_ids_used).toEqual([]);
    expect(result.output.breaks).toEqual([]);
    expect(result.internal.skipped_pre_v0_3).toBe(0);
    expect(result.internal.unparseable).toBe(0);
    expect(exitCodeFor(result, false)).toBe(0);
  });

  it("T1.2: channel with only non-audit-verdict messages is vacuously ok", async () => {
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "note",
      body: "informational",
    });
    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(true);
    expect(result.output.total_audit_verdicts).toBe(0);
    expect(exitCodeFor(result, false)).toBe(0);
  });
});

describe("verifyChannelAuditChain — Section 2: intact chain", () => {
  it("T2.1: single bootstrap audit-verdict verifies", async () => {
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
      body_ref: "body-ref-1",
    });
    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(true);
    expect(result.output.total_audit_verdicts).toBe(1);
    expect(result.output.key_ids_used).toEqual(["charlie"]);
    expect(result.output.breaks).toEqual([]);
    expect(exitCodeFor(result, false)).toBe(0);
  });

  it("T2.2: 3-entry chain with prev_audit_body_ref verifies", async () => {
    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = unwrap(await importPrivateKey(bootstrap.secretKeyPath));

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

    const prev1Hash = await computePayloadHash(env1.payload);
    const body2: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 100 },
      signed_at: "2099-12-31T23:59:59.999Z",
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

    const prev2Hash = await computePayloadHash(env2.payload);
    const body3: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 101 },
      signed_at: "2099-12-31T23:59:59.999Z",
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

    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(true);
    expect(result.output.total_audit_verdicts).toBe(3);
    expect(result.output.breaks).toEqual([]);
    expect(exitCodeFor(result, false)).toBe(0);
  });
});

describe("verifyChannelAuditChain — Section 3: tamper detection", () => {
  it("T3.1: payload mutation after signing → tamper break", async () => {
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
    const envObj = JSON.parse(envelopeJson) as {
      payloadType: string;
      payload: string;
      signatures: { keyid: string; sig: string }[];
    };
    const tamperedBody: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_peer: "Bravo",
    };
    const tamperedJson = await wrapAuditVerdictBody(
      tamperedBody,
      priv,
      "charlie",
    );
    const tamperedEnvObj = JSON.parse(tamperedJson) as { payload: string };
    envObj.payload = tamperedEnvObj.payload;
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: JSON.stringify(envObj),
      body_ref: "body-ref-tamper",
    });
    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(false);
    expect(result.output.breaks.length).toBe(1);
    expect(result.output.breaks[0]?.reason).toBe("tamper");
    expect(result.output.breaks[0]?.key_id).toBe("charlie");
    expect(exitCodeFor(result, false)).toBe(1);
  });
});

describe("verifyChannelAuditChain — Section 4: chain discontinuity", () => {
  it("T4.1: wrong prev_audit_body_ref on entry 2 → key-rotation-discontinuity break", async () => {
    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = unwrap(await importPrivateKey(bootstrap.secretKeyPath));

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

    const body2: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 100 },
      signed_at: "2026-05-26T18:01:00.000Z",
      prev_audit_body_ref:
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    };
    const env2Json = await wrapAuditVerdictBody(body2, priv, "charlie");
    appendChannelMessage({
      ts: "2026-05-26T18:01:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: env2Json,
      body_ref: "body-ref-2",
    });

    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(false);
    expect(result.output.breaks.length).toBe(1);
    expect(result.output.breaks[0]?.reason).toBe("key-rotation-discontinuity");
    expect(result.output.breaks[0]?.at_msg_seq).toBe(1);
    expect(exitCodeFor(result, false)).toBe(1);
  });
});

describe("verifyChannelAuditChain — Section 5: revoked-key", () => {
  it("T5.1: history entry status='revoked' at signed_at → revoked-key break", async () => {
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
      body_ref: "body-ref-1",
    });

    const history = unwrap(await readKeyHistory(bootstrap.historyPath));
    const revokedHistory = {
      ...history,
      entries: history.entries.map((e) => ({
        ...e,
        status: "revoked" as const,
      })),
    };
    await writeKeyHistory(bootstrap.historyPath, revokedHistory);

    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(false);
    expect(result.output.breaks.length).toBe(1);
    expect(result.output.breaks[0]?.reason).toBe("revoked-key");
    expect(result.output.breaks[0]?.key_id).toBe("charlie");
    expect(exitCodeFor(result, false)).toBe(1);
  });
});

describe("verifyChannelAuditChain — Section 6: skipped pre-v0.3 (partial)", () => {
  it("T6.1: raw v0.2 body (no DSSE wrap) counts toward partial; not in breaks", async () => {
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: JSON.stringify(CANONICAL_BODY),
      body_ref: "body-ref-raw",
    });
    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(true);
    expect(result.output.total_audit_verdicts).toBe(0);
    expect(result.output.breaks).toEqual([]);
    expect(result.internal.skipped_pre_v0_3).toBe(1);
    expect(result.internal.unparseable).toBe(0);
    expect(exitCodeFor(result, false)).toBe(2);
    expect(exitCodeFor(result, true)).toBe(1);
  });
});

describe("verifyChannelAuditChain — Section 7: unparseable (unsupported)", () => {
  it("T7.1: audit-verdict body neither DSSE nor raw → unsupported", async () => {
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: "not-json-and-not-envelope",
      body_ref: "body-ref-garbage",
    });
    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(true);
    expect(result.output.total_audit_verdicts).toBe(0);
    expect(result.internal.unparseable).toBe(1);
    expect(exitCodeFor(result, false)).toBe(3);
  });
});

describe("verifyChannelAuditChain — Section 8: exit code precedence", () => {
  it("T8.1: broken > unsupported (broken wins precedence)", async () => {
    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = unwrap(await importPrivateKey(bootstrap.secretKeyPath));

    const envJson = await wrapAuditVerdictBody(CANONICAL_BODY, priv, "charlie");
    const envObj = JSON.parse(envJson) as { payload: string };
    const tamperedBody: AuditVerdictBody = {
      ...CANONICAL_BODY,
      target_peer: "Bravo",
    };
    const tamperedJson = await wrapAuditVerdictBody(
      tamperedBody,
      priv,
      "charlie",
    );
    const tamperedObj = JSON.parse(tamperedJson) as { payload: string };
    envObj.payload = tamperedObj.payload;
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: JSON.stringify(envObj),
      body_ref: "body-ref-1",
    });
    appendChannelMessage({
      ts: "2026-05-26T18:01:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: "garbage",
      body_ref: "body-ref-2",
    });

    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.breaks.length).toBe(1);
    expect(result.internal.unparseable).toBe(1);
    expect(exitCodeFor(result, false)).toBe(1);
  });
});

describe("verifyChannelAuditChain — Section 9: key_ids_used ordering", () => {
  it("T9.1: multi-NATO key_ids_used preserves first-occurrence order", async () => {
    const charlie = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const delta = await runBootstrap({
      identity: "delta",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const charliePriv = unwrap(await importPrivateKey(charlie.secretKeyPath));
    const deltaPriv = unwrap(await importPrivateKey(delta.secretKeyPath));

    const sequence: Array<[string, CryptoKey]> = [
      ["charlie", charliePriv],
      ["delta", deltaPriv],
      ["charlie", charliePriv],
      ["delta", deltaPriv],
    ];
    let i = 0;
    for (const [keyid, priv] of sequence) {
      const body: AuditVerdictBody = {
        ...CANONICAL_BODY,
        signed_at: `2026-05-26T18:0${i}:00.000Z`,
      };
      const envJson = await wrapAuditVerdictBody(body, priv, keyid);
      appendChannelMessage({
        ts: `2026-05-26T18:0${i}:00.000Z`,
        from: "session-x",
        kind: "audit-verdict",
        body: envJson,
        body_ref: `body-ref-${i}`,
      });
      i++;
    }

    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.key_ids_used).toEqual(["charlie", "delta"]);
  });
});

describe("verifyChannelAuditChain — Section 10: human render", () => {
  it("T10.1: human output contains ok + total + key_ids_used + breaks header", () => {
    const out = {
      ok: false,
      key_ids_used: ["charlie", "delta"],
      total_audit_verdicts: 2,
      breaks: [
        {
          at_msg_seq: 1,
          body_ref: "body-1",
          reason: "tamper" as const,
          detail: "signature verify failed",
          key_id: "charlie",
        },
      ],
    };
    const internal = { skipped_pre_v0_3: 0, unparseable: 0 };
    const text = renderHuman(out, internal);
    expect(text).toContain("ok: false");
    expect(text).toContain("total_audit_verdicts: 2");
    expect(text).toContain("key_ids_used: [charlie, delta]");
    expect(text).toContain("breaks: 1");
    expect(text).toContain("at_msg_seq=1");
    expect(text).toContain("reason=tamper");
    expect(text).toContain("key_id=charlie");
  });
});
