// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for the cycle-character classifier (Tier 3-F).
 *
 * Coverage per plan §8:
 *   - empty handoff → low-confidence PRISTINE default
 *   - self-declared PRISTINE + no rework signals → high-confidence PRISTINE
 *   - self-declared PRISTINE + NEEDS-REWORK in audits → medium-confidence (disagree)
 *   - self-declared COHORT-PASS + multi-pair reciprocation → high-confidence COHORT-PASS
 *   - no self-declared + 4 §Failed Approaches → medium-confidence RECOVERED
 *   - §Summary "incident" + recovered language → INCIDENT-DRIVEN (priority D5)
 *   - §Next Steps "carry-forward" → STALLED
 *
 * Plan: slice-T3F-cycle-character-classifier-2026-05-20.md v0.1.
 */

import { describe, expect, it } from "bun:test";

import { classifyHandoff } from "../../src/cycle-character/classifier.ts";

describe("classifyHandoff", () => {
  it("empty handoff → low-confidence PRISTINE default", () => {
    const result = classifyHandoff("");
    expect(result.class).toBe("PRISTINE");
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("derived");
    expect(result.self_declared_class).toBeNull();
  });

  it("self-declared PRISTINE + no rework signals → high-confidence PRISTINE", () => {
    const body = `# Handoff
## Summary
Clean cycle.

## Failed Approaches
(none)

## Cycle character
PRISTINE — no rework cycles encountered.
`;
    const result = classifyHandoff(body);
    expect(result.class).toBe("PRISTINE");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("self-declared");
    expect(result.self_declared_class).toBe("PRISTINE");
    expect(result.rubric_class).toBe("PRISTINE");
  });

  it("self-declared PRISTINE + NEEDS-REWORK in audits → medium-confidence (disagree)", () => {
    const body = `## Summary
Mostly clean cycle.

## Audits delivered

| When  | Verdict        |
| ----- | -------------- |
| 13:00 | NEEDS-REWORK   |

## Cycle character
PRISTINE
`;
    const result = classifyHandoff(body);
    expect(result.class).toBe("PRISTINE");
    expect(result.source).toBe("self-declared");
    expect(result.confidence).toBe("medium");
    expect(result.rubric_class).toBe("RECOVERED");
  });

  it("self-declared COHORT-PASS + multi-pair reciprocation → high-confidence COHORT-PASS", () => {
    const body = `## Reciprocation ledger

Bravo→Alpha: 4
Alpha→Bravo: 2
Charlie→Delta: 3
Delta→Charlie: 1

## Cycle character
COHORT-PASS
`;
    const result = classifyHandoff(body);
    expect(result.class).toBe("COHORT-PASS");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("self-declared");
    expect(result.rubric_class).toBe("COHORT-PASS");
  });

  it("no self-declared + 4 §Failed Approaches → medium-confidence RECOVERED", () => {
    const body = `## Failed Approaches

- Tried foo, failed
- Tried bar, failed
- Tried baz, failed
- Tried qux, failed
`;
    const result = classifyHandoff(body);
    expect(result.class).toBe("RECOVERED");
    expect(result.confidence).toBe("medium");
    expect(result.source).toBe("derived");
    expect(result.self_declared_class).toBeNull();
  });

  it("incident in §Summary outranks recovered language (priority D5)", () => {
    const body = `## Summary
Incident-driven cycle: hotfix recovered the outage.

## Failed Approaches
- Initial debug path
- Workaround attempt
`;
    const result = classifyHandoff(body);
    expect(result.class).toBe("INCIDENT-DRIVEN");
    expect(result.rubric_class).toBe("INCIDENT-DRIVEN");
  });

  it("§Next Steps 'carry-forward' → STALLED", () => {
    const body = `## Next Steps

- Work carry-forward to next cycle (incomplete)
`;
    const result = classifyHandoff(body);
    expect(result.class).toBe("STALLED");
    expect(result.rubric_class).toBe("STALLED");
  });

  it("signals are sorted ASC (F2 deterministic order)", () => {
    const body = `## Cycle character
PRISTINE
`;
    const result = classifyHandoff(body);
    const sorted = [...result.signals].sort();
    expect(result.signals).toEqual(sorted);
  });
});
