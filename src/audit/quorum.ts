// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * Multi-persona audit-quorum check (Cycle 4+ enforcement-side substrate
 * fix; cohort cycle 2026-05-28 Pair-B Charlie-pen). Closes the R-3
 * convention-by-vigilance gap enumerated at CONTRIBUTING.md §"INSTRUCTION-
 * vs-ENFORCEMENT boundary" for "multi-persona audit dispatch verification."
 *
 * **What it gates:** for a given `target_pr`, were enough INDEPENDENT
 * perspectives applied? "Multi-persona" is multi-PERSPECTIVE, not multi-
 * session-headcount — so the quorum is a CONJUNCTION (Charlie+Delta
 * cross-pair convergence 2026-05-28; both arrived at the same synthesis
 * from opposite starting axes):
 *
 *   - lens-diversity (PRIMARY): >= `minLenses` distinct {@link LensClass}
 *     covered across the PR's audit-verdicts. Catches "same lens xN" —
 *     three auditors all applying only Security is one perspective, not
 *     three. Default 3 per CONTRIBUTING.md line 14 ("3 minimum personas").
 *   - auditor-independence (FLOOR): >= `minAuditors` distinct auditor
 *     identities. Catches the pure-lens-diversity hole — a single auditor
 *     self-declaring N lens-classes in one verdict's `lens_set_applied`
 *     would satisfy lens-diversity with ZERO independent eyes. Default 2.
 *
 * **Self-audit exclusion:** verdicts whose `auditor_identity` equals the
 * verdict's own `target_peer` (the addressee = the original audit-ask
 * author) are dropped — auditing a PR addressed to yourself is not an
 * independent perspective (Delta catch, cross-pair convergence).
 *
 * **Why this is a LOCAL verb, not a CI check** (the load-bearing premise
 * correction for this lane): audit-verdicts live in the channel JSONL
 * under `~/.claude/channels/<id>/` — operator-LOCAL + ephemeral, never
 * pushed to the git remote. GitHub Actions checks out the REPO only, so a
 * CI step literally cannot see the data this gate inspects. The sibling
 * `audit verify` (signature-chain) verb is local for the same reason. The
 * CONTRIBUTING.md "CI workflow + branch-protection rule" framing was
 * architecturally impossible; this ships as a local pre-merge verb wired
 * into the cohort audit-loop-closure discipline instead. See the doc-fix
 * landed in the same PR.
 *
 * **Composition, not reimplementation:** by default counts shape-PARSEABLE
 * verdicts across BOTH wire-shapes via the SSOT
 * {@link parseAuditVerdictBodyAnyVersion} helper (raw v0.1/v0.2 + v0.3
 * DSSE-wrapped) — without wrapped-dispatch, signed verdicts would be silently
 * skipped → false quorum-NOT-met once the cohort signs. The default is
 * SHAPE-only (does NOT verify the signature; a signed-but-tampered verdict
 * still counts). The opt-in {@link AuditQuorumOptions.requireSigned} axis
 * composes `audit/verify.ts` — the I/O caller supplies the failed-chain
 * `at_msg_seq` set as {@link AuditQuorumOptions.brokenSignatureSeqs} — so only
 * crypto-VALID v0.3 verdicts count; default off preserves back-compat with
 * pre-v0.3 unsigned verdicts.
 *
 * **Known boundaries** (cross-pair audit OBS, cohort cycle 2026-05-28):
 *
 *   - Independence is PROXIED via the verdict addressee: self-audit
 *     exclusion drops `auditor_identity === target_peer`. This holds under
 *     the cohort convention that a verdict addresses the audited PR's
 *     author, but would NOT catch a PR-author auditing their own PR while
 *     addressing the verdict to a third party. The opt-in
 *     {@link AuditQuorumOptions.prAuthor} (`--pr-author`) closes that hole by
 *     also excluding `auditor_identity === prAuthor` (Bravo OBS-B1).
 *   - Lens-diversity is the UNION of `lens_set_applied` across counted
 *     verdicts — NOT required to be distributed across auditors. One
 *     auditor declaring [A,B,C] plus a second declaring [A] passes (3
 *     lenses + 2 auditors). Deliberate: lens-diversity is PRIMARY,
 *     auditor count is the independence FLOOR (Bravo OBS-B2).
 *   - Gates DECLARED diversity, not SUBSTANTIVE: `lens_set_applied` is
 *     auditor-self-declared, so this is a metadata gate (an over-declaring
 *     auditor is not caught here). Substance is backstopped by cohort-
 *     precedent + the audit-loop; crypto-validity is the orthogonal opt-in
 *     {@link AuditQuorumOptions.requireSigned} axis (Bravo OBS-B3).
 *
 * Pure functions modulo the caller-supplied message set (no I/O here; the
 * CLI does `readMessages` + body-ref hydration and passes them in, mirroring
 * `reciprocation/graph.ts` + `audits/cli.ts`).
 */

import {
  parseAuditVerdictBody,
  parseAuditVerdictBodyAnyVersion,
  parseAuditVerdictV0_3Wrapped,
  type AuditVerdictBody,
} from "../channels/audit-verdict.ts";
import type { AuditClass, LensClass } from "../channels/audit-types.ts";
import type { ChannelMessage } from "../channels/index.ts";

/** Default lens-diversity quorum — CONTRIBUTING.md line 14 "3 minimum personas". */
export const DEFAULT_MIN_LENSES = 3;

/** Default auditor-independence floor — blocks single-author N-hats quorum. */
export const DEFAULT_MIN_AUDITORS = 2;

/** The PR under audit. Mirror of `AuditVerdictBody.target_pr`. */
export type TargetPr = { repo: string; number: number };

/** Tunable quorum thresholds; both default to the cohort-canonical values. */
export type AuditQuorumOptions = {
  minLenses?: number;
  minAuditors?: number;
  /**
   * Opt-in crypto-validity filter. When true, ONLY v0.3 DSSE-wrapped verdicts
   * whose signature chain VERIFIES count toward quorum — raw/unsigned
   * (v0.1/v0.2) verdicts and signature/chain-broken ones are excluded. Default
   * off preserves back-compat (counts any shape-parseable verdict via the SSOT
   * helper). The I/O caller (CLI) supplies {@link brokenSignatureSeqs} from
   * `audit/verify.ts`; this function stays pure (no crypto here).
   */
  requireSigned?: boolean;
  /**
   * Full-array message indices (verify.ts `at_msg_seq`) whose v0.3 signature
   * chain FAILED — supplied by the CLI from
   * `verifyChannelAuditChain(...).output.breaks`. Consulted only when
   * {@link requireSigned}. Index basis MUST match this call's `messages`
   * ordering; the CLI reads the same channel for both verify and quorum within
   * one command, so the full-array indices align. Absent ⇒ no wrapped verdict
   * is treated as broken (requireSigned still excludes raw/unsigned).
   */
  brokenSignatureSeqs?: ReadonlySet<number>;
  /**
   * The audited PR's author identity. When set, verdicts whose
   * `auditor_identity` equals it are excluded as non-independent — closes
   * OBS-B1 (a PR-author auditing their own PR while addressing the verdict to a
   * third party evades the `auditor === target_peer` self-exclusion).
   */
  prAuthor?: string;
};

/**
 * Quorum report for one `target_pr`. `ok` is the conjunction outcome;
 * `shortfalls` is empty iff `ok`. Distinct-value arrays are sorted for
 * deterministic output (test-friendly + grep-friendly).
 */
export type AuditQuorumReport = {
  target_pr: TargetPr;
  /** Distinct auditor identities, self-audits excluded. Sorted. */
  distinct_auditors: string[];
  /** Distinct lens-classes covered across the PR's verdicts. Sorted. */
  distinct_lenses: LensClass[];
  /** Distinct audit_classes (pair-topology coverage). Informational. Sorted. */
  distinct_audit_classes: AuditClass[];
  /** Count of parseable, target-matched, non-self audit-verdicts counted. */
  verdicts_considered: number;
  /** Count of verdicts dropped because auditor_identity === target_peer. */
  self_audits_excluded: number;
  /** Echo of the requireSigned option — true iff the crypto-validity filter was engaged. */
  require_signed: boolean;
  /** Under requireSigned: count of raw/unsigned (pre-v0.3) verdicts excluded. 0 otherwise. */
  unsigned_excluded: number;
  /** Under requireSigned: count of v0.3 verdicts whose signature chain failed to verify. 0 otherwise. */
  invalid_signature_excluded: number;
  /** The PR author used for independence exclusion, or null when not supplied. */
  pr_author: string | null;
  /** Count of verdicts dropped because auditor_identity === pr_author (OBS-B1). */
  pr_author_audits_excluded: number;
  min_lenses: number;
  min_auditors: number;
  /** True iff BOTH thresholds met. */
  ok: boolean;
  /** Human-readable shortfall lines; empty iff `ok`. */
  shortfalls: string[];
};

type ComputeArgs = {
  messages: readonly ChannelMessage[];
  bodies_by_ref: ReadonlyMap<string, string>;
  target_pr: TargetPr;
  options?: AuditQuorumOptions;
};

/**
 * Match repos tolerant of the bare `<name>` vs owner-prefixed
 * `<owner>/<name>` wire-shape divergence (same normalization
 * `substrate-class.ts` applies). Without this, verdicts posted with
 * `"claude-conductor"` and `"nbruzzi/claude-conductor"` would split into
 * two buckets for the same PR.
 */
function repoMatches(a: string, b: string): boolean {
  const suffix = (s: string): string => {
    const trimmed = s.trim();
    const slash = trimmed.indexOf("/");
    return slash === -1 ? trimmed : trimmed.slice(slash + 1);
  };
  return suffix(a) === suffix(b);
}

/** Inline `body` wins; else hydrate from the body-ref map. Null if neither. */
function resolveMessageBody(
  message: ChannelMessage,
  bodies_by_ref: ReadonlyMap<string, string>,
): string | null {
  if (message.body !== undefined) return message.body;
  if (message.body_ref !== undefined) {
    const fromMap = bodies_by_ref.get(message.body_ref);
    if (fromMap !== undefined) return fromMap;
  }
  return null;
}

/**
 * Compute the multi-persona audit quorum for one `target_pr` from a
 * channel's messages. See module JSDoc for the conjunction rationale.
 */
export function computeAuditQuorum(args: ComputeArgs): AuditQuorumReport {
  const minLenses = args.options?.minLenses ?? DEFAULT_MIN_LENSES;
  const minAuditors = args.options?.minAuditors ?? DEFAULT_MIN_AUDITORS;
  const requireSigned = args.options?.requireSigned ?? false;
  const brokenSignatureSeqs = args.options?.brokenSignatureSeqs;
  const prAuthor = args.options?.prAuthor?.trim();
  const prAuthorActive = prAuthor !== undefined && prAuthor.length > 0;

  const auditors = new Set<string>();
  const lenses = new Set<LensClass>();
  const auditClasses = new Set<AuditClass>();
  let verdictsConsidered = 0;
  let selfAuditsExcluded = 0;
  let unsignedExcluded = 0;
  let invalidSignatureExcluded = 0;
  let prAuthorAuditsExcluded = 0;

  // msgSeq is the index into the FULL message array — it MUST share verify.ts's
  // `at_msg_seq` basis (both iterate the same readMessages output) so
  // brokenSignatureSeqs lookups line up under requireSigned.
  let msgSeq = -1;
  for (const m of args.messages) {
    msgSeq += 1;
    if (m.kind !== "audit-verdict") continue;
    if (m.identity === undefined || m.identity.length === 0) continue;
    const bodyRaw = resolveMessageBody(m, args.bodies_by_ref);
    if (bodyRaw === null) continue;

    let body: AuditVerdictBody | null;
    if (requireSigned) {
      // Crypto-validity filter: count ONLY v0.3 DSSE-wrapped verdicts whose
      // chain verifies. A raw (unsigned) verdict is excluded; a wrapped verdict
      // whose signature/chain broke (per verify.ts breaks[] → brokenSignatureSeqs)
      // is excluded. Keeps this function pure — the CLI runs the crypto walk.
      const wrapped = parseAuditVerdictV0_3Wrapped(bodyRaw);
      if (wrapped === null) {
        // Not DSSE-wrapped. Count an unsigned-exclusion only for a real
        // (raw-parseable) verdict, not arbitrary non-verdict garbage.
        if (parseAuditVerdictBody(bodyRaw) !== null) unsignedExcluded += 1;
        continue;
      }
      if (brokenSignatureSeqs?.has(msgSeq)) {
        invalidSignatureExcluded += 1;
        continue;
      }
      body = wrapped.body;
    } else {
      // Default: count any shape-parseable verdict (both wire-shapes) via the
      // SSOT helper — signature validity is the orthogonal requireSigned axis.
      body = parseAuditVerdictBodyAnyVersion(bodyRaw);
    }
    if (body === null) continue;
    if (body.target_pr.number !== args.target_pr.number) continue;
    if (!repoMatches(body.target_pr.repo, args.target_pr.repo)) continue;

    // Self-audit: the auditor is the verdict's own addressee (the PR's
    // audit-ask author). Not an independent perspective — exclude.
    // `target_peer` is parser-trimmed; trim identity too so a whitespace-
    // laden identity can't evade exclusion (Delta NIT hardening).
    const identity = m.identity.trim();
    if (identity === body.target_peer) {
      selfAuditsExcluded += 1;
      continue;
    }
    // Independence (OBS-B1): a verdict authored by the PR's own author is not
    // an independent perspective even when addressed to a third party. Applied
    // only when the caller supplies the PR author via --pr-author.
    if (prAuthorActive && identity === prAuthor) {
      prAuthorAuditsExcluded += 1;
      continue;
    }

    verdictsConsidered += 1;
    auditors.add(identity);
    for (const lens of body.lens_set_applied) lenses.add(lens);
    auditClasses.add(body.audit_class);
  }

  const distinctAuditors = [...auditors].sort();
  const distinctLenses = [...lenses].sort();
  const distinctAuditClasses = [...auditClasses].sort();

  const shortfalls: string[] = [];
  if (distinctLenses.length < minLenses) {
    shortfalls.push(
      `lens-diversity: ${distinctLenses.length} distinct lens-class(es) < required ${minLenses} (covered: [${distinctLenses.join(", ")}])`,
    );
  }
  if (distinctAuditors.length < minAuditors) {
    shortfalls.push(
      `auditor-independence: ${distinctAuditors.length} distinct auditor(s) < required ${minAuditors} (auditors: [${distinctAuditors.join(", ")}])`,
    );
  }

  return {
    target_pr: { repo: args.target_pr.repo, number: args.target_pr.number },
    distinct_auditors: distinctAuditors,
    distinct_lenses: distinctLenses,
    distinct_audit_classes: distinctAuditClasses,
    verdicts_considered: verdictsConsidered,
    self_audits_excluded: selfAuditsExcluded,
    require_signed: requireSigned,
    unsigned_excluded: unsignedExcluded,
    invalid_signature_excluded: invalidSignatureExcluded,
    pr_author: prAuthorActive ? prAuthor : null,
    pr_author_audits_excluded: prAuthorAuditsExcluded,
    min_lenses: minLenses,
    min_auditors: minAuditors,
    ok: shortfalls.length === 0,
    shortfalls,
  };
}

/**
 * Render a quorum report as grep-friendly plain text (one field per line),
 * mirroring `audit/verify.ts` `renderHuman`. CLI uses this for
 * `--output human`.
 */
export function renderQuorumHuman(report: AuditQuorumReport): string {
  const lines: string[] = [];
  lines.push(`ok: ${report.ok}`);
  lines.push(`target_pr: ${report.target_pr.repo}#${report.target_pr.number}`);
  lines.push(
    `distinct_lenses: ${report.distinct_lenses.length} (>= ${report.min_lenses} required) [${report.distinct_lenses.join(", ")}]`,
  );
  lines.push(
    `distinct_auditors: ${report.distinct_auditors.length} (>= ${report.min_auditors} required) [${report.distinct_auditors.join(", ")}]`,
  );
  lines.push(
    `distinct_audit_classes: [${report.distinct_audit_classes.join(", ")}]`,
  );
  lines.push(`verdicts_considered: ${report.verdicts_considered}`);
  if (report.require_signed) {
    lines.push(`require_signed: true`);
    if (report.unsigned_excluded > 0) {
      lines.push(`unsigned_excluded: ${report.unsigned_excluded}`);
    }
    if (report.invalid_signature_excluded > 0) {
      lines.push(
        `invalid_signature_excluded: ${report.invalid_signature_excluded}`,
      );
    }
  }
  if (report.self_audits_excluded > 0) {
    lines.push(`self_audits_excluded: ${report.self_audits_excluded}`);
  }
  if (report.pr_author !== null) {
    lines.push(`pr_author: ${report.pr_author}`);
    if (report.pr_author_audits_excluded > 0) {
      lines.push(
        `pr_author_audits_excluded: ${report.pr_author_audits_excluded}`,
      );
    }
  }
  for (const s of report.shortfalls) lines.push(`shortfall: ${s}`);
  return lines.join("\n") + "\n";
}
