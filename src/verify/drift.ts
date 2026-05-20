// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Drift detector for verify-manifest.json vs `.github/workflows/test.yml`
 * (Tier 3-A — local-clean ≠ CI-clean class structural close).
 *
 * Pure logic — caller reads files and passes content as strings.
 * The drift detector returns a structured `DriftReport` indicating
 * whether the manifest's `gates[].ci_step_name` set matches the CI YAML's
 * `- name: <step>` set. Asymmetries declared in `ci_only_steps` are
 * permitted (workflow-lint runs on CI only).
 *
 * Plan: slice-T3A-verify-manifest-2026-05-20.md v0.1.
 */

export type VerifyManifest = {
  version: 1;
  gates: readonly { name: string; local_cmd: string; ci_step_name: string }[];
  ci_only_steps: readonly {
    name: string;
    ci_step_name: string;
    reason: string;
  }[];
  local_only_steps: readonly {
    name: string;
    local_cmd: string;
    reason: string;
  }[];
};

export type DriftReport = {
  status: "clean" | "drift";
  manifest_only: readonly string[];
  ci_yaml_only: readonly string[];
  ok_steps: readonly string[];
};

/**
 * Parse a verify-manifest.json text. Returns null on shape mismatch
 * (mirror Slice 2 audit-verdict parser discipline; F1 fold).
 */
export function parseVerifyManifest(raw: string): VerifyManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["version"] !== 1) return null;
  const gates = obj["gates"];
  if (!Array.isArray(gates)) return null;
  for (const g of gates) {
    if (g === null || typeof g !== "object" || Array.isArray(g)) return null;
    const go = g as Record<string, unknown>;
    if (typeof go["name"] !== "string" || go["name"].length === 0) return null;
    if (typeof go["local_cmd"] !== "string" || go["local_cmd"].length === 0)
      return null;
    if (
      typeof go["ci_step_name"] !== "string" ||
      go["ci_step_name"].length === 0
    )
      return null;
  }
  const ciOnly = obj["ci_only_steps"];
  if (!Array.isArray(ciOnly)) return null;
  for (const s of ciOnly) {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return null;
    const so = s as Record<string, unknown>;
    if (typeof so["name"] !== "string" || so["name"].length === 0) return null;
    if (
      typeof so["ci_step_name"] !== "string" ||
      so["ci_step_name"].length === 0
    )
      return null;
    if (typeof so["reason"] !== "string" || so["reason"].length === 0)
      return null;
  }
  const localOnly = obj["local_only_steps"];
  if (!Array.isArray(localOnly)) return null;
  for (const s of localOnly) {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return null;
    const so = s as Record<string, unknown>;
    if (typeof so["name"] !== "string" || so["name"].length === 0) return null;
    if (typeof so["local_cmd"] !== "string" || so["local_cmd"].length === 0)
      return null;
    if (typeof so["reason"] !== "string" || so["reason"].length === 0)
      return null;
  }
  return parsed as VerifyManifest;
}

/**
 * Extract `- name: <step>` entries from a CI workflow YAML's `steps:`
 * blocks. Returns the set of step names found. Regex-based; sufficient
 * for the conductor workflow shape (single job, no fancy YAML).
 */
export function extractCiStepNames(yaml: string): readonly string[] {
  // Use [ \t] explicitly instead of \s — \s matches \n which would bleed
  // the capture across lines on adjacent empty `- name:` entries.
  const matches = yaml.matchAll(
    /^[ \t]*-[ \t]+name:[ \t]+(\S[^\n]*?)[ \t]*$/gm,
  );
  const out: string[] = [];
  for (const m of matches) {
    const name = m[1];
    if (name !== undefined && name.length > 0) out.push(name);
  }
  return out;
}

/**
 * Compare manifest vs CI YAML step list. Returns a structured drift
 * report with deterministic (sorted ASC) output (F2 fold).
 *
 * Asymmetries:
 * - Manifest entries in `ci_only_steps` are NOT required to appear in
 *   YAML; they're ignored in the manifest_only check.
 * - YAML steps matching any `ci_only_steps.ci_step_name` are NOT flagged
 *   as ci_yaml_only.
 */
export function detectDrift(
  manifest: VerifyManifest,
  ci_yaml_text: string,
): DriftReport {
  const manifestStepNames = new Set(manifest.gates.map((g) => g.ci_step_name));
  const ciOnlyNames = new Set(
    manifest.ci_only_steps.map((s) => s.ci_step_name),
  );
  const yamlStepNames = new Set(extractCiStepNames(ci_yaml_text));

  const manifest_only: string[] = [];
  const ok_steps: string[] = [];
  for (const name of manifestStepNames) {
    if (yamlStepNames.has(name)) {
      ok_steps.push(name);
    } else {
      manifest_only.push(name);
    }
  }
  const ci_yaml_only: string[] = [];
  for (const name of yamlStepNames) {
    if (manifestStepNames.has(name)) continue;
    if (ciOnlyNames.has(name)) continue;
    ci_yaml_only.push(name);
  }

  manifest_only.sort();
  ci_yaml_only.sort();
  ok_steps.sort();

  const status: "clean" | "drift" =
    manifest_only.length === 0 && ci_yaml_only.length === 0 ? "clean" : "drift";

  return { status, manifest_only, ci_yaml_only, ok_steps };
}
