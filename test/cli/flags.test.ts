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
      expect(result.flags).toEqual({ json: false, quiet: false, help: false });
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
      expect(result.flags).toEqual({ json: true, quiet: true, help: false });
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
      expect(result.flags).toEqual({ json: false, quiet: false, help: false });
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
});
