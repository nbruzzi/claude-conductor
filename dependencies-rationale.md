<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Dependency Rationale

Every runtime dependency added to `claude-conductor` requires an entry here documenting (a) why it's needed, (b) what alternatives were considered, (c) what's the supply-chain footprint (transitive count + license).

## Active runtime dependencies

_(none yet — Phase 0 sub-steps 0.4+ will add components that may pull deps; each gets a rationale entry)_

## Active dev dependencies

| Package                            | Version | Why needed                                                                                   | Alternatives considered                                                                |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@types/bun`                       | latest  | Type definitions for Bun runtime APIs (Bun.spawn, Bun.file, etc.) used in plugin code.       | Hand-rolled type stubs — too fragile, breaks on Bun version bumps.                     |
| `@typescript-eslint/eslint-plugin` | ^8.0.0  | TypeScript-aware lint rules per the parent plan's professional-product code-style standards. | Plain ESLint rules — insufficient for TS-specific concerns (no-explicit-any, etc.).    |
| `@typescript-eslint/parser`        | ^8.0.0  | Parser for `@typescript-eslint/eslint-plugin`. Mandatory peer.                               | None — required by the plugin.                                                         |
| `eslint`                           | ^9.0.0  | Lint runner. Phase 0 sub-step 0.1.1 + ongoing per-phase audit gates.                         | Biome — considered but ESLint v9 has better TS-strict rule coverage today.             |
| `prettier`                         | ^3.0.0  | Format runner. Phase 0 sub-step 0.1 pre-commit gate.                                         | Biome (combined lint + format) — see ESLint comment; reconsider when Biome catches up. |
| `typescript`                       | ^5.5.0  | tsc compiler. Phase 0 sub-step 0.1 typecheck gate.                                           | None — TypeScript is the language.                                                     |

## Stdlib reliance

Whenever possible, prefer Bun standard library + Node standard library over npm packages:

- File I/O: Bun's built-in `fs`/`Bun.file()` instead of fs-extra.
- Crypto: `node:crypto` instead of crypto-js.
- HTTP: built-in `fetch` instead of axios.
- Spawning: `Bun.spawn` instead of execa.
- Path: `node:path` (no path-utils package).

## Forbidden dependencies

- Anything with known unmaintained-status warning.
- Anything with a transitive dep count >100 (signals supply-chain bloat).
- Anything that requires running install scripts (postinstall, etc.) without explicit justification.
- Test runners other than Bun's built-in test runner (no jest, vitest, mocha — use `bun test`).

## Audit cadence

This file is reviewed at every per-phase audit (per the audit-skill discipline). Auditors verify that every entry in `package.json` has a corresponding rationale entry here.
