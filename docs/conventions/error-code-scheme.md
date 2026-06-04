<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 nbruzzi
-->

# Detector error-code scheme

Static-analysis detectors in `scripts/` emit compiler-style violations using a
unified error-code format. This document is the source-of-truth for the
scheme; new detectors MUST follow it.

## Format

```
<file>:<line>:<col>: error[<DETECTOR-PREFIX>-<NNN>]: <message>
```

Where:

- `<DETECTOR-PREFIX>` is a 3-letter (uppercase) identifier for the detector.
- `<NNN>` is a zero-padded 3-digit number for the violation class within
  that detector.

The space allows 999 violation classes per detector, which is forever for
the use case.

## Detector prefixes

| Prefix | Detector                           | Script                                          |
| ------ | ---------------------------------- | ----------------------------------------------- |
| `CGP`  | check-generic-paths                | `scripts/check-generic-paths.sh`                |
| `CIE`  | check-import-extensions            | `scripts/check-import-extensions.sh`            |
| `LGC`  | check-liveness-gate-store-contract | `scripts/check-liveness-gate-store-contract.sh` |

## Active codes

### `CGP` — check-generic-paths

- `CGP-001` — hardcoded user identifier `nbruzzi` (substrate leak). Remediation: parameterize via `effectiveHome()` from `src/shared/home.ts`, or extend Layer 1 allowlist in the detector if intentional fixture.
- `CGP-002` — hardcoded `/Users/<name>/` absolute path (non-portable). Remediation: use `path.join(homedir(), ...)` or `process.env.HOME`-based construction.
- `CGP-003` — `.claude/` literal under `src/` outside the 12-file bypasser allowlist. Remediation: route through `paths.ts` (`channelsDir` / `todosDir` / `activeSessionsDir` / etc.), or add the file to `P3_FILE_ALLOWLIST` in the detector with rationale.
- `CGP-004` — potential anonymization leak (7-40 char hex string bordered by non-letter, non-backtick chars). Remediation: verify it is not a real SHA / commit / cache key; if intentional reference, quote in backticks (`` `<sha>` ``) to mark as documentation, or rewrite using a parameterized constant.

### `CIE` — check-import-extensions

- `CIE-001` — relative import missing `.ts` extension. Remediation: add the explicit `.ts` (or `.json`) extension to the import path. Covers both statement-form (static) imports and call-site-form (dynamic) imports — same root cause.

### `LGC` — check-liveness-gate-store-contract

- `LGC-001` — a `src/` file calls a liveness prefix-helper (`isSessionLiveByPrefix` / `isSidPrefixLiveOnChannel`) but is not on the gate `ALLOWLIST`. Remediation: classify the new gate per `docs/conventions/liveness-gate-store-contract.md` (alive-anywhere → consult ALL stores at every decision point it acts on liveness; store-specific → the one store that defines that participation), then add the file to `ALLOWLIST` in the detector with the classification; or route the liveness decision through an allow-listed gate.

## Adding a new code

1. Pick the existing detector's next available `NNN` (e.g., `CGP-005`).
2. Add the case-arm in the detector's awk emit block.
3. Add the row to the §Active codes table above.
4. Update the detector's existing test to assert the new code on a fixture
   that triggers the new class.

## Adding a new detector

1. Pick a 3-letter uppercase prefix not in use (table above). Avoid letters
   already used informally (`P`, `T` were retired — used pre-slice-6
   convention; do not reuse to avoid catalog confusion).
2. Start the detector's catalog at `<PREFIX>-001`.
3. Add a row to the §Detector prefixes table.
4. Emit the codes in the same compiler-style format (`<file>:<line>:<col>: error[<code>]: <msg>`)
   for IDE clickthrough + GitHub Actions annotation parity.

## Breaking change notice (slice 6, 2026-05-18)

The pre-slice-6 codes (`P1` / `P2` / `P3` / `P4` for check-generic-paths;
`T1` for check-import-extensions) were renamed to the unified
`<DETECTOR-PREFIX>-<NNN>` scheme. Primary-source verification at the time
of the rename confirmed zero external consumers of the old codes outside
the detector scripts themselves — Phase 0 → v0.1.0 boundary made it the
tolerable churn window.

Old → new:

| Old  | New       |
| ---- | --------- |
| `P1` | `CGP-001` |
| `P2` | `CGP-002` |
| `P3` | `CGP-003` |
| `P4` | `CGP-004` |
| `T1` | `CIE-001` |

If you have local tooling that parses the old codes (CI log greps, IDE
annotation regex, GHA workflow assertions), update to the new format.
