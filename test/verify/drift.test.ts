// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Unit tests for the verify-manifest drift detector (Tier 3-A).
 *
 * Coverage per plan §7:
 *   - empty manifest + empty YAML → clean drift report (edge case)
 *   - manifest matches YAML exactly → clean drift report
 *   - manifest has gate X, YAML doesn't → drift; manifest_only=[X]
 *   - YAML has step Y, manifest doesn't → drift; ci_yaml_only=[Y]
 *   - ci_only_steps entry in YAML → no drift (asymmetry honored)
 *   - ci_only_steps entry MISSING from YAML → still no drift (permissive)
 *   - real repo manifest + YAML → in-sync (canonical fixture sanity)
 *
 * Plan: slice-T3A-verify-manifest-2026-05-20.md v0.1.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  detectDrift,
  extractCiStepNames,
  parseVerifyManifest,
  type VerifyManifest,
} from "../../src/verify/drift.ts";

function makeManifest(opts: {
  gates?: readonly { name: string; ci_step_name: string }[];
  ci_only?: readonly { name: string; ci_step_name: string }[];
}): VerifyManifest {
  return {
    version: 1,
    gates: (opts.gates ?? []).map((g) => ({
      name: g.name,
      local_cmd: `bun run ${g.name}`,
      ci_step_name: g.ci_step_name,
    })),
    ci_only_steps: (opts.ci_only ?? []).map((s) => ({
      name: s.name,
      ci_step_name: s.ci_step_name,
      reason: "test fixture",
    })),
    local_only_steps: [],
  };
}

function makeYaml(stepNames: readonly string[]): string {
  return `name: CI\njobs:\n  check:\n    steps:\n${stepNames.map((n) => `      - name: ${n}\n        run: echo ${n}`).join("\n")}\n`;
}

describe("detectDrift", () => {
  it("empty manifest + empty YAML → clean", () => {
    const report = detectDrift(makeManifest({}), "name: CI\njobs: {}\n");
    expect(report.status).toBe("clean");
    expect(report.ok_steps).toEqual([]);
    expect(report.manifest_only).toEqual([]);
    expect(report.ci_yaml_only).toEqual([]);
  });

  it("manifest matches YAML exactly → clean", () => {
    const manifest = makeManifest({
      gates: [
        { name: "typecheck", ci_step_name: "Typecheck" },
        { name: "test", ci_step_name: "Test" },
      ],
    });
    const yaml = makeYaml(["Typecheck", "Test"]);
    const report = detectDrift(manifest, yaml);
    expect(report.status).toBe("clean");
    expect(report.ok_steps).toEqual(["Test", "Typecheck"]);
  });

  it("manifest has gate X, YAML doesn't → drift", () => {
    const manifest = makeManifest({
      gates: [
        { name: "typecheck", ci_step_name: "Typecheck" },
        { name: "lint", ci_step_name: "Lint" },
      ],
    });
    const yaml = makeYaml(["Typecheck"]);
    const report = detectDrift(manifest, yaml);
    expect(report.status).toBe("drift");
    expect(report.manifest_only).toEqual(["Lint"]);
    expect(report.ci_yaml_only).toEqual([]);
    expect(report.ok_steps).toEqual(["Typecheck"]);
  });

  it("YAML has step Y, manifest doesn't → drift", () => {
    const manifest = makeManifest({
      gates: [{ name: "typecheck", ci_step_name: "Typecheck" }],
    });
    const yaml = makeYaml(["Typecheck", "Format"]);
    const report = detectDrift(manifest, yaml);
    expect(report.status).toBe("drift");
    expect(report.ci_yaml_only).toEqual(["Format"]);
  });

  it("ci_only_steps entry in YAML → no drift", () => {
    const manifest = makeManifest({
      gates: [{ name: "typecheck", ci_step_name: "Typecheck" }],
      ci_only: [{ name: "actionlint", ci_step_name: "Lint workflows" }],
    });
    const yaml = makeYaml(["Lint workflows", "Typecheck"]);
    const report = detectDrift(manifest, yaml);
    expect(report.status).toBe("clean");
    expect(report.ci_yaml_only).toEqual([]);
  });

  it("ci_only_steps entry MISSING from YAML → still no drift (permissive)", () => {
    const manifest = makeManifest({
      gates: [{ name: "typecheck", ci_step_name: "Typecheck" }],
      ci_only: [{ name: "actionlint", ci_step_name: "Lint workflows" }],
    });
    const yaml = makeYaml(["Typecheck"]);
    const report = detectDrift(manifest, yaml);
    expect(report.status).toBe("clean");
  });

  it("real repo manifest + YAML → in-sync (canonical sanity)", () => {
    const repoRoot = resolvePath(import.meta.dir, "../..");
    const manifestRaw = readFileSync(
      resolvePath(repoRoot, "verify-manifest.json"),
      "utf8",
    );
    const yamlRaw = readFileSync(
      resolvePath(repoRoot, ".github/workflows/test.yml"),
      "utf8",
    );
    const manifest = parseVerifyManifest(manifestRaw);
    if (manifest === null) throw new Error("real manifest failed to parse");
    const report = detectDrift(manifest, yamlRaw);
    expect(report.status).toBe("clean");
  });
});

describe("parseVerifyManifest", () => {
  it("accepts a well-formed manifest", () => {
    const raw = JSON.stringify({
      version: 1,
      gates: [{ name: "x", local_cmd: "bun run x", ci_step_name: "X" }],
      ci_only_steps: [],
      local_only_steps: [],
    });
    const parsed = parseVerifyManifest(raw);
    if (parsed === null) throw new Error("expected non-null");
    expect(parsed.gates).toHaveLength(1);
  });

  it("rejects version other than 1", () => {
    const raw = JSON.stringify({
      version: 2,
      gates: [],
      ci_only_steps: [],
      local_only_steps: [],
    });
    expect(parseVerifyManifest(raw)).toBeNull();
  });

  it("rejects missing gates field", () => {
    const raw = JSON.stringify({
      version: 1,
      ci_only_steps: [],
      local_only_steps: [],
    });
    expect(parseVerifyManifest(raw)).toBeNull();
  });

  it("rejects malformed gate entry", () => {
    const raw = JSON.stringify({
      version: 1,
      gates: [{ name: "x", local_cmd: "", ci_step_name: "X" }],
      ci_only_steps: [],
      local_only_steps: [],
    });
    expect(parseVerifyManifest(raw)).toBeNull();
  });

  it("rejects non-JSON input", () => {
    expect(parseVerifyManifest("not json")).toBeNull();
  });
});

describe("extractCiStepNames", () => {
  it("extracts step names from YAML", () => {
    const yaml = "      - name: Typecheck\n      - name: Lint\n";
    expect(extractCiStepNames(yaml)).toEqual(["Typecheck", "Lint"]);
  });

  it("ignores empty step name", () => {
    const yaml = "      - name: \n      - name: Lint\n";
    expect(extractCiStepNames(yaml)).toEqual(["Lint"]);
  });
});
