// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Tests for the `poll` message kind's shared parser (`parsePollBody`).
 *
 * Coverage by section:
 *   1. Happy path (canonical body parses; options + flags preserved)
 *   2. kind_version (missing / wrong / non-numeric)
 *   3. question (missing / empty / whitespace / non-string / trim-on-output)
 *   4. options (missing / non-array / <2 / option-shape / empty id|label /
 *      dup id / non-string description / trim-on-output)
 *   5. multi_select + free_text (defaults / accept / type-guard)
 *   6. Forward-compat (extra unknown fields ignored)
 *   7. JSON-root failures (invalid JSON / non-object / array / null root)
 *
 * Plan: `~/.claude/plans/cycle-6-item-2-poll-kind-slice-plan-2026-05-29.md`.
 */

import { describe, expect, it } from "bun:test";

import { parsePollBody, type PollBody } from "../../src/channels/poll.ts";

/** Canonical reference body — the happy-path subject + negative-case base. */
const CANONICAL_POLL_BODY: PollBody = {
  kind_version: 1,
  question: "Which lane should Pair A take this cycle?",
  options: [
    { id: "cycle-6", label: "Cycle 6 sundry-P1" },
    {
      id: "cycle-4",
      label: "Cycle 4 identity/auth",
      description: "depends on Cycle 1 key mgmt; partially subsumed",
    },
  ],
  multi_select: false,
  free_text: false,
};

/** JSON body from the canonical with field overrides spread on top. */
function bodyWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...CANONICAL_POLL_BODY, ...overrides });
}

/** JSON body from the canonical with a single field omitted. */
function bodyWithout(field: keyof PollBody): string {
  const copy: Record<string, unknown> = { ...CANONICAL_POLL_BODY };
  delete copy[field];
  return JSON.stringify(copy);
}

describe("parsePollBody", () => {
  describe("1. happy path", () => {
    it("parses a canonical body", () => {
      const parsed = parsePollBody(JSON.stringify(CANONICAL_POLL_BODY));
      expect(parsed).not.toBeNull();
      expect(parsed?.kind_version).toBe(1);
      expect(parsed?.question).toBe(
        "Which lane should Pair A take this cycle?",
      );
      expect(parsed?.options).toHaveLength(2);
      expect(parsed?.options[0]?.id).toBe("cycle-6");
      expect(parsed?.options[0]?.label).toBe("Cycle 6 sundry-P1");
      expect(parsed?.multi_select).toBe(false);
      expect(parsed?.free_text).toBe(false);
    });

    it("preserves an option description", () => {
      const parsed = parsePollBody(JSON.stringify(CANONICAL_POLL_BODY));
      expect(parsed?.options[1]?.description).toBe(
        "depends on Cycle 1 key mgmt; partially subsumed",
      );
    });

    it("omits description when not provided", () => {
      const parsed = parsePollBody(JSON.stringify(CANONICAL_POLL_BODY));
      expect(parsed?.options[0]?.description).toBeUndefined();
    });
  });

  describe("2. kind_version", () => {
    it("rejects missing kind_version", () => {
      expect(parsePollBody(bodyWithout("kind_version"))).toBeNull();
    });
    it("rejects a wrong kind_version", () => {
      expect(parsePollBody(bodyWith({ kind_version: 2 }))).toBeNull();
    });
    it("rejects a non-numeric kind_version", () => {
      expect(parsePollBody(bodyWith({ kind_version: "1" }))).toBeNull();
    });
  });

  describe("3. question", () => {
    it("rejects missing question", () => {
      expect(parsePollBody(bodyWithout("question"))).toBeNull();
    });
    it("rejects an empty question", () => {
      expect(parsePollBody(bodyWith({ question: "" }))).toBeNull();
    });
    it("rejects a whitespace-only question", () => {
      expect(parsePollBody(bodyWith({ question: "   " }))).toBeNull();
    });
    it("rejects a non-string question", () => {
      expect(parsePollBody(bodyWith({ question: 42 }))).toBeNull();
    });
    it("trims question on output", () => {
      expect(
        parsePollBody(bodyWith({ question: "  pick one  " }))?.question,
      ).toBe("pick one");
    });
  });

  describe("4. options", () => {
    it("rejects missing options", () => {
      expect(parsePollBody(bodyWithout("options"))).toBeNull();
    });
    it("rejects non-array options", () => {
      expect(parsePollBody(bodyWith({ options: "a,b" }))).toBeNull();
    });
    it("rejects fewer than 2 options", () => {
      expect(
        parsePollBody(bodyWith({ options: [{ id: "a", label: "A" }] })),
      ).toBeNull();
    });
    it("rejects an option missing id", () => {
      expect(
        parsePollBody(
          bodyWith({ options: [{ label: "A" }, { id: "b", label: "B" }] }),
        ),
      ).toBeNull();
    });
    it("rejects an option with a whitespace-only id", () => {
      expect(
        parsePollBody(
          bodyWith({
            options: [
              { id: " ", label: "A" },
              { id: "b", label: "B" },
            ],
          }),
        ),
      ).toBeNull();
    });
    it("rejects an option with an empty label", () => {
      expect(
        parsePollBody(
          bodyWith({
            options: [
              { id: "a", label: "" },
              { id: "b", label: "B" },
            ],
          }),
        ),
      ).toBeNull();
    });
    it("rejects duplicate option ids (post-trim)", () => {
      expect(
        parsePollBody(
          bodyWith({
            options: [
              { id: "a", label: "A" },
              { id: " a ", label: "B" },
            ],
          }),
        ),
      ).toBeNull();
    });
    it("rejects a non-object option", () => {
      expect(
        parsePollBody(bodyWith({ options: ["a", { id: "b", label: "B" }] })),
      ).toBeNull();
    });
    it("rejects a null option", () => {
      expect(
        parsePollBody(bodyWith({ options: [null, { id: "b", label: "B" }] })),
      ).toBeNull();
    });
    it("rejects a non-string option description", () => {
      expect(
        parsePollBody(
          bodyWith({
            options: [
              { id: "a", label: "A", description: 5 },
              { id: "b", label: "B" },
            ],
          }),
        ),
      ).toBeNull();
    });
    it("trims option id and label on output", () => {
      const parsed = parsePollBody(
        bodyWith({
          options: [
            { id: " a ", label: " A " },
            { id: "b", label: "B" },
          ],
        }),
      );
      expect(parsed?.options[0]?.id).toBe("a");
      expect(parsed?.options[0]?.label).toBe("A");
    });
  });

  describe("5. multi_select + free_text", () => {
    it("defaults multi_select to false when absent", () => {
      expect(parsePollBody(bodyWithout("multi_select"))?.multi_select).toBe(
        false,
      );
    });
    it("defaults free_text to false when absent", () => {
      expect(parsePollBody(bodyWithout("free_text"))?.free_text).toBe(false);
    });
    it("accepts multi_select true", () => {
      expect(
        parsePollBody(bodyWith({ multi_select: true }))?.multi_select,
      ).toBe(true);
    });
    it("accepts free_text true", () => {
      expect(parsePollBody(bodyWith({ free_text: true }))?.free_text).toBe(
        true,
      );
    });
    it("rejects a non-boolean multi_select", () => {
      expect(parsePollBody(bodyWith({ multi_select: "yes" }))).toBeNull();
    });
    it("rejects a non-boolean free_text", () => {
      expect(parsePollBody(bodyWith({ free_text: 1 }))).toBeNull();
    });
  });

  describe("6. forward-compat", () => {
    it("ignores extra unknown fields", () => {
      const parsed = parsePollBody(bodyWith({ extra: "x", another: 99 }));
      expect(parsed).not.toBeNull();
      expect(parsed?.question).toBe(
        "Which lane should Pair A take this cycle?",
      );
    });
  });

  describe("7. JSON-root failures", () => {
    it("rejects invalid JSON", () => {
      expect(parsePollBody("{not json")).toBeNull();
    });
    it("rejects a non-object root", () => {
      expect(parsePollBody("42")).toBeNull();
    });
    it("rejects an array root", () => {
      expect(parsePollBody("[]")).toBeNull();
    });
    it("rejects a null root", () => {
      expect(parsePollBody("null")).toBeNull();
    });
  });
});
