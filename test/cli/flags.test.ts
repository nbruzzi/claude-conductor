// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for parseFlags — the shared CLI flag-parsing helper.
 *
 * Per Phase 1 plan v2 §Slice 4 (CLI-DX-MAJ-3 — flag-parsing infrastructure).
 * Pins the contract every per-domain CLI verb depends on for --json /
 * --quiet / --help discovery.
 */

import { describe, expect, it } from "bun:test";
import { parseFlags } from "../../src/cli/flags.ts";

describe("parseFlags", () => {
  describe("default spec — accepts all standard flags", () => {
    it("returns all-false flags + every input as positional when no flags present", () => {
      const result = parseFlags(["a", "b", "c"]);
      expect(result.flags).toEqual({
        json: false,
        quiet: false,
        help: false,
        sinceMtime: undefined,
        sinceCursor: false,
      });
      expect(result.positional).toEqual(["a", "b", "c"]);
    });

    it("recognizes --json and removes it from positional", () => {
      const result = parseFlags(["my-channel", "--json"]);
      expect(result.flags.json).toBe(true);
      expect(result.flags.quiet).toBe(false);
      expect(result.flags.help).toBe(false);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("recognizes --quiet and removes it from positional", () => {
      const result = parseFlags(["--quiet", "my-channel"]);
      expect(result.flags.quiet).toBe(true);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("recognizes --help and removes it from positional", () => {
      const result = parseFlags(["--help"]);
      expect(result.flags.help).toBe(true);
      expect(result.positional).toEqual([]);
    });

    it("treats -h as an alias for --help", () => {
      const result = parseFlags(["-h"]);
      expect(result.flags.help).toBe(true);
      expect(result.positional).toEqual([]);
    });

    it("combines multiple flags", () => {
      const result = parseFlags(["my-channel", "--json", "--quiet"]);
      expect(result.flags).toEqual({
        json: true,
        quiet: true,
        help: false,
        sinceMtime: undefined,
        sinceCursor: false,
      });
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("preserves positional ordering when flags interleave", () => {
      const result = parseFlags(["a", "--json", "b", "--quiet", "c"]);
      expect(result.flags.json).toBe(true);
      expect(result.flags.quiet).toBe(true);
      expect(result.positional).toEqual(["a", "b", "c"]);
    });
  });

  describe("custom spec — opt-out per flag", () => {
    it("when json: false, --json passes through as positional", () => {
      const result = parseFlags(["my-id", "--json"], { json: false });
      expect(result.flags.json).toBe(false);
      expect(result.positional).toEqual(["my-id", "--json"]);
    });

    it("when quiet: false, --quiet passes through as positional", () => {
      const result = parseFlags(["my-id", "--quiet"], { quiet: false });
      expect(result.flags.quiet).toBe(false);
      expect(result.positional).toEqual(["my-id", "--quiet"]);
    });

    it("when help: false, --help and -h pass through as positional", () => {
      const result = parseFlags(["--help", "-h"], { help: false });
      expect(result.flags.help).toBe(false);
      expect(result.positional).toEqual(["--help", "-h"]);
    });

    it("partial spec — only json accepted, others pass through", () => {
      const result = parseFlags(["--json", "--quiet", "--help"], {
        json: true,
        quiet: false,
        help: false,
      });
      expect(result.flags.json).toBe(true);
      expect(result.flags.quiet).toBe(false);
      expect(result.flags.help).toBe(false);
      expect(result.positional).toEqual(["--quiet", "--help"]);
    });
  });

  describe("edge cases", () => {
    it("empty argv returns empty positional + all-false flags", () => {
      const result = parseFlags([]);
      expect(result.flags).toEqual({
        json: false,
        quiet: false,
        help: false,
        sinceMtime: undefined,
        sinceCursor: false,
      });
      expect(result.positional).toEqual([]);
    });

    it("unknown long-flag passes through as positional (no strict validation)", () => {
      const result = parseFlags(["my-id", "--unknown-flag"]);
      expect(result.positional).toEqual(["my-id", "--unknown-flag"]);
    });

    it("preserves duplicate flag-set semantics (idempotent boolean)", () => {
      const result = parseFlags(["--json", "--json", "--json"]);
      expect(result.flags.json).toBe(true);
      expect(result.positional).toEqual([]);
    });

    it("preserves positional that look like flag-values (no key=value parsing)", () => {
      const result = parseFlags(["--json=invalid"]);
      // We don't accept --json=value form; the literal string passes through.
      expect(result.flags.json).toBe(false);
      expect(result.positional).toEqual(["--json=invalid"]);
    });
  });

  describe("Phase 2 Slice 8 — --since-mtime + --since-cursor", () => {
    const SLICE_8_SPEC = { sinceMtime: true, sinceCursor: true } as const;

    it("--since-mtime <ms> consumes the next argv as numeric value", () => {
      const result = parseFlags(
        ["my-channel", "--since-mtime", "12345"],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(12345);
      expect(result.flags.sinceCursor).toBe(false);
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("--since-mtime accepts ISO 8601 (CLI-6)", () => {
      const expected = Date.parse("2025-01-01T00:00:00Z");
      const result = parseFlags(
        ["my-channel", "--since-mtime", "2025-01-01T00:00:00Z"],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(expected);
      expect(result.parseErrors).toEqual([]);
    });

    it("--since-mtime with no value flags an error", () => {
      const result = parseFlags(["my-channel", "--since-mtime"], SLICE_8_SPEC);
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
      expect(result.parseErrors[0]).toContain("missing value");
    });

    it("--since-mtime with another flag as value flags an error", () => {
      const result = parseFlags(
        ["my-channel", "--since-mtime", "--json"],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
      expect(result.flags.json).toBe(true); // --json still parsed normally
    });

    it("--since-mtime abc → parse error (RE-2)", () => {
      const result = parseFlags(
        ["my-channel", "--since-mtime", "abc"],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
      expect(result.parseErrors[0]).toContain('"abc"');
    });

    it('--since-mtime "" → parse error (empty string treated as missing)', () => {
      const result = parseFlags(
        ["my-channel", "--since-mtime", ""],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
    });

    it("--since-mtime -5 → parse error (RE-2 — negative integer rejected via digit-only regex)", () => {
      const result = parseFlags(
        ["my-channel", "--since-mtime", "-5"],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
    });

    it("--since-mtime 1.5e10 → parse error (RE-2 — scientific notation rejected)", () => {
      const result = parseFlags(
        ["my-channel", "--since-mtime", "1.5e10"],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
    });

    it("--since-mtime 0 → parse error (CLI-9 — must be >= 1)", () => {
      const result = parseFlags(
        ["my-channel", "--since-mtime", "0"],
        SLICE_8_SPEC,
      );
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
    });

    it("--since-cursor sets the boolean flag without consuming a value", () => {
      const result = parseFlags(["my-channel", "--since-cursor"], SLICE_8_SPEC);
      expect(result.flags.sinceCursor).toBe(true);
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("--since-mtime and --since-cursor together → mutual-exclusivity error (CLI-3)", () => {
      const result = parseFlags(
        ["my-channel", "--since-cursor", "--since-mtime", "12345"],
        SLICE_8_SPEC,
      );
      expect(result.parseErrors.length).toBe(1);
      expect(result.parseErrors[0]).toContain("mutually exclusive");
    });

    it("--json combines cleanly with --since-cursor", () => {
      const result = parseFlags(
        ["my-channel", "--json", "--since-cursor"],
        SLICE_8_SPEC,
      );
      expect(result.flags.json).toBe(true);
      expect(result.flags.sinceCursor).toBe(true);
      expect(result.parseErrors).toEqual([]);
    });

    it("when sinceMtime: false (spec opt-out), --since-mtime passes through as positional", () => {
      const result = parseFlags(["my-channel", "--since-mtime", "12345"], {
        sinceMtime: false,
        sinceCursor: false,
      });
      expect(result.flags.sinceMtime).toBe(undefined);
      expect(result.positional).toContain("--since-mtime");
      expect(result.positional).toContain("12345");
    });
  });
});
