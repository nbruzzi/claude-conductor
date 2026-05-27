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
    expect(inner.target_pr.repo).toBe("conductor");
    expect(inner.prev_audit_body_ref).toBeNull();
  });
});
