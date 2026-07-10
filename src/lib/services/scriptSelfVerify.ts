// Generation-time self-verify (FIX 1). After the act generator writes the
// script but BEFORE it is persisted, every isFactualClaim:true line is run
// through the SAME deterministic verifier the fact-check gate uses
// (verifyLineAgainstEvidence). Any line that asserts a figure or a person-
// attribution absent from its evidence is sent back to the model to be
// rewritten — with the correct figure, or restated qualitatively (the "argue
// without it" valve). This turns the post-hoc gate into a generation-time
// constraint, so we stop persisting scripts we already know will fail.
//
// Pure + injectable: the model call is passed in as `rewrite`, so the loop is
// unit-testable with a stub (no LLM/DB).

import { verifyLineAgainstEvidence, FigureVerdict } from "./factNumbers";

export interface RewriteContext {
  line: any;
  evidenceText: string; // the line's cited evidence (fallback: full corpus)
  unsupportedFigures: FigureVerdict[];
  unsupportedAttributions: string[];
  attempt: number;
}

/** Returns the corrected spoken text (and optionally revised evidenceRefs and a
 *  downgraded isFactualClaim when the line goes qualitative), or null to give up
 *  this attempt. */
export type LineRewriter = (
  ctx: RewriteContext
) => Promise<{ text: string; evidenceRefs?: any[]; isFactualClaim?: boolean } | null>;

export interface SelfVerifyReport {
  factualLinesChecked: number;
  linesWithViolations: number;
  linesCorrected: number;
  linesUnresolved: number; // still violating after maxAttempts
  corrections: Array<{
    lineIndex: number;
    attempts: number;
    resolved: boolean;
    before: string;
    after: string;
    figures: string[];
    attributions: string[];
  }>;
}

export interface SelfVerifyOptions {
  evidenceByRefId: Map<string, string>;
  fullEvidenceText: string;
  hostNames: string[];
  rewrite: LineRewriter;
  maxAttempts?: number;
}

function citedTextFor(line: any, evidenceByRefId: Map<string, string>): string {
  const refs = Array.isArray(line?.evidenceRefs) ? line.evidenceRefs : [];
  return refs.map((r: any) => evidenceByRefId.get(r?.id) || "").join("  ");
}

/**
 * Verify + correct every factual line in place. Mutates `segments` (line.text /
 * line.evidenceRefs) and returns a report. Lines still violating after
 * maxAttempts are left as-is (the gate will still catch them — we never silently
 * pass), and counted as unresolved.
 */
export async function selfVerifyAndCorrect(
  segments: any[],
  opts: SelfVerifyOptions
): Promise<SelfVerifyReport> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const report: SelfVerifyReport = {
    factualLinesChecked: 0,
    linesWithViolations: 0,
    linesCorrected: 0,
    linesUnresolved: 0,
    corrections: [],
  };

  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || !Array.isArray(seg.lines)) continue;
    for (const line of seg.lines) {
      if (!line || line.isFactualClaim !== true || typeof line.text !== "string") continue;
      report.factualLinesChecked++;

      const before = line.text;
      let v = verifyLineAgainstEvidence(line.text, citedTextFor(line, opts.evidenceByRefId), opts.fullEvidenceText, opts.hostNames);
      if (!v.verifiable || (v.unsupportedFigures.length === 0 && v.unsupportedAttributions.length === 0)) continue;

      report.linesWithViolations++;
      const initialFigures = v.unsupportedFigures.map((f) => `${f.surface}(${f.value})`);
      const initialAttrs = [...v.unsupportedAttributions];

      let attempts = 0;
      let resolved = false;
      while (attempts < maxAttempts) {
        attempts++;
        let result: { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean } | null = null;
        try {
          result = await opts.rewrite({
            line,
            evidenceText: citedTextFor(line, opts.evidenceByRefId) || opts.fullEvidenceText,
            unsupportedFigures: v.unsupportedFigures,
            unsupportedAttributions: v.unsupportedAttributions,
            attempt: attempts,
          });
        } catch {
          result = null;
        }
        if (!result || typeof result.text !== "string" || !result.text.trim()) continue;

        line.text = result.text.trim();
        if (Array.isArray(result.evidenceRefs)) line.evidenceRefs = result.evidenceRefs;
        // The "argue without it" valve: a qualitative rewrite carries no
        // checkable figure, so let the model mark it opinion (isFactualClaim
        // false, no refs) — the gate then treats it as the opinion it is.
        if (result.isFactualClaim === false) {
          line.isFactualClaim = false;
          if (!Array.isArray(result.evidenceRefs)) line.evidenceRefs = [];
        }

        v = verifyLineAgainstEvidence(line.text, citedTextFor(line, opts.evidenceByRefId), opts.fullEvidenceText, opts.hostNames);
        if (!v.verifiable || (v.unsupportedFigures.length === 0 && v.unsupportedAttributions.length === 0)) {
          resolved = true;
          break;
        }
      }

      if (resolved) report.linesCorrected++;
      else report.linesUnresolved++;
      report.corrections.push({
        lineIndex: line.lineIndex,
        attempts,
        resolved,
        before,
        after: line.text,
        figures: initialFigures,
        attributions: initialAttrs,
      });
    }
  }

  return report;
}
