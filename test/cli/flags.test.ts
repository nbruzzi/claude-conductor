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
        as: undefined,
        role: undefined,
        force: false,
        fromSession: undefined,
        base: undefined,
        dryRun: false,
        onto: undefined,
        noChain: false,
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
        as: undefined,
        role: undefined,
        force: false,
        fromSession: undefined,
        base: undefined,
        dryRun: false,
        onto: undefined,
        noChain: false,
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
        as: undefined,
        role: undefined,
        force: false,
        fromSession: undefined,
        base: undefined,
        dryRun: false,
        onto: undefined,
        noChain: false,
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

  describe("P2 — --as / --role / --force / --from-session (channel-as-flag plan)", () => {
    /**
     * Plan: ~/.claude/plans/giggly-bouncing-spark.md (P2 — Channel-CLI explicit
     * `--as <Identity>` flag). The parser is value-extraction only — domain
     * validation (NATO letter for `--as`, ChannelRole for `--role`, session-id
     * shape for `--from-session`) happens at verb-level dispatch. These tests
     * pin the extraction contract.
     */
    const P2_SPEC = {
      as: true,
      role: true,
      force: true,
      fromSession: true,
    } as const;

    // ─── --as ──────────────────────────────────────────────────────

    it("--as Alpha consumes the next argv as the NATO-letter value (verbatim, no flag-level validation)", () => {
      const result = parseFlags(["my-channel", "--as", "Alpha"], P2_SPEC);
      expect(result.flags.as).toBe("Alpha");
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("--as Alpha combines cleanly with --json", () => {
      const result = parseFlags(
        ["my-channel", "--as", "Alpha", "--json"],
        P2_SPEC,
      );
      expect(result.flags.as).toBe("Alpha");
      expect(result.flags.json).toBe(true);
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("--as with no following value → parseError 'expected value, got missing value'", () => {
      const result = parseFlags(["my-channel", "--as"], P2_SPEC);
      expect(result.flags.as).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
      expect(result.parseErrors[0]).toContain("--as");
      expect(result.parseErrors[0]).toContain("missing value");
    });

    it("--as --quiet (flag-after-flag, no value) → parseError on --as; --quiet still parsed", () => {
      const result = parseFlags(["my-channel", "--as", "--quiet"], P2_SPEC);
      expect(result.flags.as).toBe(undefined);
      expect(result.flags.quiet).toBe(true);
      expect(result.parseErrors.length).toBe(1);
      expect(result.parseErrors[0]).toContain("--as");
    });

    it('--as "" (empty string value) → parseError (empty treated as missing)', () => {
      const result = parseFlags(["my-channel", "--as", ""], P2_SPEC);
      expect(result.flags.as).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
    });

    it("--as <non-NATO-letter> → flag-level extraction succeeds verbatim (verb-level validates)", () => {
      // Lowercase "alpha" is not a valid NATO identity, but the parser is
      // value-extraction-only; verb-level dispatch validates via
      // isValidIdentity before use.
      const result = parseFlags(["--as", "alpha"], P2_SPEC);
      expect(result.flags.as).toBe("alpha");
      expect(result.parseErrors).toEqual([]);
    });

    // ─── --role ────────────────────────────────────────────────────

    it("--role pen / queue / out — flag.role is the verbatim value for each ChannelRole", () => {
      for (const role of ["pen", "queue", "out"] as const) {
        const result = parseFlags(["my-channel", "--role", role], P2_SPEC);
        expect(result.flags.role).toBe(role);
        expect(result.parseErrors).toEqual([]);
      }
    });

    it("--role with no following value → parseError", () => {
      const result = parseFlags(["--role"], P2_SPEC);
      expect(result.flags.role).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
      expect(result.parseErrors[0]).toContain("--role");
      expect(result.parseErrors[0]).toContain("missing value");
    });

    it("--role <non-ChannelRole> → flag-level extraction succeeds verbatim (verb-level validates)", () => {
      const result = parseFlags(["--role", "admin"], P2_SPEC);
      expect(result.flags.role).toBe("admin");
      expect(result.parseErrors).toEqual([]);
    });

    // ─── --force ───────────────────────────────────────────────────

    it("--force standalone (no value consumed) → flag.force=true", () => {
      const result = parseFlags(["my-channel", "--force"], P2_SPEC);
      expect(result.flags.force).toBe(true);
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("--force --force → idempotent (still true; positional empty)", () => {
      const result = parseFlags(["--force", "--force"], P2_SPEC);
      expect(result.flags.force).toBe(true);
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual([]);
    });

    // ─── --from-session ────────────────────────────────────────────

    it("--from-session <session-id> consumes the next argv as the session-id value", () => {
      const uuid = "204d1756-036b-4fcd-bda4-0e4fce9e30dc";
      const result = parseFlags(
        ["my-channel", "--from-session", uuid],
        P2_SPEC,
      );
      expect(result.flags.fromSession).toBe(uuid);
      expect(result.parseErrors).toEqual([]);
    });

    it("--from-session with no following value → parseError", () => {
      const result = parseFlags(["--from-session"], P2_SPEC);
      expect(result.flags.fromSession).toBe(undefined);
      expect(result.parseErrors.length).toBe(1);
      expect(result.parseErrors[0]).toContain("--from-session");
    });

    it("--from-session with non-UUID value → flag-level extraction succeeds verbatim (verb-level validates)", () => {
      const result = parseFlags(["--from-session", "foo"], P2_SPEC);
      expect(result.flags.fromSession).toBe("foo");
      expect(result.parseErrors).toEqual([]);
    });

    // ─── Combinations ──────────────────────────────────────────────

    it("all four P2 flags together — all set correctly + positional cleaned", () => {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const result = parseFlags(
        [
          "my-channel",
          "--as",
          "Alpha",
          "--role",
          "pen",
          "--force",
          "--from-session",
          uuid,
        ],
        P2_SPEC,
      );
      expect(result.flags.as).toBe("Alpha");
      expect(result.flags.role).toBe("pen");
      expect(result.flags.force).toBe(true);
      expect(result.flags.fromSession).toBe(uuid);
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["my-channel"]);
    });

    it("P2 flags interleaved with positional — preserves positional ordering", () => {
      const result = parseFlags(
        ["join", "my-channel", "--as", "Alpha", "extra", "--role", "pen"],
        P2_SPEC,
      );
      expect(result.flags.as).toBe("Alpha");
      expect(result.flags.role).toBe("pen");
      expect(result.positional).toEqual(["join", "my-channel", "extra"]);
    });

    // ─── Spec opt-in / opt-out ─────────────────────────────────────

    it("default spec (no P2 opt-in) — --as Alpha passes through as positional args", () => {
      const result = parseFlags(["my-id", "--as", "Alpha"]);
      expect(result.flags.as).toBe(undefined);
      expect(result.positional).toEqual(["my-id", "--as", "Alpha"]);
    });

    it("custom spec opt-out — { as: false } leaves --as Alpha as positional", () => {
      const result = parseFlags(["--as", "Alpha"], { as: false });
      expect(result.flags.as).toBe(undefined);
      expect(result.positional).toEqual(["--as", "Alpha"]);
    });

    // ─── Edge: key=value form ──────────────────────────────────────

    it("--as=Alpha (key=value form, unsupported) — passes through as positional", () => {
      // Mirrors the existing `--json=invalid` edge case at line 144 — we don't
      // accept `--flag=value` shape; the literal arg passes through.
      const result = parseFlags(["my-channel", "--as=Alpha"], P2_SPEC);
      expect(result.flags.as).toBe(undefined);
      expect(result.positional).toEqual(["my-channel", "--as=Alpha"]);
    });
  });

  describe("Slice 0 — --base / --dry-run (pr cascade-rebase flags)", () => {
    /**
     * Slice 0 origin: plan ~/.claude/plans/slice-0-cascade-rebase-2026-05-19.md
     * §D1 + §Files-to-modify §4. Parser is value-extraction only — verb-level
     * dispatch validates non-empty + branch-name shape for --base.
     */
    const SLICE0_SPEC = { base: true, dryRun: true, onto: true } as const;

    // ─── --base ────────────────────────────────────────────────────

    it("--base alpha/conductor-foo consumes the next argv as the branch-name value (verbatim)", () => {
      const result = parseFlags(
        ["pr-cascade", "--base", "alpha/conductor-foo"],
        SLICE0_SPEC,
      );
      expect(result.flags.base).toBe("alpha/conductor-foo");
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["pr-cascade"]);
    });

    it("--base combines cleanly with --json + --dry-run + --quiet", () => {
      const result = parseFlags(
        ["--base", "main", "--dry-run", "--json", "--quiet"],
        SLICE0_SPEC,
      );
      expect(result.flags.base).toBe("main");
      expect(result.flags.dryRun).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.flags.quiet).toBe(true);
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual([]);
    });

    it("--base with no following value emits a parseError (missing-value)", () => {
      const result = parseFlags(["pr-cascade", "--base"], SLICE0_SPEC);
      expect(result.flags.base).toBe(undefined);
      expect(result.parseErrors).toEqual([
        "--base: expected value, got missing value",
      ]);
      // Don't consume forward; positional preserves the verb.
      expect(result.positional).toEqual(["pr-cascade"]);
    });

    it("--base followed by another flag (eats the flag as value? no — rejected)", () => {
      // `consumeStringValue` rejects values that start with `--`, treating them
      // as a missing value (mirrors --as/--role behavior on flag-shaped values).
      const result = parseFlags(
        ["pr-cascade", "--base", "--json"],
        SLICE0_SPEC,
      );
      expect(result.flags.base).toBe(undefined);
      expect(result.flags.json).toBe(true);
      expect(result.parseErrors).toEqual([
        "--base: expected value, got missing value",
      ]);
    });

    it("when base: false (default — opt-out), --base passes through as positional", () => {
      const result = parseFlags(["pr-cascade", "--base", "main"], {
        base: false,
      });
      expect(result.flags.base).toBe(undefined);
      expect(result.positional).toContain("--base");
      expect(result.positional).toContain("main");
    });

    // ─── --dry-run ─────────────────────────────────────────────────

    it("--dry-run (standalone) sets dryRun flag without consuming next argv", () => {
      const result = parseFlags(
        ["pr-cascade", "--dry-run", "main"],
        SLICE0_SPEC,
      );
      expect(result.flags.dryRun).toBe(true);
      expect(result.positional).toEqual(["pr-cascade", "main"]);
    });

    it("--dry-run is position-insensitive (before or after positional)", () => {
      const before = parseFlags(["--dry-run", "pr-cascade"], {
        dryRun: true,
      } as const);
      const after = parseFlags(["pr-cascade", "--dry-run"], {
        dryRun: true,
      } as const);
      expect(before.flags.dryRun).toBe(true);
      expect(after.flags.dryRun).toBe(true);
      expect(before.positional).toEqual(["pr-cascade"]);
      expect(after.positional).toEqual(["pr-cascade"]);
    });

    it("when dryRun: false (default — opt-out), --dry-run passes through as positional", () => {
      const result = parseFlags(["pr-cascade", "--dry-run"], { dryRun: false });
      expect(result.flags.dryRun).toBe(false);
      expect(result.positional).toContain("--dry-run");
    });

    // ─── --onto (Slice 0 v0.3 — Delta F-NEW-1 fold) ────────────────

    it("T-onto.1 — --onto main consumes the next argv as the branch-name value (verbatim)", () => {
      const result = parseFlags(["pr-cascade", "--onto", "main"], {
        onto: true,
      } as const);
      expect(result.flags.onto).toBe("main");
      expect(result.parseErrors).toEqual([]);
      expect(result.positional).toEqual(["pr-cascade"]);
    });

    it("T-onto.2 — --onto with branch-name that includes /", () => {
      const result = parseFlags(["pr-cascade", "--onto", "release/v2"], {
        onto: true,
      } as const);
      expect(result.flags.onto).toBe("release/v2");
    });

    it("T-onto.3 — --onto combines cleanly with --base + --dry-run + --json", () => {
      const result = parseFlags(
        ["--base", "feat-A", "--onto", "main", "--dry-run", "--json"],
        SLICE0_SPEC,
      );
      expect(result.flags.base).toBe("feat-A");
      expect(result.flags.onto).toBe("main");
      expect(result.flags.dryRun).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.parseErrors).toEqual([]);
    });

    it("T-onto.4 — --onto with no following value emits a parseError", () => {
      const result = parseFlags(["pr-cascade", "--onto"], {
        onto: true,
      } as const);
      expect(result.flags.onto).toBe(undefined);
      expect(result.parseErrors).toEqual([
        "--onto: expected value, got missing value",
      ]);
    });

    it("T-onto.5 — when onto: false (default — opt-out), --onto passes through as positional", () => {
      const result = parseFlags(["pr-cascade", "--onto", "main"], {
        onto: false,
      });
      expect(result.flags.onto).toBe(undefined);
      expect(result.positional).toContain("--onto");
      expect(result.positional).toContain("main");
    });
  });
});
