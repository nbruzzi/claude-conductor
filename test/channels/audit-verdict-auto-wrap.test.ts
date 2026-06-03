// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for audit-verdict auto-wrap dispatcher (Cycle 2 Pair B substrate-debt
 * — Charlie-pen Lane P per slice plan body
 * `~/.claude/plans/cycle-2-substrate-debt-pair-b-2026-05-27.md` §3).
 *
 * Coverage organized by section:
 *   1. lookupPriorAuditVerdictPayload — channel walk helper unit tests
 *   2. autoWrapAuditVerdict Mode A — auto-wrap happy path
 *   3. autoWrapAuditVerdict Mode C — fallback paths (no key, wrong-shape chain)
 *   4. Round-trip — Mode A envelope shape verification
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoWrapAuditVerdict,
  lookupPriorAuditVerdictPayload,
} from "../../src/channels/audit-verdict-auto-wrap.ts";
import { runBootstrap } from "../../src/audit/cli.ts";
import type { AuditVerdictBody } from "../../src/channels/audit-verdict.ts";
import {
  parseDsseEnvelope,
  AUDIT_VERDICT_PAYLOAD_TYPE,
} from "../../src/channels/audit-signature-chain.ts";

function unwrap<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`unwrap: expected non-null/non-undefined ${label}`);
  }
  return value;
}

let tmpDir: string;
let prevHome: string | undefined;
let channelsDirAbs: string;
let cohortDirAbs: string;
let channelId: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-wrap-test-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
  channelsDirAbs = path.join(tmpDir, "channels");
  cohortDirAbs = path.join(tmpDir, ".claude", "keys", "cohort");
  mkdirSync(cohortDirAbs, { recursive: true });
  channelId = "auto-wrap-test-" + Math.random().toString(36).slice(2, 10);
  mkdirSync(path.join(channelsDirAbs, channelId), { recursive: true });
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
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

const CANONICAL_BODY: AuditVerdictBody = {
  kind_version: 1,
  target: { kind: "pr", repo: "conductor", number: 999 },
  target_pr: { repo: "conductor", number: 999 },
  target_peer: "Alpha",
  lens_set_applied: ["RE"],
  audit_class: "inside-pair",
  audit_axes: ["depth"],
  verdict: "SHIP-CLEAN",
  counts: { blocker: 0, fold: 0, nit: 0 },
  three_option_ask: {
    a_ratify: "Lane P auto-wrap test fixture",
    b_fold_if_applicable: null,
    c_reframe_if_applicable: null,
  },
  findings: [],
  signed_at: "2099-12-31T23:59:59.999Z",
  signer_role: "queue",
};

describe("lookupPriorAuditVerdictPayload — Section 1: channel walk helper", () => {
  it("T1.1: channel JSONL absent → null", () => {
    const result = lookupPriorAuditVerdictPayload(channelsDirAbs, channelId);
    expect(result).toBeNull();
  });

  it("T1.2: channel with non-audit-verdict messages only → null", () => {
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "status",
      body: "hello",
    });
    const result = lookupPriorAuditVerdictPayload(channelsDirAbs, channelId);
    expect(result).toBeNull();
  });

  it("T1.3: channel with audit-verdict + inline body → returns body string", () => {
    const rawAuditBody = JSON.stringify(CANONICAL_BODY);
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: rawAuditBody,
      body_ref: "body-1",
    });
    const result = lookupPriorAuditVerdictPayload(channelsDirAbs, channelId);
    expect(result).toBe(rawAuditBody);
  });

  it("T1.4: walks backwards — returns most-recent audit-verdict, skips later non-audit-verdict messages", () => {
    const olderBody = JSON.stringify({
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 1 },
    });
    const newerBody = JSON.stringify({
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 2 },
    });
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: olderBody,
    });
    appendChannelMessage({
      ts: "2026-05-26T18:01:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: newerBody,
    });
    appendChannelMessage({
      ts: "2026-05-26T18:02:00.000Z",
      from: "session-1",
      kind: "status",
      body: "bump",
    });
    const result = lookupPriorAuditVerdictPayload(channelsDirAbs, channelId);
    expect(result).toBe(newerBody);
  });

  it("T1.5: body_ref UUID → reads bodies/<uuid>.txt", () => {
    const rawAuditBody = JSON.stringify(CANONICAL_BODY);
    const bodyRef = "test-body-ref-uuid";
    const bodiesDir = path.join(channelsDirAbs, channelId, "bodies");
    mkdirSync(bodiesDir, { recursive: true });
    writeFileSync(path.join(bodiesDir, `${bodyRef}.txt`), rawAuditBody);
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body_ref: bodyRef,
    });
    const result = lookupPriorAuditVerdictPayload(channelsDirAbs, channelId);
    expect(result).toBe(rawAuditBody);
  });
});

describe("autoWrapAuditVerdict — Section 2: Mode A auto-wrap happy path", () => {
  it("T2.1: no prior audit-verdict + key resolvable → Mode A bootstrap envelope (prev_audit_body_ref: null)", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const result = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("A");
    expect(result.warn).toBeUndefined();
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
    expect(envelope.signatures.length).toBe(1);
    expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");
  });

  it("T2.2: prior audit-verdict exists + key resolvable → Mode A auto-compute chain (prev_audit_body_ref: SHA-256 hex)", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priorBody = JSON.stringify({
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 1 },
    });
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: priorBody,
    });
    const result = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("A");
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
    const inner = JSON.parse(decoded) as AuditVerdictBody;
    expect(inner.prev_audit_body_ref).toBeDefined();
    expect(typeof inner.prev_audit_body_ref).toBe("string");
    const chainRef = unwrap(inner.prev_audit_body_ref, "chainRef");
    expect(chainRef.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(chainRef)).toBe(true);
  });
});

describe("autoWrapAuditVerdict — Section 3: Mode C fallback paths", () => {
  it("T3.1: cohort key unresolvable → Mode C raw + WARN", async () => {
    const result = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("C");
    expect(result.body).toBe(JSON.stringify(CANONICAL_BODY));
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("cohort key file");
    expect(result.warn).toContain("audit bootstrap");
  });

  it("T3.2: operator-supplied UUID chain ref → Mode C raw + WARN (shape gate)", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const uuidChainRef = "b4f430cd-5eab-4189-995b-0a940ee48b67";
    const bodyWithUuid: AuditVerdictBody = {
      ...CANONICAL_BODY,
      prev_audit_body_ref: uuidChainRef,
    };
    const result = await autoWrapAuditVerdict({
      parsedBody: bodyWithUuid,
      rawBody: JSON.stringify(bodyWithUuid),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("C");
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("does not match SHA-256 hex");
    expect(result.warn).toContain("36 chars");
  });

  it("T3.3: operator-supplied literal 'null' string chain ref → Mode C raw + WARN", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const bodyWithLiteralNull: AuditVerdictBody = {
      ...CANONICAL_BODY,
      prev_audit_body_ref: "null",
    };
    const result = await autoWrapAuditVerdict({
      parsedBody: bodyWithLiteralNull,
      rawBody: JSON.stringify(bodyWithLiteralNull),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("C");
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("4 chars");
  });
});

describe("autoWrapAuditVerdict — Section 4: round-trip envelope shape verification", () => {
  it("T4.1: Mode A envelope is valid DSSE shape with all required fields populated", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const result = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("A");
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
    expect(envelope.payload.length).toBeGreaterThan(0);
    expect(envelope.signatures.length).toBe(1);
    expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");
    expect(
      unwrap(envelope.signatures[0], "signature").sig.length,
    ).toBeGreaterThan(0);
    const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
    const inner = JSON.parse(decoded) as AuditVerdictBody;
    expect(inner.kind_version).toBe(1);
    expect(inner.verdict).toBe("SHIP-CLEAN");
    expect(inner.target_pr?.repo).toBe("conductor");
    expect(inner.prev_audit_body_ref).toBeNull();
  });
});

describe("autoWrapAuditVerdict — Section 5: Mode B operator-supplied SHA-256 chain ref trust path", () => {
  // Canonical SHA-256 hex shape: 64 lowercase hex chars. Fixture chosen as a
  // recognizable pattern (alternating 0/f) so test failures surface clearly if
  // anything mutates the operator value. Real-world SHA-256 hex from
  // `computePayloadHash` would be cryptographically random.
  const OPERATOR_SHA256_HEX =
    "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

  it("T5.1: cohort key + operator-supplied SHA-256 chain ref → Mode B preserves operator value in DSSE envelope", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const bodyWithOperatorChainRef: AuditVerdictBody = {
      ...CANONICAL_BODY,
      prev_audit_body_ref: OPERATOR_SHA256_HEX,
    };
    const result = await autoWrapAuditVerdict({
      parsedBody: bodyWithOperatorChainRef,
      rawBody: JSON.stringify(bodyWithOperatorChainRef),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("B");
    expect(result.warn).toBeUndefined();
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
    expect(envelope.signatures.length).toBe(1);
    expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");

    const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
    const inner = JSON.parse(decoded) as AuditVerdictBody;
    // Mode B contract: operator-supplied chain ref preserved verbatim.
    expect(inner.prev_audit_body_ref).toBe(OPERATOR_SHA256_HEX);
  });

  it("T5.2: operator-supplied SHA-256 chain ref takes precedence over channel-JSONL prior audit-verdict (Mode B trust vs Mode A walk)", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    // Seed channel with a prior audit-verdict so Mode A would have a chain ref
    // to compute. Mode B contract: even WITH a prior on the channel, operator-
    // supplied SHA-256 hex takes precedence and the JSONL-walk is skipped.
    const priorBody = JSON.stringify({
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 1 },
    });
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: priorBody,
    });

    const bodyWithOperatorChainRef: AuditVerdictBody = {
      ...CANONICAL_BODY,
      prev_audit_body_ref: OPERATOR_SHA256_HEX,
    };
    const result = await autoWrapAuditVerdict({
      parsedBody: bodyWithOperatorChainRef,
      rawBody: JSON.stringify(bodyWithOperatorChainRef),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("B");
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
    const inner = JSON.parse(decoded) as AuditVerdictBody;
    // Operator value wins; Mode A walk-computed value would have been a
    // different hash (computePayloadHash of priorBody). The operator
    // alternating-hex pattern is preserved verbatim, proving Mode B
    // bypassed the walk.
    expect(inner.prev_audit_body_ref).toBe(OPERATOR_SHA256_HEX);
    // Negative assertion: not the computed-from-priorBody value Mode A would
    // have injected. computePayloadHash uses canonical-JSON of priorBody;
    // independent computation confirms Mode B bypassed the walk.
    const computedFromPrior =
      await import("../../src/channels/audit-signature-chain.ts").then((m) =>
        m.computePayloadHash(priorBody),
      );
    expect(inner.prev_audit_body_ref).not.toBe(computedFromPrior);
  });

  it("T5.3: Mode B envelope round-trips through parseDsseEnvelope with operator chain ref intact", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const bodyWithOperatorChainRef: AuditVerdictBody = {
      ...CANONICAL_BODY,
      prev_audit_body_ref: OPERATOR_SHA256_HEX,
    };
    const result = await autoWrapAuditVerdict({
      parsedBody: bodyWithOperatorChainRef,
      rawBody: JSON.stringify(bodyWithOperatorChainRef),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(result.mode).toBe("B");
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
    expect(envelope.payload.length).toBeGreaterThan(0);
    expect(envelope.signatures.length).toBe(1);
    expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");
    expect(
      unwrap(envelope.signatures[0], "signature").sig.length,
    ).toBeGreaterThan(0);

    const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
    const inner = JSON.parse(decoded) as AuditVerdictBody;
    expect(inner.kind_version).toBe(1);
    expect(inner.verdict).toBe("SHIP-CLEAN");
    expect(inner.target_pr?.repo).toBe("conductor");
    expect(inner.prev_audit_body_ref).toBe(OPERATOR_SHA256_HEX);
    // Verify the signature is a base64-encoded non-empty string (signature
    // bytes; not the payload).
    expect(unwrap(envelope.signatures[0], "signature").sig).toMatch(
      /^[A-Za-z0-9+/=_-]+$/,
    );
  });
});

describe("autoWrapAuditVerdict — Section 6: Mode D operator-explicit chain-ref opt-out (--no-chain)", () => {
  it("T6.1: forceNoChain=true + cohort key resolvable → Mode D envelope with prev_audit_body_ref: null", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const result = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
      forceNoChain: true,
    });
    expect(result.mode).toBe("D");
    expect(result.warn).toBeUndefined();
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
    expect(envelope.signatures.length).toBe(1);
    expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");

    const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
    const inner = JSON.parse(decoded) as AuditVerdictBody;
    // Mode D contract: prev_audit_body_ref MUST be null (explicit opt-out).
    expect(inner.prev_audit_body_ref).toBeNull();
  });

  it("T6.2: forceNoChain=true + prior audit-verdict on channel → Mode D bypasses Mode A walk (precedence)", async () => {
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    // Seed a prior audit-verdict — Mode A would walk this and compute a chain
    // ref. Mode D contract: forceNoChain=true bypasses the walk; envelope has
    // null chain ref despite the prior existing on channel.
    const priorBody = JSON.stringify({
      ...CANONICAL_BODY,
      target_pr: { repo: "conductor", number: 1 },
    });
    appendChannelMessage({
      ts: "2026-05-26T18:00:00.000Z",
      from: "session-1",
      kind: "audit-verdict",
      body: priorBody,
    });

    const result = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
      forceNoChain: true,
    });
    expect(result.mode).toBe("D");
    const envelope = unwrap(parseDsseEnvelope(result.body), "envelope");
    const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
    const inner = JSON.parse(decoded) as AuditVerdictBody;
    // Mode D bypassed the walk — chain ref null, NOT the Mode-A-equivalent
    // computed hash. Independent negative assertion via computePayloadHash
    // proves the walk was skipped.
    expect(inner.prev_audit_body_ref).toBeNull();
    const computedFromPrior =
      await import("../../src/channels/audit-signature-chain.ts").then((m) =>
        m.computePayloadHash(priorBody),
      );
    expect(inner.prev_audit_body_ref).not.toBe(computedFromPrior);
  });

  it("T6.3: forceNoChain=true + cohort key UNRESOLVABLE → Mode C fallback (Mode D requires resolvable key, same as Mode A)", async () => {
    // No runBootstrap — cohort key unresolvable.
    const result = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
      forceNoChain: true,
    });
    // Mode D requires a resolvable cohort key (DSSE envelope wrap needs the
    // private key); without it, dispatcher falls back to Mode C — same shape
    // as Mode A's unresolvable-key behavior. Mode D is NOT a bypass for the
    // signing requirement; only a bypass for the chain-ref computation.
    expect(result.mode).toBe("C");
    expect(result.body).toBe(JSON.stringify(CANONICAL_BODY));
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("cohort key file");
  });

  it("T6.4: forceNoChain=false (or omitted) → Mode A path unaffected (regression coverage)", async () => {
    // forceNoChain omitted is equivalent to forceNoChain=false (undefined !==
    // true). This test locks the regression class: pre-Mode-D consumers that
    // don't pass forceNoChain must continue to get Mode A behavior.
    await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const resultOmitted = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
    });
    expect(resultOmitted.mode).toBe("A");

    const resultExplicitFalse = await autoWrapAuditVerdict({
      parsedBody: CANONICAL_BODY,
      rawBody: JSON.stringify(CANONICAL_BODY),
      channelId,
      channelsDir: channelsDirAbs,
      nato: "charlie",
      cohortDir: cohortDirAbs,
      forceNoChain: false,
    });
    expect(resultExplicitFalse.mode).toBe("A");
  });
});
