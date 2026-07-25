// Generation-time antithesis pass. Runs after the script has been cleaned and
// globally renumbered, before the hard validations. Same shape as
// scriptSelfVerify: detect -> batched rewrite -> re-check, with a round cap and
// never-silently-pass behavior.
//
// The detector (scriptAntithesis) matches the balanced-negation frame. The
// rewrite goes through the SAME batched rewriter the self-verify pass uses, so
// antithesis fixes inherit its chunking, its cost-ledger stage, its lineIndex
// keying, and its guard against touching lines that were never listed.
//
// Lines that still carry the frame after the cap keep their text and get
// needsHumanReview. The script review console shows the count, and the caller
// decides whether ANTITHESIS_STRICT turns that into a job failure.
//
// Pure + injectable: the rewriter is passed in, so the loop is testable with a
// stub.

import {
  analyzeAntithesis,
  rewriteInstruction,
  type AntithesisLine,
  type AntithesisPolicy,
  type AntithesisReport,
} from "./scriptAntithesis";
import type { BatchLineRewriter, RewriteContext } from "./scriptSelfVerify";

/** The fields this pass reads or writes on a cleaned script line. */
export interface ScriptLineLike {
  lineIndex: number;
  speakerName?: string;
  text: string;
  isInterruption?: boolean;
  isFactualClaim?: boolean;
  evidenceRefs?: unknown[];
  needsHumanReview?: boolean;
}

export interface ScriptSegmentLike {
  lines?: ScriptLineLike[];
}

type RewriteResult = { text: string; evidenceRefs?: unknown[]; isFactualClaim?: boolean };

export interface AntithesisPassReport {
  ran: boolean;
  rounds: number;
  /** Frame count before any rewrite, so the effect of the pass is visible. */
  before: { totalHits: number; hitsPerHundredLines: number };
  /** Frame count after the last re-check. These are the numbers the UI shows. */
  totalHits: number;
  hitsPerHundredLines: number;
  byKind: Record<string, number>;
  linesFlagged: number;
  linesCorrected: number;
  linesUnresolved: number;
  corrections: Array<{
    lineIndex: number;
    round: number;
    kinds: string[];
    before: string;
    after: string;
  }>;
  /** Violations that survived the cap. Each of these lines has needsHumanReview. */
  unresolved: Array<{
    lineIndex: number;
    speakerName: string;
    text: string;
    kinds: string[];
    reason: string;
  }>;
  reasons: string[];
}

export interface AntithesisPassOptions {
  /** The batched rewriter (rewriteLinesForGrounding in production). */
  rewrite: BatchLineRewriter;
  /** Rewrite rounds. Defaults to 2, matching maxSemanticRounds. */
  maxRounds?: number;
  policy?: AntithesisPolicy;
  /** Evidence text for a line, so a rewrite keeps its facts. */
  evidenceTextFor?: (line: ScriptLineLike) => string;
}

const endsWithDash = (s: string): boolean => /[—–-]\s*$/.test(String(s || "").trim());

/** Walk segments in order and collect every spoken line. lineIndex is taken
 *  from the line itself, which is the true episode-wide index by the time this
 *  pass runs (normalizeLineIndexes has already renumbered). The cold-open rule
 *  depends on that, so callers must run this AFTER renumbering. */
function collectLines(segments: ScriptSegmentLike[]): Array<{ line: ScriptLineLike; entry: AntithesisLine }> {
  const out: Array<{ line: ScriptLineLike; entry: AntithesisLine }> = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || !Array.isArray(seg.lines)) continue;
    for (const line of seg.lines) {
      if (!line || typeof line.text !== "string") continue;
      out.push({
        line,
        entry: {
          lineIndex: line.lineIndex,
          speakerName: String(line.speakerName || "?"),
          text: line.text,
        },
      });
    }
  }
  return out;
}

/** Apply a rewrite in place, preserving the interruption overlap marker the
 *  same way scriptSelfVerify does. */
function applyRewrite(line: ScriptLineLike, result: RewriteResult, before: string) {
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

function summarize(report: AntithesisReport) {
  return {
    totalHits: report.totalHits,
    hitsPerHundredLines: Number(report.hitsPerHundredLines.toFixed(1)),
  };
}

/**
 * Detect and rewrite antithesis frames in place. Mutates `segments` and returns
 * a report. Violations still present after `maxRounds` keep their text and are
 * marked needsHumanReview, so nothing passes silently.
 */
export async function antithesisPassAndCorrect(
  segments: ScriptSegmentLike[],
  opts: AntithesisPassOptions
): Promise<AntithesisPassReport> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 2);
  const collected = collectLines(segments);
  const lineByIndex = new Map<number, ScriptLineLike>(collected.map((c) => [c.entry.lineIndex, c.line]));

  let report = analyzeAntithesis(
    collected.map((c) => c.entry),
    opts.policy
  );

  const pass: AntithesisPassReport = {
    ran: true,
    rounds: 0,
    before: summarize(report),
    ...summarize(report),
    byKind: report.byKind,
    linesFlagged: 0,
    linesCorrected: 0,
    linesUnresolved: 0,
    corrections: [],
    unresolved: [],
    reasons: [],
  };

  const everFlagged = new Set<number>();

  while (report.violations.length > 0 && pass.rounds < maxRounds) {
    pass.rounds++;

    const roundItems: Array<{ line: ScriptLineLike; before: string; kinds: string[] }> = [];
    const contexts: RewriteContext[] = [];
    for (const v of report.violations) {
      everFlagged.add(v.lineIndex);
      const line = lineByIndex.get(v.lineIndex);
      if (!line || typeof line.text !== "string") continue;
      roundItems.push({ line, before: line.text, kinds: v.hits.map((h) => h.kind) });
      contexts.push({
        line,
        evidenceText: opts.evidenceTextFor ? opts.evidenceTextFor(line) : "",
        unsupportedFigures: [],
        unsupportedAttributions: [],
        // The rewriter surfaces semanticReason as "fix exactly this", which is
        // where the antithesis instruction belongs.
        semanticReason: rewriteInstruction(v),
        attempt: pass.rounds,
      });
    }

    let results: Map<number, RewriteResult>;
    try {
      results = await opts.rewrite(contexts);
    } catch {
      results = new Map();
    }

    for (const { line, before, kinds } of roundItems) {
      const result = results.get(line.lineIndex);
      if (!result || typeof result.text !== "string" || !result.text.trim()) continue;
      applyRewrite(line, result, before);
      pass.corrections.push({
        lineIndex: line.lineIndex,
        round: pass.rounds,
        kinds,
        before,
        after: line.text,
      });
    }

    // Re-check against the mutated text.
    report = analyzeAntithesis(
      collectLines(segments).map((c) => c.entry),
      opts.policy
    );
  }

  for (const v of report.violations) {
    everFlagged.add(v.lineIndex);
    const line = lineByIndex.get(v.lineIndex);
    if (line) line.needsHumanReview = true;
    pass.unresolved.push({
      lineIndex: v.lineIndex,
      speakerName: v.speakerName,
      text: v.text,
      kinds: v.hits.map((h) => h.kind),
      reason: v.reason,
    });
  }

  const summary = summarize(report);
  pass.totalHits = summary.totalHits;
  pass.hitsPerHundredLines = summary.hitsPerHundredLines;
  pass.byKind = report.byKind;
  pass.linesFlagged = everFlagged.size;
  pass.linesUnresolved = report.violations.length;
  pass.linesCorrected = everFlagged.size - report.violations.length;

  pass.reasons.push(
    `Antithesis: ${pass.before.totalHits} frame(s) at generation (${pass.before.hitsPerHundredLines} per 100 lines) -> ` +
      `${pass.totalHits} after ${pass.rounds} rewrite round(s) (${pass.hitsPerHundredLines} per 100 lines); ` +
      `${pass.linesCorrected}/${pass.linesFlagged} flagged line(s) fixed, ${pass.linesUnresolved} left for human review.`
  );

  return pass;
}
