// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, it } from "bun:test";

import {
  VALID_ID_REGEX,
  isValidArtifactId,
} from "../../src/shared/artifact-id";

describe("VALID_ID_REGEX", () => {
  it("is the exact-shape regex moved from active-sessions (cycle 2026-05-23 extraction)", () => {
    // Documents the regex literal at single source of truth. If the regex
    // is intentionally tightened/loosened in the future, this assertion
    // makes the change visible (cohort-aware fence test).
    expect(VALID_ID_REGEX.source).toBe("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$");
    expect(VALID_ID_REGEX.flags).toBe("");
  });
});

describe("isValidArtifactId — accept corpus", () => {
  const accepts: ReadonlyArray<readonly [string, string]> = [
    ["plain-lowercase", "alpha"],
    ["plain-uppercase-start", "Alpha"],
    ["mixed-case", "AlphaBravo"],
    ["digit-start", "0sibling"],
    ["with-underscore", "alpha_bravo"],
    ["with-hyphen", "alpha-bravo"],
    ["with-dot-interior", "alpha.bravo"],
    ["with-dot-trailing", "alpha."], // L1-S2 oracle finding: regex ACCEPTS trailing-dot
    ["arbitrary-channel-id", "2026-05-22_pair-cd"],
    ["arbitrary-channel-id-spec-shape", "2026-05-22_19-45"],
    ["max-length-128", "a" + "b".repeat(127)],
    ["short-single-char", "a"],
    ["short-single-digit", "0"],
    ["all-digits", "12345"],
    ["mixed-symbols", "a.b_c-d.e"],
  ] as const;

  for (const [label, value] of accepts) {
    it(`accepts ${label} → "${value}"`, () => {
      expect(isValidArtifactId(value)).toBe(true);
    });
  }
});

describe("isValidArtifactId — reject corpus", () => {
  const rejects: ReadonlyArray<readonly [string, string]> = [
    ["empty", ""],
    ["dot-only", "."],
    ["dot-dot (path traversal)", ".."],
    ["leading-dot", ".alpha"],
    ["leading-hyphen", "-alpha"],
    ["leading-underscore", "_alpha"],
    ["with-slash", "alpha/bravo"],
    ["with-backslash", "alpha\\bravo"],
    ["with-NUL", "alpha\0bravo"],
    ["with-space", "alpha bravo"],
    ["unicode-bmp", "alphä"],
    ["unicode-emoji", "alpha🎉"],
    ["percent-encoded-slash", "alpha%2Fbravo"], // % char not in allowed set
    ["too-long-129-chars", "a" + "b".repeat(128)],
    ["pure-symbols", "..."],
  ] as const;

  for (const [label, value] of rejects) {
    it(`rejects ${label} → "${value.length > 40 ? value.slice(0, 40) + "..." : value}"`, () => {
      expect(isValidArtifactId(value)).toBe(false);
    });
  }
});

describe("isValidArtifactId — non-string inputs", () => {
  it("rejects undefined", () => {
    expect(isValidArtifactId(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidArtifactId(null)).toBe(false);
  });

  it("rejects number", () => {
    expect(isValidArtifactId(42)).toBe(false);
  });

  it("rejects object", () => {
    expect(isValidArtifactId({ id: "alpha" })).toBe(false);
  });

  it("rejects array", () => {
    expect(isValidArtifactId(["alpha"])).toBe(false);
  });

  it("rejects boolean", () => {
    expect(isValidArtifactId(true)).toBe(false);
  });
});

describe("isValidArtifactId — type guard narrowing", () => {
  it("narrows unknown to string after positive check", () => {
    const candidate: unknown = "alpha";
    if (isValidArtifactId(candidate)) {
      const upper: string = candidate.toUpperCase();
      expect(upper).toBe("ALPHA");
    } else {
      throw new Error("expected isValidArtifactId to narrow positive");
    }
  });
});
