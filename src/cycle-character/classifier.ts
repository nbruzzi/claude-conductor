// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Cycle-character classifier (Tier 3-F) — pure logic layer.
 *
 * Reads a handoff body, applies a classification rubric, and returns
 * a `CycleClassification` describing the cycle's character. Reuses
 * `CycleCharacter` enum from V1 wind-down-checkin schema (SSOT).
 *
 * Plan: slice-T3F-cycle-character-classifier-2026-05-20.md v0.1.
 */

import {
  CYCLE_CHARACTERS,
  isCycleCharacter,
  type CycleCharacter,
} from "../channels/wind-down-checkin.ts";

export type CycleClassification = {
  /** Final class — prefers self-declared when present; else rubric. */
  class: CycleCharacter;
  /** Confidence level reflecting self/rubric alignment + signal strength. */
  confidence: "high" | "medium" | "low";
  /** Whether the final class came from author self-declaration or rubric derivation. */
  source: "self-declared" | "derived";
  /** Human-readable signal list (sorted ASC; F2 deterministic order). */
  signals: readonly string[];
  /** Author self-declared class in §Cycle character section; null if missing/unrecognized. */
  self_declared_class: CycleCharacter | null;
  /** Rubric-derived class; always present so operator can cross-check. */
  rubric_class: CycleCharacter;
};

/**
 * Extract a markdown section by header. Returns the section body (text
 * between the matching `## Header` line and the next `## ` line or EOF).
 * Matches case-insensitive to tolerate author casing drift (F1).
 */
function extractSection(body: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}.*$`, "im");
  const startMatch = re.exec(body);
  if (startMatch === null) return "";
  const startIdx = startMatch.index + startMatch[0].length;
  const slice = body.slice(startIdx);
  const nextHeader = /^##\s+/m;
  const endMatch = nextHeader.exec(slice);
  return endMatch === null ? slice : slice.slice(0, endMatch.index);
}

/**
 * Search a section for the first explicit CycleCharacter class name.
 * Case-insensitive (F1). Returns the class or null.
 */
function findExplicitClass(text: string): CycleCharacter | null {
  const upper = text.toUpperCase();
  for (const cls of CYCLE_CHARACTERS) {
    if (upper.includes(cls)) {
      if (isCycleCharacter(cls)) return cls;
    }
  }
  return null;
}

/** Count the number of `- ` list items in a section. */
function countListEntries(text: string): number {
  return text.split("\n").filter((l) => /^\s*-\s+/.test(l)).length;
}

function rubricClassify(body: string): {
  class: CycleCharacter;
  signals: string[];
} {
  const signals: string[] = [];
  const nextSteps = extractSection(body, "Next Steps");
  const summary = extractSection(body, "Summary");
  const currentState = extractSection(body, "Current State");
  const reciprocation = extractSection(body, "Reciprocation ledger");
  const failedApproaches = extractSection(body, "Failed Approaches");
  const auditsDelivered = extractSection(body, "Audits delivered");

  const stalledKeywords =
    /\b(incomplete|stalled|carry-forward|blocked|unfinished)\b/i;
  if (stalledKeywords.test(nextSteps)) {
    signals.push("§Next Steps mentions stalled-class keyword");
    return { class: "STALLED", signals };
  }

  const incidentKeywords = /\b(incident|outage|security breach|p0)\b/i;
  if (incidentKeywords.test(summary) || incidentKeywords.test(currentState)) {
    signals.push("§Summary or §Current State mentions incident-class keyword");
    return { class: "INCIDENT-DRIVEN", signals };
  }

  const arrowMatches = reciprocation.match(/\b\w+\s*[→]\s*\w+\b/g) ?? [];
  const distinctArrows = new Set(arrowMatches);
  if (distinctArrows.size >= 3) {
    signals.push(
      `§Reciprocation ledger has ${distinctArrows.size} directional pairs`,
    );
    return { class: "COHORT-PASS", signals };
  }

  const failedEntries = countListEntries(failedApproaches);
  const needsReworkRegex = /\bNEEDS-REWORK\b/i;
  const recoveredKeywords = /\b(recovered|hotfix|rework cycle)\b/i;
  if (failedEntries >= 2) {
    signals.push(`§Failed Approaches has ${failedEntries} entries`);
    return { class: "RECOVERED", signals };
  }
  if (needsReworkRegex.test(auditsDelivered)) {
    signals.push("§Audits delivered table contains NEEDS-REWORK");
    return { class: "RECOVERED", signals };
  }
  if (recoveredKeywords.test(summary)) {
    signals.push("§Summary mentions recovered-class keyword");
    return { class: "RECOVERED", signals };
  }

  signals.push("no rework / cohort / incident signals detected");
  return { class: "PRISTINE", signals };
}

/**
 * Classify a handoff body. Reads §Cycle character section for explicit
 * self-declaration; applies rubric for derived class; combines into
 * a confidence-graded `CycleClassification`.
 *
 * F2: signals[] sorted ASC for diff-friendly output.
 */
export function classifyHandoff(body: string): CycleClassification {
  const cycleCharSection = extractSection(body, "Cycle character");
  const selfDeclared = findExplicitClass(cycleCharSection);
  const rubric = rubricClassify(body);

  const signals = [...rubric.signals];
  if (selfDeclared !== null) {
    signals.push(`§Cycle character section self-declares ${selfDeclared}`);
  } else if (cycleCharSection.length === 0) {
    signals.push("no §Cycle character section present");
  } else {
    signals.push(
      "§Cycle character section present but no explicit class found",
    );
  }
  signals.sort();

  let final_class: CycleCharacter;
  let source: "self-declared" | "derived";
  let confidence: "high" | "medium" | "low";

  if (selfDeclared !== null) {
    final_class = selfDeclared;
    source = "self-declared";
    confidence = selfDeclared === rubric.class ? "high" : "medium";
  } else {
    final_class = rubric.class;
    source = "derived";
    confidence = rubric.class === "PRISTINE" ? "low" : "medium";
  }

  return {
    class: final_class,
    confidence,
    source,
    signals,
    self_declared_class: selfDeclared,
    rubric_class: rubric.class,
  };
}
