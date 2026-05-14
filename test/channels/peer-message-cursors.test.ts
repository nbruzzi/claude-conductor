// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for the Phase 4 Step A — Layer 1 substrate helpers in
 * `src/channels/peer-message-cursors.ts`.
 *
 * Coverage:
 *
 *   - Cursor read (committed + pending): present / absent / corrupt JSON
 *     / non-finite mtime / non-string ts / boundary-check throws
 *   - Pending write: atomic + mkdir parent + non-finite mtime rejected
 *   - Promote: returns true on rename / false on absent / idempotent
 *   - Clear: both / committed-only / pending-only / absent
 *   - Path resolvers: dir + committed + pending paths
 *   - Body sanitization: targeted-strip patterns + bare-`<` escape +
 *     multibyte UTF-8 preserved (MINOR-3 regression test)
 *   - Body fence: wraps with nonce + preserves content
 *
 * Sibling-shape to `test/channels/identity-context.test.ts` for sandbox
 * setup + cleanup discipline.
 *
 * Some test string literals (closing platform-marker tags) are built via
 * string concatenation rather than embedded directly, so this source file
 * doesn't itself contain the literal closing tags that could confuse
 * tokenizers or grep-based audits.
 *
 * Plan: `~/.claude/plans/eventual-marinating-wall.md` v4 §Phase 1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  MAX_INLINE_BODY_CHARS,
  clearPeerMessageCursor,
  fencePeerBody,
  promotePendingPeerMessageCursor,
  readPeerMessageCursor,
  readPendingPeerMessageCursor,
  resolvePeerMessageEmitCursorPath,
  resolvePeerMessageEmitDir,
  resolvePendingPeerMessageEmitCursorPath,
  sanitizePeerBody,
  writePendingPeerMessageCursor,
} from "../../src/channels/peer-message-cursors.ts";

const SANDBOX = `/tmp/test-peer-message-cursors-${process.pid}`;
const CH = "test-ch-pmc";
const SID_A = "sess-pmc-a";
const SID_B = "sess-pmc-b";

function sandbox(): void {
  cleanup();
  mkdirSync(SANDBOX, { recursive: true });
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = SANDBOX;
}

function cleanup(): void {
  delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
}

function cursorDir(): string {
  return join(SANDBOX, CH, "peer-message-emit-cursors");
}

function committedPath(sid: string): string {
  return join(cursorDir(), `${sid}.json`);
}

function pendingPath(sid: string): string {
  return `${committedPath(sid)}.pending`;
}

// ─── Closing-tag string constructors ────────────────────────────
// Build the literal closing-tag strings via concatenation so this source
// doesn't contain the embedded closing tags (which can confuse tokenizers
// and grep-based audits). The regex patterns in peer-message-cursors.ts
// match these exact byte sequences regardless of how they're constructed
// at the source level.

const LT = "<";
const GT = ">";
const SLASH = "/";

function openTag(name: string): string {
  return `${LT}${name}${GT}`;
}
function closeTag(name: string): string {
  return `${LT}${SLASH}${name}${GT}`;
}

const OPEN_SR = openTag("system-reminder");
const CLOSE_SR = closeTag("system-reminder");
const OPEN_FC = openTag("function_calls");
const CLOSE_FC = closeTag("function_calls");
const OPEN_ANTML_PARAM = openTag("antml:parameter name=foo");
const CLOSE_ANTML_PARAM = closeTag("antml:parameter");
const OPEN_ANTML_INVOKE = openTag("antml:invoke");
const CLOSE_ANTML_INVOKE = closeTag("antml:invoke");
const BARE_CLOSE = `${LT}${SLASH}`;
const REDACTED = "[redacted-platform-marker]";

describe("MAX_INLINE_BODY_CHARS", () => {
  it("is a positive finite integer", () => {
    expect(MAX_INLINE_BODY_CHARS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_INLINE_BODY_CHARS)).toBe(true);
  });
});

describe("path resolvers", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("resolvePeerMessageEmitDir returns <channels>/<ch>/peer-message-emit-cursors", () => {
    expect(resolvePeerMessageEmitDir(CH)).toBe(cursorDir());
  });

  it("resolvePeerMessageEmitCursorPath returns committed path", () => {
    expect(resolvePeerMessageEmitCursorPath(CH, SID_A)).toBe(
      committedPath(SID_A),
    );
  });

  it("resolvePendingPeerMessageEmitCursorPath returns pending path", () => {
    expect(resolvePendingPeerMessageEmitCursorPath(CH, SID_A)).toBe(
      pendingPath(SID_A),
    );
  });

  it("resolvePeerMessageEmitDir throws on invalid channelId", () => {
    expect(() => resolvePeerMessageEmitDir("../bad")).toThrow(
      /invalid channelId/,
    );
  });

  it("resolvePeerMessageEmitCursorPath throws on invalid sessionId", () => {
    expect(() => resolvePeerMessageEmitCursorPath(CH, "../bad")).toThrow(
      /invalid sessionId/,
    );
  });
});

describe("readPeerMessageCursor", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns null when no cursor file exists", () => {
    expect(readPeerMessageCursor(CH, SID_A)).toBeNull();
  });

  it("returns parsed cursor when committed file present + valid", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(
      committedPath(SID_A),
      JSON.stringify({ mtime: 1700000000000, ts: "2023-11-14T22:13:20Z" }),
      "utf-8",
    );
    expect(readPeerMessageCursor(CH, SID_A)).toEqual({
      mtime: 1700000000000,
      ts: "2023-11-14T22:13:20Z",
    });
  });

  it("returns null on corrupt JSON", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(committedPath(SID_A), "not json {{{", "utf-8");
    expect(readPeerMessageCursor(CH, SID_A)).toBeNull();
  });

  it("returns null on non-finite mtime (string 'NaN')", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(
      committedPath(SID_A),
      JSON.stringify({ mtime: "NaN", ts: "2023-11-14T22:13:20Z" }),
      "utf-8",
    );
    expect(readPeerMessageCursor(CH, SID_A)).toBeNull();
  });

  it("returns null on missing ts field", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(
      committedPath(SID_A),
      JSON.stringify({ mtime: 1700000000000 }),
      "utf-8",
    );
    expect(readPeerMessageCursor(CH, SID_A)).toBeNull();
  });

  it("returns null on JSON array (invalid shape)", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(committedPath(SID_A), JSON.stringify([1, 2, 3]), "utf-8");
    expect(readPeerMessageCursor(CH, SID_A)).toBeNull();
  });

  it("throws on invalid channelId", () => {
    expect(() => readPeerMessageCursor("../bad", SID_A)).toThrow(
      /invalid channelId/,
    );
  });

  it("throws on invalid sessionId", () => {
    expect(() => readPeerMessageCursor(CH, "../bad")).toThrow(
      /invalid sessionId/,
    );
  });
});

describe("readPendingPeerMessageCursor", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns null when no pending file exists", () => {
    expect(readPendingPeerMessageCursor(CH, SID_A)).toBeNull();
  });

  it("returns parsed pending cursor when present", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(
      pendingPath(SID_A),
      JSON.stringify({ mtime: 1700000000001, ts: "2023-11-14T22:13:20.001Z" }),
      "utf-8",
    );
    expect(readPendingPeerMessageCursor(CH, SID_A)).toEqual({
      mtime: 1700000000001,
      ts: "2023-11-14T22:13:20.001Z",
    });
  });

  it("returns null on corrupt JSON in pending", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(pendingPath(SID_A), "{not-valid", "utf-8");
    expect(readPendingPeerMessageCursor(CH, SID_A)).toBeNull();
  });
});

describe("writePendingPeerMessageCursor", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("writes pending file with {mtime, ts} shape", () => {
    writePendingPeerMessageCursor(
      CH,
      SID_A,
      1700000000000,
      "2023-11-14T22:13:20Z",
    );
    expect(existsSync(pendingPath(SID_A))).toBe(true);
    const parsed = JSON.parse(readFileSync(pendingPath(SID_A), "utf-8"));
    expect(parsed).toEqual({
      mtime: 1700000000000,
      ts: "2023-11-14T22:13:20Z",
    });
  });

  it("mkdir's the cursor parent dir if absent", () => {
    expect(existsSync(cursorDir())).toBe(false);
    writePendingPeerMessageCursor(CH, SID_A, 1, "2023-01-01T00:00:00Z");
    expect(existsSync(cursorDir())).toBe(true);
  });

  it("does NOT overwrite committed cursor (separate path)", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(
      committedPath(SID_A),
      JSON.stringify({ mtime: 999, ts: "committed" }),
      "utf-8",
    );
    writePendingPeerMessageCursor(CH, SID_A, 1234, "pending-ts");
    const committed = JSON.parse(readFileSync(committedPath(SID_A), "utf-8"));
    expect(committed).toEqual({ mtime: 999, ts: "committed" });
  });

  it("throws on non-finite mtime", () => {
    expect(() =>
      writePendingPeerMessageCursor(CH, SID_A, Number.NaN, "ts"),
    ).toThrow(/mtime must be finite/);
    expect(() =>
      writePendingPeerMessageCursor(CH, SID_A, Number.POSITIVE_INFINITY, "ts"),
    ).toThrow(/mtime must be finite/);
  });

  it("throws on invalid channelId", () => {
    expect(() =>
      writePendingPeerMessageCursor("../bad", SID_A, 1, "ts"),
    ).toThrow(/invalid channelId/);
  });

  it("throws on invalid sessionId", () => {
    expect(() => writePendingPeerMessageCursor(CH, "../bad", 1, "ts")).toThrow(
      /invalid sessionId/,
    );
  });
});

describe("promotePendingPeerMessageCursor", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns false when no pending file exists", () => {
    expect(promotePendingPeerMessageCursor(CH, SID_A)).toBe(false);
  });

  it("returns true + renames pending -> committed when pending exists", () => {
    writePendingPeerMessageCursor(
      CH,
      SID_A,
      1700000000000,
      "2023-11-14T22:13:20Z",
    );
    expect(existsSync(pendingPath(SID_A))).toBe(true);
    expect(promotePendingPeerMessageCursor(CH, SID_A)).toBe(true);
    expect(existsSync(pendingPath(SID_A))).toBe(false);
    expect(existsSync(committedPath(SID_A))).toBe(true);
    const committed = JSON.parse(readFileSync(committedPath(SID_A), "utf-8"));
    expect(committed).toEqual({
      mtime: 1700000000000,
      ts: "2023-11-14T22:13:20Z",
    });
  });

  it("is idempotent — subsequent promote calls return false", () => {
    writePendingPeerMessageCursor(CH, SID_A, 1, "ts1");
    expect(promotePendingPeerMessageCursor(CH, SID_A)).toBe(true);
    expect(promotePendingPeerMessageCursor(CH, SID_A)).toBe(false);
    expect(promotePendingPeerMessageCursor(CH, SID_A)).toBe(false);
  });

  it("overwrites prior committed when promoting newer pending", () => {
    writePendingPeerMessageCursor(CH, SID_A, 100, "old-ts");
    promotePendingPeerMessageCursor(CH, SID_A);
    writePendingPeerMessageCursor(CH, SID_A, 200, "new-ts");
    expect(promotePendingPeerMessageCursor(CH, SID_A)).toBe(true);
    expect(readPeerMessageCursor(CH, SID_A)).toEqual({
      mtime: 200,
      ts: "new-ts",
    });
  });
});

describe("clearPeerMessageCursor", () => {
  beforeEach(sandbox);
  afterEach(cleanup);

  it("returns {kind:absent} when neither file exists", () => {
    expect(clearPeerMessageCursor(CH, SID_A)).toEqual({ kind: "absent" });
  });

  it("returns {kind:cleared} when committed-only exists", () => {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(
      committedPath(SID_A),
      JSON.stringify({ mtime: 1, ts: "x" }),
      "utf-8",
    );
    expect(clearPeerMessageCursor(CH, SID_A)).toEqual({ kind: "cleared" });
    expect(existsSync(committedPath(SID_A))).toBe(false);
  });

  it("returns {kind:cleared} when pending-only exists", () => {
    writePendingPeerMessageCursor(CH, SID_A, 1, "x");
    expect(clearPeerMessageCursor(CH, SID_A)).toEqual({ kind: "cleared" });
    expect(existsSync(pendingPath(SID_A))).toBe(false);
  });

  it("clears BOTH when both exist", () => {
    writePendingPeerMessageCursor(CH, SID_A, 1, "x");
    promotePendingPeerMessageCursor(CH, SID_A);
    writePendingPeerMessageCursor(CH, SID_A, 2, "y");
    expect(existsSync(committedPath(SID_A))).toBe(true);
    expect(existsSync(pendingPath(SID_A))).toBe(true);
    expect(clearPeerMessageCursor(CH, SID_A)).toEqual({ kind: "cleared" });
    expect(existsSync(committedPath(SID_A))).toBe(false);
    expect(existsSync(pendingPath(SID_A))).toBe(false);
  });

  it("does NOT affect another session's cursor", () => {
    writePendingPeerMessageCursor(CH, SID_A, 1, "a");
    writePendingPeerMessageCursor(CH, SID_B, 2, "b");
    clearPeerMessageCursor(CH, SID_A);
    expect(existsSync(pendingPath(SID_A))).toBe(false);
    expect(existsSync(pendingPath(SID_B))).toBe(true);
  });
});

describe("sanitizePeerBody — targeted strip + bare-< escape", () => {
  it("preserves empty body", () => {
    expect(sanitizePeerBody("")).toBe("");
  });

  it("preserves benign markdown text", () => {
    const body = "Hello world! This is a peer message.\n- bullet 1\n- bullet 2";
    expect(sanitizePeerBody(body)).toBe(body);
  });

  it("redacts system-reminder open tag", () => {
    const body = `before ${OPEN_SR} middle`;
    const out = sanitizePeerBody(body);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(OPEN_SR);
  });

  it("redacts system-reminder close tag (case-insensitive)", () => {
    const body = `before ${CLOSE_SR.toUpperCase()} after`;
    const out = sanitizePeerBody(body);
    expect(out).toContain(REDACTED);
    // Lower- and upper-case variants of the close-tag both get redacted.
    expect(out.toLowerCase()).not.toContain(CLOSE_SR.toLowerCase());
  });

  it("redacts function_calls open + close pair, preserving inner payload", () => {
    const body = `${OPEN_FC}payload-data${CLOSE_FC}`;
    const out = sanitizePeerBody(body);
    expect(out).not.toContain(OPEN_FC);
    expect(out).not.toContain(CLOSE_FC);
    const redactedCount = (out.match(/\[redacted-platform-marker\]/g) ?? [])
      .length;
    expect(redactedCount).toBeGreaterThanOrEqual(2);
    expect(out).toContain("payload-data");
  });

  it("redacts antml namespace tags (open + close)", () => {
    const body = `before ${OPEN_ANTML_INVOKE} mid ${OPEN_ANTML_PARAM} x ${CLOSE_ANTML_PARAM} ${CLOSE_ANTML_INVOKE} after`;
    const out = sanitizePeerBody(body);
    expect(out).not.toContain(OPEN_ANTML_INVOKE);
    expect(out).not.toContain(CLOSE_ANTML_INVOKE);
    expect(out).not.toContain(OPEN_ANTML_PARAM);
    expect(out).not.toContain(CLOSE_ANTML_PARAM);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("redacts fence-marker shape `[peer-body-<8hex>]` (the very fence used for wrapping)", () => {
    const body = "before [peer-body-deadbeef] middle [/peer-body-cafebabe] end";
    const out = sanitizePeerBody(body);
    expect(out).not.toContain("[peer-body-deadbeef]");
    expect(out).not.toContain("[/peer-body-cafebabe]");
    expect(out).toContain(REDACTED);
  });

  it("redacts bare close-tag sequence `</`", () => {
    const body = `before ${BARE_CLOSE}unknown> after`;
    const out = sanitizePeerBody(body);
    expect(out).not.toContain(BARE_CLOSE);
    expect(out).toContain(REDACTED);
  });

  it("escapes bare `<` chars (after targeted strip) to `&lt;`", () => {
    // No platform-control patterns; just bare `<`.
    const body = "a < b math comparison";
    const out = sanitizePeerBody(body);
    expect(out).toBe("a &lt; b math comparison");
  });

  it("preserves multibyte UTF-8 verbatim (MINOR-3 regression: em-dash, smart quotes, emoji, ellipsis)", () => {
    // High-byte chars that earlier v3 design would have stripped:
    //   — em-dash (U+2014, UTF-8 E2 80 94)
    //   ‘’ smart quotes (U+2018/9, UTF-8 E2 80 98/99)
    //   🎯 target emoji (U+1F3AF, UTF-8 F0 9F 8E AF)
    //   … ellipsis (U+2026, UTF-8 E2 80 A6)
    const body = "before — middle ‘with’ “quoted” 🎯 emoji … and ellipsis";
    const out = sanitizePeerBody(body);
    expect(out).toBe(body); // Verbatim preservation; MINOR-3 honored.
  });

  it("strips multiple occurrences of the same pattern", () => {
    const body = `${OPEN_SR}one${CLOSE_SR}two${OPEN_SR}three${CLOSE_SR}`;
    const out = sanitizePeerBody(body);
    expect(out).not.toContain(OPEN_SR);
    expect(out).not.toContain(CLOSE_SR);
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("three");
    const redactedCount = (out.match(/\[redacted-platform-marker\]/g) ?? [])
      .length;
    expect(redactedCount).toBe(4);
  });

  it("composes correctly: targeted strip THEN bare-< escape", () => {
    // A body with both platform-control markup AND a bare `<` math expr.
    // Targeted-strip removes the markup; bare-< escape catches the math `<`.
    const body = `${OPEN_SR}danger${CLOSE_SR} and a < b`;
    const out = sanitizePeerBody(body);
    expect(out).not.toContain(OPEN_SR);
    expect(out).not.toContain(CLOSE_SR);
    expect(out).toContain(REDACTED);
    expect(out).toContain("a &lt; b");
    expect(out).not.toContain(" < "); // No bare `<` survives.
  });
});

describe("fencePeerBody", () => {
  it("wraps with given nonce", () => {
    const out = fencePeerBody("hello", "deadbeef");
    expect(out).toBe("[peer-body-deadbeef]\nhello\n[/peer-body-deadbeef]");
  });

  it("preserves sanitized content verbatim within the fence", () => {
    const sanitized = "preserved content with &lt; escape";
    const out = fencePeerBody(sanitized, "abc12345");
    expect(out).toContain(sanitized);
    expect(out).toMatch(/^\[peer-body-abc12345\]\n/);
    expect(out).toMatch(/\n\[\/peer-body-abc12345\]$/);
  });

  it("uses a different fence marker per nonce (so concurrent emissions don't collide)", () => {
    const a = fencePeerBody("a", "11111111");
    const b = fencePeerBody("b", "22222222");
    expect(a).not.toBe(b);
    expect(a).toContain("[peer-body-11111111]");
    expect(b).toContain("[peer-body-22222222]");
  });
});
