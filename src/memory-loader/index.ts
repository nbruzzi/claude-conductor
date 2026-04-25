// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { memoriesDir } from "../shared/paths";

type MemoryType = "feedback" | "user" | "project" | "reference";
type Cadence = "stable" | "evolving" | "fluid";
type Scope = "global" | "project" | "tool";
type Origin = "extracted" | "template";

export type MemoryFrontmatter = {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly cadence: Cadence;
  readonly scope: Scope;
  readonly updated: string;
  readonly origin?: Origin;
};

export type MemoryEntry = {
  readonly filename: string;
  readonly path: string;
  readonly frontmatter: MemoryFrontmatter;
  readonly body: string;
};

export type MemoryLoadError = {
  readonly filename: string;
  readonly reason: string;
};

export type MemoryLoadResult = {
  readonly entries: readonly MemoryEntry[];
  readonly errors: readonly MemoryLoadError[];
};

export const NAMESPACE_PREFIX = "[claude-conductor]";

const TYPE_VALUES: readonly MemoryType[] = [
  "feedback",
  "user",
  "project",
  "reference",
];
const CADENCE_VALUES: readonly Cadence[] = ["stable", "evolving", "fluid"];
const SCOPE_VALUES: readonly Scope[] = ["global", "project", "tool"];
const ORIGIN_VALUES: readonly Origin[] = ["extracted", "template"];

function isMemoryType(value: string): value is MemoryType {
  return (TYPE_VALUES as readonly string[]).includes(value);
}

function isCadence(value: string): value is Cadence {
  return (CADENCE_VALUES as readonly string[]).includes(value);
}

function isScope(value: string): value is Scope {
  return (SCOPE_VALUES as readonly string[]).includes(value);
}

function isOrigin(value: string): value is Origin {
  return (ORIGIN_VALUES as readonly string[]).includes(value);
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

type RawFrontmatter = ReadonlyMap<string, string>;

type ValidateResult =
  | { readonly ok: true; readonly value: MemoryFrontmatter }
  | { readonly ok: false; readonly reason: string };

function parseFrontmatter(text: string): {
  raw: RawFrontmatter;
  body: string;
} | null {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return null;
  }
  const [, block, body] = match;
  if (block === undefined || body === undefined) {
    return null;
  }
  const raw = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const kv = KEY_VALUE_RE.exec(trimmed);
    if (!kv) {
      continue;
    }
    const [, key, rawValue] = kv;
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    raw.set(key, stripQuotes(rawValue));
  }
  return { raw, body };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function fail(reason: string): ValidateResult {
  return { ok: false, reason };
}

function validateFrontmatter(raw: RawFrontmatter): ValidateResult {
  const name = raw.get("name");
  const description = raw.get("description");
  const typeRaw = raw.get("type");
  const cadenceRaw = raw.get("cadence");
  const scopeRaw = raw.get("scope");
  const updated = raw.get("updated");

  if (name === undefined || name.length === 0)
    return fail("missing required frontmatter field: name");
  if (description === undefined || description.length === 0)
    return fail("missing required frontmatter field: description");
  if (typeRaw === undefined || typeRaw.length === 0)
    return fail("missing required frontmatter field: type");
  if (cadenceRaw === undefined || cadenceRaw.length === 0)
    return fail("missing required frontmatter field: cadence");
  if (scopeRaw === undefined || scopeRaw.length === 0)
    return fail("missing required frontmatter field: scope");
  if (updated === undefined || updated.length === 0)
    return fail("missing required frontmatter field: updated");

  if (!isMemoryType(typeRaw)) {
    return fail(
      `invalid type: '${typeRaw}' (allowed: ${TYPE_VALUES.join(" | ")})`,
    );
  }
  if (!isCadence(cadenceRaw)) {
    return fail(
      `invalid cadence: '${cadenceRaw}' (allowed: ${CADENCE_VALUES.join(" | ")})`,
    );
  }
  if (!isScope(scopeRaw)) {
    return fail(
      `invalid scope: '${scopeRaw}' (allowed: ${SCOPE_VALUES.join(" | ")})`,
    );
  }

  const originRaw = raw.get("origin");
  let origin: Origin | undefined;
  if (originRaw !== undefined && originRaw.length > 0) {
    if (!isOrigin(originRaw)) {
      return fail(
        `invalid origin: '${originRaw}' (allowed: ${ORIGIN_VALUES.join(" | ")})`,
      );
    }
    origin = originRaw;
  }

  const value: MemoryFrontmatter = {
    name,
    description,
    type: typeRaw,
    cadence: cadenceRaw,
    scope: scopeRaw,
    updated,
    ...(origin !== undefined ? { origin } : {}),
  };
  return { ok: true, value };
}

function isReadableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function loadMemories(dir: string = memoriesDir()): MemoryLoadResult {
  if (!isReadableDirectory(dir)) {
    return { entries: [], errors: [] };
  }

  const entries: MemoryEntry[] = [];
  const errors: MemoryLoadError[] = [];

  const filenames = readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith(".md") && !name.startsWith("_") && name !== "INDEX.md",
    )
    .sort();

  for (const filename of filenames) {
    const filePath = join(dir, filename);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      errors.push({
        filename,
        reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (parsed === null) {
      errors.push({ filename, reason: "missing or malformed frontmatter" });
      continue;
    }

    const validated = validateFrontmatter(parsed.raw);
    if (!validated.ok) {
      errors.push({ filename, reason: validated.reason });
      continue;
    }

    entries.push({
      filename,
      path: filePath,
      frontmatter: validated.value,
      body: parsed.body,
    });
  }

  return { entries, errors };
}

export function formatMemoriesIndex(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) {
    return `## Bundled Memories\n\n_No memories bundled yet._\n`;
  }

  const lines: string[] = [
    "## Bundled Memories",
    "",
    `${entries.length} discipline memor${entries.length === 1 ? "y" : "ies"} ship with the plugin under \`memories/\`. Entries are namespaced \`${NAMESPACE_PREFIX}\` to distinguish from the host project's memories.`,
    "",
  ];

  for (const entry of entries) {
    const link = `memories/${entry.filename}`;
    lines.push(
      `- ${NAMESPACE_PREFIX} [${entry.frontmatter.name}](${link}) — ${entry.frontmatter.description}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}
