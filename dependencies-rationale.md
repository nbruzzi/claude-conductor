<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Dependency Rationale

Every runtime dependency added to `claude-conductor` requires an entry here documenting (a) why it's needed, (b) what alternatives were considered, (c) what's the supply-chain footprint (transitive count + license).

## Active runtime dependencies

_(none yet — Phase 0 in progress)_

## Active dev dependencies

_(none yet — typecheck + format + lint will use Bun stdlib + tsc + prettier + eslint added during Phase 0)_

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
