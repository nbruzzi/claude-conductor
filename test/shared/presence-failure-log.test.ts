// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for src/shared/presence-failure-log.ts.
 *
 * Covers:
 * - Append → read round-trip preserves all fields.
 * - Line-cap enforcement: oversized `detail` is truncated with the sentinel
 *   marker; serialized line never exceeds MAX_LINE_BYTES.
 * - Malformed lines (corrupt JSON, wrong shape, invalid enum values) are
 *   filtered by the reader without poisoning valid events around them.
 * - Limit parameter returns the tail, not the head — a briefing wants
 *   recent events.
 * - Missing file returns `[]` rather than throwing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { makeTmpHome, type TmpHome } from "../../test-utils/index.ts";
import {
  appendPresenceFailure,
  failureLogPath,
  INTERNAL,
  readPresenceFailures,
  type PresenceFailureEvent,
} from "../../src/shared/presence-failure-log.ts";

let tmpHome: TmpHome | null = null;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = makeTmpHome();
  prevHome = process.env["HOME"];
  process.env["HOME"] = tmpHome.home;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = prevHome;
  }
  tmpHome?.cleanup();
  tmpHome = null;
});

function sampleEvent(
  overrides: Partial<PresenceFailureEvent> = {},
): PresenceFailureEvent {
  return {
    timestamp: "2026-04-20T00:00:00.000Z",
    sessionId: "session-self-abc",
    source: "session-collision-gate",
    kind: "lock-timeout",
    artifactPath: "/tmp/fake-repo",
    detail: "lock held >1500ms",
    ...overrides,
  };
}

describe("presence-failure-log", () => {
  it("appends and reads an event round-trip", () => {
    const ev = sampleEvent();
    appendPresenceFailure(ev);

    const events = readPresenceFailures();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(ev);
  });

  it("supports null sessionId and null artifactPath for pre-resolution failures", () => {
    const ev = sampleEvent({
      sessionId: null,
      source: "session-presence-register",
      kind: "unhandled",
      artifactPath: null,
      detail: "pre-resolution crash",
    });
    appendPresenceFailure(ev);

    const events = readPresenceFailures();
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBeNull();
    expect(events[0]?.artifactPath).toBeNull();
  });

  it("round-trips the #8b check-import-failed telemetry kind (source=dispatcher, null sessionId at registry-build)", () => {
    const ev = sampleEvent({
      sessionId: null,
      source: "dispatcher",
      kind: "check-import-failed",
      artifactPath: null,
      detail:
        "check 'task-coordinator' import failed (cross-edge): module not found",
    });
    appendPresenceFailure(ev);

    const events = readPresenceFailures();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(ev);
  });

  it("returns [] when the log file does not exist", () => {
    expect(existsSync(failureLogPath())).toBe(false);
    expect(readPresenceFailures()).toEqual([]);
  });

  it("returns tail events when limit is smaller than log length", () => {
    for (let i = 0; i < 5; i++) {
      appendPresenceFailure(
        sampleEvent({
          timestamp: `2026-04-20T00:00:0${i}.000Z`,
          detail: `event ${i}`,
        }),
      );
    }

    const events = readPresenceFailures(2);
    expect(events).toHaveLength(2);
    expect(events[0]?.detail).toBe("event 3");
    expect(events[1]?.detail).toBe("event 4");
  });

  it("truncates oversized detail with the sentinel marker", () => {
    const hugeDetail = "x".repeat(INTERNAL.MAX_LINE_BYTES * 2);
    const ev = sampleEvent({ detail: hugeDetail });
    appendPresenceFailure(ev);

    const raw = readFileSync(failureLogPath(), "utf-8").replace(/\n$/, "");
    expect(Buffer.byteLength(`${raw}\n`, "utf-8")).toBeLessThanOrEqual(
      INTERNAL.MAX_LINE_BYTES,
    );

    const events = readPresenceFailures();
    expect(events).toHaveLength(1);
    const detail = events[0]?.detail ?? "";
    expect(detail.endsWith(INTERNAL.TRUNCATION_MARKER)).toBe(true);
    expect(detail.length).toBeLessThan(hugeDetail.length);
  });

  it("serializes exactly one newline-terminated line per event", () => {
    appendPresenceFailure(sampleEvent({ detail: "a" }));
    appendPresenceFailure(sampleEvent({ detail: "b" }));
    appendPresenceFailure(sampleEvent({ detail: "c" }));

    const raw = readFileSync(failureLogPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("reader skips malformed lines without dropping surrounding valid events", () => {
    appendPresenceFailure(sampleEvent({ detail: "first" }));
    appendFileSync(failureLogPath(), "this is not json\n", "utf-8");
    appendFileSync(
      failureLogPath(),
      `${JSON.stringify({ totally: "wrong shape" })}\n`,
      "utf-8",
    );
    appendFileSync(
      failureLogPath(),
      `${JSON.stringify({ ...sampleEvent(), source: "bogus-source" })}\n`,
      "utf-8",
    );
    appendPresenceFailure(sampleEvent({ detail: "last" }));

    const events = readPresenceFailures();
    expect(events).toHaveLength(2);
    expect(events[0]?.detail).toBe("first");
    expect(events[1]?.detail).toBe("last");
  });

  it("rejects events whose sessionId key is absent vs explicitly null", () => {
    // Explicit `null` is allowed (pre-resolution failure). Missing key is rejected —
    // it's a corrupt write from a buggy caller, not a semantically valid null.
    writeFileSync(
      failureLogPath(),
      `${JSON.stringify({
        timestamp: "2026-04-20T00:00:00.000Z",
        source: "session-collision-gate",
        kind: "lock-timeout",
        artifactPath: null,
        detail: "no sessionId key",
      })}\n`,
      "utf-8",
    );

    expect(readPresenceFailures()).toEqual([]);
  });

  it("rejects events with invalid kind (type-unsafe legacy log entries)", () => {
    const badKind = { ...sampleEvent(), kind: "legacy-kind" };
    writeFileSync(failureLogPath(), `${JSON.stringify(badKind)}\n`, "utf-8");
    expect(readPresenceFailures()).toEqual([]);
  });

  it("round-trips kind=clock-skew (Phase 2 Slice 7 substrate extension)", () => {
    const ev = sampleEvent({
      source: "channels-identity",
      kind: "clock-skew",
      detail:
        "teammate-idle-reminder: peer Bravo body_ts=1700000000000 mtime=1700000400000 delta=400000ms",
    });
    appendPresenceFailure(ev);

    const events = readPresenceFailures();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("clock-skew");
    expect(events[0]?.source).toBe("channels-identity");
  });

  // Phase 3 Slice 2 — REV 0.2 ARCH-8 / Bravo C1 substrate extension.
  // Six new kinds land in Commit 2 alongside the active-sessions
  // schema extensions so Commit 3's resolver tests T3 (deprecation
  // breadcrumb) + T7 (sentinel-corrupt) + Commit 4's hook breadcrumbs
  // can fire without referencing yet-undefined kinds.
  const SLICE_2_KINDS = [
    "deprecation",
    "sentinel-corrupt",
    "worktree-provision-failed",
    "worktree-gc-reaped",
    "worktree-cleanup-failed",
    "worktree-cleanup-incomplete",
  ] as const;

  for (const kind of SLICE_2_KINDS) {
    it(`round-trips kind=${kind} (Phase 3 Slice 2 substrate extension)`, () => {
      const ev = sampleEvent({
        source: "dispatcher",
        kind,
        detail: `Phase 3 Slice 2 ${kind} fixture`,
      });
      appendPresenceFailure(ev);

      const events = readPresenceFailures();
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe(kind);
      expect(events[0]?.source).toBe("dispatcher");
    });
  }

  // P0 substrate canary (backlog L:892, 2026-05-17) — new kind from
  // `linkCanonicalNodeModules` primitive composed by the provisioner hook
  // when symlink creation fails. Mirrors the SLICE_2 round-trip pattern.
  const SLICE_3_KINDS = ["worktree-deps-link-failed"] as const;

  for (const kind of SLICE_3_KINDS) {
    it(`round-trips kind=${kind} (P0 substrate canary)`, () => {
      const ev = sampleEvent({
        source: "dispatcher",
        kind,
        detail: `P0 substrate canary ${kind} fixture`,
      });
      appendPresenceFailure(ev);

      const events = readPresenceFailures();
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe(kind);
      expect(events[0]?.source).toBe("dispatcher");
    });
  }

  it("serializeWithinCap is idempotent on short lines", () => {
    const ev = sampleEvent();
    const a = INTERNAL.serializeWithinCap(ev);
    const b = INTERNAL.serializeWithinCap(ev);
    expect(a).toBe(b);
  });

  it("redacts $HOME to ~ in artifactPath and detail on append", () => {
    const home = process.env["HOME"];
    if (!home) throw new Error("HOME not set in test environment");
    const artifactUnderHome = `${home}/projects/secret-app`;
    const errMsg = `ENOENT: link ${home}/.claude/active-sessions/id/meta.json.tmp.123.456.abc`;
    appendPresenceFailure(
      sampleEvent({
        artifactPath: artifactUnderHome,
        detail: errMsg,
      }),
    );

    const rows = readPresenceFailures();
    expect(rows.length).toBe(1);
    const ev = rows[0];
    expect(ev?.artifactPath).toBe("~/projects/secret-app");
    expect(ev?.detail).toContain("~/.claude/active-sessions/");
    expect(ev?.detail).not.toContain(home);
  });

  it("leaves paths outside $HOME untouched", () => {
    appendPresenceFailure(
      sampleEvent({
        artifactPath: "/tmp/not-a-home-path",
        detail: "error at /var/log/system.log",
      }),
    );
    const rows = readPresenceFailures();
    expect(rows[0]?.artifactPath).toBe("/tmp/not-a-home-path");
    expect(rows[0]?.detail).toBe("error at /var/log/system.log");
  });

  it("redactEvent: null artifactPath stays null", () => {
    const ev = sampleEvent({ artifactPath: null });
    const redacted = INTERNAL.redactEvent(ev);
    expect(redacted.artifactPath).toBeNull();
  });

  describe("size-based rotation", () => {
    it("rotates the log to .1 when size is at or over PRESENCE_LOG_MAX_BYTES", () => {
      const path = failureLogPath();
      // Pre-fill the log to exactly PRESENCE_LOG_MAX_BYTES (1 MiB) — the
      // rotation gate fires when size >= max.
      const filler = "x".repeat(INTERNAL.PRESENCE_LOG_MAX_BYTES);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, filler);
      expect(statSync(path).size).toBe(INTERNAL.PRESENCE_LOG_MAX_BYTES);

      // Append an event — should rename old log to .1 + write fresh.
      appendPresenceFailure(sampleEvent({ detail: "post-rotation entry" }));

      expect(existsSync(`${path}.1`)).toBe(true);
      expect(statSync(`${path}.1`).size).toBe(INTERNAL.PRESENCE_LOG_MAX_BYTES);
      const newRows = readPresenceFailures();
      expect(newRows).toHaveLength(1);
      expect(newRows[0]?.detail).toBe("post-rotation entry");
    });

    it("does not rotate when size is below PRESENCE_LOG_MAX_BYTES", () => {
      const path = failureLogPath();
      // Pre-fill to one byte under the threshold.
      const filler = "x".repeat(INTERNAL.PRESENCE_LOG_MAX_BYTES - 1);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, filler);

      appendPresenceFailure(sampleEvent({ detail: "no-rotation entry" }));

      expect(existsSync(`${path}.1`)).toBe(false);
      // Original content + appended event should both be in the log.
      const raw = readFileSync(path, "utf-8");
      expect(raw.length).toBeGreaterThan(INTERNAL.PRESENCE_LOG_MAX_BYTES);
      expect(raw).toContain("no-rotation entry");
    });

    it("clobbers an existing .1 archive on subsequent rotation (single-slot)", () => {
      const path = failureLogPath();
      mkdirSync(dirname(path), { recursive: true });
      // Plant a stale .1 from an earlier rotation.
      writeFileSync(`${path}.1`, "stale archive content");
      expect(statSync(`${path}.1`).size).toBe(21);

      // Pre-fill main log to threshold to force rotation.
      const filler = "x".repeat(INTERNAL.PRESENCE_LOG_MAX_BYTES);
      writeFileSync(path, filler);

      appendPresenceFailure(sampleEvent({ detail: "rotation clobber test" }));

      // .1 should now be the just-rotated 1 MiB content, NOT the stale 21-byte one.
      expect(statSync(`${path}.1`).size).toBe(INTERNAL.PRESENCE_LOG_MAX_BYTES);
      expect(readFileSync(`${path}.1`, "utf-8")).toBe(filler);
    });

    it("creates parent directories on first append when log directory does not exist", () => {
      const path = failureLogPath();
      // Remove the logs dir to force the mkdir branch (tmpHome may pre-create
      // some structure under .claude/).
      rmSync(dirname(path), { recursive: true, force: true });
      expect(existsSync(dirname(path))).toBe(false);

      appendPresenceFailure(sampleEvent({ detail: "first-append" }));

      expect(existsSync(dirname(path))).toBe(true);
      const rows = readPresenceFailures();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.detail).toBe("first-append");
    });

    it("appends a single event when log is fresh (rotation gate's ENOENT branch)", () => {
      // No pre-existing log file. statSync inside rotation throws ENOENT,
      // which should be silently caught — append still runs cleanly.
      const path = failureLogPath();
      expect(existsSync(path)).toBe(false);

      appendPresenceFailure(sampleEvent({ detail: "fresh-log-append" }));

      expect(existsSync(`${path}.1`)).toBe(false);
      const rows = readPresenceFailures();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.detail).toBe("fresh-log-append");
    });

    it("readPresenceFailures includes events from .log.1 archive (RE-1 fold)", () => {
      // Plant 3 archived events in .log.1 + 2 fresh events in .log.
      // Reader should return all 5 oldest→newest within the tail window.
      const path = failureLogPath();
      mkdirSync(dirname(path), { recursive: true });
      const archive = [
        sampleEvent({
          detail: "archived-1",
          timestamp: "2026-04-19T00:00:00Z",
        }),
        sampleEvent({
          detail: "archived-2",
          timestamp: "2026-04-19T01:00:00Z",
        }),
        sampleEvent({
          detail: "archived-3",
          timestamp: "2026-04-19T02:00:00Z",
        }),
      ]
        .map((ev) => INTERNAL.serializeWithinCap(INTERNAL.redactEvent(ev)))
        .join("");
      writeFileSync(`${path}.1`, archive);

      // Append 2 fresh events to current log via the public API.
      appendPresenceFailure(
        sampleEvent({ detail: "current-1", timestamp: "2026-04-20T00:00:00Z" }),
      );
      appendPresenceFailure(
        sampleEvent({ detail: "current-2", timestamp: "2026-04-20T01:00:00Z" }),
      );

      const rows = readPresenceFailures();
      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.detail)).toEqual([
        "archived-1",
        "archived-2",
        "archived-3",
        "current-1",
        "current-2",
      ]);
    });

    it("readPresenceFailures applies limit AFTER archive concatenation (chronological tail)", () => {
      // 3 archived + 3 current; limit=4 should return last 4 chronologically
      // (archived-3, current-1, current-2, current-3).
      const path = failureLogPath();
      mkdirSync(dirname(path), { recursive: true });
      const archive = [
        sampleEvent({ detail: "archived-1" }),
        sampleEvent({ detail: "archived-2" }),
        sampleEvent({ detail: "archived-3" }),
      ]
        .map((ev) => INTERNAL.serializeWithinCap(INTERNAL.redactEvent(ev)))
        .join("");
      writeFileSync(`${path}.1`, archive);

      for (let i = 1; i <= 3; i++) {
        appendPresenceFailure(sampleEvent({ detail: `current-${i}` }));
      }

      const rows = readPresenceFailures(4);
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.detail)).toEqual([
        "archived-3",
        "current-1",
        "current-2",
        "current-3",
      ]);
    });
  });
});
