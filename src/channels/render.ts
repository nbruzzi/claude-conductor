// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Single-message display renderer for the `read` CLI verb.
 *
 * Implements the **7-cell display matrix + 2 soft-wrap scenarios** from
 * parent plan §311-321 (renamed from "9-cell" per Wave 0 CLI DX-7 audit
 * finding — see `~/.claude/plans/vivid-seeking-crayon.md` line 19).
 *
 * **NOT exported externally** — `package.json` `exports` field intentionally
 * excludes `./channels/render` per plan vivid-seeking-crayon §110. The
 * module is consumed only by `src/channels/cli.ts` (read verb) and by
 * `test/channels/render.test.ts`.
 *
 * Internal-only because the render format is a CLI presentation choice,
 * not a stable contract — callers that need structured access should use
 * `read --json` (raw `ChannelMessage[]`) instead.
 *
 * ─── 7-cell matrix ─────────────────────────────────────────────
 *
 *   1. identity + role + body inline
 *      → "[<ts>] <identity> (<role>): <body>"
 *
 *   2. identity + role + body_ref
 *      → "[<ts>] <identity> (<role>) [body-ref:<ref>]"
 *
 *   3. identity, no role + body inline
 *      → "[<ts>] <identity>: <body>"
 *
 *   4. identity, no role + body_ref
 *      → "[<ts>] <identity> [body-ref:<ref>]"
 *
 *   5. legacy (no identity, no role) + body inline
 *      → "[<ts>] <unknown>: <body>"
 *
 *   6. legacy + body_ref
 *      → "[<ts>] <unknown> [body-ref:<ref>]"
 *
 *   7. malformed (neither body NOR body_ref, OR both present)
 *      → "[<ts>] <identity-or-unknown>: <malformed: <reason>>"
 *      + warn-once-per-process via `console.error` (deduped by reason key)
 *
 * Cells 5 + 6 are how legacy pre-Phase-1 messages render — `<unknown>`
 * standing in for the absent NATO identity. Cell 7 is the anomaly path:
 * messages that violate the schema invariant `body XOR body_ref`. The
 * warn-once dedup avoids spamming when reading a long log of malformed
 * entries — operators see one warning, then the message bodies render
 * inline so the corrupt content is still visible.
 *
 * ─── Soft-wrap scenarios ───────────────────────────────────────
 *
 *   A. Body containing literal newlines:
 *      Each `\n` in the body becomes `\n  ` (continuation indent), so a
 *      multi-line message visually associates with its speaker label
 *      across lines. Input: `"line one\nline two"` → Output (after the
 *      `:` prefix): `"line one\n  line two"`.
 *
 *   B. Long body without literal newlines:
 *      NOT auto-wrapped. The terminal handles soft-wrap based on its
 *      column width. The renderer is content-shape-aware, not column-
 *      width-aware — width-aware rendering would require a TTY column
 *      query, fragile across non-tty consumers (jq pipelines, file
 *      redirects, CI logs).
 *
 * ─── Test reset ────────────────────────────────────────────────
 *
 * `INTERNAL.resetWarnedKeys` clears the warn-once-dedup state for tests
 * that need to verify the "warn once per key" property in isolation. Do
 * NOT call from production code.
 */

import type { ChannelMessage } from "./index.ts";

export type RenderMessageOptions = {
  /**
   * Suppress the `[ts] ` prefix. Useful for compact display modes where
   * timestamps are shown elsewhere (e.g., in column headers). Defaults
   * to `false` — timestamps included.
   */
  readonly suppressTimestamp?: boolean;
};

/**
 * Format a single `ChannelMessage` for human-readable display per the
 * 7-cell + 2 soft-wrap matrix documented in this file's header.
 *
 * Pure function modulo the warn-once side effect (cell 7 only). For each
 * malformed message reason key, `console.error` fires at most once per
 * process; subsequent malformed messages with the same reason render
 * silently. Reset for tests via `INTERNAL.resetWarnedKeys()`.
 */
export function renderMessage(
  msg: ChannelMessage,
  opts: RenderMessageOptions = {},
): string {
  const tsPrefix = opts.suppressTimestamp === true ? "" : `[${msg.ts}] `;
  const identityLabel = msg.identity ?? "<unknown>";
  const roleSuffix = msg.role !== undefined ? ` (${msg.role})` : "";
  const speaker = `${identityLabel}${roleSuffix}`;

  const hasBody = msg.body !== undefined;
  const hasBodyRef = msg.body_ref !== undefined;

  // Cell 7 — malformed: schema requires exactly one of body / body_ref.
  // Render with the salvageable content + warn-once dedup so operators
  // see the corruption signal without log spam on long histories.
  if (!hasBody && !hasBodyRef) {
    warnOnce(
      "missing-body",
      `[render] message at ${msg.ts} from ${msg.from} has neither body nor body_ref (schema violation; rendering as <empty>)`,
    );
    return `${tsPrefix}${speaker}: <malformed: missing-body>`;
  }
  if (hasBody && hasBodyRef) {
    warnOnce(
      "both-body-and-body-ref",
      `[render] message at ${msg.ts} from ${msg.from} has both body AND body_ref (schema violation; rendering inline body, body_ref ignored)`,
    );
    // Salvage: render the inline body since it's the cheaper-to-display path.
    return `${tsPrefix}${speaker}: ${softWrapBody(msg.body ?? "")}`;
  }

  if (hasBodyRef) {
    return `${tsPrefix}${speaker} [body-ref:${msg.body_ref ?? ""}]`;
  }

  // hasBody === true at this point.
  return `${tsPrefix}${speaker}: ${softWrapBody(msg.body ?? "")}`;
}

/**
 * Soft-wrap a body string per scenario A: literal newlines become
 * `\n  ` (continuation indent). Scenario B (long no-newline) is a
 * no-op — the terminal handles column-width wrapping.
 */
function softWrapBody(body: string): string {
  if (!body.includes("\n")) return body;
  return body.split("\n").join("\n  ");
}

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.error(message);
}

/**
 * Test-only handle for resetting warn-once dedup state. Production code
 * MUST NOT call this — the dedup is per-process and the lifetime is
 * intentional.
 */
export const INTERNAL = {
  /** Clear all warn-once dedup keys. Call from test setup. */
  resetWarnedKeys(): void {
    warnedKeys.clear();
  },
};
