// Pure, dependency-free core of the LLM semantic fact-check reviewer.
//
// Kept separate from factCheckService (which pulls the DB + provider stack) so
// the invariants that keep the reviewer honest are unit-testable in isolation:
//   STEP 1 — only lines the script marked isFactualClaim:true may fail or need
//            review. Verdicts on non-factual lines (intros, reactions,
//            fragments, interruptions) are recorded but ignored — even when the
//            LLM over-flags them.
//   STEP 2 — an "unsupported"/"needs_review" verdict with no non-empty rationale
//            is unauditable; it is downgraded to a parse-error warning and never
//            fails a script.
// Neither invariant touches the deterministic checks or the publish gate.

export type SemanticStatus = "passed" | "needs_review" | "failed";

const STATUS_SEVERITY: Record<SemanticStatus, number> = {
  passed: 0,
  needs_review: 1,
  failed: 2,
};

export function mostSevereStatus(a: SemanticStatus, b: SemanticStatus): SemanticStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

/** A line is a fragment when it trails off / is cut off (an interruption, a
 *  reaction, or an incomplete sentence). These are never factual claims — a
 *  claim needs a complete assertion. Stage directions ([interrupting],
 *  [stammers]) are stripped first so "[stammers] I— it's a start!" reads as the
 *  fragment it is. */
export function isFragmentLine(text: unknown): boolean {
  const s = String(text ?? "")
    .replace(/\[[^\]]*\]/g, " ") // drop [stage directions]
    .trim();
  if (!s) return true;
  return /[—–-]$/.test(s) || s.endsWith("...") || s.endsWith("…");
}

export interface SemanticLineProcessOutput {
  errors: any[];
  warnings: any[];
  semanticLineResults: any[];
  counts: {
    unsupported: number;
    needsReview: number;
    invalidEvidenceRef: number;
    skippedNonFactual: number;
    parseError: number;
  };
  /** Derived purely from actionable, rationale-backed findings. */
  status: SemanticStatus;
}

/**
 * Turn the semantic reviewer's per-line verdicts into actionable findings,
 * enforcing STEP 1 (scope to factual claims) and STEP 2 (require a rationale).
 * Invalid evidence refs on factual lines remain a real failure — those carry a
 * server-built rationale, so they are never rationale-less.
 */
export function processSemanticLineResults(params: {
  rawLineResults: any[];
  factualByIndex: Map<number, boolean>;
  allowedSourceRefs: Set<string>;
  originalFlatLines: Array<{ lineIndex: number; speakerName: string; text: string }>;
  validEvidenceTypes: string[];
}): SemanticLineProcessOutput {
  const { rawLineResults, factualByIndex, allowedSourceRefs, originalFlatLines, validEvidenceTypes } = params;
  const errors: any[] = [];
  const warnings: any[] = [];
  const semanticLineResults: any[] = [];
  const counts = { unsupported: 0, needsReview: 0, invalidEvidenceRef: 0, skippedNonFactual: 0, parseError: 0 };
  let status: SemanticStatus = "passed";

  for (const lr of Array.isArray(rawLineResults) ? rawLineResults : []) {
    // Enrich with original script speaker/text if the LLM returned empty strings.
    const origLine = originalFlatLines.find((ol) => ol.lineIndex === lr.lineIndex);
    if (origLine) {
      if (!lr.speakerName || !lr.speakerName.trim()) lr.speakerName = origLine.speakerName;
      if (!lr.claimText || !lr.claimText.trim()) lr.claimText = origLine.text;
    }

    // STEP 1 — only isFactualClaim:true lines may fail or need review.
    const isFactual = factualByIndex.get(lr.lineIndex) === true;
    if (!isFactual) {
      if (lr.status === "unsupported" || lr.status === "needs_review") counts.skippedNonFactual++;
      semanticLineResults.push({ ...lr, evidenceRefs: [], skippedNonFactual: true });
      continue;
    }

    // Filter out evidence refs outside allowedSourceRefs (factual lines only).
    const cleanRefs: any[] = [];
    let lineHasInvalidRef = false;
    for (const ref of Array.isArray(lr.evidenceRefs) ? lr.evidenceRefs : []) {
      let refValid = true;
      if (!ref || typeof ref !== "object" || !ref.type || !ref.id) refValid = false;
      else if (!validEvidenceTypes.includes(ref.type)) refValid = false;
      else if (!allowedSourceRefs.has(`${ref.type}:${ref.id}`)) refValid = false;

      if (!refValid) {
        lineHasInvalidRef = true;
        counts.invalidEvidenceRef++;
        errors.push({
          type: "semantic_invalid_evidence_ref",
          lineIndex: lr.lineIndex,
          reason: `Semantic review: Line #${(lr.lineIndex || 0) + 1} has invalid evidence reference ${JSON.stringify(ref)}.`,
        });
      } else {
        cleanRefs.push(ref);
      }
    }
    if (lineHasInvalidRef) {
      status = mostSevereStatus(status, lr.status === "unsupported" ? "failed" : "needs_review");
    }

    semanticLineResults.push({ ...lr, evidenceRefs: cleanRefs });

    // STEP 2 — a verdict is only actionable with a rationale. The provider does
    // not enforce the schema's required `reason` (JSON is instruction-forced,
    // not schema-validated), so a flag can arrive with no reason. Discard it as a
    // parse error; it must never fail a script.
    const hasRationale = typeof lr.reason === "string" && lr.reason.trim().length > 0;

    if (lr.status === "unsupported") {
      if (!hasRationale) {
        counts.parseError++;
        warnings.push({
          type: "semantic_parse_error",
          lineIndex: lr.lineIndex,
          reason: `Semantic reviewer returned 'unsupported' for line #${(lr.lineIndex || 0) + 1} with no rationale — discarded as an unusable verdict (parse error, not a violation).`,
        });
      } else {
        counts.unsupported++;
        status = mostSevereStatus(status, "failed");
        errors.push({
          type: "semantic_unsupported_claim",
          lineIndex: lr.lineIndex,
          reason: `Semantic review: Line #${(lr.lineIndex || 0) + 1} is unsupported. ${lr.reason.trim()}`,
        });
      }
    } else if (lr.status === "needs_review") {
      if (!hasRationale) {
        counts.parseError++;
        warnings.push({
          type: "semantic_parse_error",
          lineIndex: lr.lineIndex,
          reason: `Semantic reviewer returned 'needs_review' for line #${(lr.lineIndex || 0) + 1} with no rationale — discarded as an unusable verdict (parse error, not a violation).`,
        });
      } else {
        counts.needsReview++;
        status = mostSevereStatus(status, "needs_review");
        warnings.push({
          type: "semantic_needs_review_claim",
          lineIndex: lr.lineIndex,
          reason: `Semantic review suspect: Line #${(lr.lineIndex || 0) + 1} needs review. ${lr.reason.trim()}`,
        });
      }
    }
  }

  return { errors, warnings, semanticLineResults, counts, status };
}
