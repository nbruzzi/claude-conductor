// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { HookInput } from "../../src/hooks/types.ts";
import { DEFAULT_DISPATCH } from "../../src/hooks/types.ts";
import {
  extractSessionId,
  extractValidSessionId,
  resolveSessionIdOrNull,
} from "../../src/hooks/session-id.ts";

function input(raw: Record<string, unknown>): HookInput {
  return {
    toolName: "Edit",
    filePath: undefined,
    command: undefined,
    cwd: undefined,
    transcriptPath: undefined,
    raw,
    dispatch: { ...DEFAULT_DISPATCH },
  };
}

describe("extractSessionId (raw — deprecated for end-consumers; preserved for test infra)", () => {
  it("returns the session_id field when present and non-empty", () => {
    expect(extractSessionId({ session_id: "abc-123" })).toBe("abc-123");
  });

  it("returns undefined when session_id is absent", () => {
    expect(extractSessionId({})).toBe(undefined);
  });

  it("returns undefined when session_id is empty string", () => {
    expect(extractSessionId({ session_id: "" })).toBe(undefined);
  });

  it("returns undefined when session_id is non-string", () => {
    expect(extractSessionId({ session_id: 42 })).toBe(undefined);
    expect(extractSessionId({ session_id: null })).toBe(undefined);
    expect(extractSessionId({ session_id: ["abc"] })).toBe(undefined);
  });

  it("returns path-traversal-shaped strings VERBATIM (the safety gap the safe wrapper closes)", () => {
    // This is the L:768 motivating case: the raw extractor does not validate,
    // so a malformed id flows through to any consumer that forgets to gate.
    expect(extractSessionId({ session_id: "../etc/passwd" })).toBe(
      "../etc/passwd",
    );
    expect(extractSessionId({ session_id: "bad/slash" })).toBe("bad/slash");
  });
});

describe("extractValidSessionId (safe — preferred for all end-consumers, L:768)", () => {
  let prevEnv: string | undefined;
  let errors: string[];
  let origError: typeof console.error;

  beforeEach(() => {
    prevEnv = process.env["CLAUDE_SESSION_ID"];
    delete process.env["CLAUDE_SESSION_ID"];
    errors = [];
    origError = console.error;
    console.error = ((msg: string) => {
      errors.push(msg);
    }) as unknown as typeof console.error;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env["CLAUDE_SESSION_ID"];
    else process.env["CLAUDE_SESSION_ID"] = prevEnv;
    console.error = origError;
  });

  it("returns the validated session_id when it matches isValidSessionId", () => {
    expect(extractValidSessionId({ session_id: "abc-123" })).toBe("abc-123");
    expect(errors).toHaveLength(0);
  });

  it("returns undefined when session_id is absent (no breadcrumb — normal case)", () => {
    expect(extractValidSessionId({})).toBe(undefined);
    expect(errors).toHaveLength(0);
  });

  it("returns undefined when session_id is empty (no breadcrumb — empty is treated as absent)", () => {
    expect(extractValidSessionId({ session_id: "" })).toBe(undefined);
    expect(errors).toHaveLength(0);
  });

  it("rejects path-traversal-shaped strings AND emits a stderr breadcrumb (the safety property)", () => {
    expect(extractValidSessionId({ session_id: "../etc/passwd" })).toBe(
      undefined,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[session-id]");
    expect(errors[0]).toContain("raw.session_id");
    expect(errors[0]).toContain("isValidSessionId");
    // The raw id is never logged — only its length
    expect(errors[0]).not.toContain("../etc/passwd");
  });

  it("rejects slash-containing ids with breadcrumb", () => {
    expect(extractValidSessionId({ session_id: "bad/slash" })).toBe(undefined);
    expect(errors).toHaveLength(1);
  });

  it("rejects leading-hyphen ids with breadcrumb", () => {
    expect(extractValidSessionId({ session_id: "-abc" })).toBe(undefined);
    expect(errors).toHaveLength(1);
  });

  it("rejects ids exceeding 128 chars with breadcrumb", () => {
    expect(extractValidSessionId({ session_id: "a" + "b".repeat(128) })).toBe(
      undefined,
    );
    expect(errors).toHaveLength(1);
  });

  it("accepts the 128-char boundary", () => {
    const exactlyMax = "a" + "b".repeat(127);
    expect(extractValidSessionId({ session_id: exactlyMax })).toBe(exactlyMax);
    expect(errors).toHaveLength(0);
  });

  it("accepts allowed special chars (._-)", () => {
    expect(extractValidSessionId({ session_id: "a.b_c-d" })).toBe("a.b_c-d");
    expect(errors).toHaveLength(0);
  });

  it("returns undefined for non-string session_id (no breadcrumb — extraction failed)", () => {
    expect(extractValidSessionId({ session_id: 42 })).toBe(undefined);
    expect(extractValidSessionId({ session_id: null })).toBe(undefined);
    expect(extractValidSessionId({ session_id: ["abc"] })).toBe(undefined);
    // No breadcrumbs — these fail at extractSessionId, never reach validation
    expect(errors).toHaveLength(0);
  });
});

describe("resolveSessionIdOrNull", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env["CLAUDE_SESSION_ID"];
    delete process.env["CLAUDE_SESSION_ID"];
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env["CLAUDE_SESSION_ID"];
    else process.env["CLAUDE_SESSION_ID"] = prevEnv;
  });

  it("returns the hook input session_id when valid", () => {
    expect(resolveSessionIdOrNull(input({ session_id: "session-abc" }))).toBe(
      "session-abc",
    );
  });

  it("returns null when session_id is absent", () => {
    expect(resolveSessionIdOrNull(input({}))).toBe(null);
  });

  it("returns null when session_id is empty", () => {
    expect(resolveSessionIdOrNull(input({ session_id: "" }))).toBe(null);
  });

  describe("isValidSessionId rejection shapes", () => {
    // Regex: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
    it.each([
      ["leading hyphen", "-abc"],
      ["leading dot", ".abc"],
      ["leading underscore", "_abc"],
      ["contains slash", "bad/session"],
      ["contains space", "bad session"],
      ["contains null byte", "bad\x00session"],
      ["contains tab", "bad\tsession"],
      ["exceeds 128 chars", "a" + "b".repeat(128)],
    ])("rejects %s", (_desc, invalid) => {
      expect(resolveSessionIdOrNull(input({ session_id: invalid }))).toBe(null);
    });

    it("accepts the 128-char boundary", () => {
      const exactlyMax = "a" + "b".repeat(127);
      expect(resolveSessionIdOrNull(input({ session_id: exactlyMax }))).toBe(
        exactlyMax,
      );
    });

    it("accepts allowed special chars (._-)", () => {
      expect(resolveSessionIdOrNull(input({ session_id: "a.b_c-d" }))).toBe(
        "a.b_c-d",
      );
    });
  });

  describe("CLAUDE_SESSION_ID env override", () => {
    it("takes precedence over hook input session_id", () => {
      process.env["CLAUDE_SESSION_ID"] = "from-env";
      expect(resolveSessionIdOrNull(input({ session_id: "from-raw" }))).toBe(
        "from-env",
      );
    });

    it("returns null when env override is set but invalid — does not fall back to raw", () => {
      // Explicit env takes precedence; an invalid env value is rejected and
      // does NOT silently fall through to raw. Otherwise "override" would not
      // mean override.
      process.env["CLAUDE_SESSION_ID"] = "bad/env";
      expect(resolveSessionIdOrNull(input({ session_id: "valid-raw" }))).toBe(
        null,
      );
    });

    it("empty env override is ignored — raw wins", () => {
      process.env["CLAUDE_SESSION_ID"] = "";
      expect(resolveSessionIdOrNull(input({ session_id: "from-raw" }))).toBe(
        "from-raw",
      );
    });
  });
});
