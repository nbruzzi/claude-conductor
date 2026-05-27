// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for `lineage-envelope.ts` (Cycle 1 substrate-extension
 * PR-A1). Covers parser shape contract (strict-required + permissive-
 * extras + optional-field tolerance + version-skip + type-rejects),
 * type guard, constructor defaults, and lineageVerify Cycle 1 stub.
 *
 * Plan: ~/.claude/plans/cycle-1-substrate-extension-slice-plan-2026-05-26.md
 * §1.1 + §2.5 + §3.1.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  createLineageEnvelope,
  isLineageEnvelope,
  lineageVerify,
  parseLineageEnvelope,
  type LineageEnvelope,
  type TokenCost,
} from "../../src/channels/lineage-envelope.ts";

const VALID_MINIMAL: LineageEnvelope = {
  kind_version: 1,
  producer_session_id: "session-abc",
  input_body_refs: ["body-ref-1"],
};

describe("parseLineageEnvelope — happy path", () => {
  it("parses minimal valid envelope from object", () => {
    const out = parseLineageEnvelope(VALID_MINIMAL);
    expect(out).toEqual(VALID_MINIMAL);
  });

  it("parses minimal valid envelope from JSON string", () => {
    const out = parseLineageEnvelope(JSON.stringify(VALID_MINIMAL));
    expect(out).toEqual(VALID_MINIMAL);
  });

  it("parses full envelope with all optional fields populated", () => {
    const full: LineageEnvelope = {
      kind_version: 1,
      producer_session_id: "session-full",
      produced_at: "2026-05-26T17:00:00.000Z",
      input_body_refs: ["a", "b", "c"],
      input_handoffs: ["HANDOFF_2026-05-26_15-50.md"],
      prompt_sha: "abc123def",
      model: "claude-opus-4-7",
      cost: { input_tokens: 1000, output_tokens: 500, cost_usd_micros: 12300 },
    };
    expect(parseLineageEnvelope(full)).toEqual(full);
  });

  it("permissive on extra unknown fields (forward-compat)", () => {
    const withExtras = {
      ...VALID_MINIMAL,
      future_field_xyz: "should-be-ignored",
      another_extension: { nested: true },
    };
    const out = parseLineageEnvelope(withExtras);
    expect(out).toEqual(VALID_MINIMAL);
  });

  it("accepts empty input_body_refs (vacuous source-of-truth-no-prior-input)", () => {
    const empty: LineageEnvelope = {
      kind_version: 1,
      producer_session_id: "session-source",
      input_body_refs: [],
    };
    expect(parseLineageEnvelope(empty)).toEqual(empty);
  });
});

describe("parseLineageEnvelope — strict-required rejects", () => {
  it("rejects missing kind_version", () => {
    const obj = { producer_session_id: "x", input_body_refs: ["r"] };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects wrong kind_version (skip-other-versions semantics)", () => {
    const obj = { ...VALID_MINIMAL, kind_version: 2 };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects missing producer_session_id", () => {
    const obj = { kind_version: 1, input_body_refs: ["r"] };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects empty-string producer_session_id", () => {
    const obj = { ...VALID_MINIMAL, producer_session_id: "" };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects non-string producer_session_id", () => {
    const obj = { ...VALID_MINIMAL, producer_session_id: 42 };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects missing input_body_refs", () => {
    const obj = { kind_version: 1, producer_session_id: "x" };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects non-array input_body_refs", () => {
    const obj = { ...VALID_MINIMAL, input_body_refs: "not-an-array" };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects non-string entry in input_body_refs", () => {
    const obj = { ...VALID_MINIMAL, input_body_refs: ["valid", 42] };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("rejects empty-string entry in input_body_refs", () => {
    const obj = { ...VALID_MINIMAL, input_body_refs: ["valid", ""] };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });
});

describe("parseLineageEnvelope — optional-field tolerance", () => {
  it("tolerates absent / undefined / null for produced_at", () => {
    const absent = parseLineageEnvelope(VALID_MINIMAL);
    expect(absent?.produced_at).toBeUndefined();
    const explicitNull = parseLineageEnvelope({
      ...VALID_MINIMAL,
      produced_at: null,
    });
    expect(explicitNull?.produced_at).toBeNull();
    const explicitStr = parseLineageEnvelope({
      ...VALID_MINIMAL,
      produced_at: "2026-05-26T17:00:00Z",
    });
    expect(explicitStr?.produced_at).toBe("2026-05-26T17:00:00Z");
  });

  it("rejects wrong-type produced_at (e.g., number)", () => {
    const obj = { ...VALID_MINIMAL, produced_at: 42 };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("tolerates absent / null / array for input_handoffs", () => {
    const explicitNull = parseLineageEnvelope({
      ...VALID_MINIMAL,
      input_handoffs: null,
    });
    expect(explicitNull?.input_handoffs).toBeNull();
    const explicitArr = parseLineageEnvelope({
      ...VALID_MINIMAL,
      input_handoffs: ["HANDOFF_2026-05-26_15-50.md"],
    });
    expect(explicitArr?.input_handoffs).toEqual([
      "HANDOFF_2026-05-26_15-50.md",
    ]);
  });

  it("rejects non-string entry in input_handoffs", () => {
    const obj = {
      ...VALID_MINIMAL,
      input_handoffs: ["valid.md", 42],
    };
    expect(parseLineageEnvelope(obj)).toBeNull();
  });

  it("tolerates absent / null / string for prompt_sha + model", () => {
    expect(
      parseLineageEnvelope({ ...VALID_MINIMAL, prompt_sha: null })?.prompt_sha,
    ).toBeNull();
    expect(
      parseLineageEnvelope({ ...VALID_MINIMAL, prompt_sha: "abc" })?.prompt_sha,
    ).toBe("abc");
    expect(
      parseLineageEnvelope({ ...VALID_MINIMAL, model: null })?.model,
    ).toBeNull();
    expect(
      parseLineageEnvelope({ ...VALID_MINIMAL, model: "claude-opus-4-7" })
        ?.model,
    ).toBe("claude-opus-4-7");
  });

  it("rejects wrong-type prompt_sha + model", () => {
    expect(
      parseLineageEnvelope({ ...VALID_MINIMAL, prompt_sha: 42 }),
    ).toBeNull();
    expect(parseLineageEnvelope({ ...VALID_MINIMAL, model: 42 })).toBeNull();
  });
});

describe("parseLineageEnvelope — TokenCost", () => {
  it("parses valid cost with cost_usd_micros integer (Stripe/PayPal precedent: 1200 micros = $0.0012)", () => {
    const cost: TokenCost = {
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd_micros: 1200,
    };
    const out = parseLineageEnvelope({ ...VALID_MINIMAL, cost });
    expect(out?.cost).toEqual(cost);
  });

  it("parses valid cost without cost_usd_micros (opt-in field absent)", () => {
    const cost: TokenCost = { input_tokens: 100, output_tokens: 50 };
    const out = parseLineageEnvelope({ ...VALID_MINIMAL, cost });
    expect(out?.cost).toEqual(cost);
  });

  it("rejects negative input_tokens / output_tokens", () => {
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: { input_tokens: -1, output_tokens: 50 },
      }),
    ).toBeNull();
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: { input_tokens: 100, output_tokens: -1 },
      }),
    ).toBeNull();
  });

  it("rejects non-integer input_tokens / output_tokens", () => {
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: { input_tokens: 1.5, output_tokens: 50 },
      }),
    ).toBeNull();
  });

  it("rejects negative cost_usd_micros", () => {
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: { input_tokens: 100, output_tokens: 50, cost_usd_micros: -100 },
      }),
    ).toBeNull();
  });

  it("rejects NaN / Infinity cost_usd_micros", () => {
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: { input_tokens: 100, output_tokens: 50, cost_usd_micros: NaN },
      }),
    ).toBeNull();
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: {
          input_tokens: 100,
          output_tokens: 50,
          cost_usd_micros: Infinity,
        },
      }),
    ).toBeNull();
  });

  it("rejects non-integer cost_usd_micros (Cycle 3 S3-D integer-micros invariant)", () => {
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: {
          input_tokens: 100,
          output_tokens: 50,
          cost_usd_micros: 1200.5,
        },
      }),
    ).toBeNull();
    // Float that rounds to a positive integer should also reject — the
    // integer-micros invariant is structural, not value-equivalent.
    expect(
      parseLineageEnvelope({
        ...VALID_MINIMAL,
        cost: { input_tokens: 100, output_tokens: 50, cost_usd_micros: 0.0012 },
      }),
    ).toBeNull();
  });

  it("tolerates absent / null cost field", () => {
    const out1 = parseLineageEnvelope({ ...VALID_MINIMAL, cost: null });
    expect(out1?.cost).toBeNull();
    const out2 = parseLineageEnvelope(VALID_MINIMAL);
    expect(out2?.cost).toBeUndefined();
  });
});

describe("parseLineageEnvelope — root input rejects", () => {
  it("rejects invalid JSON string", () => {
    expect(parseLineageEnvelope("not json {")).toBeNull();
  });

  it("rejects JSON of non-object (array)", () => {
    expect(parseLineageEnvelope("[1,2,3]")).toBeNull();
  });

  it("rejects JSON of non-object (null)", () => {
    expect(parseLineageEnvelope("null")).toBeNull();
  });

  it("rejects primitive inputs", () => {
    expect(parseLineageEnvelope(42)).toBeNull();
    expect(parseLineageEnvelope(true)).toBeNull();
    expect(parseLineageEnvelope(null)).toBeNull();
    expect(parseLineageEnvelope(undefined)).toBeNull();
  });

  it("rejects array input", () => {
    expect(parseLineageEnvelope([1, 2, 3])).toBeNull();
  });
});

describe("isLineageEnvelope — type guard", () => {
  it("returns true for valid envelope object", () => {
    expect(isLineageEnvelope(VALID_MINIMAL)).toBe(true);
  });

  it("returns false for missing required fields", () => {
    expect(isLineageEnvelope({ kind_version: 1 })).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isLineageEnvelope("string")).toBe(false);
    expect(isLineageEnvelope(42)).toBe(false);
    expect(isLineageEnvelope(null)).toBe(false);
    expect(isLineageEnvelope(undefined)).toBe(false);
    expect(isLineageEnvelope([])).toBe(false);
  });

  it("narrows type for downstream access", () => {
    const v: unknown = VALID_MINIMAL;
    if (isLineageEnvelope(v)) {
      expect(v.producer_session_id).toBe("session-abc");
    }
  });
});

describe("createLineageEnvelope — constructor", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env["CLAUDE_SESSION_ID"];
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["CLAUDE_SESSION_ID"];
    } else {
      process.env["CLAUDE_SESSION_ID"] = originalEnv;
    }
  });

  it("defaults producer_session_id from CLAUDE_SESSION_ID env", () => {
    process.env["CLAUDE_SESSION_ID"] = "session-from-env";
    const env = createLineageEnvelope({ input_body_refs: ["r"] });
    expect(env.producer_session_id).toBe("session-from-env");
  });

  it("explicit opts.producer_session_id overrides env", () => {
    process.env["CLAUDE_SESSION_ID"] = "env-id";
    const env = createLineageEnvelope({
      producer_session_id: "explicit-id",
      input_body_refs: ["r"],
    });
    expect(env.producer_session_id).toBe("explicit-id");
  });

  it("throws when both opts + env are absent", () => {
    delete process.env["CLAUDE_SESSION_ID"];
    expect(() => createLineageEnvelope({ input_body_refs: ["r"] })).toThrow(
      /producer_session_id required/,
    );
  });

  it("throws when env is empty string", () => {
    process.env["CLAUDE_SESSION_ID"] = "";
    expect(() => createLineageEnvelope({ input_body_refs: ["r"] })).toThrow(
      /producer_session_id required/,
    );
  });

  it("includes all optional fields when provided", () => {
    process.env["CLAUDE_SESSION_ID"] = "s";
    const env = createLineageEnvelope({
      input_body_refs: ["r"],
      produced_at: "2026-05-26T17:00:00Z",
      input_handoffs: ["h.md"],
      prompt_sha: "sha1",
      model: "claude-opus-4-7",
      cost: { input_tokens: 100, output_tokens: 50, cost_usd_micros: 10000 },
    });
    expect(env.produced_at).toBe("2026-05-26T17:00:00Z");
    expect(env.input_handoffs).toEqual(["h.md"]);
    expect(env.prompt_sha).toBe("sha1");
    expect(env.model).toBe("claude-opus-4-7");
    expect(env.cost?.cost_usd_micros).toBe(10000);
  });

  it("omits optional fields when not provided (clean shape)", () => {
    process.env["CLAUDE_SESSION_ID"] = "s";
    const env = createLineageEnvelope({ input_body_refs: ["r"] });
    expect(env.produced_at).toBeUndefined();
    expect(env.input_handoffs).toBeUndefined();
    expect(env.prompt_sha).toBeUndefined();
    expect(env.model).toBeUndefined();
    expect(env.cost).toBeUndefined();
  });

  it("kind_version is fixed at 1", () => {
    process.env["CLAUDE_SESSION_ID"] = "s";
    const env = createLineageEnvelope({ input_body_refs: ["r"] });
    expect(env.kind_version).toBe(1);
  });
});

describe("lineageVerify — Cycle 1 PR-A1 stub shape", () => {
  it("returns ok=true with empty arrays + skip-not-in-channel sig status", async () => {
    const out = await lineageVerify("any-target");
    expect(out.ok).toBe(true);
    expect(out.resolved_inputs).toEqual([]);
    expect(out.unresolved_inputs).toEqual([]);
    expect(out.sig_chain_status).toBe("skip-not-in-channel");
    expect(out.chain_start_at_msg_seq).toBeNull();
  });

  it("accepts and ignores opts (Cycle 1 stub)", async () => {
    const out = await lineageVerify("target", {
      pubkeyDir: "/some/dir",
      strict: true,
    });
    expect(out.ok).toBe(true);
    expect(out.sig_chain_status).toBe("skip-not-in-channel");
  });
});
