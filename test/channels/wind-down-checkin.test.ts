// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tier 2 Verb 1 — `wind-down-checkin` schema parser unit tests.
 *
 * Coverage per plan v0.1 §6 (Slice 2 B1 + V2 F1 symmetric trim discipline):
 *
 *   - Section 1 (happy path): canonical body + amends/amendment-style usage
 *     + all 5 cycle_character values acceptance.
 *   - Section 2 (kind_version): only 1 accepted.
 *   - Section 3 (next_steps): min-1 required + F1 symmetric trim per entry.
 *   - Section 4 (decisions_logged): same shape as next_steps + F1 trim.
 *   - Section 5 (failed_approaches): CAN be empty + each entry F1 trim.
 *   - Section 6 (memory_candidates): same shape as failed_approaches + F1 trim.
 *   - Section 7 (cycle_character): 5 valid + invalid + non-string + missing.
 *   - Section 8 (forward-compat): permissive on extra fields.
 *   - Section 9 (JSON-root failures): malformed / empty / null / array / etc.
 *   - Section 10 (isCycleCharacter type-guard).
 */

import { describe, it, expect } from "bun:test";

import {
  parseWindDownCheckinBody,
  isCycleCharacter,
  CYCLE_CHARACTERS,
  isFirePhase,
  FIRE_PHASES,
  type WindDownCheckinBody,
  type FirePhase,
} from "../../src/channels/wind-down-checkin.ts";

const CANONICAL_WIND_DOWN_CHECKIN_BODY: WindDownCheckinBody = {
  kind_version: 1,
  next_steps: [
    "Charlie+Delta to close Slice 3 audit + squash",
    "Bravo to start Y plan v0.2 fold cycle",
  ],
  decisions_logged: [
    "Cohort A ratified as X+Y+Z 3-sub-slice cohort with split-authorship rebalance",
    "kind=audit-verdict requires target_pr — defer schema-revision to Tier-2-v2",
  ],
  failed_approaches: [
    "kind=audit-verdict for plan-level audits (target_pr requirement)",
  ],
  memory_candidates: [
    "feedback-cycle-character-rubric-as-substrate-primitive",
    "feedback-preemptive-fold-application-symmetric-trim",
  ],
  cycle_character: "COHORT-PASS",
};

function bodyWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...CANONICAL_WIND_DOWN_CHECKIN_BODY, ...overrides });
}

function bodyWithout(key: keyof WindDownCheckinBody): string {
  const obj: Record<string, unknown> = { ...CANONICAL_WIND_DOWN_CHECKIN_BODY };
  delete obj[key as string];
  return JSON.stringify(obj);
}

describe("parseWindDownCheckinBody — happy path", () => {
  it("parses canonical wind-down checkin", () => {
    const result = parseWindDownCheckinBody(
      JSON.stringify(CANONICAL_WIND_DOWN_CHECKIN_BODY),
    );
    expect(result).toEqual(CANONICAL_WIND_DOWN_CHECKIN_BODY);
  });

  it("parses all 5 cycle_character values", () => {
    for (const cycle_character of CYCLE_CHARACTERS) {
      const result = parseWindDownCheckinBody(bodyWith({ cycle_character }));
      expect(result?.cycle_character).toBe(cycle_character);
    }
  });

  it("parses with empty failed_approaches array (pristine cycle)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ failed_approaches: [], cycle_character: "PRISTINE" }),
    );
    expect(result?.failed_approaches).toEqual([]);
    expect(result?.cycle_character).toBe("PRISTINE");
  });

  it("parses with empty memory_candidates array", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ memory_candidates: [] }),
    );
    expect(result?.memory_candidates).toEqual([]);
  });

  it("parses with both empty arrays (pristine + no memorialization)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({
        failed_approaches: [],
        memory_candidates: [],
        cycle_character: "PRISTINE",
      }),
    );
    expect(result?.failed_approaches).toEqual([]);
    expect(result?.memory_candidates).toEqual([]);
  });
});

describe("parseWindDownCheckinBody — Section 2: kind_version", () => {
  it("rejects missing kind_version", () => {
    expect(parseWindDownCheckinBody(bodyWithout("kind_version"))).toBeNull();
  });

  it("rejects kind_version=0", () => {
    expect(parseWindDownCheckinBody(bodyWith({ kind_version: 0 }))).toBeNull();
  });

  it("rejects kind_version=2 (mis-versioned)", () => {
    expect(parseWindDownCheckinBody(bodyWith({ kind_version: 2 }))).toBeNull();
  });

  it("rejects kind_version='1' (string not number)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ kind_version: "1" })),
    ).toBeNull();
  });
});

describe("parseWindDownCheckinBody — Section 3: next_steps (min-1 + F1 trim)", () => {
  it("rejects missing next_steps", () => {
    expect(parseWindDownCheckinBody(bodyWithout("next_steps"))).toBeNull();
  });

  it("rejects non-array next_steps", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ next_steps: "not-an-array" })),
    ).toBeNull();
  });

  it("rejects empty next_steps array (min-1 required per Q3)", () => {
    expect(parseWindDownCheckinBody(bodyWith({ next_steps: [] }))).toBeNull();
  });

  it("rejects next_steps entry that is empty string (F1)", () => {
    expect(parseWindDownCheckinBody(bodyWith({ next_steps: [""] }))).toBeNull();
  });

  it("rejects next_steps entry that is whitespace-only (F1)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ next_steps: ["   \t\n  "] })),
    ).toBeNull();
  });

  it("rejects next_steps entry that is non-string", () => {
    expect(parseWindDownCheckinBody(bodyWith({ next_steps: [42] }))).toBeNull();
  });

  it("trims leading/trailing whitespace per entry on output (F1)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ next_steps: ["  Close Slice 3 audit  ", "  Y plan v0.2  "] }),
    );
    expect(result?.next_steps).toEqual(["Close Slice 3 audit", "Y plan v0.2"]);
  });

  it("preserves internal whitespace per entry on output (F1)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({
        next_steps: ["Step one with spaces and  multiple  whitespace"],
      }),
    );
    expect(result?.next_steps).toEqual([
      "Step one with spaces and  multiple  whitespace",
    ]);
  });
});

describe("parseWindDownCheckinBody — Section 4: decisions_logged (min-1 + F1 trim)", () => {
  it("rejects missing decisions_logged", () => {
    expect(
      parseWindDownCheckinBody(bodyWithout("decisions_logged")),
    ).toBeNull();
  });

  it("rejects empty decisions_logged array (min-1 required per Q3)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ decisions_logged: [] })),
    ).toBeNull();
  });

  it("rejects whitespace-only entry (F1)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ decisions_logged: ["  "] })),
    ).toBeNull();
  });

  it("rejects non-string entry", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ decisions_logged: [null] })),
    ).toBeNull();
  });

  it("trims leading/trailing whitespace per entry on output (F1)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ decisions_logged: ["  Cohort A locked  "] }),
    );
    expect(result?.decisions_logged).toEqual(["Cohort A locked"]);
  });
});

describe("parseWindDownCheckinBody — Section 5: failed_approaches (CAN be empty + F1 trim)", () => {
  it("rejects missing failed_approaches", () => {
    expect(
      parseWindDownCheckinBody(bodyWithout("failed_approaches")),
    ).toBeNull();
  });

  it("rejects non-array failed_approaches", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ failed_approaches: null })),
    ).toBeNull();
  });

  it("accepts empty failed_approaches array (pristine cycle)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ failed_approaches: [] }),
    );
    expect(result?.failed_approaches).toEqual([]);
  });

  it("rejects empty-string entry (F1)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ failed_approaches: [""] })),
    ).toBeNull();
  });

  it("rejects whitespace-only entry (F1)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ failed_approaches: ["   "] })),
    ).toBeNull();
  });

  it("trims leading/trailing whitespace per entry on output (F1)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ failed_approaches: ["  tried plan-mode-skip  "] }),
    );
    expect(result?.failed_approaches).toEqual(["tried plan-mode-skip"]);
  });
});

describe("parseWindDownCheckinBody — Section 6: memory_candidates (CAN be empty + F1 trim)", () => {
  it("rejects missing memory_candidates", () => {
    expect(
      parseWindDownCheckinBody(bodyWithout("memory_candidates")),
    ).toBeNull();
  });

  it("rejects non-array memory_candidates", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ memory_candidates: 42 })),
    ).toBeNull();
  });

  it("accepts empty memory_candidates array", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ memory_candidates: [] }),
    );
    expect(result?.memory_candidates).toEqual([]);
  });

  it("rejects whitespace-only slug entry (F1)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ memory_candidates: ["   "] })),
    ).toBeNull();
  });

  it("trims leading/trailing whitespace per entry on output (F1)", () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ memory_candidates: ["  feedback-test-slug  "] }),
    );
    expect(result?.memory_candidates).toEqual(["feedback-test-slug"]);
  });
});

describe("parseWindDownCheckinBody — Section 7: cycle_character", () => {
  it("rejects missing cycle_character", () => {
    expect(parseWindDownCheckinBody(bodyWithout("cycle_character"))).toBeNull();
  });

  it("rejects invalid cycle_character literal", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ cycle_character: "GREAT" })),
    ).toBeNull();
  });

  it("rejects empty-string cycle_character", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ cycle_character: "" })),
    ).toBeNull();
  });

  it("rejects non-string cycle_character", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ cycle_character: 42 })),
    ).toBeNull();
  });

  it("rejects lowercase variant (case-sensitive enum)", () => {
    expect(
      parseWindDownCheckinBody(bodyWith({ cycle_character: "pristine" })),
    ).toBeNull();
  });
});

describe("parseWindDownCheckinBody — Section 8: forward-compat", () => {
  it("ignores extra unknown fields on outer body", () => {
    const body = bodyWith({
      extra_field: "ignored",
      cycle_id: "2026-05-20",
      nick_intervention_count: 0,
    });
    const result = parseWindDownCheckinBody(body);
    expect(result).toEqual(CANONICAL_WIND_DOWN_CHECKIN_BODY);
  });
});

describe("parseWindDownCheckinBody — Section 9: JSON-root failures", () => {
  it("rejects malformed JSON", () => {
    expect(parseWindDownCheckinBody("not-json")).toBeNull();
  });

  it("rejects empty string body", () => {
    expect(parseWindDownCheckinBody("")).toBeNull();
  });

  it("rejects JSON null", () => {
    expect(parseWindDownCheckinBody("null")).toBeNull();
  });

  it("rejects JSON array root", () => {
    expect(parseWindDownCheckinBody("[]")).toBeNull();
  });

  it("rejects JSON number root", () => {
    expect(parseWindDownCheckinBody("42")).toBeNull();
  });

  it("rejects JSON string root", () => {
    expect(parseWindDownCheckinBody('"some string"')).toBeNull();
  });
});

describe("isCycleCharacter", () => {
  it("accepts all 5 valid CycleCharacter literals", () => {
    for (const c of CYCLE_CHARACTERS) {
      expect(isCycleCharacter(c)).toBe(true);
    }
  });

  it("rejects invalid string literals", () => {
    expect(isCycleCharacter("invalid")).toBe(false);
    expect(isCycleCharacter("pristine")).toBe(false);
    expect(isCycleCharacter("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isCycleCharacter(42)).toBe(false);
    expect(isCycleCharacter(null)).toBe(false);
    expect(isCycleCharacter(undefined)).toBe(false);
    expect(isCycleCharacter({})).toBe(false);
  });
});

// ─── Section 10: fire_phase additive field (W1b L113) ─────────────────────
// T1–T6 per spec §3 (l113-w1b-spec-2026-06-12.md).
// Base fixture = CANONICAL_WIND_DOWN_CHECKIN_BODY (min next_steps +
// decisions_logged + cycle_character — all required fields present).

describe("parseWindDownCheckinBody — Section 10: fire_phase (T1-T6)", () => {
  // T1 (back-compat): existing v1 bodies without fire_phase parse unchanged.
  it("T1: absent fire_phase → parses non-null; result has no fire_phase key", () => {
    const result = parseWindDownCheckinBody(
      JSON.stringify(CANONICAL_WIND_DOWN_CHECKIN_BODY),
    );
    expect(result).not.toBeNull();
    expect(result?.fire_phase).toBeUndefined();
  });

  // T2: present + "mid" accepted.
  it('T2: fire_phase "mid" → result.fire_phase === "mid"', () => {
    const result = parseWindDownCheckinBody(bodyWith({ fire_phase: "mid" }));
    expect(result?.fire_phase).toBe("mid");
  });

  // T3: present + "terminal" accepted.
  it('T3: fire_phase "terminal" → result.fire_phase === "terminal"', () => {
    const result = parseWindDownCheckinBody(
      bodyWith({ fire_phase: "terminal" }),
    );
    expect(result?.fire_phase).toBe("terminal");
  });

  // T4 (present-invalid reject, spec 1c): present + invalid → null (whole body rejected).
  // T6 REVERT-PROOF comment: temporarily neutering the
  //   `if (!isFirePhase(firePhaseRaw)) return null`
  // line in parseWindDownCheckinBody must turn EACH case below from null → non-null.
  // The lens runs this revert in an isolated worktree; canonical untouched.
  it("T4: present-invalid fire_phase rejects whole body (case-sensitive, type-strict)", () => {
    const invalids = ["MID", "Terminal", "done", "paused", 1, null, []];
    for (const fire_phase of invalids) {
      expect(
        parseWindDownCheckinBody(bodyWith({ fire_phase })),
        `expected null for fire_phase=${JSON.stringify(fire_phase)}`,
      ).toBeNull();
    }
  });

  // T5 (NON-VACUITY #1 — M2 guard, load-bearing):
  // The parser MUST NOT synthesize a terminal default.
  // REVERT-PROOF: if a builder adds `fire_phase: obj["fire_phase"] ?? "terminal"`
  // (the unsafe default), THIS test REDS.
  it("T5 (non-vacuity): absent fire_phase => undefined, NOT 'terminal'", () => {
    const result = parseWindDownCheckinBody(
      JSON.stringify(CANONICAL_WIND_DOWN_CHECKIN_BODY),
    );
    expect(result?.fire_phase).toBeUndefined();
    // Explicit negative: must NOT be "terminal"
    expect(result?.fire_phase).not.toBe("terminal" as FirePhase);
  });
});

describe("isFirePhase", () => {
  it("accepts both valid FirePhase literals", () => {
    for (const p of FIRE_PHASES) {
      expect(isFirePhase(p)).toBe(true);
    }
  });

  it("rejects invalid string literals (case-sensitive)", () => {
    expect(isFirePhase("MID")).toBe(false);
    expect(isFirePhase("Terminal")).toBe(false);
    expect(isFirePhase("done")).toBe(false);
    expect(isFirePhase("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isFirePhase(1)).toBe(false);
    expect(isFirePhase(null)).toBe(false);
    expect(isFirePhase(undefined)).toBe(false);
    expect(isFirePhase([])).toBe(false);
  });
});
