// Generation-time self-verify (FIX 1). After the act generator writes the
// script but BEFORE it is persisted, we run TWO passes over the isFactualClaim
// lines and rewrite any that won't survive the gate:
//   1. DETERMINISTIC — verifyLineAgainstEvidence: figures/attributions absent
//      from the cited evidence (fast, exact).
//   2. SEMANTIC — the SAME reviewer the fact-check gate runs, in ONE batched
//      call over all factual lines, catching what the deterministic check
//      structurally can't (a real figure on the WRONG subject, over-precision).
// Each flagged line is sent back to the model to rewrite — correct figure/
// subject, reduce precision to the evidence, or restate qualitatively. This
// turns the post-hoc gate into a generation-time constraint.
//
// Pure + injectable: both the per-line `rewrite` and the batched
// `semanticReview` are passed in, so the loop is unit-testable with stubs.

import { verifyLineAgainstEvidence, FigureVerdict } from "./factNumbers";
import { isFragmentLine, SemanticReviewLine } from "./semanticReview";

export interface RewriteContext {
  line: any;
  evidenceText: string; // the line's cited evidence (fallback: full corpus)
  unsupportedFigures: FigureVerdict[];
  unsupportedAttributions: string[];
  /** Set when the SEMANTIC reviewer flagged the line — its rationale. */
  semanticReason?: string;
  attempt: number;
}

/** Returns the corrected spoken text (and optionally revised evidenceRefs and a
 *  downgraded isFactualClaim when the line goes qualitative), or null to give up
 *  this attempt. */
export type LineRewriter = (
  ctx: RewriteContext
) => Promise<{ text: string; evidenceRefs?: any[]; isFactualClaim?: boolean } | null>;

/** One batched semantic review over all lines; returns only the flagged ones. */
export type SemanticReviewFn = (
  reviewLines: SemanticReviewLine[]
) => Promise<Array<{ lineIndex: number; status: string; reason: string }>>;

export interface SelfVerifyReport {
  factualLinesChecked: number;
  // Deterministic pass
  linesWithViolations: number;
  linesCorrected: number;
  linesUnresolved: number;
  corrections: Array<{
    lineIndex: number;
    attempts: number;
    resolved: boolean;
    before: string;
    after: string;
    figures: string[];
    attributions: string[];
  }>;
  // Semantic pass
  semantic: {
    ran: boolean;
    rounds: number; // rewrite rounds (LLM review calls = rounds + 1)
    linesFlagged: number;
    linesCorrected: number;
    linesUnresolved: number;
    corrections: Array<{ lineIndex: number; round: number; reason: string; before: string; after: string }>;
  };
  /** Cost, stamped by the orchestrator (scriptService) around the whole call. */
  latencyMs?: number;
  tokensDelta?: { inputTokens: number; outputTokens: number; requestCount: number };
}

export interface SelfVerifyOptions {
  evidenceByRefId: Map<string, string>;
  fullEvidenceText: string;
  hostNames: string[];
  rewrite: LineRewriter;
  maxAttempts?: number;
  /** Optional batched semantic reviewer (the gate reviewer). */
  semanticReview?: SemanticReviewFn;
  /** Max semantic rewrite rounds (each round = 1 review call + K rewrites). */
  maxSemanticRounds?: number;
}

function citedTextFor(line: any, evidenceByRefId: Map<string, string>): string {
  const refs = Array.isArray(line?.evidenceRefs) ? line.evidenceRefs : [];
  return refs.map((r: any) => evidenceByRefId.get(r?.id) || "").join("  ");
}

const endsWithDash = (s: string): boolean => /[—–-]\s*$/.test(String(s || "").trim());

/** Apply a rewrite in place, PRESERVING the interruption overlap marker (FIX 3):
 *  if the original line ended in an em dash (it's the line a later one
 *  interrupts) or the line itself is an interruption, keep a trailing "—" so the
 *  audio overlap still fires. isInterruption is never dropped (we never touch
 *  it). */
function applyRewrite(line: any, result: { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }, before: string) {
  let text = result.text.trim();
  if ((endsWithDash(before) || line.isInterruption === true) && !endsWithDash(text)) {
    text = text.replace(/[.!?,;:]+$/, "").trimEnd() + "—";
  }
  line.text = text;
  if (Array.isArray(result.evidenceRefs)) line.evidenceRefs = result.evidenceRefs;
  if (result.isFactualClaim === false) {
    line.isFactualClaim = false;
    if (!Array.isArray(result.evidenceRefs)) line.evidenceRefs = [];
  }
}

function collectReviewLines(segments: any[]): SemanticReviewLine[] {
  const out: SemanticReviewLine[] = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || !Array.isArray(seg.lines)) continue;
    for (const line of seg.lines) {
      if (!line || typeof line.text !== "string") continue;
      out.push({
        lineIndex: line.lineIndex,
        speakerName: line.speakerName,
        text: line.text,
        isFactualClaim: line.isFactualClaim === true,
        tone: line.tone,
        isInterruption: line.isInterruption === true,
        isFragment: isFragmentLine(line.text),
      });
    }
  }
  return out;
}

function findLine(segments: any[], lineIndex: number): any | null {
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || !Array.isArray(seg.lines)) continue;
    for (const line of seg.lines) if (line && line.lineIndex === lineIndex) return line;
  }
  return null;
}

/**
 * Verify + correct every factual line in place. Mutates `segments` and returns a
 * report. Lines still violating after the caps are left as-is (the gate still
 * catches them — we never silently pass) and counted as unresolved.
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
    semantic: { ran: false, rounds: 0, linesFlagged: 0, linesCorrected: 0, linesUnresolved: 0, corrections: [] },
  };

  // ---- Pass 1: deterministic (figures / attributions) ----
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

        applyRewrite(line, result, before);
        v = verifyLineAgainstEvidence(line.text, citedTextFor(line, opts.evidenceByRefId), opts.fullEvidenceText, opts.hostNames);
        if (!v.verifiable || (v.unsupportedFigures.length === 0 && v.unsupportedAttributions.length === 0)) {
          resolved = true;
          break;
        }
      }

      if (resolved) report.linesCorrected++;
      else report.linesUnresolved++;
      report.corrections.push({ lineIndex: line.lineIndex, attempts, resolved, before, after: line.text, figures: initialFigures, attributions: initialAttrs });
    }
  }

  // ---- Pass 2: semantic (subject-mismatch / over-precision) ----
  if (opts.semanticReview) {
    report.semantic.ran = true;
    const maxRounds = Math.max(1, opts.maxSemanticRounds ?? 2);
    const everFlagged = new Set<number>();

    let flagged = await opts.semanticReview(collectReviewLines(segments)); // review call #1
    while (flagged.length > 0 && report.semantic.rounds < maxRounds) {
      report.semantic.rounds++;
      for (const f of flagged) {
        everFlagged.add(f.lineIndex);
        const line = findLine(segments, f.lineIndex);
        if (!line || line.isFactualClaim !== true || typeof line.text !== "string") continue;
        const before = line.text;
        let result: { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean } | null = null;
        try {
          result = await opts.rewrite({
            line,
            evidenceText: citedTextFor(line, opts.evidenceByRefId) || opts.fullEvidenceText,
            unsupportedFigures: [],
            unsupportedAttributions: [],
            semanticReason: f.reason,
            attempt: report.semantic.rounds,
          });
        } catch {
          result = null;
        }
        if (!result || typeof result.text !== "string" || !result.text.trim()) continue;
        applyRewrite(line, result, before);
        report.semantic.corrections.push({ lineIndex: f.lineIndex, round: report.semantic.rounds, reason: f.reason, before, after: line.text });
      }
      flagged = await opts.semanticReview(collectReviewLines(segments)); // re-review
    }

    for (const f of flagged) everFlagged.add(f.lineIndex);
    const stillFlagged = new Set(flagged.map((f) => f.lineIndex));
    report.semantic.linesUnresolved = stillFlagged.size;
    report.semantic.linesFlagged = everFlagged.size;
    report.semantic.linesCorrected = everFlagged.size - stillFlagged.size;
  }

  return report;
}
