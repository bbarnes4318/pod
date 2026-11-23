// Business fact-check verification states and the business release rule
// (directives §4 and §7).
//
// Deterministic checks and semantic verification are different things and are
// reported separately. "No semantic judge configured" is UNAVAILABLE, never a
// pass. A business script is releasable to voicing/stitching/publishing only
// when the latest fact-check reached FACT_CHECK_PASSED for THIS exact text —
// either by independent semantic verification, or by an attributable human
// factual review. A general editorial release (`humanRelease`) does not satisfy
// this rule: editorial approval is not a statement about factual accuracy.
//
// Pure functions here; the guard, the publish validator and the Studio action
// call them. Sports scripts (no `kind: "business"`) are never affected.

import crypto from "node:crypto";

export type DeterministicState = "DETERMINISTIC_CHECK_PASSED" | "FACT_CHECK_FAILED";
export type SemanticState = "SEMANTIC_VERIFICATION_PASSED" | "SEMANTIC_VERIFICATION_UNAVAILABLE" | "SEMANTIC_VERIFICATION_FAILED";
export type OverallState = "FACT_CHECK_PASSED" | "FACT_CHECK_FAILED" | "NEEDS_HUMAN_REVIEW";
export type VerificationBasis = "SEMANTIC" | "HUMAN_REVIEW" | null;

/** Per-claim outcome. A human review never rewrites these. */
export type ClaimStatus =
  | "SUPPORTED"            // cited; deterministic ok; independent judge entailed
  | "CITED_UNVERIFIED"     // cited; deterministic ok; no independent judge ran
  | "INSUFFICIENT_EVIDENCE"// cited; judge: evidence doesn't establish it
  | "CONTRADICTED"         // cited; judge or deterministic check: evidence contradicts it
  | "UNSUPPORTED"          // factual, no citation
  | "NOT_A_CLAIM";         // soft detection cleared by the independent classifier

export interface ClaimOutcome {
  lineIndex: number;
  text: string;
  kinds: string[];
  detectedBy: ("writer_label" | "deterministic" | "classifier")[];
  status: ClaimStatus;
  factIds: string[];
  note?: string;
}

export interface BusinessVerification {
  deterministic: DeterministicState;
  semantic: SemanticState;
  overall: OverallState;
  basis: VerificationBasis;
  /** Fingerprint of the spoken text the verdict applies to. */
  fingerprint: string;
  factCheckResultId: string | null;
  checkedAt: string;
  judge: string | null;
  reasons: string[];
  claimCounts: Partial<Record<ClaimStatus, number>>;
}

/** Attributable human factual review: the documented path when semantic verification is unavailable or inconclusive. */
export interface BusinessFactReview {
  actor: string;
  at: string;
  scriptId: string;
  scriptVersion: number;
  fingerprint: string;
  reason: string;
  /** What the reviewer signed off on, verbatim: unresolved claims stay listed with their original statuses. */
  unresolved: { lineIndex: number; text: string; status: ClaimStatus }[];
  permittedStages: string[];
}

export const BUSINESS_RELEASE_STAGES = ["tts:generate-segments", "audio:stitch-final", "audio:regenerate-line", "publish"] as const;

type Line = { lineIndex?: number; speakerHostId?: string; speakerName?: string; text?: string };

/** sha256 over (lineIndex, speaker, text) of every line. Any spoken-text edit changes it. */
export function scriptTextFingerprint(content: unknown): string {
  const segs = (content as { segments?: { lines?: Line[] }[] } | null)?.segments ?? [];
  const canon = segs.flatMap((s) => (s.lines ?? []).map((l) => `${l.lineIndex ?? ""}\u0001${l.speakerHostId ?? l.speakerName ?? ""}\u0001${(l.text ?? "").trim()}`)).join("\u0002");
  return crypto.createHash("sha256").update(canon).digest("hex");
}

export function combineStates(input: {
  deterministicErrors: number;
  contradicted: number;
  semantic: SemanticState;
  unresolved: number;
}): { deterministic: DeterministicState; overall: OverallState } {
  const deterministic: DeterministicState = input.deterministicErrors ? "FACT_CHECK_FAILED" : "DETERMINISTIC_CHECK_PASSED";
  if (input.deterministicErrors || input.contradicted) return { deterministic, overall: "FACT_CHECK_FAILED" };
  if (input.semantic === "SEMANTIC_VERIFICATION_PASSED" && input.unresolved === 0) return { deterministic, overall: "FACT_CHECK_PASSED" };
  return { deterministic, overall: "NEEDS_HUMAN_REVIEW" };
}

export interface BusinessReleaseVerdict {
  applies: boolean;
  allowed: boolean;
  state: OverallState | "NOT_FACT_CHECKED" | "TEXT_CHANGED_SINCE_CHECK";
  basis: VerificationBasis;
  reasons: string[];
}

/**
 * May this script content enter `stage`? Non-business content: always (rule doesn't apply).
 * Business: needs FACT_CHECK_PASSED on the current text; a HUMAN_REVIEW basis
 * must also cover the stage and the current text.
 */
export function evaluateBusinessRelease(content: unknown, stage: string): BusinessReleaseVerdict {
  const c = content as { kind?: string; businessVerification?: BusinessVerification; businessFactReview?: BusinessFactReview } | null;
  if (c?.kind !== "business") return { applies: false, allowed: true, state: "FACT_CHECK_PASSED", basis: null, reasons: [] };
  const v = c.businessVerification;
  if (!v) return { applies: true, allowed: false, state: "NOT_FACT_CHECKED", basis: null, reasons: ["This business script has not been fact-checked."] };
  const fp = scriptTextFingerprint(content);
  if (v.fingerprint !== fp) {
    return { applies: true, allowed: false, state: "TEXT_CHANGED_SINCE_CHECK", basis: v.basis, reasons: ["The script text changed after its fact-check. Re-run the fact-check."] };
  }
  if (v.overall !== "FACT_CHECK_PASSED") {
    return { applies: true, allowed: false, state: v.overall, basis: v.basis, reasons: v.reasons.length ? v.reasons : [`Fact-check state is ${v.overall}.`] };
  }
  if (v.basis === "HUMAN_REVIEW") {
    const r = c.businessFactReview;
    if (!r || r.fingerprint !== fp) return { applies: true, allowed: false, state: "NEEDS_HUMAN_REVIEW", basis: v.basis, reasons: ["The human factual review does not cover the current script text."] };
    if (!r.permittedStages.includes(stage)) return { applies: true, allowed: false, state: "NEEDS_HUMAN_REVIEW", basis: v.basis, reasons: [`The human factual review by ${r.actor} does not permit ${stage}.`] };
    return { applies: true, allowed: true, state: "FACT_CHECK_PASSED", basis: v.basis, reasons: [`Human factual review by ${r.actor} at ${r.at}: ${r.reason}`] };
  }
  return { applies: true, allowed: true, state: "FACT_CHECK_PASSED", basis: v.basis, reasons: [] };
}

export class BusinessFactHoldError extends Error {
  readonly code = "BUSINESS_FACT_HOLD";
  constructor(readonly scriptId: string, readonly stage: string, readonly verdict: BusinessReleaseVerdict) {
    super(`Business script ${scriptId} cannot enter ${stage}: ${verdict.state}. ${verdict.reasons.join(" ")} Resolve it in Studio (fact-check, or record a human factual review).`);
    this.name = "BusinessFactHoldError";
  }
}

/** Throw unless the business rule allows `stage`. No-op for sports. */
export function assertBusinessRelease(scriptId: string, content: unknown, stage: string): BusinessReleaseVerdict {
  const v = evaluateBusinessRelease(content, stage);
  if (!v.allowed) throw new BusinessFactHoldError(scriptId, stage, v);
  return v;
}

/**
 * Build the review record + the updated verification. Pure; the caller persists.
 * Refuses FACT_CHECK_FAILED (deterministic errors / contradictions are fixed by
 * editing, not signed off) and stale fingerprints. A reason is mandatory.
 */
export function buildFactReview(input: {
  content: unknown;
  scriptId: string;
  scriptVersion: number;
  actor: string;
  reason: string;
  claims: ClaimOutcome[];
  permittedStages?: string[];
  now?: Date;
}): { ok: true; review: BusinessFactReview; verification: BusinessVerification } | { ok: false; error: string } {
  const c = input.content as { kind?: string; businessVerification?: BusinessVerification } | null;
  if (c?.kind !== "business") return { ok: false, error: "Not a business script." };
  const v = c.businessVerification;
  if (!v) return { ok: false, error: "Run the fact-check first." };
  const fp = scriptTextFingerprint(input.content);
  if (v.fingerprint !== fp) return { ok: false, error: "The script changed since its fact-check. Re-run the fact-check, then review." };
  if (v.overall === "FACT_CHECK_FAILED") return { ok: false, error: "The fact-check failed (an invented number, a contradiction, or a bad citation). Fix the script; a review can't sign that off." };
  if (v.overall === "FACT_CHECK_PASSED" && v.basis === "SEMANTIC") return { ok: false, error: "This script already passed independent verification." };
  const reason = input.reason.trim();
  if (reason.length < 10) return { ok: false, error: "Say what you checked (at least a sentence)." };
  if (!input.actor.trim()) return { ok: false, error: "A review must be attributable to a person." };
  const at = (input.now ?? new Date()).toISOString();
  const unresolved = input.claims.filter((x) => x.status !== "SUPPORTED" && x.status !== "NOT_A_CLAIM").map((x) => ({ lineIndex: x.lineIndex, text: x.text, status: x.status }));
  const review: BusinessFactReview = {
    actor: input.actor, at, scriptId: input.scriptId, scriptVersion: input.scriptVersion, fingerprint: fp, reason,
    unresolved, permittedStages: input.permittedStages?.length ? input.permittedStages : [...BUSINESS_RELEASE_STAGES],
  };
  return {
    ok: true,
    review,
    verification: { ...v, overall: "FACT_CHECK_PASSED", basis: "HUMAN_REVIEW", reasons: [`Human factual review by ${input.actor}; ${unresolved.length} claim(s) not independently verified.`] },
  };
}
