// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the `memory-proposal` message kind's shared parser
 * (`parseMemoryProposalBody`) + `MemoryType` type-guard.
 *
 * Coverage organized by Section per plan v0.2 §Test-grid (extended with
 * F1 symmetric trim coverage across all 5 string fields):
 *
 *   1. Happy path (canonical body parses cleanly + amends_existing=null + non-null)
 *   2. kind_version
 *   3. candidate_name (F1 — required non-empty post-trim + whitespace-only rej + trim-on-output + internal-whitespace-preserved)
 *   4. memory_type (4 valid values + invalid + missing + non-string)
 *   5. description (F1 symmetric trim)
 *   6. reason (F1 symmetric trim)
 *   7. proposed_body (F1 symmetric trim + multi-paragraph preserved)
 *   8. amends_existing (null OR non-empty post-trim; whitespace-only rej; trim-on-output)
 *   9. Forward-compat (extra unknown fields ignored)
 *   10. JSON-root failures (non-object / array / parse-error)
 *
 * F1 symmetric trim discipline (Bravo audit fold on v0.1): each string
 * field gets THREE tests — non-empty post-trim required, whitespace-only
 * rejected, internal whitespace preserved on output (only leading/trailing
 * trim is canonicalized). Mirrors Slice 1 A1 + Slice 2 B1 carry-over.
 *
 * Plan: `~/.claude/plans/slice-T2V2-memory-proposal-schema-2026-05-20.md` v0.2.
 */

import { describe, expect, it } from "bun:test";

import {
  isMemoryType,
  MEMORY_TYPES,
  parseMemoryProposalBody,
  type MemoryProposalBody,
} from "../../src/channels/memory-proposal.ts";

/**
 * Canonical reference body — net-new feedback memory proposal.
 * Used by happy-path tests + as override-base for negative-case construction.
 */
const CANONICAL_MEMORY_PROPOSAL_BODY: MemoryProposalBody = {
  kind_version: 1,
  candidate_name: "feedback-auto-sync-recurrence",
  memory_type: "feedback",
  description:
    "Auto-sync Stop-hook captured staged atomic transactions under generic sync: commit message — 2 instances cycle 2026-05-19.",
  reason:
    "Recurring pattern (2 instances within ~2h on cycle 2026-05-19). Existing memory documents the class; this proposal would amend with recurrence-frequency fact + suggest Stop-hook deferral when staged-files-with-explicit-commit-message pending.",
  proposed_body:
    "**Why:** Cycle 2026-05-19 fired this pattern TWICE within ~2h.\n\n**How to apply:** When committing a manual atomic transaction (staged conductor PR + paired dotfiles cross-edge mirror), check that the dotfiles auto-sync Stop-hook does not fire between conductor stage and dotfiles stage. If it does, `git stash` the staged dotfiles change, complete the conductor commit + push, then `git stash pop` and manually commit dotfiles with explicit `feat()` message.",
  amends_existing: null,
};

function bodyWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    ...CANONICAL_MEMORY_PROPOSAL_BODY,
    ...overrides,
  });
}

function bodyWithout(field: keyof MemoryProposalBody): string {
  const copy: Record<string, unknown> = { ...CANONICAL_MEMORY_PROPOSAL_BODY };
  delete copy[field];
  return JSON.stringify(copy);
}

describe("parseMemoryProposalBody — happy path", () => {
  it("parses canonical net-new proposal", () => {
    const result = parseMemoryProposalBody(
      JSON.stringify(CANONICAL_MEMORY_PROPOSAL_BODY),
    );
    expect(result).toEqual(CANONICAL_MEMORY_PROPOSAL_BODY);
  });

  it("parses amendment proposal (amends_existing non-null)", () => {
    const body = bodyWith({
      amends_existing: "feedback-auto-sync-captures-staged-atomic",
    });
    const result = parseMemoryProposalBody(body);
    expect(result?.amends_existing).toBe(
      "feedback-auto-sync-captures-staged-atomic",
    );
  });

  it("parses all 4 memory_type values", () => {
    for (const memory_type of MEMORY_TYPES) {
      const result = parseMemoryProposalBody(
        bodyWith({
          memory_type,
          candidate_name: `${memory_type}-example-name`,
        }),
      );
      expect(result?.memory_type).toBe(memory_type);
    }
  });
});

describe("parseMemoryProposalBody — Section 2: kind_version", () => {
  it("rejects missing kind_version", () => {
    expect(parseMemoryProposalBody(bodyWithout("kind_version"))).toBeNull();
  });

  it("rejects kind_version=0", () => {
    expect(parseMemoryProposalBody(bodyWith({ kind_version: 0 }))).toBeNull();
  });

  it("rejects kind_version=2 (mis-versioned)", () => {
    expect(parseMemoryProposalBody(bodyWith({ kind_version: 2 }))).toBeNull();
  });

  it("rejects kind_version='1' (string not number)", () => {
    expect(parseMemoryProposalBody(bodyWith({ kind_version: "1" }))).toBeNull();
  });
});

describe("parseMemoryProposalBody — Section 3: candidate_name (F1 symmetric trim)", () => {
  it("rejects missing candidate_name", () => {
    expect(parseMemoryProposalBody(bodyWithout("candidate_name"))).toBeNull();
  });

  it("rejects empty string candidate_name", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ candidate_name: "" })),
    ).toBeNull();
  });

  it("rejects whitespace-only candidate_name (F1 — symmetric trim)", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ candidate_name: "   \t\n  " })),
    ).toBeNull();
  });

  it("rejects non-string candidate_name", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ candidate_name: 42 })),
    ).toBeNull();
  });

  it("trims leading/trailing whitespace on output (F1 — symmetric trim)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ candidate_name: "  feedback-test-name  " }),
    );
    expect(result?.candidate_name).toBe("feedback-test-name");
  });

  it("preserves internal whitespace on output (F1 — only leading/trailing trim)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ candidate_name: "feedback name with spaces" }),
    );
    expect(result?.candidate_name).toBe("feedback name with spaces");
  });
});

describe("parseMemoryProposalBody — Section 4: memory_type", () => {
  it("rejects missing memory_type", () => {
    expect(parseMemoryProposalBody(bodyWithout("memory_type"))).toBeNull();
  });

  it("rejects invalid memory_type literal", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ memory_type: "invalid" })),
    ).toBeNull();
  });

  it("rejects non-string memory_type", () => {
    expect(parseMemoryProposalBody(bodyWith({ memory_type: 42 }))).toBeNull();
  });

  it("rejects empty string memory_type", () => {
    expect(parseMemoryProposalBody(bodyWith({ memory_type: "" }))).toBeNull();
  });
});

describe("parseMemoryProposalBody — Section 5: description (F1 symmetric trim)", () => {
  it("rejects missing description", () => {
    expect(parseMemoryProposalBody(bodyWithout("description"))).toBeNull();
  });

  it("rejects empty string description", () => {
    expect(parseMemoryProposalBody(bodyWith({ description: "" }))).toBeNull();
  });

  it("rejects whitespace-only description (F1)", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ description: "  \n\t  " })),
    ).toBeNull();
  });

  it("rejects non-string description", () => {
    expect(parseMemoryProposalBody(bodyWith({ description: 42 }))).toBeNull();
  });

  it("trims leading/trailing whitespace on output (F1)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ description: "  Short summary.  " }),
    );
    expect(result?.description).toBe("Short summary.");
  });

  it("preserves internal whitespace on output (F1 — incl. embedded newlines)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ description: "Multi-line\nsummary here." }),
    );
    expect(result?.description).toBe("Multi-line\nsummary here.");
  });
});

describe("parseMemoryProposalBody — Section 6: reason (F1 symmetric trim)", () => {
  it("rejects missing reason", () => {
    expect(parseMemoryProposalBody(bodyWithout("reason"))).toBeNull();
  });

  it("rejects empty string reason", () => {
    expect(parseMemoryProposalBody(bodyWith({ reason: "" }))).toBeNull();
  });

  it("rejects whitespace-only reason (F1)", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ reason: "  \n\t  " })),
    ).toBeNull();
  });

  it("trims leading/trailing whitespace on output (F1)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ reason: "  Why this matters.  " }),
    );
    expect(result?.reason).toBe("Why this matters.");
  });

  it("preserves internal whitespace on output (F1 — multi-paragraph)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ reason: "Para one.\n\nPara two." }),
    );
    expect(result?.reason).toBe("Para one.\n\nPara two.");
  });
});

describe("parseMemoryProposalBody — Section 7: proposed_body (F1 symmetric trim)", () => {
  it("rejects missing proposed_body", () => {
    expect(parseMemoryProposalBody(bodyWithout("proposed_body"))).toBeNull();
  });

  it("rejects empty string proposed_body", () => {
    expect(parseMemoryProposalBody(bodyWith({ proposed_body: "" }))).toBeNull();
  });

  it("rejects whitespace-only proposed_body (F1)", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ proposed_body: "  \n\t  " })),
    ).toBeNull();
  });

  it("trims leading/trailing whitespace on output (F1)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ proposed_body: "  Body text.  " }),
    );
    expect(result?.proposed_body).toBe("Body text.");
  });

  it("preserves multi-paragraph markdown body verbatim (F1 — internal preserved)", () => {
    const body =
      "**Why:** Reason A.\n\n**How to apply:** Step 1.\n- Bullet item\n- Another bullet\n\nParagraph continues.";
    const result = parseMemoryProposalBody(bodyWith({ proposed_body: body }));
    expect(result?.proposed_body).toBe(body);
  });
});

describe("parseMemoryProposalBody — Section 8: amends_existing", () => {
  it("accepts amends_existing=null (net-new proposal)", () => {
    const result = parseMemoryProposalBody(bodyWith({ amends_existing: null }));
    expect(result?.amends_existing).toBeNull();
  });

  it("accepts amends_existing=undefined (treats as null)", () => {
    const body = bodyWithout("amends_existing");
    const result = parseMemoryProposalBody(body);
    expect(result?.amends_existing).toBeNull();
  });

  it("accepts non-empty string amends_existing (amendment proposal)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ amends_existing: "feedback-existing-name" }),
    );
    expect(result?.amends_existing).toBe("feedback-existing-name");
  });

  it("rejects empty-string amends_existing", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ amends_existing: "" })),
    ).toBeNull();
  });

  it("rejects whitespace-only amends_existing (F1)", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ amends_existing: "   \t  " })),
    ).toBeNull();
  });

  it("rejects non-string non-null amends_existing", () => {
    expect(
      parseMemoryProposalBody(bodyWith({ amends_existing: 42 })),
    ).toBeNull();
  });

  it("trims leading/trailing whitespace on output (F1)", () => {
    const result = parseMemoryProposalBody(
      bodyWith({ amends_existing: "  feedback-trimmed-slug  " }),
    );
    expect(result?.amends_existing).toBe("feedback-trimmed-slug");
  });
});

describe("parseMemoryProposalBody — Section 9: forward-compat", () => {
  it("ignores extra unknown fields on outer body", () => {
    const body = bodyWith({
      extra_field: "ignored",
      linked_memories: ["[[feedback-foo]]", "[[feedback-bar]]"],
      body_ref: "deep-link-uuid",
    });
    const result = parseMemoryProposalBody(body);
    expect(result).toEqual(CANONICAL_MEMORY_PROPOSAL_BODY);
  });
});

describe("parseMemoryProposalBody — Section 10: JSON-root failures", () => {
  it("rejects malformed JSON", () => {
    expect(parseMemoryProposalBody("not-json")).toBeNull();
  });

  it("rejects empty string body", () => {
    expect(parseMemoryProposalBody("")).toBeNull();
  });

  it("rejects JSON null", () => {
    expect(parseMemoryProposalBody("null")).toBeNull();
  });

  it("rejects JSON array root", () => {
    expect(parseMemoryProposalBody("[]")).toBeNull();
  });

  it("rejects JSON number root", () => {
    expect(parseMemoryProposalBody("42")).toBeNull();
  });

  it("rejects JSON string root", () => {
    expect(parseMemoryProposalBody('"some string"')).toBeNull();
  });
});

describe("isMemoryType", () => {
  it("accepts all 4 valid MemoryType literals", () => {
    for (const t of MEMORY_TYPES) {
      expect(isMemoryType(t)).toBe(true);
    }
  });

  it("rejects invalid string", () => {
    expect(isMemoryType("invalid")).toBe(false);
  });

  it("rejects non-string", () => {
    expect(isMemoryType(42)).toBe(false);
    expect(isMemoryType(null)).toBe(false);
    expect(isMemoryType(undefined)).toBe(false);
    expect(isMemoryType({})).toBe(false);
    expect(isMemoryType([])).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isMemoryType("")).toBe(false);
  });

  it("MEMORY_TYPES tuple is 4 elements", () => {
    expect(MEMORY_TYPES.length).toBe(4);
  });
});
