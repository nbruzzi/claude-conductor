#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI for Layer 2 lineage envelope verification (Cycle 1 substrate-extension
 * PR-A4; Pair A Alpha-pen per slice plan
 * `cycle-1-substrate-extension-slice-plan-2026-05-26.md` §3.1 + §7 step 4).
 *
 * Wires PR-A1 `lineageVerify` library (`src/channels/lineage-envelope.ts`)
 * into operator workflow + composes with Pair-B-PR-A6 `verifyChannelAuditChain`
 * (`src/audit/verify.ts`) per the composition-lens contract LOCKED at my
 * Pair-B-PR-A6 audit-shadow body_ref `c27946e5`:
 *
 *   sig_chain_status: "intact" ⟸ AuditVerifyOutput.ok && total_audit_verdicts > 0 && breaks=[]
 *   sig_chain_status: "broken" ⟸ AuditVerifyOutput.breaks non-empty
 *   sig_chain_status: "skip-not-in-channel" ⟸ AuditVerifyOutput.total_audit_verdicts === 0
 *
 * Direct in-package import (not subprocess) per dispatcher.ts design rationale:
 * audit/verify.ts is the library; audit/cli.ts is the script that ends with
 * `await main();`. Importing the library is the clean composition path.
 *
 * **Verb (Cycle 1):**
 *
 *   verify    — Verify lineage envelope for a target. If target is a
 *               channel-id, composes with audit verify chain integrity
 *               check. Returns LineageVerifyOutput shape per §3.1
 *               LOCKED contract + 4-state exit code per §3.1 DC-3:
 *
 *                 0 = ok            (all inputs resolve OR vacuously ok)
 *                 1 = broken        (sig chain or input resolution broken)
 *                 2 = partial       (--strict promotes to 1)
 *                 3 = unsupported   (target unparseable or unknown shape)
 *
 * **Target shape (per §3.1):** `session-id | run-id | artifact-path`.
 * Cycle 1: target is interpreted as a channel-id literal — if it matches
 * the channel-id heuristic (alphanumeric + hyphen/underscore), the CLI
 * dispatches `verifyChannelAuditChain` for the chain-integrity portion.
 * Future cycles can extend resolution to session-id lookup + run-id
 * mapping + artifact-path content-hash resolution.
 *
 * Distinct from `src/audit/cli.ts` (Pair-B-PR-A4 + PR-A6) which handles
 * Layer 1.5 signature chain primitives; this `src/lineage/cli.ts` handles
 * Layer 2 lineage envelope verification composing with Layer 1.5.
 */

import { lineageVerify } from "../channels/api.ts";
import { verifyChannelAuditChain } from "../audit/verify.ts";
import type {
  LineageVerifyOptions,
  LineageVerifyOutput,
} from "../channels/api.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[lineage] ${message}\n`);
  process.exit(code);
}

function consumeStringValue(
  argv: readonly string[],
  i: number,
  flag: string,
): { value: string; consumed: number } {
  const head = argv[i];
  if (head === undefined) die(`missing argument for ${flag}`);
  if (head.startsWith(`${flag}=`)) {
    const value = head.slice(flag.length + 1);
    if (value.length === 0) die(`empty value for ${flag}`);
    return { value, consumed: 1 };
  }
  const next = argv[i + 1];
  if (next === undefined || next.length === 0) {
    die(`missing argument for ${flag}`);
  }
  return { value: next, consumed: 2 };
}

type VerifyFlags = {
  target: string | null;
  pubkeyDir: string | null;
  output: "json" | "human";
  strict: boolean;
};

function parseVerifyFlags(argv: readonly string[]): VerifyFlags {
  let target: string | null = null;
  let pubkeyDir: string | null = null;
  let output: "json" | "human" = "json";
  let strict = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      break;
    } else if (arg === "--pubkey-dir" || arg.startsWith("--pubkey-dir=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--pubkey-dir");
      pubkeyDir = value;
      i += consumed;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--output");
      if (value !== "json" && value !== "human") {
        die(`invalid --output value '${value}' — expected 'json' or 'human'`);
      }
      output = value;
      i += consumed;
    } else if (arg === "--strict") {
      strict = true;
      i += 1;
    } else if (arg.startsWith("-")) {
      die(`unknown flag '${arg}' for lineage verify`);
    } else {
      if (target !== null) {
        die(
          `unexpected positional '${arg}' — lineage verify takes exactly one <target>`,
        );
      }
      target = arg;
      i += 1;
    }
  }
  return { target, pubkeyDir, output, strict };
}

/**
 * Channel-id heuristic for target dispatch. Cycle 1: matches typical
 * channel-id shape (alphanumeric with hyphens/underscores, no slashes).
 * Future cycles can extend to session-id (UUID) + run-id + artifact-path.
 */
export function looksLikeChannelId(target: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_\-]+$/.test(target);
}

/**
 * Derive `LineageVerifyOutput.sig_chain_status` from `AuditVerifyOutput`
 * per the composition-lens contract LOCKED at PR-A6 audit-shadow body_ref
 * `c27946e5`. Returns one of the 3 status enums.
 */
export function deriveSigChainStatus(audit: {
  ok: boolean;
  total_audit_verdicts: number;
  breaks: readonly unknown[];
}): "intact" | "broken" | "skip-not-in-channel" {
  if (audit.breaks.length > 0) return "broken";
  if (audit.total_audit_verdicts === 0) return "skip-not-in-channel";
  if (audit.ok) return "intact";
  return "broken";
}

/**
 * Render LineageVerifyOutput as human-readable text. Compact 1-line
 * summary + per-break detail when breaks exist. Mirrors audit/verify.ts
 * renderHuman shape for consistency across substrate-core + substrate-
 * extension CLI verbs.
 */
export function renderHumanLineage(result: LineageVerifyOutput): string {
  const lines: string[] = [];
  const status = result.ok ? "OK" : "BROKEN";
  const sig = result.sig_chain_status;
  const resolved = result.resolved_inputs.length;
  const unresolved = result.unresolved_inputs.length;
  lines.push(
    `lineage verify: ${status} (sig_chain=${sig}; resolved=${resolved}; unresolved=${unresolved})`,
  );
  if (result.unresolved_inputs.length > 0) {
    lines.push("");
    lines.push("Unresolved inputs:");
    for (const u of result.unresolved_inputs) {
      lines.push(`  - ${u.body_ref}: ${u.reason}`);
    }
  }
  if (result.chain_start_at_msg_seq !== null) {
    lines.push(`Chain start at msg seq: ${result.chain_start_at_msg_seq}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Map `LineageVerifyOutput` + strict-flag to the 4-state exit code per
 * §3.1 DC-3 contract:
 *
 *   0 = ok        (sig chain intact OR vacuously ok; all inputs resolved)
 *   1 = broken    (sig chain broken)
 *   2 = partial   (sig chain intact BUT some inputs unresolved; --strict promotes to 1)
 *   3 = unsupported (reserved for target unparseable / unknown shape)
 */
export function exitCodeForLineage(
  result: LineageVerifyOutput,
  strict: boolean,
): number {
  if (result.sig_chain_status === "broken") return 1;
  if (result.unresolved_inputs.length > 0) {
    return strict ? 1 : 2;
  }
  return 0;
}

export async function runVerify(argv: readonly string[]): Promise<void> {
  const { target, pubkeyDir, output, strict } = parseVerifyFlags(argv);
  if (target === null) {
    die(
      "lineage verify requires a <target> positional argument (session-id | run-id | artifact-path)",
    );
  }

  const opts: LineageVerifyOptions = {
    ...(pubkeyDir !== null ? { pubkeyDir } : {}),
    strict,
  };
  const baseResult = await lineageVerify(target, opts);

  let result: LineageVerifyOutput = baseResult;

  if (looksLikeChannelId(target)) {
    try {
      const auditResult = await verifyChannelAuditChain(
        target,
        pubkeyDir !== null ? { pubkeyDir } : {},
      );
      const sig = deriveSigChainStatus(auditResult.output);
      result = {
        ...baseResult,
        sig_chain_status: sig,
        ok: sig !== "broken" && baseResult.unresolved_inputs.length === 0,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[lineage] audit-chain dispatch failed (target=${target}): ${detail}\n`,
      );
    }
  }

  if (output === "json") {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(renderHumanLineage(result));
  }
  process.exit(exitCodeForLineage(result, strict));
}

const HELP_TEXT = `claude-conductor lineage — Layer 2 lineage envelope CLI (Cycle 1 substrate-extension)

Usage:
  claude-conductor lineage verify <target> [--pubkey-dir <dir>] [--output json|human] [--strict]

Verbs:
  verify      Verify Layer 2 lineage envelope for a target. Composes with
              Pair-B-PR-A6 verifyChannelAuditChain for sig_chain_status
              when target is a channel-id.

              <target>       Required positional; session-id | run-id |
                             artifact-path. Cycle 1: channel-id literal
                             dispatch only; future cycles extend.

              --pubkey-dir   Override cohort key directory (default:
                             paths.ts cohortKeysDir()).

              --output       'json' (default; LineageVerifyOutput shape
                             per Pair A slice plan §3.1 LOCKED) or 'human'
                             (compact summary + per-break detail).

              --strict       Promote 'partial' exit code (2) to 'broken'
                             (1). Mirrors audit verify --strict semantics.

Exit codes per §3.1 DC-3:
  0  ok           (all inputs resolve + sig chain intact OR vacuously ok)
  1  broken       (sig chain broken)
  2  partial      (some inputs unresolved + sig chain intact; --strict promotes to 1)
  3  unsupported  (reserved for target unparseable or unknown shape)

Per Pair A slice plan body §3.1 LOCKED contract + composition-lens audit-shadow
body_ref \`c27946e5\` (AuditVerifyOutput → LineageVerifyOutput derivation paths).
`;

export async function runLineageCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (verb === "verify") {
    await runVerify(rest);
    return;
  }
  die(`unknown verb '${verb}' for lineage CLI — see --help`);
}

if (import.meta.main) {
  await runLineageCli();
}
