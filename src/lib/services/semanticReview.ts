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

import type { LLMProvider } from "../providers/llm/interface";

export type SemanticStatus = "passed" | "needs_review" | "failed";

export interface SemanticReviewLine {
  lineIndex: number;
  speakerName: string;
  text: string;
  isFactualClaim: boolean;
  tone?: string;
  isInterruption?: boolean;
  isFragment?: boolean;
}

export interface SemanticReviewInput {
  reviewLines: SemanticReviewLine[];
  evidencePanelItems: any[];
  unsafeClaims: string[];
  rumorKeywords: string[];
}

/** The SINGLE semantic-reviewer prompt + schema, shared by the fact-check gate
 *  and the generation-time self-verify loop (one reviewer, not two). */
export function buildSemanticReviewPrompt(input: SemanticReviewInput): {
  systemPrompt: string;
  prompt: string;
  jsonSchema: any;
} {
  const systemPrompt = `You are a strict fact-checking assistant for a sports DEBATE podcast. The show format is two hosts arguing: hot takes, predictions, and judgments are the product, not violations. Your job is to verify FACTUAL ASSERTIONS against the allowed evidence records — not to demand citations for opinions.

Each line is PRE-CLASSIFIED with an "isFactualClaim" flag plus "tone", "isInterruption", and "isFragment" context. Honor them.

A FACTUAL CLAIM is a specific, checkable assertion about the world: a stat, score, record, date, result, standing, streak, transaction, injury, or an attribution/quote presented as true. Everything else is not a claim.

Rules:
1. ONLY evaluate lines where isFactualClaim is true. For every one of those, verify it against the provided facts and stats and identify unsupported claims, overstatements, missing context, misleading wording, OR a real figure attached to the WRONG subject (e.g. one team's record stated as another team's).
2. Non-factual lines (isFactualClaim false) are supported by default — never flag them. This includes rhetorical questions, exclamations, reactions, concessions, hot takes, predictions, jokes, the show intro/outro, interruptions (isInterruption true), and incomplete or cut-off sentences (isFragment true, or text ending in a dash "—"). Opinions and fragments are not verifiable and that is fine.
3. Fabricated sourcing ("sources say", "reportedly", "rumored", "insiders", "unnamed source") is prohibited on ANY line unless the provided evidence itself contains that reporting.
4. You are NOT allowed to verify using outside knowledge or make up facts. You cannot create new evidence IDs.
5. MANDATORY RATIONALE: for every line you mark "unsupported" or "needs_review", the "reason" field MUST be a specific, non-empty explanation that quotes the exact claim and says why the evidence does not support it. A verdict with an empty or missing reason is invalid and will be discarded — do not emit one.
6. OUTPUT ONLY PROBLEMS: return a lineResults entry ONLY for lines you mark "unsupported" or "needs_review". Do NOT emit an entry for any "supported" line — omit them entirely. A line absent from lineResults is treated as supported. This keeps the response small; emitting all lines can truncate it and fail the whole review.
7. Return a strict JSON response.`;

  const prompt = `Script dialogue — each line is pre-classified. Evaluate ONLY lines with isFactualClaim:true. Return a lineResults entry ONLY for lines you flag as unsupported or needs_review — omit every supported line:
${JSON.stringify(input.reviewLines)}

Allowed evidence packet:
${JSON.stringify(input.evidencePanelItems)}

Unsafe claims (strictly disallowed):
${JSON.stringify(input.unsafeClaims)}

Prohibited fabricated-sourcing phrases (banned unless the evidence packet itself contains that reporting):
${JSON.stringify(input.rumorKeywords)}

Reminder: predictive hedging ("expected to", "likely to", "could be", "might be") is NORMAL debate speech on opinion/prediction lines — never a violation by itself.

Run the fact-checking comparison and output the JSON structure containing status, summary, and lineResults (flagged lines only).`;

  const jsonSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["passed", "failed", "needs_review"] },
      summary: { type: "string" },
      lineResults: {
        type: "array",
        items: {
          type: "object",
          properties: {
            segmentIndex: { type: "integer" },
            lineIndex: { type: "integer" },
            speakerName: { type: "string" },
            claimText: { type: "string" },
            status: { type: "string", enum: ["supported", "unsupported", "needs_review"] },
            reason: { type: "string" },
            evidenceRefs: {
              type: "array",
              items: {
                type: "object",
                properties: { type: { type: "string" }, id: { type: "string" } },
                required: ["type", "id"],
              },
            },
            suggestedFix: { type: "string" },
          },
          required: ["segmentIndex", "lineIndex", "speakerName", "claimText", "status", "reason", "evidenceRefs"],
        },
      },
      unsupportedClaims: { type: "array", items: { type: "string" } },
      misleadingClaims: { type: "array", items: { type: "string" } },
      unsafeClaimsUsed: { type: "array", items: { type: "string" } },
      missingEvidence: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
    },
    required: ["status", "summary", "lineResults", "unsupportedClaims", "misleadingClaims", "unsafeClaimsUsed", "missingEvidence", "confidence"],
  };

  return { systemPrompt, prompt, jsonSchema };
}

/** One batched semantic-review LLM call. Returns the raw structured result. */
export async function runSemanticReview(provider: LLMProvider, input: SemanticReviewInput): Promise<any> {
  const { systemPrompt, prompt, jsonSchema } = buildSemanticReviewPrompt(input);
  return provider.generateStructuredOutput<any>({ prompt, systemPrompt, jsonSchema });
}

/**
 * Reuse the gate reviewer to find factual lines that need a rewrite. One batched
 * call; applies the same two invariants the gate applies (STEP 1: only
 * isFactualClaim:true lines; STEP 2: a flag needs a non-empty rationale).
 * Returns the flagged lines with the reviewer's rationale.
 */
export async function reviewFactualLinesForRewrite(
  provider: LLMProvider,
  input: SemanticReviewInput
): Promise<Array<{ lineIndex: number; status: string; reason: string }>> {
  const factualByIndex = new Map<number, boolean>();
  for (const l of input.reviewLines) factualByIndex.set(l.lineIndex, l.isFactualClaim === true);

  const resultObj = await runSemanticReview(provider, input);
  const flagged: Array<{ lineIndex: number; status: string; reason: string }> = [];
  const seen = new Set<number>();
  for (const lr of Array.isArray(resultObj?.lineResults) ? resultObj.lineResults : []) {
    if (factualByIndex.get(lr?.lineIndex) !== true) continue; // STEP 1
    if (lr.status !== "unsupported" && lr.status !== "needs_review") continue;
    const reason = typeof lr.reason === "string" ? lr.reason.trim() : "";
    if (!reason) continue; // STEP 2
    if (seen.has(lr.lineIndex)) continue;
    seen.add(lr.lineIndex);
    flagged.push({ lineIndex: lr.lineIndex, status: lr.status, reason });
  }
  return flagged;
}

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
