// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Layer 2 per-artefact lineage envelope (Cycle 1 substrate-extension
 * PR-A1; Pair A Alpha-pen per slice plan body
 * `cycle-1-substrate-extension-slice-plan-2026-05-26.md` §1.1 + §2.5
 * + §3.1).
 *
 * SSOT module for the `LineageEnvelope` shape + parser + constructor
 * + `lineageVerify` library entry point. Per §0.3 LAYERING PRINCIPLE:
 * all Layer 2 envelope types + parsers live plugin-canonical. Re-exports
 * via `src/channels/api.ts` land in PR-A2; dotfiles shim mirror lands
 * with PR-A2 per substrate-shim-mirror discipline.
 *
 * **Forward-compat:** `kind_version`-tagged. Today's parser accepts only
 * version 1; mis-versioned envelopes return `null` (skip semantics;
 * sibling to {@link parseLiveUpdateBody} / {@link parseDigestBody} /
 * {@link parseAuditVerdictBody}).
 *
 * **Composition with Pair B substrate-core PR-A5 (DSSE wrapper) per
 * §2.6 + cross-pair contract §4:** Pair A PR-A2 extends
 * `AuditVerdictBody` with optional `lineage?: LineageEnvelope` field;
 * the entire body (including lineage) gets canonical-JSON-encoded
 * (`canonicalJson()`) before DSSE PAE — signature covers payload bytes
 * → `lineage` field is signature-covered automatically. Verifier
 * unwraps DSSE → parses inner AuditVerdictBody → accesses
 * `body.lineage` if present.
 *
 * **Substrate-debt note:** `TokenCost.cost_usd` is a float per locked
 * spec §1.1. `canonical-json.ts` RFC 8785 subset does NOT implement
 * §3.2.2 full number canonicalization (per Pair-B-PR-A5 audit-shadow
 * PUNT-OBS-CL-1 + canonical-json.ts JSDoc). For Cycle 1 cost field is
 * opt-in (OQ-A4); risk does not surface unless cost is populated.
 * Filed as Cycle 2 substrate-debt for canonical-json.ts full RFC 8785
 * upgrade.
 */

/**
 * Token cost record for opt-in lineage envelope cost capture (OQ-A4
 * Cycle 1).
 */
export type TokenCost = {
  input_tokens: number;
  output_tokens: number;
  /**
   * Optional cost in USD (float). Cycle 1: opt-in only. If populated,
   * may cause canonical-encoding non-determinism across runtimes —
   * `canonical-json.ts` (PR-A5 substrate-core SSOT) ships an RFC 8785
   * SUBSET that does NOT implement §3.2.2 full number canonicalization
   * (no scientific-notation normalization for large/small floats).
   * Cycle 2 will promote `canonical-json.ts` to full RFC 8785 OR amend
   * this field to integer micros (Stripe/PayPal precedent: 1200 micros
   * = $0.0012). Substrate-debt filed at
   * `~/Documents/Obsidian Vault/wiki/backlog.md` per PR-A1 PUNT-OBS-CL-1
   * cohort discretion (Option B; Bravo RATIFY-CLEAN-w-3-CONDITIONS
   * 2026-05-26T17:59Z body_ref TBD).
   */
  cost_usd?: number;
};

/**
 * Layer 2 per-artefact lineage envelope.
 *
 * Applied to 4 surfaces (per §1.1):
 *   1. `AuditVerdictBody` (inside DSSE `payload`; signature-covered via PAE)
 *   2. Channel message body (structured-kind body OR free-form wrapper)
 *   3. Memory entry frontmatter (`lineage:` YAML block)
 *   4. Handoff frontmatter (`lineage:` YAML block + `input_handoffs` extension)
 *
 * **Required fields:** `kind_version`, `producer_session_id`,
 * `input_body_refs`. All optional fields tolerate `undefined`, `null`,
 * OR field-absent (read-side back-compat per §2.5).
 *
 * **Forward-compat:** `kind_version: 1` only; other versions return
 * `null` from {@link parseLineageEnvelope} (skip semantics).
 */
export type LineageEnvelope = {
  kind_version: 1;
  producer_session_id: string;
  produced_at?: string | null;
  input_body_refs: readonly string[];
  input_handoffs?: readonly string[] | null;
  prompt_sha?: string | null;
  model?: string | null;
  cost?: TokenCost | null;
};

/**
 * Options for {@link lineageVerify}.
 */
export type LineageVerifyOptions = {
  pubkeyDir?: string;
  strict?: boolean;
};

/**
 * Output shape from {@link lineageVerify} per §3.1 LOCKED contract.
 */
export type LineageVerifyOutput = {
  ok: boolean;
  resolved_inputs: ReadonlyArray<{
    body_ref: string;
    ts: string;
    kind: string;
    producer_session_id: string;
  }>;
  unresolved_inputs: ReadonlyArray<{
    body_ref: string;
    reason: "not-found" | "wrong-channel" | "schema-mismatch";
  }>;
  sig_chain_status: "intact" | "broken" | "skip-not-in-channel";
  chain_start_at_msg_seq: number | null;
};

/**
 * Parse a `LineageEnvelope` value from arbitrary `unknown` input.
 * Tolerates string-input (JSON-parse first) OR object-input (skip parse).
 * Returns `null` on:
 *
 *   - String input is not valid JSON
 *   - Parsed value is not a non-null, non-array object
 *   - `kind_version` is missing or not `1` (skip-other-versions semantics)
 *   - `producer_session_id` is missing or not a non-empty string
 *   - `input_body_refs` is missing or not an array OR contains non-string
 *     entries OR contains empty-string entries
 *   - Optional fields present-but-wrong-shape (e.g., `prompt_sha: 42`)
 *
 * Permissive on extra fields (forward-compat per existing parser
 * convention; sibling to {@link parseLiveUpdateBody}).
 */
export function parseLineageEnvelope(input: unknown): LineageEnvelope | null {
  let obj: Record<string, unknown>;
  if (typeof input === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    obj = parsed as Record<string, unknown>;
  } else if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input)
  ) {
    obj = input as Record<string, unknown>;
  } else {
    return null;
  }

  if (obj["kind_version"] !== 1) return null;

  const producerSessionId = obj["producer_session_id"];
  if (typeof producerSessionId !== "string" || producerSessionId.length === 0) {
    return null;
  }

  const inputBodyRefsRaw = obj["input_body_refs"];
  if (!Array.isArray(inputBodyRefsRaw)) return null;
  for (const entry of inputBodyRefsRaw) {
    if (typeof entry !== "string" || entry.length === 0) return null;
  }
  const inputBodyRefs: readonly string[] =
    inputBodyRefsRaw as readonly string[];

  const producedAtRaw = obj["produced_at"];
  let producedAt: string | null | undefined;
  if (producedAtRaw === undefined) {
    producedAt = undefined;
  } else if (producedAtRaw === null) {
    producedAt = null;
  } else if (typeof producedAtRaw === "string") {
    producedAt = producedAtRaw;
  } else {
    return null;
  }

  const inputHandoffsRaw = obj["input_handoffs"];
  let inputHandoffs: readonly string[] | null | undefined;
  if (inputHandoffsRaw === undefined) {
    inputHandoffs = undefined;
  } else if (inputHandoffsRaw === null) {
    inputHandoffs = null;
  } else if (Array.isArray(inputHandoffsRaw)) {
    for (const entry of inputHandoffsRaw) {
      if (typeof entry !== "string" || entry.length === 0) return null;
    }
    inputHandoffs = inputHandoffsRaw as readonly string[];
  } else {
    return null;
  }

  const promptShaRaw = obj["prompt_sha"];
  let promptSha: string | null | undefined;
  if (promptShaRaw === undefined) {
    promptSha = undefined;
  } else if (promptShaRaw === null) {
    promptSha = null;
  } else if (typeof promptShaRaw === "string") {
    promptSha = promptShaRaw;
  } else {
    return null;
  }

  const modelRaw = obj["model"];
  let model: string | null | undefined;
  if (modelRaw === undefined) {
    model = undefined;
  } else if (modelRaw === null) {
    model = null;
  } else if (typeof modelRaw === "string") {
    model = modelRaw;
  } else {
    return null;
  }

  const costRaw = obj["cost"];
  let cost: TokenCost | null | undefined;
  if (costRaw === undefined) {
    cost = undefined;
  } else if (costRaw === null) {
    cost = null;
  } else if (
    typeof costRaw === "object" &&
    costRaw !== null &&
    !Array.isArray(costRaw)
  ) {
    const costObj = costRaw as Record<string, unknown>;
    const inputTokens = costObj["input_tokens"];
    const outputTokens = costObj["output_tokens"];
    if (
      typeof inputTokens !== "number" ||
      !Number.isInteger(inputTokens) ||
      inputTokens < 0
    ) {
      return null;
    }
    if (
      typeof outputTokens !== "number" ||
      !Number.isInteger(outputTokens) ||
      outputTokens < 0
    ) {
      return null;
    }
    const costUsdRaw = costObj["cost_usd"];
    let costUsd: number | undefined;
    if (costUsdRaw === undefined) {
      costUsd = undefined;
    } else if (
      typeof costUsdRaw === "number" &&
      Number.isFinite(costUsdRaw) &&
      costUsdRaw >= 0
    ) {
      costUsd = costUsdRaw;
    } else {
      return null;
    }
    cost = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
    };
  } else {
    return null;
  }

  return {
    kind_version: 1,
    producer_session_id: producerSessionId,
    input_body_refs: inputBodyRefs,
    ...(producedAt !== undefined ? { produced_at: producedAt } : {}),
    ...(inputHandoffs !== undefined ? { input_handoffs: inputHandoffs } : {}),
    ...(promptSha !== undefined ? { prompt_sha: promptSha } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

/**
 * Type guard for `LineageEnvelope`. Returns `true` iff
 * {@link parseLineageEnvelope} would succeed on the value passed as
 * an object (no JSON-string convenience — pass already-parsed values).
 */
export function isLineageEnvelope(v: unknown): v is LineageEnvelope {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return parseLineageEnvelope(v) !== null;
}

/**
 * Constructor options for {@link createLineageEnvelope}.
 *
 * `producer_session_id` defaults from `CLAUDE_SESSION_ID` env var when
 * omitted. Throws if both omitted-arg AND env-absent.
 */
export type CreateLineageEnvelopeOpts = {
  producer_session_id?: string;
  produced_at?: string | null;
  input_body_refs: readonly string[];
  input_handoffs?: readonly string[] | null;
  prompt_sha?: string | null;
  model?: string | null;
  cost?: TokenCost | null;
};

/**
 * Construct a `LineageEnvelope` value with sensible defaults.
 *
 * `producer_session_id` defaults from `CLAUDE_SESSION_ID` env var.
 * `kind_version` is fixed at `1`.
 *
 * Throws if `producer_session_id` cannot be resolved from arg + env.
 */
export function createLineageEnvelope(
  opts: CreateLineageEnvelopeOpts,
): LineageEnvelope {
  const producerSessionId =
    opts.producer_session_id ?? process.env["CLAUDE_SESSION_ID"];
  if (producerSessionId === undefined || producerSessionId.length === 0) {
    throw new Error(
      "createLineageEnvelope: producer_session_id required (pass via opts OR set CLAUDE_SESSION_ID env)",
    );
  }
  return {
    kind_version: 1,
    producer_session_id: producerSessionId,
    input_body_refs: opts.input_body_refs,
    ...(opts.produced_at !== undefined
      ? { produced_at: opts.produced_at }
      : {}),
    ...(opts.input_handoffs !== undefined
      ? { input_handoffs: opts.input_handoffs }
      : {}),
    ...(opts.prompt_sha !== undefined ? { prompt_sha: opts.prompt_sha } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
  };
}

/**
 * Library entry point for `lineage verify` (PR-A4 CLI dispatch wires
 * this; Cycle 1 PR-A1 ships the library function shape).
 *
 * **Cycle 1 sig_chain_status:** Always returns `"skip-not-in-channel"`
 * because Pair B `audit verify` CLI does not land until PR-A6. PR-A4
 * wires the actual call to `audit verify` once PR-A6 merges, replacing
 * this stub.
 *
 * **Body_ref lookup:** PR-A1 returns empty resolved/unresolved arrays.
 * PR-A4 wires channel-message lookup alongside CLI dispatch (both
 * wire-ups land together for cohesive PR shape).
 *
 * Per §3.1 4-state exit code matrix at CLI dispatch level:
 *   - exit 0 = ok
 *   - exit 1 = broken
 *   - exit 2 = partial (`--strict` flag promotes to 1)
 *   - exit 3 = unsupported (envelope unparseable)
 */
export async function lineageVerify(
  target: string,
  opts: LineageVerifyOptions = {},
): Promise<LineageVerifyOutput> {
  void target;
  void opts;
  return {
    ok: true,
    resolved_inputs: [],
    unresolved_inputs: [],
    sig_chain_status: "skip-not-in-channel",
    chain_start_at_msg_seq: null,
  };
}
