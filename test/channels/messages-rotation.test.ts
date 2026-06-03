// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for `messages.jsonl` rotation — the intra-channel archive primitive
 * that bounds an eternal channel's unbounded growth (Lane B follow-up to the
 * dispatcher-resilience arc; design `~/.claude/plans/messages-jsonl-rotation-
 * design.md`, mode-A full-rename per the concurrency-safety inversion ratified
 * on the cohort `coordination` channel).
 *
 * Invariants covered (per the design build-checklist + Alpha's merge-gate
 * pressure-tests):
 *   - threshold gating: below-threshold / absent → skip; at/above → rotate;
 *     RE-3 boundary guard.
 *   - archive seal + live reset: rotate renames the live file into
 *     `messages.<seq>.archive.jsonl` (zero-loss atomic rename) and resets the
 *     live file; subsequent appends isolate to the fresh live file.
 *   - round-trip + ordering: `readMessages({ includeArchive: true })` after
 *     rotation equals the full original append-order sequence, spanning
 *     multiple archive seqs + live.
 *   - boundary-spanning readers: `readMessagesTail` / `readMessagesAfter`
 *     stay correct across the rotation boundary.
 *   - verdict-chain integrity: a real DSSE-signed verdict chain split across
 *     archive + live still fully verifies (the verifier reads `includeArchive`).
 *   - opt-in gate: `isChannelRotationAutoEnabled` is OFF by default.
 *
 * Setup writes raw JSONL lines (sibling to `test/audit/verify.test.ts`) so the
 * tests control ts + body exactly; rotation + the readers do not depend on how
 * a line was appended.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isChannelRotationAutoEnabled,
  listChannelArchiveFilePaths,
  readMessages,
  readMessagesAfter,
  readMessagesTail,
  rotateChannelMessages,
  type RotateMessagesResult,
} from "../../src/channels/index.ts";
import { lookupPriorAuditVerdictPayload } from "../../src/channels/audit-verdict-auto-wrap.ts";
import { getMostRecentPeerKind } from "../../src/channels/peer-recent-message.ts";
import { verifyChannelAuditChain } from "../../src/audit/verify.ts";
import { runBootstrap } from "../../src/audit/cli.ts";
import { importPrivateKey } from "../../src/channels/key-surface.ts";
import {
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";
import { computePayloadHash } from "../../src/channels/audit-signature-chain.ts";

const SESSION_ID = "ad41f287-c7d2-4b01-a3ad-3aec8eb25d29";

let tmpRoot: string;
let channelsDirAbs: string;
let cohortDirAbs: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "messages-rotation-test-"));
  channelsDirAbs = join(tmpRoot, "channels");
  cohortDirAbs = join(tmpRoot, "cohort");
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = channelsDirAbs;
  process.env["CLAUDE_SESSION_ID"] = SESSION_ID;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
  if (prevSessionId !== undefined) {
    process.env["CLAUDE_SESSION_ID"] = prevSessionId;
  } else {
    delete process.env["CLAUDE_SESSION_ID"];
  }
});

function channelDirAbs(channelId: string): string {
  return join(channelsDirAbs, channelId);
}
function messagesFileAbs(channelId: string): string {
  return join(channelDirAbs(channelId), "messages.jsonl");
}
function archiveFileAbs(channelId: string, seq: number): string {
  return join(channelDirAbs(channelId), `messages.${seq}.archive.jsonl`);
}
function setup(channelId: string): void {
  mkdirSync(channelDirAbs(channelId), { recursive: true });
}
function tsAt(i: number): string {
  return `2026-06-03T20:00:${String(i).padStart(2, "0")}.000Z`;
}
function appendRaw(channelId: string, msg: Record<string, unknown>): void {
  writeFileSync(messagesFileAbs(channelId), JSON.stringify(msg) + "\n", {
    flag: "a",
  });
}
function appendStatus(channelId: string, i: number): void {
  appendRaw(channelId, {
    ts: tsAt(i),
    from: SESSION_ID,
    kind: "status",
    body: `msg-${i}`,
  });
}
function populate(channelId: string, count: number): void {
  setup(channelId);
  for (let i = 0; i < count; i++) appendStatus(channelId, i);
}
function assertRotated(
  r: RotateMessagesResult,
): asserts r is Extract<RotateMessagesResult, { kind: "rotated" }> {
  if (r.kind !== "rotated") {
    throw new Error(`expected rotated result, got "${r.kind}"`);
  }
}

describe("rotateChannelMessages — threshold gating", () => {
  it("skips when the live file is below threshold", async () => {
    populate("rot-below", 3);
    const r = await rotateChannelMessages("rot-below", {
      thresholdBytes: 1_000_000,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("below-threshold");
    expect(existsSync(archiveFileAbs("rot-below", 1))).toBe(false);
  });

  it("skips when messages.jsonl is absent", async () => {
    setup("rot-absent");
    const r = await rotateChannelMessages("rot-absent", { thresholdBytes: 1 });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("absent");
  });

  it("rotates when at/above threshold", async () => {
    populate("rot-fire", 3);
    const r = await rotateChannelMessages("rot-fire", { thresholdBytes: 1 });
    assertRotated(r);
    expect(r.seq).toBe(1);
    expect(r.archivePath).toBe(archiveFileAbs("rot-fire", 1));
    expect(r.archivedBytes).toBeGreaterThan(0);
    expect(existsSync(archiveFileAbs("rot-fire", 1))).toBe(true);
  });

  it("throws on invalid channelId (RE-3 boundary guard)", async () => {
    let err: unknown;
    try {
      await rotateChannelMessages("../escape", { thresholdBytes: 1 });
    } catch (e: unknown) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /rotateChannelMessages.*invalid channelId/,
    );
  });
});

describe("rotateChannelMessages — archive seal + live reset (zero-loss)", () => {
  it("seals live into the archive, resets live, and isolates later appends", async () => {
    populate("rot-seal", 3); // msg-0..2
    await rotateChannelMessages("rot-seal", { thresholdBytes: 1 });

    // live file renamed away; default (live-only) read is empty
    expect(existsSync(messagesFileAbs("rot-seal"))).toBe(false);
    expect(readMessages("rot-seal")).toEqual([]);
    expect(existsSync(archiveFileAbs("rot-seal", 1))).toBe(true);

    // a later append lands in a fresh live file, isolated from the archive
    appendStatus("rot-seal", 3); // msg-3
    expect(readMessages("rot-seal").map((m) => m.body)).toEqual(["msg-3"]);

    // includeArchive spans archive + live in append order — nothing lost
    expect(
      readMessages("rot-seal", { includeArchive: true }).map((m) => m.body),
    ).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
  });
});

describe("readMessages includeArchive — round-trip + ordering across rotations", () => {
  it("includeArchive after rotation equals the full original sequence", async () => {
    populate("rt-1", 5);
    const before = readMessages("rt-1").map((m) => m.body);
    await rotateChannelMessages("rt-1", { thresholdBytes: 1 });
    expect(
      readMessages("rt-1", { includeArchive: true }).map((m) => m.body),
    ).toEqual(before);
  });

  it("spans multiple archive seqs (1, 2) + live, in order", async () => {
    setup("rt-multi");
    appendStatus("rt-multi", 0);
    appendStatus("rt-multi", 1);
    const r1 = await rotateChannelMessages("rt-multi", { thresholdBytes: 1 });
    assertRotated(r1);
    expect(r1.seq).toBe(1);

    appendStatus("rt-multi", 2);
    appendStatus("rt-multi", 3);
    const r2 = await rotateChannelMessages("rt-multi", { thresholdBytes: 1 });
    assertRotated(r2);
    expect(r2.seq).toBe(2);

    appendStatus("rt-multi", 4);

    expect(existsSync(archiveFileAbs("rt-multi", 1))).toBe(true);
    expect(existsSync(archiveFileAbs("rt-multi", 2))).toBe(true);
    expect(
      readMessages("rt-multi", { includeArchive: true }).map((m) => m.body),
    ).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
    // default read = live only (post-2nd-rotation: just msg-4)
    expect(readMessages("rt-multi").map((m) => m.body)).toEqual(["msg-4"]);
  });
});

describe("readMessagesTail — spans the rotation boundary", () => {
  it("returns the last N across archive + live when live is short", async () => {
    populate("tail-rot", 5); // msg-0..4
    await rotateChannelMessages("tail-rot", { thresholdBytes: 1 }); // all archived
    appendStatus("tail-rot", 5); // msg-5 live
    appendStatus("tail-rot", 6); // msg-6 live

    // tail(4) spans msg-3,4 (archive) + msg-5,6 (live)
    expect(readMessagesTail("tail-rot", 4).map((m) => m.body)).toEqual([
      "msg-3",
      "msg-4",
      "msg-5",
      "msg-6",
    ]);
    // tail(2) satisfied from the live file alone
    expect(readMessagesTail("tail-rot", 2).map((m) => m.body)).toEqual([
      "msg-5",
      "msg-6",
    ]);
  });
});

describe("readMessagesAfter — spans the rotation boundary", () => {
  it("returns archived + live messages after a cursor that predates live", async () => {
    populate("after-rot", 5); // msg-0..4 (ts 00..04)
    await rotateChannelMessages("after-rot", { thresholdBytes: 1 }); // all archived
    appendStatus("after-rot", 5); // msg-5 live

    expect(readMessagesAfter("after-rot", tsAt(1)).map((m) => m.body)).toEqual([
      "msg-2",
      "msg-3",
      "msg-4",
      "msg-5",
    ]);
  });

  it("reads live only for a near-live cursor (no needless archive scan)", async () => {
    setup("after-near");
    appendStatus("after-near", 0);
    appendStatus("after-near", 1);
    await rotateChannelMessages("after-near", { thresholdBytes: 1 });
    appendStatus("after-near", 3); // live (ts 03)
    appendStatus("after-near", 4); // live (ts 04)

    // cursor at ts 03: live earliest (03) is not > 03, so no archive span; only msg-4
    expect(readMessagesAfter("after-near", tsAt(3)).map((m) => m.body)).toEqual(
      ["msg-4"],
    );
  });
});

describe("verifyChannelAuditChain — chain verifies across the rotation boundary", () => {
  it("a signed chain split across archive + live still fully verifies", async () => {
    const channelId = "chain-rot";
    setup(channelId);

    const bootstrap = await runBootstrap({
      identity: "charlie",
      force: false,
      cohortDir: cohortDirAbs,
    });
    const priv = await importPrivateKey(bootstrap.secretKeyPath);
    if (priv === null)
      throw new Error("failed to import bootstrap private key");

    const baseBody: AuditVerdictBody = {
      kind_version: 1,
      target_pr: { repo: "conductor", number: 99 },
      target_peer: "Alpha",
      lens_set_applied: ["RE"],
      audit_class: "inside-pair",
      audit_axes: ["depth"],
      verdict: "SHIP-CLEAN",
      counts: { blocker: 0, fold: 0, nit: 0 },
      three_option_ask: {
        a_ratify: "cleared",
        b_fold_if_applicable: null,
        c_reframe_if_applicable: null,
      },
      findings: [],
      signed_at: "2099-12-31T23:59:59.999Z",
      prev_audit_body_ref: null,
      signer_role: "queue",
    };

    // verdict 1 (bootstrap, prev=null)
    const env1Json = await wrapAuditVerdictBody(baseBody, priv, "charlie");
    const env1 = JSON.parse(env1Json) as { payload: string };
    appendRaw(channelId, {
      ts: tsAt(0),
      from: SESSION_ID,
      kind: "audit-verdict",
      body: env1Json,
    });

    // verdict 2 (chained to 1)
    const body2: AuditVerdictBody = {
      ...baseBody,
      target_pr: { repo: "conductor", number: 100 },
      prev_audit_body_ref: await computePayloadHash(env1.payload),
    };
    const env2Json = await wrapAuditVerdictBody(body2, priv, "charlie");
    const env2 = JSON.parse(env2Json) as { payload: string };
    appendRaw(channelId, {
      ts: tsAt(1),
      from: SESSION_ID,
      kind: "audit-verdict",
      body: env2Json,
    });

    // rotate → verdicts 1 + 2 sealed into the archive; live file reset
    const r = await rotateChannelMessages(channelId, { thresholdBytes: 1 });
    assertRotated(r);

    // verdict 3 (chained to 2) appended to the fresh live file
    const body3: AuditVerdictBody = {
      ...baseBody,
      target_pr: { repo: "conductor", number: 101 },
      prev_audit_body_ref: await computePayloadHash(env2.payload),
    };
    const env3Json = await wrapAuditVerdictBody(body3, priv, "charlie");
    appendRaw(channelId, {
      ts: tsAt(2),
      from: SESSION_ID,
      kind: "audit-verdict",
      body: env3Json,
    });

    // sanity: live-only sees just verdict 3; includeArchive sees all 3
    expect(readMessages(channelId).length).toBe(1);
    expect(readMessages(channelId, { includeArchive: true }).length).toBe(3);

    // the verifier reads includeArchive → the FULL chain verifies across the
    // boundary (total === 3 is the load-bearing assertion: a live-only verifier
    // would see only verdict 3 and report total === 1).
    const result = await verifyChannelAuditChain(channelId, {
      pubkeyDir: cohortDirAbs,
    });
    expect(result.output.ok).toBe(true);
    expect(result.output.total_audit_verdicts).toBe(3);
    expect(result.output.breaks).toEqual([]);
    expect(result.output.key_ids_used).toEqual(["charlie"]);
  });
});

describe("isChannelRotationAutoEnabled — opt-in gate (default OFF)", () => {
  it("is false by default and true once the flag file exists", () => {
    expect(isChannelRotationAutoEnabled()).toBe(false);
    mkdirSync(channelsDirAbs, { recursive: true });
    writeFileSync(join(channelsDirAbs, ".rotation-enabled"), "", "utf-8");
    expect(isChannelRotationAutoEnabled()).toBe(true);
  });
});

describe("listChannelArchiveFilePaths — sealed archive paths (seq-ascending)", () => {
  it("returns [] when there are no archives", () => {
    setup("arc-none");
    expect(listChannelArchiveFilePaths(channelDirAbs("arc-none"))).toEqual([]);
    appendStatus("arc-none", 0); // live file only — still no archives
    expect(listChannelArchiveFilePaths(channelDirAbs("arc-none"))).toEqual([]);
  });

  it("lists multiple archives oldest-seq first", async () => {
    setup("arc-multi");
    appendStatus("arc-multi", 0);
    await rotateChannelMessages("arc-multi", { thresholdBytes: 1 }); // seq 1
    appendStatus("arc-multi", 1);
    await rotateChannelMessages("arc-multi", { thresholdBytes: 1 }); // seq 2
    expect(listChannelArchiveFilePaths(channelDirAbs("arc-multi"))).toEqual([
      archiveFileAbs("arc-multi", 1),
      archiveFileAbs("arc-multi", 2),
    ]);
  });
});

describe("lookupPriorAuditVerdictPayload — write-path spans the boundary (CRITICAL)", () => {
  it("finds the prior verdict in the archive after rotation (no false bootstrap)", async () => {
    const channelId = "lookup-rot";
    setup(channelId);
    appendRaw(channelId, {
      ts: tsAt(0),
      from: SESSION_ID,
      kind: "audit-verdict",
      body: "prior-verdict-body",
    });
    await rotateChannelMessages(channelId, { thresholdBytes: 1 });
    // live file reset → a live-only lookup would return null → the next verdict
    // would bootstrap with prev_audit_body_ref:null → a chain break at the seam.
    expect(readMessages(channelId)).toEqual([]);
    expect(lookupPriorAuditVerdictPayload(channelsDirAbs, channelId)).toBe(
      "prior-verdict-body",
    );
  });

  it("prefers the most-recent verdict (live over archive)", async () => {
    const channelId = "lookup-recent";
    setup(channelId);
    appendRaw(channelId, {
      ts: tsAt(0),
      from: SESSION_ID,
      kind: "audit-verdict",
      body: "old-verdict",
    });
    await rotateChannelMessages(channelId, { thresholdBytes: 1 }); // old → archive
    appendRaw(channelId, {
      ts: tsAt(1),
      from: SESSION_ID,
      kind: "audit-verdict",
      body: "new-verdict",
    }); // live
    expect(lookupPriorAuditVerdictPayload(channelsDirAbs, channelId)).toBe(
      "new-verdict",
    );
  });

  it("returns null when no verdict exists in live or any archive", async () => {
    const channelId = "lookup-none";
    setup(channelId);
    appendStatus(channelId, 0); // non-verdict message
    await rotateChannelMessages(channelId, { thresholdBytes: 1 });
    expect(lookupPriorAuditVerdictPayload(channelsDirAbs, channelId)).toBe(
      null,
    );
  });
});

describe("getMostRecentPeerKind — tail-scan spans the rotation boundary", () => {
  it("still finds a peer's most-recent kind after it was archived", async () => {
    const channelId = "peerkind-rot";
    const PEER = "11111111-2222-4333-8444-555555555555";
    setup(channelId);
    appendRaw(channelId, {
      ts: tsAt(0),
      from: PEER,
      kind: "standby",
      body: "holding",
    });
    await rotateChannelMessages(channelId, { thresholdBytes: 1 }); // → archive; live reset
    // a live-only scan would return null (the peer's message is archived); the
    // boundary-spanning tail-scan must still surface it.
    const recent = getMostRecentPeerKind(channelId, PEER);
    expect(recent).not.toBeNull();
    expect(recent?.kind).toBe("standby");
  });
});
