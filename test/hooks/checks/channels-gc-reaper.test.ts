// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Phase 2 Slice 4 hook tests for `channels-gc-reaper`.
 *
 * Coverage matrix per plan REV 1.2 §Plugin tests.
 * Implementation plan: ~/.claude/plans/lovely-dreaming-willow.md REV 1.2.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { check } from "../../../src/hooks/checks/channels-gc-reaper.ts";
import { createChannel } from "../../../src/channels/index.ts";
import type { HookInput } from "../../../src/hooks/types.ts";

const SANDBOX = `/tmp/test-channels-gc-reaper-${process.pid}`;
const SESSION_OWNER = "11111111-1111-4111-8111-111111111111";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

function inputFor(): HookInput {
  return {
    toolName: undefined,
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw: { hook_event_name: "SessionStart" } as Record<string, unknown>,
    dispatch: { verbose: false },
  };
}

function channelDir(channelId: string): string {
  return join(SANDBOX, channelId);
}

function identitiesDirOf(channelId: string): string {
  return join(channelDir(channelId), "identities");
}

function sentinelPath(channelId: string, letter: string): string {
  return join(identitiesDirOf(channelId), letter);
}

/** Plant an orphan sentinel. */
function plantOrphan(
  channelId: string,
  letter: string,
  options: {
    sessionId?: string;
    role?: string;
    ageSeconds: number;
    sentinelContent?: string;
  },
): string {
  const sessionId = options.sessionId ?? SESSION_OWNER;
  const role = options.role ?? "queue";
  const claim = {
    session_id: sessionId,
    role,
    joined_at: new Date(Date.now() - options.ageSeconds * 1000).toISOString(),
  };
  const content = options.sentinelContent ?? `${JSON.stringify(claim)}\n`;
  const path = sentinelPath(channelId, letter);
  mkdirSync(identitiesDirOf(channelId), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  const mtime = Date.now() / 1000 - options.ageSeconds;
  utimesSync(path, mtime, mtime);
  return path;
}

function ageMetadataBy(channelId: string, ageSeconds: number): void {
  const metaPath = join(channelDir(channelId), "metadata.json");
  const mtime = Date.now() / 1000 - ageSeconds;
  utimesSync(metaPath, mtime, mtime);
}

async function makeChannel(channelId: string): Promise<void> {
  await createChannel({
    channelId,
    handoffId: channelId,
    sessionId: SESSION_OWNER,
  });
}

describe("channels-gc-reaper hook", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("reaps an orphan sentinel whose mtime is past the 90-s gate", async () => {
    await makeChannel("c1");
    plantOrphan("c1", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("c1", 120);

    const result = await check(inputFor());

    expect(existsSync(sentinelPath("c1", "Foxtrot"))).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("reaped channel=c1 letter=Foxtrot");
  });

  it("skips orphan candidates whose sentinel mtime is fresher than 90 s", async () => {
    await makeChannel("c2");
    plantOrphan("c2", "Foxtrot", { ageSeconds: 30 });
    ageMetadataBy("c2", 120);

    const result = await check(inputFor());

    expect(existsSync(sentinelPath("c2", "Foxtrot"))).toBe(true);
    expect(result.stdout).not.toContain("reaped channel=c2");
  });

  it("skips orphan candidates whose metadata.json mtime is fresher than 90 s (RE-1)", async () => {
    await makeChannel("c5");
    plantOrphan("c5", "Foxtrot", { ageSeconds: 120 });
    // metadata.json was just written by createChannel — fresh mtime → skip.

    const result = await check(inputFor());

    expect(existsSync(sentinelPath("c5", "Foxtrot"))).toBe(true);
    expect(result.stdout).not.toContain("reaped channel=c5");
  });

  it("silently skips when sentinel was already unlinked between mark and sweep", async () => {
    await makeChannel("c8");
    const path = plantOrphan("c8", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("c8", 120);
    rmSync(path);

    const result = await check(inputFor());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("STUCK orphan");
  });

  it("respects the 5-min rate-gate cursor on subsequent invocations", async () => {
    await makeChannel("c9");
    plantOrphan("c9", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("c9", 120);

    await check(inputFor());
    expect(existsSync(sentinelPath("c9", "Foxtrot"))).toBe(false);

    plantOrphan("c9", "Golf", { ageSeconds: 120 });

    const result = await check(inputFor());

    expect(existsSync(sentinelPath("c9", "Golf"))).toBe(true);
    expect(result.stdout).not.toContain("reaped channel=c9 letter=Golf");
  });

  it("reaps again once the rate-gate cursor mtime crosses 5 min", async () => {
    await makeChannel("c10");
    plantOrphan("c10", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("c10", 120);

    await check(inputFor());

    const cursorPath = join(channelDir("c10"), "gc-reap", "cursor");
    const past = Date.now() / 1000 - 6 * 60;
    utimesSync(cursorPath, past, past);

    plantOrphan("c10", "Golf", { ageSeconds: 120 });

    const result = await check(inputFor());

    expect(existsSync(sentinelPath("c10", "Golf"))).toBe(false);
    expect(result.stdout).toContain("reaped channel=c10 letter=Golf");
  });

  it("logs reconcile-candidate breadcrumb without recreating the sentinel", async () => {
    await makeChannel("c11");
    const metaPath = join(channelDir("c11"), "metadata.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
      identities?: Record<string, unknown>;
    };
    meta.identities = {
      Charlie: {
        session_id: SESSION_OWNER,
        role: "queue",
        joined_at: new Date(Date.now() - 200_000).toISOString(),
      },
    };
    writeFileSync(metaPath, `${JSON.stringify(meta)}\n`);
    ageMetadataBy("c11", 120);

    const result = await check(inputFor());

    expect(existsSync(sentinelPath("c11", "Charlie"))).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Charlie");
  });

  it("skips channel whose metadata.json is corrupt (fail-open)", async () => {
    await makeChannel("c13");
    const metaPath = join(channelDir("c13"), "metadata.json");
    writeFileSync(metaPath, "{not json", "utf-8");
    ageMetadataBy("c13", 120);
    plantOrphan("c13", "Foxtrot", { ageSeconds: 120 });

    const result = await check(inputFor());

    expect(result.exitCode).toBe(0);
    expect(existsSync(sentinelPath("c13", "Foxtrot"))).toBe(true);
    expect(result.stdout).not.toContain("reaped channel=c13");
  });

  it("skips a sentinel candidate whose content is unparseable JSON", async () => {
    await makeChannel("c14");
    plantOrphan("c14", "Foxtrot", {
      ageSeconds: 120,
      sentinelContent: "not-json-content\n",
    });
    ageMetadataBy("c14", 120);

    const result = await check(inputFor());

    expect(existsSync(sentinelPath("c14", "Foxtrot"))).toBe(true);
    expect(result.stdout).not.toContain("reaped");
  });

  it("respects a fresh .reaper-acked suppression marker", async () => {
    await makeChannel("c15");
    const path = plantOrphan("c15", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("c15", 120);
    writeFileSync(`${path}.reaper-acked`, "");

    const result = await check(inputFor());

    expect(existsSync(path)).toBe(true);
    expect(result.stdout).not.toContain("reaped");
    expect(result.stdout).not.toContain("STUCK orphan");
  });

  it("touches the rate-gate cursor in the gc-reap subdirectory", async () => {
    await makeChannel("ccursor");
    plantOrphan("ccursor", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("ccursor", 120);

    await check(inputFor());

    const cursorPath = join(channelDir("ccursor"), "gc-reap", "cursor");
    expect(existsSync(cursorPath)).toBe(true);
  });

  it("returns pass() and emits no output when no orphans are present", async () => {
    await makeChannel("cclean");
    ageMetadataBy("cclean", 120);

    const result = await check(inputFor());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("emits a [channels-gc-reaper] warn() result when orphans are reaped", async () => {
    await makeChannel("cwarn");
    plantOrphan("cwarn", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("cwarn", 120);

    const result = await check(inputFor());

    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("channels-gc-reaper");
    expect(result.stdout).toContain("Channel GC reaper");
  });

  it("ignores invalid (non-NATO) entries in identitiesDir", async () => {
    await makeChannel("cnonNato");
    mkdirSync(identitiesDirOf("cnonNato"), { recursive: true });
    writeFileSync(join(identitiesDirOf("cnonNato"), "garbage"), "noise");
    ageMetadataBy("cnonNato", 120);

    const result = await check(inputFor());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("garbage");
  });

  it("surfaces UNREACHABLE breadcrumb for channels whose metadata.json cannot be parsed (Step C RE-W2-1 closure)", async () => {
    // Set up: one valid channel + one channel-dir with corrupt metadata.json.
    // The reaper used to silently skip the corrupt one (listChannels caught
    // + suppressed the readMetadata throw), leaving any orphan sentinels in
    // that channel invisible to all GC paths. Phase 3 Step C opts into the
    // new `listChannels({ includeUnreachable: true })` variant + emits a
    // breadcrumb + summary line so the operator can intervene.
    await makeChannel("c-live");
    plantOrphan("c-live", "Foxtrot", { ageSeconds: 120 });
    ageMetadataBy("c-live", 120);

    const corruptDir = join(SANDBOX, "c-corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "metadata.json"), "{ not json", "utf-8");

    const result = await check(inputFor());

    // The valid channel still gets its orphan reaped — narrow scope of
    // the unreachable-channel handling is preserved (it doesn't disrupt
    // the normal reap-flow for unrelated channels).
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("reaped channel=c-live letter=Foxtrot");

    // The unreachable channel surfaces a breadcrumb summary line. The
    // exact `reason` text is parser-dependent, so the assertion only
    // pins the structural prefix.
    expect(result.stdout).toContain("UNREACHABLE channel=c-corrupt");
  });

  it("UNREACHABLE breadcrumb does NOT attempt to reap orphan sentinels in the corrupt channel (no exception, no STUCK marker)", async () => {
    // Defensive: the reaper has no valid metadata anchor in an unreachable
    // channel, so it cannot distinguish orphan from live identity claims.
    // Disposition is breadcrumb-only; no GC attempt. This test pins that
    // behavior by planting a sentinel in a corrupt channel + verifying
    // (a) no exception, (b) sentinel survives, (c) no STUCK orphan line.
    const corruptDir = join(SANDBOX, "c-corrupt2");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "metadata.json"), "{ not json", "utf-8");
    // Plant a sentinel-shaped file directly (bypass makeChannel which would
    // succeed in writing a valid metadata).
    const identitiesDir = join(corruptDir, "identities");
    mkdirSync(identitiesDir, { recursive: true });
    writeFileSync(
      join(identitiesDir, "Foxtrot"),
      JSON.stringify({
        session_id: SESSION_OWNER,
        role: "queue",
        joined_at: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await check(inputFor());

    expect(result.exitCode).toBe(0);
    // Sentinel survives (no unsafe reap attempt).
    expect(existsSync(join(identitiesDir, "Foxtrot"))).toBe(true);
    // No STUCK orphan line (which would indicate the reaper tried + failed).
    expect(result.stdout).not.toContain("STUCK orphan channel=c-corrupt2");
    // Breadcrumb present.
    expect(result.stdout).toContain("UNREACHABLE channel=c-corrupt2");
  });
});
