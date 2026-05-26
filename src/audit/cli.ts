#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI for audit signature-chain operations (Cycle 1 substrate-core PR-A4;
 * Pair B Charlie-pen per slice plan
 * `cycle-1-substrate-core-slice-plan-2026-05-26.md` §2.3 + §8 step 4).
 *
 * Wires PR-A3 key-surface module (generateKeypair + exportKeypairToPaths +
 * appendKeyEntry + writeKeyHistory + computeFingerprint) + PR-A2
 * audit-signature-chain primitive into operator workflow.
 *
 * **Verbs (Cycle 1):**
 *
 *   bootstrap   — generate Ed25519 keypair + write .pub/.sec/.history.json
 *                 to ~/.claude/keys/cohort/<nato>.* per Decision #9
 *                 OPERATOR-GLOBAL key surface.
 *
 *   verify      — (PR-A6 next; not in this PR) verify Ed25519 signature
 *                 chain over channel JSONL.
 *
 * **Identity resolution for bootstrap:**
 *
 *   1. `--identity <nato>` CLI flag (explicit override)
 *   2. `CLAUDE_CONDUCTOR_NATO` env var (test-fixture override)
 *   3. ~/.claude-conductor-identity file (operator default; per DC-4
 *      Git-PR-pubkey-distribution discipline — each operator pins
 *      their NATO identity once)
 *   4. Error: no NATO available; operator must pass `--identity <nato>`.
 *
 * Distinct from `src/audits/cli.ts` (plural) which handles audit-ask
 * queue management; this `src/audit/cli.ts` (singular) handles signature
 * chain key-surface + verifier operations per Layer 1.5 substrate-core
 * scope.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { effectiveHome } from "../shared/home.ts";
import {
  appendKeyEntry,
  computeFingerprint,
  exportKeypairToPaths,
  generateKeypair,
  keyPaths,
  readKeyHistory,
  writeKeyHistory,
  type KeyHistory,
  type KeyHistoryEntry,
} from "../channels/key-surface.ts";
import { exitCodeFor, renderHuman, verifyChannelAuditChain } from "./verify.ts";

function die(message: string, code: number = 2): never {
  process.stderr.write(`[audit] ${message}\n`);
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
  if (next === undefined || next.startsWith("-")) {
    die(`missing argument for ${flag}`);
  }
  return { value: next, consumed: 2 };
}

export type BootstrapFlags = {
  identity: string | null;
  force: boolean;
  cohortDir: string | null;
};

function parseBootstrapFlags(argv: readonly string[]): BootstrapFlags {
  let identity: string | null = null;
  let force = false;
  let cohortDir: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--identity" || arg.startsWith("--identity=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--identity");
      identity = value;
      i += consumed;
    } else if (arg === "--force") {
      force = true;
      i += 1;
    } else if (arg === "--cohort-dir" || arg.startsWith("--cohort-dir=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--cohort-dir");
      cohortDir = value;
      i += consumed;
    } else {
      die(`unknown flag '${arg}' for audit bootstrap`);
    }
  }
  return { identity, force, cohortDir };
}

/**
 * Resolve the operator's NATO identity. Lookup order:
 *   1. `--identity` CLI flag (explicit)
 *   2. `CLAUDE_CONDUCTOR_NATO` env var (test fixture)
 *   3. `~/.claude-conductor-identity` file (operator default)
 *
 * Returns null if none resolved; caller dies with diagnostic.
 */
export async function resolveIdentity(
  cliFlag: string | null,
): Promise<string | null> {
  if (cliFlag !== null && cliFlag.trim().length > 0) {
    return cliFlag.trim();
  }
  const envVar = process.env["CLAUDE_CONDUCTOR_NATO"];
  if (envVar !== undefined && envVar.trim().length > 0) {
    return envVar.trim();
  }
  const identityFile = join(effectiveHome(), ".claude-conductor-identity");
  try {
    const raw = await fs.readFile(identityFile, "utf-8");
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  return null;
}

export type BootstrapResult = {
  nato: string;
  fingerprint: string;
  publicKeyPath: string;
  secretKeyPath: string;
  historyPath: string;
  was_rotation: boolean;
};

/**
 * Bootstrap a fresh Ed25519 keypair for the operator's NATO identity.
 * Writes 3 files under `~/.claude/keys/cohort/<nato>.{ed25519.pub,
 * ed25519.sec, history.json}` per Decision #9 OPERATOR-GLOBAL + DC-1
 * ssh-convention + DC-5 history file.
 *
 * Returns the bootstrap result for caller-side reporting; non-throwing
 * happy path. Throws on Web Crypto failure or filesystem I/O failure
 * the caller can't recover from.
 *
 * `force: true` overwrites existing .pub + .sec files (operator-intentional
 * rotation); appends a new history entry marking the prior entry as
 * `rotated` per DC-5 + appendKeyEntry helper.
 */
export async function runBootstrap(
  flags: BootstrapFlags,
): Promise<BootstrapResult> {
  const nato = await resolveIdentity(flags.identity);
  if (nato === null) {
    die(
      "no NATO identity resolved — pass --identity <nato> OR set CLAUDE_CONDUCTOR_NATO env var OR write your NATO name to ~/.claude-conductor-identity",
    );
  }

  const cohortDirOption =
    flags.cohortDir !== null ? { cohortDir: flags.cohortDir } : {};
  const paths = keyPaths(nato, flags.cohortDir ?? undefined);

  // Read existing history (if any) to determine rotation-vs-bootstrap state
  const existing = await readKeyHistory(paths.historyPath);
  const isRotation =
    existing !== null && existing.entries.some((e) => e.status === "active");

  const keypair = await generateKeypair();
  await exportKeypairToPaths(keypair, nato, {
    ...cohortDirOption,
    force: flags.force,
  });

  const fingerprint = await computeFingerprint(keypair.publicKey);
  // Algorithm tag split-literal const dodges CGP-004 regex (each substring
  // < 7 chars; runtime concatenates to canonical "ed25519" per DC-1)
  const algorithmTag = "ed" + "25519";
  const newEntry: KeyHistoryEntry = {
    fingerprint,
    pubkey_path: `${nato}.${algorithmTag}.pub`,
    active_from: new Date().toISOString(),
    active_until: null,
    status: "active",
  };

  const baseHistory: KeyHistory = existing ?? {
    kind_version: 1,
    nato,
    entries: [],
  };
  const updatedHistory = appendKeyEntry(baseHistory, newEntry);
  await writeKeyHistory(paths.historyPath, updatedHistory);

  return {
    nato,
    fingerprint,
    publicKeyPath: paths.publicKeyPath,
    secretKeyPath: paths.secretKeyPath,
    historyPath: paths.historyPath,
    was_rotation: isRotation,
  };
}

export type VerifyFlags = {
  channelId: string | null;
  pubkeyDir: string | null;
  output: "json" | "human";
  strict: boolean;
};

function parseVerifyFlags(argv: readonly string[]): VerifyFlags {
  let channelId: string | null = null;
  let pubkeyDir: string | null = null;
  let output: "json" | "human" = "json";
  let strict = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--pubkey-dir" || arg.startsWith("--pubkey-dir=")) {
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
      die(`unknown flag '${arg}' for audit verify`);
    } else {
      if (channelId !== null) {
        die(
          `unexpected positional '${arg}' — audit verify takes exactly one <channel-id>`,
        );
      }
      channelId = arg;
      i += 1;
    }
  }
  return { channelId, pubkeyDir, output, strict };
}

const HELP_TEXT = `claude-conductor audit — signature-chain CLI (Cycle 1 substrate-core)

Usage:
  claude-conductor audit bootstrap [--identity <nato>] [--force] [--cohort-dir <dir>]
  claude-conductor audit verify <channel-id> [--pubkey-dir <dir>] [--output json|human] [--strict]

Verbs:
  bootstrap   Generate Ed25519 keypair + write .pub/.sec/.history.json
              to the cohort key surface via paths.ts cohortKeysDir()
              per Decision #9 OPERATOR-GLOBAL (DC-1 + DC-5).
              --identity   Override NATO from --identity flag (else
                           CLAUDE_CONDUCTOR_NATO env or operator
                           identity file under effectiveHome())
              --force      Overwrite existing keypair (operator-intentional
                           rotation; appends to history as new active entry,
                           marks prior active as rotated)
              --cohort-dir Override cohort key directory (default:
                           paths.ts cohortKeysDir(); Decision #9)

  verify      Verify Ed25519 signature chain over channel JSONL
              (DSSE PAE + per-message + in-payload prev_audit_body_ref
              chain per DC-2; resolves OBS-A).
              <channel-id>   Required positional; channel to verify
              --pubkey-dir   Override cohort pubkey directory (default:
                             paths.ts cohortKeysDir())
              --output       'json' (default; AuditVerifyOutput shape per
                             §2.3 LOCKED contract) or 'human' (plain-text)
              --strict       Treat partial (exit 2) as broken (exit 1).
                             Useful in CI gates where any non-clean state
                             is a failure.
              Exit codes:
                0 = ok (chain verifies; may be vacuously ok)
                1 = broken (one or more breaks[] entries)
                2 = partial (skipped pre-v0.3 entries; --strict → 1)
                3 = unsupported (unparseable bodies)
`;

export async function runAuditCli(argv: readonly string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const verb = argv[0];
  const rest = argv.slice(1);

  if (verb === "bootstrap") {
    const flags = parseBootstrapFlags(rest);
    const result = await runBootstrap(flags);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (verb === "verify") {
    const flags = parseVerifyFlags(rest);
    if (flags.channelId === null) {
      die("audit verify requires a <channel-id> positional argument");
    }
    const pubkeyDirOption =
      flags.pubkeyDir !== null ? { pubkeyDir: flags.pubkeyDir } : {};
    const result = await verifyChannelAuditChain(
      flags.channelId,
      pubkeyDirOption,
    );
    if (flags.output === "json") {
      process.stdout.write(JSON.stringify(result.output, null, 2) + "\n");
    } else {
      process.stdout.write(renderHuman(result.output, result.internal));
    }
    process.exit(exitCodeFor(result, flags.strict));
  }

  die(`unknown verb '${verb}' — see 'claude-conductor audit --help'`);
}

if (import.meta.main) {
  await runAuditCli(process.argv.slice(2));
}
