// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Lock-domain registry meta-test (Step F / RE-W2-5; v2.12 fold).
 *
 * Pins 8 invariants on `BUNDLED_LOCK_DOMAINS` + `BUNDLED_LOCK_DOMAINS_BY_EVENT`
 * + `LOCK_DOMAINS`:
 *
 * 1. **Exhaustive-coverage** — `BUNDLED_LOCK_DOMAINS` ↔ `BUNDLED_CHECK_NAMES`
 *    set-equality + 1:1 mapping. Adding a new bundled check without a row
 *    fails with a directed `expect.unreachable()` message (RE-6 v2.12 fold).
 * 2. **Event-tag consistency** — each row's `event` matches the actual
 *    event-bucket in `BUNDLED_CHECKS_BY_EVENT`.
 * 3. **Event-keyed key completeness** — `BUNDLED_LOCK_DOMAINS_BY_EVENT` has
 *    a key for every `HookEvent` literal (compile-time pinned via
 *    `satisfies Record<HookEvent, ...>`; runtime test confirms parity).
 * 4. **Domain-enum exhaustive** — every non-`none` LockDomain literal is
 *    referenced by ≥1 row (catches taxonomy drift).
 * 5. **`none` discipline** — rows with `domains: ["none"]` MUST have a
 *    non-empty `comment` (rationale-required per `feedback-self-sufficient-notes.md`).
 * 6. **Duplicate-detection between rows** — no two rows share the same `phase`.
 * 7. **Domain-uniqueness within row** (ARCH-F-3 v2.12 fold) — no row's
 *    `domains` list contains a duplicate.
 * 8. **Domains-non-empty** — every row has ≥1 domain.
 *
 * Anti-drift complement to `test/hooks/bundled-registrations.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  BUNDLED_CHECK_NAMES,
  BUNDLED_CHECKS_BY_EVENT,
} from "../../src/hooks/bundled-check-names.ts";
import {
  BUNDLED_LOCK_DOMAINS,
  BUNDLED_LOCK_DOMAINS_BY_EVENT,
  LOCK_DOMAINS,
  type LockDomain,
} from "../../src/hooks/lock-domain.ts";
import { HOOK_EVENTS } from "../../src/hooks/types.ts";

describe("BUNDLED_LOCK_DOMAINS invariants", () => {
  test("exhaustive-coverage — every BundledCheckName has exactly one row", () => {
    const phases = BUNDLED_LOCK_DOMAINS.map((row) => row.phase).sort();
    const names = [...BUNDLED_CHECK_NAMES].sort();

    const missing = names.filter((n) => !phases.includes(n));
    const extra = phases.filter((p) => !names.includes(p));

    if (missing.length > 0) {
      expect.unreachable(
        `BUNDLED_LOCK_DOMAINS missing row(s) for: ${missing.join(", ")}. ` +
          `Each entry in BUNDLED_CHECK_NAMES requires a corresponding row in ` +
          `BUNDLED_LOCK_DOMAINS_BY_EVENT.`,
      );
    }
    if (extra.length > 0) {
      expect.unreachable(
        `BUNDLED_LOCK_DOMAINS has row(s) for unknown phase(s): ${extra.join(
          ", ",
        )}. These don't appear in BUNDLED_CHECK_NAMES — remove the row(s) or ` +
          `fix the typo.`,
      );
    }

    expect(phases).toEqual(names);
    expect(BUNDLED_LOCK_DOMAINS).toHaveLength(BUNDLED_CHECK_NAMES.length);
  });

  test("event-tag consistency — each row's event matches BUNDLED_CHECKS_BY_EVENT", () => {
    for (const row of BUNDLED_LOCK_DOMAINS) {
      const namesForEvent = BUNDLED_CHECKS_BY_EVENT[
        row.event
      ] as readonly string[];
      expect(namesForEvent).toContain(row.phase);
    }
  });

  test("event-keyed key completeness — every HookEvent has an entry in BUNDLED_LOCK_DOMAINS_BY_EVENT", () => {
    for (const event of HOOK_EVENTS) {
      expect(BUNDLED_LOCK_DOMAINS_BY_EVENT).toHaveProperty(event);
      const rows = BUNDLED_LOCK_DOMAINS_BY_EVENT[event];
      expect(Array.isArray(rows)).toBe(true);
    }
  });

  test("domain-enum exhaustive — every non-`none` LockDomain referenced by ≥1 row", () => {
    const referenced = new Set<LockDomain>();
    for (const row of BUNDLED_LOCK_DOMAINS) {
      for (const d of row.domains) {
        referenced.add(d);
      }
    }
    for (const literal of LOCK_DOMAINS) {
      if (literal === "none") continue;
      expect(referenced.has(literal)).toBe(true);
    }
  });

  test("`none` discipline — rows with only `none` MUST have a non-empty comment", () => {
    for (const row of BUNDLED_LOCK_DOMAINS) {
      const isNoneOnly = row.domains.length === 1 && row.domains[0] === "none";
      if (isNoneOnly) {
        expect(typeof row.comment).toBe("string");
        expect((row.comment ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  test("duplicate-detection between rows — no two rows share the same phase", () => {
    const phases = BUNDLED_LOCK_DOMAINS.map((row) => row.phase);
    const seen = new Set<string>();
    for (const p of phases) {
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
  });

  test("domain-uniqueness within row — no row's domains list contains a duplicate", () => {
    for (const row of BUNDLED_LOCK_DOMAINS) {
      const set = new Set(row.domains);
      expect(set.size).toBe(row.domains.length);
    }
  });

  test("domains-non-empty — every row has ≥1 domain", () => {
    for (const row of BUNDLED_LOCK_DOMAINS) {
      expect(row.domains.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("LOCK_DOMAINS includes `none` sentinel", () => {
    expect((LOCK_DOMAINS as readonly string[]).includes("none")).toBe(true);
  });

  // P0 substrate canary (backlog L:892, 2026-05-17): directed assertion that
  // the dotfiles-worktree-provisioner row carries the new symlink domain.
  // Invariant 4 ensures the literal is referenced SOMEWHERE; this test pins
  // it to the right row so future moves don't silently regress the registry.
  test("dotfiles-worktree-provisioner row includes per-worktree-node-modules-symlink (P0 L:892)", () => {
    const row = BUNDLED_LOCK_DOMAINS.find(
      (r) => r.phase === "dotfiles-worktree-provisioner",
    );
    expect(row?.domains).toContain("per-worktree-node-modules-symlink");
  });
});
