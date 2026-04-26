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
  readFileSync,
  writeFileSync,
} from "node:fs";
import { makeTmpHome, type TmpHome } from "../helpers/tmp-repo.ts";
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
});
