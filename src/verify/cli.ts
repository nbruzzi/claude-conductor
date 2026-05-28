#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * CLI for verify-manifest consumption (Tier 3-A).
 *
 * Usage:
 *   claude-conductor verify              Run drift check + all gates from manifest
 *   claude-conductor verify --check      Run drift check ONLY (no gate execution)
 *   claude-conductor verify --fold       Run only the local fold gates (no drift check)
 *   claude-conductor verify --gate <n>   Run only gate <n>; skip others
 *   claude-conductor verify --json       Emit structured JSON output
 *
 * The drift check compares verify-manifest.json against the CI workflow
 * YAML step names; exit 1 on drift with a structured report citing both
 * file paths (F3 fold).
 *
 * Default verb (no subcommand): drift check + sequential gate execution,
 * piping child stdout/stderr to parent. Exits with first non-zero gate
 * status.
 *
 * Plan: slice-T3A-verify-manifest-2026-05-20.md v0.1.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  detectDrift,
  parseVerifyManifest,
  selectFoldGates,
  type DriftReport,
  type VerifyManifest,
} from "./drift.ts";

const SCRIPT_DIR = import.meta.dir;
const PACKAGE_ROOT = dirname(dirname(SCRIPT_DIR));
const MANIFEST_PATH = join(PACKAGE_ROOT, "verify-manifest.json");
const CI_YAML_PATH = join(PACKAGE_ROOT, ".github", "workflows", "test.yml");

function die(message: string, code: number = 2): never {
  process.stderr.write(`[verify] ${message}\n`);
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
  if (next === undefined) die(`missing argument for ${flag}`);
  return { value: next, consumed: 2 };
}

type Flags = {
  mode: "default" | "check" | "fold" | "gate";
  gate_name: string;
  json: boolean;
};

function parseFlags(argv: readonly string[]): Flags {
  let mode: Flags["mode"] = "default";
  let gate_name = "";
  let json = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--check") {
      mode = "check";
      i += 1;
    } else if (arg === "--fold") {
      mode = "fold";
      i += 1;
    } else if (arg === "--json") {
      json = true;
      i += 1;
    } else if (arg === "--gate" || arg.startsWith("--gate=")) {
      const { value, consumed } = consumeStringValue(argv, i, "--gate");
      mode = "gate";
      gate_name = value;
      i += consumed;
    } else {
      die(`unknown flag '${arg}' for verify`);
    }
  }
  return { mode, gate_name, json };
}

function readManifest(): VerifyManifest {
  let raw: string;
  try {
    raw = readFileSync(MANIFEST_PATH, "utf8");
  } catch {
    die(`verify-manifest.json not found at ${MANIFEST_PATH}`);
  }
  const parsed = parseVerifyManifest(raw);
  if (parsed === null) {
    die(
      `verify-manifest.json at ${MANIFEST_PATH} is malformed; expected { version: 1, gates: [...], ci_only_steps: [...], local_only_steps: [...] }`,
    );
  }
  return parsed;
}

function readCiYaml(): string {
  try {
    return readFileSync(CI_YAML_PATH, "utf8");
  } catch {
    die(`CI workflow YAML not found at ${CI_YAML_PATH}`);
  }
}

function emitDriftReport(report: DriftReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (report.status === "clean") {
    process.stdout.write(
      `[verify:drift] clean (${report.ok_steps.length} steps match)\n`,
    );
    return;
  }
  process.stderr.write(`[verify:drift] DRIFT detected:\n`);
  if (report.manifest_only.length > 0) {
    process.stderr.write(
      `  In ${MANIFEST_PATH} but missing from ${CI_YAML_PATH}:\n`,
    );
    for (const name of report.manifest_only) {
      process.stderr.write(`    - ${name}\n`);
    }
  }
  if (report.ci_yaml_only.length > 0) {
    process.stderr.write(
      `  In ${CI_YAML_PATH} but missing from ${MANIFEST_PATH}:\n`,
    );
    for (const name of report.ci_yaml_only) {
      process.stderr.write(`    - ${name}\n`);
    }
  }
  process.stderr.write(
    `  Fix: align manifest.gates[].ci_step_name with the CI workflow step names (or add intentional asymmetries to manifest.ci_only_steps with rationale).\n`,
  );
}

function runGate(gate: VerifyManifest["gates"][number]): number {
  process.stdout.write(`\n[verify] ▶ ${gate.name} — ${gate.local_cmd}\n`);
  const parts = gate.local_cmd.split(/\s+/);
  const cmd = parts[0];
  if (cmd === undefined) die(`empty local_cmd for gate '${gate.name}'`);
  const result = spawnSync(cmd, parts.slice(1), {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    process.stderr.write(
      `[verify] gate '${gate.name}' failed to spawn: ${result.error.message}\n`,
    );
    return 1;
  }
  return result.status ?? 1;
}

function checkCommand(json: boolean): never {
  const manifest = readManifest();
  const ciYaml = readCiYaml();
  const report = detectDrift(manifest, ciYaml);
  emitDriftReport(report, json);
  process.exit(report.status === "clean" ? 0 : 1);
}

function foldCommand(): never {
  const manifest = readManifest();
  const foldGates = selectFoldGates(manifest);
  for (const gate of foldGates) {
    const status = runGate(gate);
    if (status !== 0) {
      process.stderr.write(
        `[verify] gate '${gate.name}' failed (exit ${status})\n`,
      );
      process.exit(status);
    }
  }
  process.stdout.write(
    `\n[verify] all ${foldGates.length} fold gates passed\n`,
  );
  process.exit(0);
}

function gateCommand(name: string): never {
  const manifest = readManifest();
  const gate = manifest.gates.find((g) => g.name === name);
  if (gate === undefined) {
    die(
      `gate '${name}' not found in manifest; available: ${manifest.gates.map((g) => g.name).join(", ")}`,
    );
  }
  const status = runGate(gate);
  process.exit(status);
}

function defaultCommand(): never {
  const manifest = readManifest();
  const ciYaml = readCiYaml();
  const report = detectDrift(manifest, ciYaml);
  if (report.status !== "clean") {
    emitDriftReport(report, false);
    process.exit(1);
  }
  emitDriftReport(report, false);
  for (const gate of manifest.gates) {
    const status = runGate(gate);
    if (status !== 0) {
      process.stderr.write(
        `[verify] gate '${gate.name}' failed (exit ${status})\n`,
      );
      process.exit(status);
    }
  }
  process.stdout.write(
    `\n[verify] all ${manifest.gates.length} gates passed\n`,
  );
  process.exit(0);
}

function printHelp(): void {
  process.stdout.write(
    [
      "verify CLI — manifest-driven gate runner + drift detector.",
      "",
      "Usage:",
      "  verify                  Run drift check + all gates from manifest",
      "  verify --check          Run drift check ONLY (no gate execution)",
      "  verify --fold           Run only the local fold gates (no drift check)",
      "  verify --gate <name>    Run only gate <name>; skip others",
      "  verify --json           Emit structured JSON output (drift report)",
      "",
      "Manifest:    verify-manifest.json (repo root)",
      "CI YAML:     .github/workflows/test.yml",
      "",
      "Exit code: 0 on success; 1 on drift OR gate failure; 2 on argument error.",
      "",
    ].join("\n"),
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    printHelp();
    process.exit(0);
  }
  const flags = parseFlags(argv);
  if (flags.mode === "check") {
    checkCommand(flags.json);
  } else if (flags.mode === "fold") {
    foldCommand();
  } else if (flags.mode === "gate") {
    gateCommand(flags.gate_name);
  } else {
    defaultCommand();
  }
}

main();
