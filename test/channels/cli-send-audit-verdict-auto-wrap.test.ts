// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI integration tests for the Lane P audit-verdict auto-wrap follow-up
 * (Cycle 2 Pair B substrate-debt — Charlie-pen Lane P follow-on to PR #146
 * MVP per slice plan body
 * `~/.claude/plans/cycle-2-substrate-debt-pair-b-2026-05-27.md` §3).
 *
 * The dispatcher unit tests at `audit-verdict-auto-wrap.test.ts` cover the
 * `autoWrapAuditVerdict` function in depth (Mode A bootstrap + chained,
 * Mode C variants, body-shape gate, key-resolvable gate). This file covers
 * the **CLI wiring** — `bun run src/channels/cli.ts send <ch> audit-verdict`
 * exercises the dispatcher via the operator-send path. The test boundary
 * here is wiring-correctness, not dispatcher-correctness.
 *
 * Coverage organized by section:
 *   1. Mode A engaged — claim + cohort key resolvable → DSSE envelope on JSONL
 *   2. Mode C fallback — claim + missing key OR UUID chain ref → raw + stderr WARN
 *   3. Claimless — no NATO claim on channel → dispatcher skipped, raw body emitted
 *   4. Schema-fail short-circuit — validation die fires before dispatcher
 *
 * Per `[[feedback-substrate-fix-pattern-must-self-mirror]]`: this CLI
 * integration test IS the operator-path-bridge canary — the dispatcher
 * already exists as substrate-primitive; the test confirms operators reach
 * it on the standard send path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claimIdentityNamed } from "../../src/channels/identity.ts";
import { createChannel } from "../../src/channels/index.ts";
import { runBootstrap } from "../../src/audit/cli.ts";
import {
  AUDIT_VERDICT_PAYLOAD_TYPE,
  parseDsseEnvelope,
} from "../../src/channels/audit-signature-chain.ts";
import { auditTargetToWire } from "../../src/channels/audit-types.ts";
import type { AuditVerdictBody } from "../../src/channels/audit-verdict.ts";
import { parseAuditAskBody } from "../../src/channels/audit-ask.ts";

function unwrap<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`unwrap: expected non-null/non-undefined ${label}`);
  }
  return value;
}

const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const CLI_PATH = join(PACKAGE_ROOT, "src", "channels", "cli.ts");

// UUID-shaped per `isValidSessionId` in src/active-sessions/index.ts; the CLI
// rejects non-UUID CLAUDE_SESSION_ID per `feedback-channel-cli-uuid-only-env`.
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000042";

const CANONICAL_BODY: AuditVerdictBody = {
  kind_version: 1,
  target: { kind: "pr", repo: "conductor", number: 998 },
  target_peer: "Alpha",
  lens_set_applied: ["RE"],
  audit_class: "inside-pair",
  audit_axes: ["depth"],
  verdict: "SHIP-CLEAN",
  counts: { blocker: 0, fold: 0, nit: 0 },
  three_option_ask: {
    a_ratify: "Lane P CLI integration test fixture",
    b_fold_if_applicable: null,
    c_reframe_if_applicable: null,
  },
  findings: [],
  signed_at: "2099-12-31T23:59:59.999Z",
  signer_role: "queue",
};

let testTmpDir: string;
let channelsDirAbs: string;
let keysDirAbs: string;
let cohortKeysDirAbs: string;

beforeEach(() => {
  testTmpDir = mkdtempSync(join(tmpdir(), "cli-send-auto-wrap-"));
  channelsDirAbs = join(testTmpDir, "channels");
  keysDirAbs = join(testTmpDir, "keys");
  cohortKeysDirAbs = join(keysDirAbs, "cohort");
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = channelsDirAbs;
  process.env["CLAUDE_CONDUCTOR_KEYS_DIR"] = keysDirAbs;
});

afterEach(() => {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  delete process.env["CLAUDE_CONDUCTOR_KEYS_DIR"];
  rmSync(testTmpDir, { recursive: true, force: true });
});

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runSend(
  channelId: string,
  bodyFilePath: string,
  sessionId: string = TEST_SESSION_ID,
  extraArgs: readonly string[] = [],
): RunResult {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      CLI_PATH,
      "send",
      channelId,
      "audit-verdict",
      "--body-file",
      bodyFilePath,
      ...extraArgs,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDirAbs,
      CLAUDE_CONDUCTOR_KEYS_DIR: keysDirAbs,
      CLAUDE_SESSION_ID: sessionId,
    },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function writeBodyFile(body: AuditVerdictBody | string): string {
  const bodyPath = join(
    testTmpDir,
    `body-${Math.random().toString(36).slice(2, 10)}.json`,
  );
  // Spread wire target fields so the strict-wire send gate (#230 F2) passes.
  const bodyStr =
    typeof body === "string"
      ? body
      : JSON.stringify({ ...body, ...auditTargetToWire(body.target) });
  writeFileSync(bodyPath, bodyStr);
  return bodyPath;
}

function readChannelJsonl(
  channelId: string,
): readonly Record<string, unknown>[] {
  const messagesPath = join(channelsDirAbs, channelId, "messages.jsonl");
  const raw = readFileSync(messagesPath, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function resolveJsonlBody(
  channelId: string,
  msg: Record<string, unknown>,
): string {
  if (typeof msg["body"] === "string") return msg["body"] as string;
  const bodyRef = msg["body_ref"];
  if (typeof bodyRef !== "string") {
    throw new Error("message has neither inline body nor body_ref");
  }
  return readFileSync(
    join(channelsDirAbs, channelId, "bodies", `${bodyRef}.txt`),
    "utf-8",
  );
}

describe("cli send audit-verdict — Lane P CLI integration", () => {
  describe("Section 1 — Mode A auto-wrap engaged via CLI", () => {
    it("C1.1: claim + cohort key + no prior audit-verdict → DSSE envelope written to JSONL", async () => {
      const channelId = "c-lane-p-mode-a-bootstrap";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      const bodyPath = writeBodyFile(CANONICAL_BODY);
      const result = runSend(channelId, bodyPath);

      expect(result.exitCode).toBe(0);
      // Mode A → no stderr WARN (dispatcher returns warn=undefined).
      expect(result.stderr).toBe("");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(1);
      const auditMsg = unwrap(auditVerdicts[0], "audit verdict");
      const bodyStr = resolveJsonlBody(channelId, auditMsg);
      const envelope = unwrap(parseDsseEnvelope(bodyStr), "DSSE envelope");
      expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
      expect(envelope.signatures.length).toBe(1);
      expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");

      const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
      const inner = JSON.parse(decoded) as AuditVerdictBody;
      // Bootstrap case: no prior audit-verdict → prev_audit_body_ref: null.
      expect(inner.prev_audit_body_ref).toBeNull();
    });

    it("C1.2: claim + cohort key + prior audit-verdict on channel → DSSE envelope with SHA-256 chain ref", async () => {
      const channelId = "c-lane-p-mode-a-chained";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      // First send — bootstrap audit-verdict, no chain ref expected.
      const firstBody: AuditVerdictBody = {
        ...CANONICAL_BODY,
        target: { kind: "pr", repo: "conductor", number: 1 },
      };
      const firstResult = runSend(channelId, writeBodyFile(firstBody));
      expect(firstResult.exitCode).toBe(0);

      // Second send — should auto-compute SHA-256 of first audit-verdict's
      // canonical-JSON payload + inject as prev_audit_body_ref.
      const secondBody: AuditVerdictBody = {
        ...CANONICAL_BODY,
        target: { kind: "pr", repo: "conductor", number: 2 },
      };
      const secondResult = runSend(channelId, writeBodyFile(secondBody));
      expect(secondResult.exitCode).toBe(0);
      expect(secondResult.stderr).toBe("");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(2);

      const secondMsg = unwrap(auditVerdicts[1], "second audit verdict");
      const bodyStr = resolveJsonlBody(channelId, secondMsg);
      const envelope = unwrap(parseDsseEnvelope(bodyStr), "second envelope");
      const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
      const inner = JSON.parse(decoded) as AuditVerdictBody;
      const chainRef = unwrap(inner.prev_audit_body_ref, "chain ref");
      expect(chainRef.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(chainRef)).toBe(true);
    });
  });

  describe("Section 2 — Mode C fallback via CLI (raw body + stderr WARN)", () => {
    it("C2.1: claim + NO cohort key → raw body on JSONL + stderr WARN naming the bootstrap path", async () => {
      const channelId = "c-lane-p-mode-c-no-key";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      // No runBootstrap — cohort key unresolvable.

      const bodyPath = writeBodyFile(CANONICAL_BODY);
      const result = runSend(channelId, bodyPath);

      expect(result.exitCode).toBe(0);
      // Mode C → stderr WARN explains the bootstrap recovery path.
      expect(result.stderr).toContain("cohort key file");
      expect(result.stderr).toContain("audit bootstrap");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(1);
      const auditMsg = unwrap(auditVerdicts[0], "audit verdict");
      const bodyStr = resolveJsonlBody(channelId, auditMsg);
      // Mode C emits the raw body unchanged — NOT a DSSE envelope.
      expect(parseDsseEnvelope(bodyStr)).toBeNull();
      const parsed = JSON.parse(bodyStr) as AuditVerdictBody;
      expect(parsed.target).toEqual(CANONICAL_BODY.target);
    });

    it("C2.2: claim + cohort key + operator-supplied UUID prev_audit_body_ref → Mode C raw + stderr WARN", async () => {
      const channelId = "c-lane-p-mode-c-uuid-ref";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      const uuidShapedChainRef = "b4f430cd-5eab-4189-995b-0a940ee48b67";
      const bodyWithUuid: AuditVerdictBody = {
        ...CANONICAL_BODY,
        prev_audit_body_ref: uuidShapedChainRef,
      };
      const result = runSend(channelId, writeBodyFile(bodyWithUuid));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("does not match SHA-256 hex");
      // WARN should preserve enough of the offending value for operator
      // diagnosis (slice 16 prefix per dispatcher implementation).
      expect(result.stderr).toContain(uuidShapedChainRef.slice(0, 16));

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(1);
      const auditMsg = unwrap(auditVerdicts[0], "audit verdict");
      const bodyStr = resolveJsonlBody(channelId, auditMsg);
      // Mode C preserves the operator-supplied UUID chain ref in the raw
      // body — important for forensic auditability.
      expect(parseDsseEnvelope(bodyStr)).toBeNull();
      const parsed = JSON.parse(bodyStr) as AuditVerdictBody;
      expect(parsed.prev_audit_body_ref).toBe(uuidShapedChainRef);
    });
  });

  describe("Section 3 — Claimless (no NATO identity) skips dispatcher", () => {
    it("C3.1: send audit-verdict without claiming identity → raw body emitted + no stderr WARN", async () => {
      const channelId = "c-lane-p-claimless";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      // No claimIdentityNamed — operator has no NATO identity on this channel.
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      const bodyPath = writeBodyFile(CANONICAL_BODY);
      const result = runSend(channelId, bodyPath);

      expect(result.exitCode).toBe(0);
      // Claimless path bypasses dispatcher entirely → no stderr WARN.
      expect(result.stderr).toBe("");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(1);
      const auditMsg = unwrap(auditVerdicts[0], "audit verdict");
      const bodyStr = resolveJsonlBody(channelId, auditMsg);
      // No DSSE envelope, no auto-wrap.
      expect(parseDsseEnvelope(bodyStr)).toBeNull();
    });
  });

  describe("Section 4 — Schema-fail short-circuits before dispatcher", () => {
    it("C4.1: malformed audit-verdict body → exit 2 (validation die fires; dispatcher never invoked)", async () => {
      const channelId = "c-lane-p-schema-fail";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      // Missing required fields (e.g., counts, three_option_ask) — schema fails.
      const malformedBody = JSON.stringify({
        kind_version: 1,
        target_pr: { repo: "conductor", number: 999 },
        target_peer: "Alpha",
      });
      const bodyPath = writeBodyFile(malformedBody);
      const result = runSend(channelId, bodyPath);

      // Validation die uses code 2 per cli.ts audit-verdict gate.
      expect(result.exitCode).toBe(2);
      // No JSONL message should be written — appendMessage is reached only
      // after all validators pass.
      try {
        const messages = readChannelJsonl(channelId);
        const auditVerdicts = messages.filter(
          (m) => m["kind"] === "audit-verdict",
        );
        expect(auditVerdicts.length).toBe(0);
      } catch (e) {
        // messages.jsonl absent is also a valid pass — no send happened.
        if (!(e instanceof Error) || !e.message.includes("ENOENT")) throw e;
      }
    });
  });

  describe("Section 5 — Mode B operator-supplied SHA-256 chain ref via CLI (Stage 2 S2-A)", () => {
    // Canonical 64-hex SHA-256 fixture; alternating-pattern keeps surface
    // recognizable if anything mutates the operator value during the round-
    // trip. Real-world SHA-256 hex from `computePayloadHash` would be random.
    const OPERATOR_SHA256_HEX =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    it("C5.1: claim + cohort key + operator-supplied SHA-256 prev_audit_body_ref → Mode B envelope with operator value preserved", async () => {
      const channelId = "c-lane-p-mode-b-operator-sha";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      const bodyWithOperatorChainRef: AuditVerdictBody = {
        ...CANONICAL_BODY,
        prev_audit_body_ref: OPERATOR_SHA256_HEX,
      };
      const result = runSend(
        channelId,
        writeBodyFile(bodyWithOperatorChainRef),
      );

      expect(result.exitCode).toBe(0);
      // Mode B → no stderr WARN (canonical operator path, no operator-
      // discipline signal needed).
      expect(result.stderr).toBe("");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(1);
      const auditMsg = unwrap(auditVerdicts[0], "audit verdict");
      const bodyStr = resolveJsonlBody(channelId, auditMsg);
      // Mode B emits a DSSE envelope (same shape as Mode A).
      const envelope = unwrap(parseDsseEnvelope(bodyStr), "DSSE envelope");
      expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
      expect(envelope.signatures.length).toBe(1);
      expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");

      const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
      const inner = JSON.parse(decoded) as AuditVerdictBody;
      // Mode B contract via CLI: operator-supplied chain ref preserved.
      expect(inner.prev_audit_body_ref).toBe(OPERATOR_SHA256_HEX);
    });

    it("C5.2: Mode B precedence — operator-supplied SHA-256 wins over channel-JSONL prior audit-verdict via CLI", async () => {
      const channelId = "c-lane-p-mode-b-precedence";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      // First send — bootstrap audit-verdict via Mode A path (no operator
      // chain ref); seeds the channel JSONL with a prior audit-verdict that
      // Mode A would normally walk to. Mode B contract: even WITH this prior
      // on the channel, the operator-supplied SHA-256 on the second send
      // takes precedence.
      const firstBody: AuditVerdictBody = {
        ...CANONICAL_BODY,
        target: { kind: "pr", repo: "conductor", number: 1 },
      };
      const firstResult = runSend(channelId, writeBodyFile(firstBody));
      expect(firstResult.exitCode).toBe(0);

      const secondBody: AuditVerdictBody = {
        ...CANONICAL_BODY,
        target: { kind: "pr", repo: "conductor", number: 2 },
        prev_audit_body_ref: OPERATOR_SHA256_HEX,
      };
      const secondResult = runSend(channelId, writeBodyFile(secondBody));
      expect(secondResult.exitCode).toBe(0);
      expect(secondResult.stderr).toBe("");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(2);

      const secondMsg = unwrap(auditVerdicts[1], "second audit verdict");
      const bodyStr = resolveJsonlBody(channelId, secondMsg);
      const envelope = unwrap(parseDsseEnvelope(bodyStr), "envelope");
      const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
      const inner = JSON.parse(decoded) as AuditVerdictBody;
      // Operator value preserved; the channel-JSONL walk that Mode A would
      // have performed against the first audit-verdict's payload is bypassed.
      expect(inner.prev_audit_body_ref).toBe(OPERATOR_SHA256_HEX);
    });
  });

  describe("Section 6 — Mode D operator-explicit chain-ref opt-out via CLI --no-chain (Stage 3 S3-A)", () => {
    it("C6.1: claim + cohort key + --no-chain → Mode D envelope with prev_audit_body_ref: null on JSONL", async () => {
      const channelId = "c-lane-p-mode-d-no-chain";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      const bodyPath = writeBodyFile(CANONICAL_BODY);
      const result = runSend(channelId, bodyPath, TEST_SESSION_ID, [
        "--no-chain",
      ]);

      expect(result.exitCode).toBe(0);
      // Mode D → no stderr WARN (canonical operator path; explicit opt-out).
      expect(result.stderr).toBe("");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(1);
      const auditMsg = unwrap(auditVerdicts[0], "audit verdict");
      const bodyStr = resolveJsonlBody(channelId, auditMsg);
      const envelope = unwrap(parseDsseEnvelope(bodyStr), "DSSE envelope");
      expect(envelope.payloadType).toBe(AUDIT_VERDICT_PAYLOAD_TYPE);
      expect(envelope.signatures.length).toBe(1);
      expect(unwrap(envelope.signatures[0], "signature").keyid).toBe("charlie");

      const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
      const inner = JSON.parse(decoded) as AuditVerdictBody;
      // Mode D contract via CLI: prev_audit_body_ref MUST be null.
      expect(inner.prev_audit_body_ref).toBeNull();
    });

    it("C6.2: --no-chain + non-null prev_audit_body_ref in body → CLI dies with VALIDATION (mutex)", async () => {
      const channelId = "c-lane-p-mode-d-mutex";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });

      const OPERATOR_SHA256_HEX =
        "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      const bodyWithChainRef: AuditVerdictBody = {
        ...CANONICAL_BODY,
        prev_audit_body_ref: OPERATOR_SHA256_HEX,
      };
      const result = runSend(
        channelId,
        writeBodyFile(bodyWithChainRef),
        TEST_SESSION_ID,
        ["--no-chain"],
      );

      // CLI semantic mutex fires → die with VALIDATION exit 2 BEFORE dispatcher invocation.
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--no-chain");
      expect(result.stderr).toContain("mutually exclusive");
      // No message landed in JSONL (die fires before appendMessage).
      try {
        const messages = readChannelJsonl(channelId);
        const auditVerdicts = messages.filter(
          (m) => m["kind"] === "audit-verdict",
        );
        expect(auditVerdicts.length).toBe(0);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes("ENOENT")) throw e;
      }
    });

    it("C6.3: --no-chain + cohort key UNRESOLVABLE → Mode C fallback (raw + stderr WARN)", async () => {
      const channelId = "c-lane-p-mode-d-no-cohort-key";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      // No runBootstrap — cohort key unresolvable.

      const bodyPath = writeBodyFile(CANONICAL_BODY);
      const result = runSend(channelId, bodyPath, TEST_SESSION_ID, [
        "--no-chain",
      ]);

      expect(result.exitCode).toBe(0);
      // Mode C fallback because cohort key unresolvable; Mode D requires
      // resolvable key for the DSSE envelope wrap.
      expect(result.stderr).toContain("cohort key file");
      expect(result.stderr).toContain("audit bootstrap");

      const messages = readChannelJsonl(channelId);
      const auditVerdicts = messages.filter(
        (m) => m["kind"] === "audit-verdict",
      );
      expect(auditVerdicts.length).toBe(1);
      const auditMsg = unwrap(auditVerdicts[0], "audit verdict");
      const bodyStr = resolveJsonlBody(channelId, auditMsg);
      // Mode C emits raw body unchanged — NOT a DSSE envelope. The --no-chain
      // flag does not override the cohort-key requirement; Mode D requires
      // signing capability same as Mode A.
      expect(parseDsseEnvelope(bodyStr)).toBeNull();
      const parsed = JSON.parse(bodyStr) as AuditVerdictBody;
      expect(parsed.target).toEqual(CANONICAL_BODY.target);
    });
  });

  describe("Section 5 — strict-wire send gate (#230 F2) rejection cells", () => {
    // Non-vacuity: these are the delete-the-gate-reds witnesses. A body
    // carrying only the pre-normalized 'target' passes schema parsing (the
    // internal roundtrip convenience branch) but violates the published
    // wire contract — the send boundary must reject it, else pre-#230
    // readers null on the wire body in mixed-version cohorts.
    function runSendKind(
      channelId: string,
      sendKind: string,
      bodyFilePath: string,
    ): RunResult {
      const proc = Bun.spawnSync({
        cmd: [
          "bun",
          CLI_PATH,
          "send",
          channelId,
          sendKind,
          "--body-file",
          bodyFilePath,
        ],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDirAbs,
          CLAUDE_CONDUCTOR_KEYS_DIR: keysDirAbs,
          CLAUDE_SESSION_ID: TEST_SESSION_ID,
        },
      });
      return {
        exitCode: proc.exitCode ?? -1,
        stdout: new TextDecoder().decode(proc.stdout),
        stderr: new TextDecoder().decode(proc.stderr),
      };
    }

    it("S5.1: target-only audit-verdict body → exit 2 VALIDATION, missing-wire-target error", async () => {
      const channelId = "c-strict-wire-verdict";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      // String form bypasses writeBodyFile's auditTargetToWire spread —
      // the body is schema-valid (target branch) but wire-invalid.
      const bodyPath = writeBodyFile(JSON.stringify(CANONICAL_BODY));
      const result = runSendKind(channelId, "audit-verdict", bodyPath);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "audit-verdict body missing wire target field",
      );
    });

    it("S5.2: target-only audit-ask body → exit 2 VALIDATION, missing-wire-target error", async () => {
      const channelId = "c-strict-wire-ask";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      const askBody = {
        kind_version: 1,
        target: { kind: "pr", repo: "conductor", number: 998 },
        target_peer: "Alpha",
        tier: "light-touch",
        lens_set_requested: ["RE"],
        audit_class: "inside-pair",
      };
      const bodyPath = writeBodyFile(JSON.stringify(askBody));
      const result = runSendKind(channelId, "audit-ask", bodyPath);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "audit-ask body missing wire target field",
      );
    });
  });

  describe("Section 6 — --target-plan flag injects wire field at send time (T1-T6)", () => {
    function runSendKindWithArgs(
      channelId: string,
      sendKind: string,
      bodyFilePath: string,
      extraArgs: readonly string[] = [],
    ): RunResult {
      const proc = Bun.spawnSync({
        cmd: [
          "bun",
          CLI_PATH,
          "send",
          channelId,
          sendKind,
          "--body-file",
          bodyFilePath,
          ...extraArgs,
        ],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDirAbs,
          CLAUDE_CONDUCTOR_KEYS_DIR: keysDirAbs,
          CLAUDE_SESSION_ID: TEST_SESSION_ID,
        },
      });
      return {
        exitCode: proc.exitCode ?? -1,
        stdout: new TextDecoder().decode(proc.stdout),
        stderr: new TextDecoder().decode(proc.stderr),
      };
    }

    it("T1: audit-ask + --target-plan → exit 0; body has target_plan.ref; parseAuditAskBody returns target.kind=plan", async () => {
      const channelId = "c-s6-t1-ask-target-plan";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      const askBody = {
        kind_version: 1,
        target_peer: "Bravo",
        tier: "light-touch",
        lens_set_requested: ["RE"],
        audit_class: "inside-pair",
      };
      const bodyPath = join(testTmpDir, "body-s6-t1.json");
      writeFileSync(bodyPath, JSON.stringify(askBody));
      const result = runSendKindWithArgs(channelId, "audit-ask", bodyPath, [
        "--target-plan",
        "plans/x.md",
      ]);
      expect(result.exitCode).toBe(0);
      const messages = readChannelJsonl(channelId);
      const askMsg = unwrap(
        messages.find((m) => m["kind"] === "audit-ask"),
        "ask message",
      );
      const bodyStr = resolveJsonlBody(channelId, askMsg);
      const parsedObj = JSON.parse(bodyStr) as Record<string, unknown>;
      expect(parsedObj["target_plan"]).toStrictEqual({ ref: "plans/x.md" });
      const parsedAsk = unwrap(parseAuditAskBody(bodyStr), "parsedAsk");
      expect(parsedAsk.target.kind).toBe("plan");
    });

    it("T2: audit-verdict + --target-plan → exit 0; DSSE payload has target_plan.ref", async () => {
      const channelId = "c-s6-t2-verdict-target-plan";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      await claimIdentityNamed({
        channelId,
        sessionId: TEST_SESSION_ID,
        identity: "Charlie",
        force: false,
      });
      await runBootstrap({
        identity: "charlie",
        force: false,
        cohortDir: cohortKeysDirAbs,
      });
      // Body string WITHOUT wire target — mirrors S5.1 fixture shape.
      // Passing a string to writeBodyFile bypasses the auditTargetToWire spread.
      const bodyPath = writeBodyFile(JSON.stringify(CANONICAL_BODY));
      const result = runSend(channelId, bodyPath, TEST_SESSION_ID, [
        "--target-plan",
        "plans/x.md",
      ]);
      expect(result.exitCode).toBe(0);
      const messages = readChannelJsonl(channelId);
      const auditMsg = unwrap(
        messages.find((m) => m["kind"] === "audit-verdict"),
        "audit verdict",
      );
      const bodyRaw = resolveJsonlBody(channelId, auditMsg);
      // Body IS the DSSE auto-wrap envelope — decode payload to inspect wire fields.
      const envelope = unwrap(parseDsseEnvelope(bodyRaw), "DSSE envelope");
      const decoded = Buffer.from(envelope.payload, "base64").toString("utf-8");
      const inner = JSON.parse(decoded) as Record<string, unknown>;
      expect(inner["target_plan"]).toStrictEqual({ ref: "plans/x.md" });
    });

    it("T3: body with target_pr + --target-plan → exit 2, stderr matches 'already carries a wire target field'", async () => {
      const channelId = "c-s6-t3-conflict";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      // writeBodyFile spreads auditTargetToWire → body already has target_pr
      const bodyPath = writeBodyFile(CANONICAL_BODY);
      const result = runSend(channelId, bodyPath, TEST_SESSION_ID, [
        "--target-plan",
        "plans/x.md",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("already carries a wire target field");
    });

    it("T4: kind=note + --target-plan → exit 2, stderr matches 'applies only to audit-ask|audit-verdict'", async () => {
      const channelId = "c-s6-t4-wrong-kind";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      const bodyPath = join(testTmpDir, "body-s6-t4.txt");
      writeFileSync(bodyPath, "plain note body");
      const result = runSendKindWithArgs(channelId, "note", bodyPath, [
        "--target-plan",
        "plans/x.md",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "applies only to audit-ask|audit-verdict",
      );
    });

    it("T5: non-JSON body + --target-plan (kind=audit-ask) → exit 2, stderr matches 'requires a JSON object body'", async () => {
      const channelId = "c-s6-t5-nonjson";
      await createChannel({
        channelId,
        handoffId: channelId,
        sessionId: TEST_SESSION_ID,
      });
      const bodyPath = join(testTmpDir, "body-s6-t5.txt");
      writeFileSync(bodyPath, "this is not json");
      const result = runSendKindWithArgs(channelId, "audit-ask", bodyPath, [
        "--target-plan",
        "plans/x.md",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("requires a JSON object body");
    });

    it("T6: --target-plan with no value → exit 2 ARGS", () => {
      // No channel setup needed — die fires in parseTargetPlanFlag before
      // any channel I/O or stdin read.
      const proc = Bun.spawnSync({
        cmd: [
          "bun",
          CLI_PATH,
          "send",
          "any-channel",
          "audit-ask",
          "--target-plan",
        ],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CLAUDE_CONDUCTOR_CHANNELS_DIR: channelsDirAbs,
          CLAUDE_CONDUCTOR_KEYS_DIR: keysDirAbs,
          CLAUDE_SESSION_ID: TEST_SESSION_ID,
        },
      });
      expect(proc.exitCode).toBe(2);
      expect(new TextDecoder().decode(proc.stderr)).toContain(
        "--target-plan requires a non-empty ref argument",
      );
    });
  });
});
