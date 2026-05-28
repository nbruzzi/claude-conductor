// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Slice 6 render tests — 7-cell display matrix + 2 soft-wrap scenarios +
 * warn-once dedup, per plan vivid-seeking-crayon §Slice 6 / §197.
 *
 * Cells 1-6 are pure-format assertions on `renderMessage`. Cell 7 (the
 * malformed path) is split into two sub-scenarios — missing-body and
 * both-body-and-body_ref — each with a separate warn-once key, exercised
 * together by the warn-once dedup test.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { ChannelMessage } from "../../src/channels/index.ts";
import { INTERNAL, renderMessage } from "../../src/channels/render.ts";
import {
  wrapAuditVerdictBody,
  type AuditVerdictBody,
} from "../../src/channels/audit-verdict.ts";
import { generateKeypair } from "../../src/channels/key-surface.ts";

const TS = "2026-04-29T12:00:00.000Z";
const FROM = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  // Reset warn-once dedup state before each test so tests run in
  // isolation (the Set is module-level and otherwise persists across
  // tests in the same process).
  INTERNAL.resetWarnedKeys();
});

afterEach(() => {
  INTERNAL.resetWarnedKeys();
});

describe("renderMessage — 7-cell matrix", () => {
  it("Cell 1: identity + role + body inline → '[ts] <identity> (<role>): <body>'", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      identity: "Alpha",
      role: "queue",
      body: "hello world",
    };
    expect(renderMessage(msg)).toBe(`[${TS}] Alpha (queue): hello world`);
  });

  it("Cell 2: identity + role + body_ref → '[ts] <identity> (<role>) [body-ref:<ref>]'", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "note",
      identity: "Bravo",
      role: "pen",
      body_ref: "ref-abc-123",
    };
    expect(renderMessage(msg)).toBe(
      `[${TS}] Bravo (pen) [body-ref:ref-abc-123]`,
    );
  });

  it("Cell 3: identity, no role + body inline → '[ts] <identity>: <body>'", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      identity: "Charlie",
      body: "no role attached",
    };
    expect(renderMessage(msg)).toBe(`[${TS}] Charlie: no role attached`);
  });

  it("Cell 4: identity, no role + body_ref → '[ts] <identity> [body-ref:<ref>]'", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "note",
      identity: "Delta",
      body_ref: "ref-xyz",
    };
    expect(renderMessage(msg)).toBe(`[${TS}] Delta [body-ref:ref-xyz]`);
  });

  it("Cell 5: legacy (no identity) + body inline → '[ts] <unknown>: <body>'", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      body: "legacy-message before Phase 1",
    };
    expect(renderMessage(msg)).toBe(
      `[${TS}] <unknown>: legacy-message before Phase 1`,
    );
  });

  it("Cell 6: legacy + body_ref → '[ts] <unknown> [body-ref:<ref>]'", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "handoff",
      body_ref: "ref-legacy-large",
    };
    expect(renderMessage(msg)).toBe(
      `[${TS}] <unknown> [body-ref:ref-legacy-large]`,
    );
  });

  it("Cell 7: malformed (neither body nor body_ref) → '<malformed: missing-body>' + warns", () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      const msg: ChannelMessage = {
        ts: TS,
        from: FROM,
        kind: "status",
        identity: "Echo",
        role: "out",
      };
      const rendered = renderMessage(msg);
      expect(rendered).toBe(`[${TS}] Echo (out): <malformed: missing-body>`);
      // Warning fires for missing-body key.
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const firstCall = consoleErrorSpy.mock.calls[0]?.[0];
      expect(typeof firstCall).toBe("string");
      expect(firstCall as string).toContain("neither body nor body_ref");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("renderMessage — 2 soft-wrap scenarios", () => {
  it("Scenario A: literal newlines in body → continuation indent on each line", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      identity: "Foxtrot",
      role: "pen",
      body: "first line\nsecond line\nthird line",
    };
    // Each \n becomes \n + two-space continuation indent so the body
    // visually associates with the speaker label across lines.
    expect(renderMessage(msg)).toBe(
      `[${TS}] Foxtrot (pen): first line\n  second line\n  third line`,
    );
  });

  it("Scenario B: long body without newlines → no auto-wrap (terminal handles)", () => {
    const longBody = "x".repeat(500);
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      identity: "Golf",
      role: "queue",
      body: longBody,
    };
    // 500 chars with zero \n characters in output (renderer is content-
    // shape-aware, not column-width-aware — terminal handles soft-wrap
    // based on column count).
    const rendered = renderMessage(msg);
    expect(rendered).toBe(`[${TS}] Golf (queue): ${longBody}`);
    // Sanity: zero line breaks were inserted.
    const lineBreakCount = (rendered.match(/\n/gu) ?? []).length;
    expect(lineBreakCount).toBe(0);
  });
});

describe("renderMessage — Slice 7 branch coverage gate", () => {
  // Per plan vivid-seeking-crayon §212 — 95% branch coverage on render.ts.
  // Existing 7-cell + 2-soft-wrap + warn-once tests already hit 100%
  // line + function coverage; these additions close the residual branch
  // gaps: suppressTimestamp option + Cell 7 both-body-and-body_ref
  // explicit render output assertion.

  it("suppressTimestamp: true omits the [ts] prefix", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      identity: "Lima",
      role: "queue",
      body: "no-prefix-please",
    };
    expect(renderMessage(msg, { suppressTimestamp: true })).toBe(
      "Lima (queue): no-prefix-please",
    );
  });

  it("suppressTimestamp: false explicitly is equivalent to default", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      identity: "Mike",
      role: "pen",
      body: "default-prefix",
    };
    expect(renderMessage(msg, { suppressTimestamp: false })).toBe(
      `[${TS}] Mike (pen): default-prefix`,
    );
  });

  it("Cell 7b: both body AND body_ref → renders inline body + warns 'both' key", () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      const msg: ChannelMessage = {
        ts: TS,
        from: FROM,
        kind: "status",
        identity: "November",
        role: "queue",
        body: "salvageable inline body",
        body_ref: "ref-shouldnt-be-here",
      };
      // Cell 7b: schema violation. Salvage by rendering the inline
      // body (cheaper-to-display path); body_ref ignored.
      const rendered = renderMessage(msg);
      expect(rendered).toBe(
        `[${TS}] November (queue): salvageable inline body`,
      );
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const warning = consoleErrorSpy.mock.calls[0]?.[0];
      expect(typeof warning).toBe("string");
      expect(warning as string).toContain("both body AND body_ref");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("Cell 7a + 7b warnings use distinct keys (cross-key independence)", () => {
    // Already covered indirectly by warn-once dedup test, but this is
    // the explicit assertion that the keys 'missing-body' and
    // 'both-body-and-body-ref' are independent in the warnedKeys Set —
    // the rendering branch in render.ts uses different `warnOnce(key, …)`
    // arguments for each subcase.
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      const missingBody: ChannelMessage = {
        ts: TS,
        from: FROM,
        kind: "status",
        identity: "Oscar",
      };
      const bothBody: ChannelMessage = {
        ts: TS,
        from: FROM,
        kind: "status",
        identity: "Papa",
        body: "x",
        body_ref: "ref",
      };
      renderMessage(missingBody);
      renderMessage(bothBody);
      // Two distinct keys → two distinct warnings.
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      // Repeating either key does not re-fire.
      renderMessage(missingBody);
      renderMessage(bothBody);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("renderMessage — warn-once dedup", () => {
  it("multiple messages with same malformed key emit console.error exactly once", () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      // Three messages, all hitting the missing-body key.
      const messages: ChannelMessage[] = [
        { ts: TS, from: FROM, kind: "status", identity: "Hotel" },
        { ts: TS, from: FROM, kind: "status", identity: "India" },
        { ts: TS, from: FROM, kind: "status", identity: "Juliet" },
      ];
      for (const m of messages) {
        renderMessage(m);
      }
      // Each message renders + emits the malformed marker, but
      // console.error fires ONCE (first occurrence) thanks to
      // warn-once dedup keyed by the reason string.
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

      // Distinct reason key (both-body-and-body_ref) gets its OWN
      // separate warn-once allotment — verifies the dedup is per-key,
      // not global.
      const dualMsg: ChannelMessage = {
        ts: TS,
        from: FROM,
        kind: "status",
        identity: "Kilo",
        body: "inline",
        body_ref: "ref-dup",
      };
      renderMessage(dualMsg);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);

      // Re-rendering ANY of the keys does NOT fire again.
      renderMessage(dualMsg);
      renderMessage(messages[0] as ChannelMessage);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

const SAMPLE_VERDICT: AuditVerdictBody = {
  kind_version: 1,
  target_pr: { repo: "claude-conductor", number: 165 },
  target_peer: "Charlie",
  lens_set_applied: ["Contract", "Architecture"],
  audit_class: "cross-pair-shadow",
  audit_axes: ["depth"],
  verdict: "SHIP-CLEAN",
  counts: { blocker: 0, fold: 0, nit: 0 },
  three_option_ask: {
    a_ratify: "ship",
    b_fold_if_applicable: null,
    c_reframe_if_applicable: null,
  },
  findings: [],
};

describe("renderMessage — audit-verdict readability", () => {
  it("renders a readable summary for a RAW audit-verdict body (not raw JSON)", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "audit-verdict",
      identity: "Alpha",
      role: "pen",
      body: JSON.stringify(SAMPLE_VERDICT),
    };
    const out = renderMessage(msg);
    expect(out).toContain("audit-verdict SHIP-CLEAN PR#165 → Charlie");
    expect(out).toContain("B0/F0/N0");
    expect(out).toContain("lenses=Contract+Architecture");
    expect(out).toContain("(raw)");
    expect(out).not.toContain("kind_version");
  });

  it("decodes a DSSE-wrapped (signed) verdict into the same readable summary", async () => {
    const kp = await generateKeypair();
    const wrapped = await wrapAuditVerdictBody(
      SAMPLE_VERDICT,
      kp.privateKey,
      "alpha",
    );
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "audit-verdict",
      identity: "Alpha",
      role: "pen",
      body: wrapped,
    };
    const out = renderMessage(msg);
    expect(out).toContain("audit-verdict SHIP-CLEAN PR#165 → Charlie");
    expect(out).toContain("(signed)");
    expect(out).not.toContain("payloadType");
  });

  it("falls back to the plain body for an undecodable audit-verdict body", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "audit-verdict",
      identity: "Alpha",
      body: "not a verdict at all",
    };
    expect(renderMessage(msg)).toBe(`[${TS}] Alpha: not a verdict at all`);
  });

  it("does NOT summary-decode a verdict body sent under a non-audit-verdict kind", () => {
    const msg: ChannelMessage = {
      ts: TS,
      from: FROM,
      kind: "status",
      identity: "Alpha",
      body: JSON.stringify(SAMPLE_VERDICT),
    };
    // kind gates the decode → rendered as the plain body (raw JSON visible).
    expect(renderMessage(msg)).toContain("kind_version");
  });
});
